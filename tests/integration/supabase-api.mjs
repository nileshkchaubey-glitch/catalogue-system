import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createBundle, restoreBundle } from "../../scripts/verify-migration-backup.mjs";
import { stageVerifiedBundle } from "../../scripts/stage-workspace.mjs";
import { join } from "node:path";
import { Miniflare, Log, LogLevel } from "miniflare";
import { launchChromium, waitFor } from "../browser/chromium.mjs";
import { photo } from "../browser/local-fixture.mjs";
import { applyBulkMarkup, buildBulkPreview } from "../../shared/quote-pricing.mjs";
import { localCommand, migrationFailure, migrationPsqlArgs } from "./supabase-migration-diagnostics.mjs";
import { preparePinnedRuntime, verifyPinnedRuntime, RuntimeFailure } from "./supabase-runtime.mjs";

const project = "catalogue-api-gate-disposable";
const dbContainer = "supabase_db_" + project;
const migrationsDir = new URL("../../supabase/migrations/", import.meta.url);
const migrationFiles = [
  "20261127000100_catalogue_foundation.sql",
  "20261127000200_catalogue_workspace_bridge.sql",
  "20261127000300_catalogue_worker_write_boundary.sql",
];
const localOrigin = "http://127.0.0.1:54321";
const revisionPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const workspacePath = "/rest/v1/catalogue_workspaces";
const rpcPath = "/rest/v1/rpc/save_catalogue_workspace";
const digest = sha256(photo);
const photoRoute = "/api/photos/" + digest;

let checkpoint = "local stack configuration";
class GateFailure extends Error {}

function check(condition, message) {
  if (!condition) throw new GateFailure(message);
}

function expectStatus(response, expected) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  check(allowed.includes(response.status), "Expected HTTP " + allowed.join("/") + ", got " + response.status + ".");
}

async function step(name, run) {
  checkpoint = name;
  await run();
  console.log("PASS " + name);
}

function db(sql, atomic = false) {
  return localCommand("docker", [
    "exec", "-i", dbContainer,
    "psql", "-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate",
    "-U", "postgres", "-d", "postgres", ...(atomic ? ["-1", "-f", "-"] : []),
  ], sql);
}

function query(sql) {
  const result = db(sql);
  check(result.status === 0, "Local SQL verification failed.");
  return result.stdout.trim();
}

function runMigrationTransaction(input, sourceLineCount) {
  const startedAt = new Date().toISOString();
  const result = localCommand("docker", migrationPsqlArgs(dbContainer), input);
  if (result.status === 0 && !result.error) return;
  throw new GateFailure(migrationFailure(dbContainer, result, input, sourceLineCount, startedAt));
}

async function applyMigrations() {
  checkpoint = "exact migration inventory";
  assert.deepEqual(readdirSync(migrationsDir).sort(), migrationFiles);

  await step("initialize empty Supabase migration history", () => {
    runMigrationTransaction(
      "set local lock_timeout = '4s';\n" +
      "create schema if not exists supabase_migrations;\n" +
      "create table if not exists supabase_migrations.schema_migrations (version text primary key);\n" +
      "alter table supabase_migrations.schema_migrations add column if not exists name text;\n" +
      "alter table supabase_migrations.schema_migrations add column if not exists statements text[];\n"
    );
    check(query("select count(*) from supabase_migrations.schema_migrations") === "0",
      "Expected empty migration history on the disposable stack.");
  });

  for (const file of migrationFiles) {
    await step("apply migration " + file, () => {
      console.log("START " + checkpoint);
      const sql = readFileSync(new URL(file, migrationsDir));
      // The pinned CLI's fetch joins statement entries with semicolons and adds
      // a final semicolon and newline. Store one block to round-trip the file.
      check(sql.subarray(-2).toString() === ";\n", "Expected a semicolon and LF at the end of the tracked SQL.");
      const version = file.slice(0, 14);
      const name = file.slice(15, -4);
      const sourceHex = sql.subarray(0, -2).toString("hex");
      const history = "insert into supabase_migrations.schema_migrations (version, name, statements)\n" +
        "values ('" + version + "', '" + name + "', array[convert_from(decode('" + sourceHex + "', 'hex'), 'UTF8')]);\n";
      const sourceLineCount = sql.toString("utf8").split("\n").length - 1;
      runMigrationTransaction(Buffer.concat([sql, Buffer.from(history)]), sourceLineCount);
    });
  }
}

function localSettings() {
  check(process.env.RUNNER_TEMP, "A disposable test directory is required.");
  const dir = join(process.env.RUNNER_TEMP, "catalogue-supabase-gate");
  const toml = readFileSync(join(dir, "supabase", "config.toml"), "utf8");
  check(toml.startsWith('project_id = "' + project + '"'), "Expected the disposable project ID.");
  const result = localCommand("supabase", ["--workdir", dir, "status", "-o", "json"]);
  check(result.status === 0, "Local Supabase status failed.");
  const { API_URL, PUBLISHABLE_KEY, SERVICE_ROLE_KEY, SECRET_KEY } = JSON.parse(result.stdout);
  check([localOrigin, "http://localhost:54321"].includes(API_URL), "Expected the local Supabase API origin.");
  check(/^sb_publishable_[\w-]+$/.test(PUBLISHABLE_KEY), "Local publishable key was absent.");
  check(/^sb_secret_[\w-]+$/.test(SECRET_KEY) && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(SERVICE_ROLE_KEY), "Local admin keys were absent.");
  return { publishable: PUBLISHABLE_KEY, serviceRole: SERVICE_ROLE_KEY, secret: SECRET_KEY };
}

async function runtimePreflight() {
  await step("special-grantee and denied-function runtime checks", () => {
    const input = readFileSync(new URL("./supabase-runtime-preflight.sql", import.meta.url));
    const startedAt = new Date().toISOString();
    // The probe owns its BEGIN/ROLLBACK; do not nest psql's single transaction.
    const args = migrationPsqlArgs(dbContainer).filter((arg) => arg !== "-1");
    const result = localCommand("docker", args, input);
    if (result.status !== 0 || result.error)
      throw new GateFailure(migrationFailure(dbContainer, result, input, input.toString("utf8").split("\n").length - 1, startedAt));
    check(query("select to_regnamespace('catalogue_runtime_probe') is null and not exists (select 1 from pg_roles where rolname = 'catalogue_runtime_probe_writer')") === "t",
      "Runtime probe did not roll back its objects.");
  });
}

async function reconcileFixture() {
  await step("recreate seven legacy policy collisions", () => {
    check(query("select to_regclass('public.business_profiles') is null") === "t", "Local database must be empty of application objects.");
    const fixture = readFileSync(new URL("./legacy-foundation.sql", import.meta.url), "utf8");
    check(db(fixture, true).status === 0, "Synthetic legacy fixture could not be prepared.");
    check(query("select count(*) from pg_policies where policyname in ('catalogue_profiles_read', 'catalogue_profiles_guard', 'catalogue_profiles_no_client_delete', 'catalogue_media_no_anon', 'catalogue_media_owner_guard', 'catalogue_media_read', 'catalogue_media_insert')") === "7", "Expected all seven legacy policies.");
    check(query("select count(*) from pg_policies where policyname in ('business_profiles_insert', 'business_profiles_select', 'business_profiles_update', 'catalogue_media_select', 'catalogue_media_update', 'catalogue_media_delete')") === "6", "Expected hosted legacy aliases.");
    check(query("select count(*) from pg_constraint where conrelid = 'public.business_profiles'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (owner_id)'") === "0", "Expected hosted legacy owner index without uniqueness.");
  });

  await step("duplicate legacy owners abort without merging or leaving partial schema", () => {
    const migration = readFileSync(new URL(migrationFiles[0], migrationsDir), "utf8");
    const owner = "10000000-0000-4000-8000-000000000099";
    const result = db("insert into auth.users (id,email) values ('" + owner + "','duplicate-fixture@example.invalid');\n" +
      "insert into public.business_profiles (owner_id,business_name) values ('" + owner + "','Duplicate A'),('" + owner + "','Duplicate B');\n" + migration, true);
    check(result.status !== 0 && /\b23505\b/.test(result.stderr), "Expected duplicate-owner constraint rejection.");
    check(query("select count(*) from auth.users where id = '" + owner + "'") === "0", "Duplicate fixture did not roll back.");
    check(query("select count(*) from public.business_profiles") === "0", "Profile changes did not roll back.");
    check(query("select to_regnamespace('catalogue_private') is null") === "t", "Partial migration schema remained.");
    check(query("select count(*) from pg_constraint where conrelid = 'public.business_profiles'::regclass and contype = 'u'") === "0", "Unexpected unique constraint after rollback.");
  });

  await step("incompatible bucket aborts the foundation transaction", () => {
    const migration = readFileSync(new URL(migrationFiles[0], migrationsDir), "utf8");
    const result = db("update storage.buckets set public = true where id = 'catalogue-media';\n" + migration, true);
    check(result.status !== 0 && /\bP0001\b/.test(result.stderr), "Expected the bucket-contract exception.");
    check(query("select not public from storage.buckets where id = 'catalogue-media'") === "t", "Bucket change did not roll back.");
    check(query("select qual from pg_policies where schemaname = 'public' and tablename = 'business_profiles' and policyname = 'catalogue_profiles_read'") === "false", "Legacy policy did not roll back.");
  });
}

function jsonRequest(method, data, headers = {}) {
  return { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(data) };
}

function call(origin, path, options = {}) {
  check(path.startsWith("/") && !path.startsWith("//"), "Expected a local request path.");
  return fetch(origin + path, { ...options, redirect: "error", signal: AbortSignal.timeout(15000) });
}

function dataApi(settings, path, { token, admin = false, ...options } = {}) {
  const headers = new Headers(options.headers);
  headers.set("apikey", admin ? settings.secret : settings.publishable);
  if (admin || token) headers.set("Authorization", "Bearer " + (admin ? settings.serviceRole : token));
  return call(localOrigin, path, { ...options, headers });
}

async function createUser(settings, label, provisioned) {
  const user = {
    email: "catalogue-" + label.toLowerCase().replaceAll(" ", "-") + "@example.com",
    password: randomBytes(24).toString("base64url"),
  };
  const response = await dataApi(settings, "/auth/v1/admin/users", {
    ...jsonRequest("POST", { ...user, email_confirm: true }), admin: true,
  });
  expectStatus(response, [200, 201]);
  const { id } = await response.json();
  check(revisionPattern.test(id), "Auth user ID was absent.");
  const businessName = "Synthetic " + label;
  if (provisioned)
    query("insert into public.business_profiles (owner_id, business_name) values ('" + id + "', '" + businessName + "');");
  return { ...user, id, businessName };
}

function sessionCookies(response) {
  const cookies = response.headers.getSetCookie();
  check(cookies.length === 2 && cookies.every((cookie) => /; HttpOnly\b/.test(cookie) && /; SameSite=Lax\b/.test(cookie)), "Expected two protected session cookies.");
  const access = cookies.find((cookie) => cookie.startsWith("catalogue_access="))?.split(";")[0];
  const refresh = cookies.find((cookie) => cookie.startsWith("catalogue_refresh="))?.split(";")[0];
  check(access && refresh && access.includes(".") && refresh.length > "catalogue_refresh=".length, "Expected Auth-issued access and refresh cookies.");
  return { access, refresh, token: access.slice("catalogue_access=".length), header: access + "; " + refresh };
}

async function expectNoRows(response) {
  expectStatus(response, 200);
  const rows = await response.json();
  check(Array.isArray(rows) && rows.length === 0, "An isolated record was visible.");
}

async function expectStorageDenied(response) {
  expectStatus(response, [400, 401, 403, 404]);
  if (response.status === 400) {
    const details = await response.json();
    check(["401", "403", "404"].includes(String(details.statusCode)), "Storage did not report access denial or a hidden object.");
  }
}

function fixture(photoPath) {
  return {
    schema: 3,
    departments: { Samples: ["Containers"] },
    collections: [],
    families: [{
      id: "synthetic-family", name: "Synthetic Tray", category: "Containers", photo: photoPath,
      collections: [], gallery: [],
      variants: [
        { id: "synthetic-pack", variant: "Pack", unit: "Pack", purchase: "5.00", rate: "10.00",
          ready: true, history: [{ at: "2026-01-01", rate: "10.00" }], overridePhoto: "" },
        { id: "synthetic-piece", variant: "Piece", unit: "Piece", purchase: "1.00", rate: "0.10",
          ready: true, history: [], overridePhoto: "" },
      ],
    }],
    customers: [{
      id: "synthetic-buyer", name: "Synthetic Buyer", phone: "00000000000",
      collection: "Full catalog", consent: true,
    }],
    quoteDrafts: [],
    quoteSnapshots: [],
  };
}

function draftQuote() {
  return { id: "synthetic-quote", customerId: "synthetic-buyer", lines: [
    { variantId: "synthetic-pack", quantity: "3", rateOverride: "8.03" },
    { variantId: "synthetic-piece", quantity: "3", rateOverride: "" },
  ] };
}

function expectedQuote() {
  return {
    id: "synthetic-quote", customerId: "synthetic-buyer", customerName: "Synthetic Buyer",
    customerPhone: "00000000000", confirmedAt: "2026-11-27T00:00:00.000Z",
    lines: [
      { variantId: "synthetic-pack", name: "Synthetic Tray", variant: "Pack", unit: "Pack",
        quantity: "3", rate: "8.03", subtotal: "24.09" },
      { variantId: "synthetic-piece", name: "Synthetic Tray", variant: "Piece", unit: "Piece",
        quantity: "3", rate: "0.10", subtotal: "0.30" },
    ],
    total: "24.39",
  };
}

const button = (label) => "[...document.querySelectorAll('button')].find(e => e.textContent.trim() === " + JSON.stringify(label) + " && e.getClientRects().length && !e.disabled)";
const heading = (label) => "document.querySelector('h1')?.textContent.trim() === " + JSON.stringify(label);
const visibleText = (label) => "document.body?.innerText.includes(" + JSON.stringify(label) + ")";
function visible(page, expression, label) {
  return waitFor(() => page.visible(expression), label, 10000);
}

async function browserSmoke(origin, userA, userB, winningCustomer) {
  const browser = await launchChromium();
  try {
    console.log("Browser " + browser.version);
    for (const [user, viewport, seesOwnerA] of [
      [userA, { width: 1366, height: 900 }, true],
      [userB, { width: 390, height: 844, mobile: true }, false],
    ]) {
      await step((viewport.mobile ? "mobile" : "desktop") + " Chromium against the real stack", async () => {
        const page = await browser.newPage(origin, viewport);
        try {
          await page.navigate();
          await visible(page, heading("Admin sign in"), "admin sign-in");
          await page.focus('document.querySelector("input[name=email]")');
          await page.type(user.email);
          await page.key("Tab");
          await page.type(user.password);
          await page.key("Enter");
          await visible(page, button("Sign out"), "signed-in workspace");
          check(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Workspace overflowed the viewport.");
          await page.navigate();
          await visible(page, button("Sign out"), "session restored on reload");
          await page.click(button("Customers"));
          await visible(page, heading("Customers"), "customer list");
          if (seesOwnerA) await visible(page, visibleText(winningCustomer), "persisted owner's customer");
          else check(!await page.visible(visibleText(winningCustomer)), "The other owner's customer was visible.");
          await page.click(button("Sign out"));
          // The heading appears while DELETE /api/session is still in flight.
          // The form is rendered only after SessionBoundary finishes sign-out.
          await visible(page, button("Sign in"), "completed sign-out");
          check(!await page.visible('document.querySelector("[role=alert]")'), "Browser sign-out reported an error.");
          const signedOutStatus = await page.evaluate('fetch("/api/workspace", { cache: "no-store" }).then(r => r.status)');
          check(signedOutStatus === 401, "Signed-out browser workspace expected HTTP 401, got " + signedOutStatus + ".");
          await page.navigate();
          await visible(page, button("Sign in"), "signed-out session persists on reload");
          check(await page.evaluate('fetch("/api/workspace", { cache: "no-store" }).then(r => r.status)') === 401, "Reloaded signed-out browser retained workspace access.");
          check(page.errors.length === 0 && page.outside.length === 0, "Browser reported an error or an unexpected external request.");
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    await browser.close();
  }
}

async function integrate(settings) {
  await step("PostgreSQL migrations preserved the legacy profile and bucket contract", () => {
    assert.match(query("show server_version"), /^17\./);
    console.log("PostgreSQL " + query("show server_version").split(" ")[0]);
    assert.equal(query("select string_agg(version || '_' || name || '.sql', ',' order by version) from supabase_migrations.schema_migrations"),
      migrationFiles.join(","));
    for (const file of migrationFiles) {
      const recordedHash = query(
        "select encode(sha256(convert_to(array_to_string(statements, E';\\n') || E';\\n', 'UTF8')), 'hex') " +
        "from supabase_migrations.schema_migrations where version = '" + file.slice(0, 14) + "';"
      );
      check(recordedHash === sha256(readFileSync(new URL(file, migrationsDir))),
        "Migration history cannot reconstruct " + file + ".");
    }
    assert.equal(query("select count(*) from pg_constraint where conrelid = 'public.business_profiles'::regclass and contype = 'u' and pg_get_constraintdef(oid) = 'UNIQUE (owner_id)'"), "1");
    assert.equal(query("select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname in ('gate_unrelated_media_policy', 'gate_unrelated_update_policy', 'gate_unrelated_delete_policy')"), "3");
    assert.equal(query("select count(*) from pg_policies where policyname in ('business_profiles_insert', 'business_profiles_select', 'business_profiles_update', 'catalogue_media_select', 'catalogue_media_update', 'catalogue_media_delete')"), "0");
    assert.equal(query("select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and permissive = 'RESTRICTIVE' and policyname in ('catalogue_media_no_client_update','catalogue_media_no_client_delete')"), "2");
    assert.equal(query("select count(*) from storage.buckets where id = 'catalogue-media' and name = id and not public and file_size_limit = 5242880 and allowed_mime_types = array['image/jpeg','image/png','image/webp']"), "1");
  });

  query("notify pgrst, 'reload schema';");
  const writeKey = randomBytes(32).toString("hex");
  let userA, userB, unprovisioned;
  await step("provision two real Auth owners and one Auth-only user", async () => {
    userA = await createUser(settings, "Owner A", true);
    userB = await createUser(settings, "Owner B", true);
    unprovisioned = await createUser(settings, "Unprovisioned", false);
    query("insert into catalogue_private.workspace_write_key (key_sha256) values (decode('" + sha256(writeKey) + "', 'hex'));");
  });

  const worker = new Miniflare({
    modules: true, scriptPath: "dist/server/index.js", compatibilityDate: "2026-05-01",
    host: "127.0.0.1", port: 0, log: new Log(LogLevel.NONE),
    bindings: {
      SUPABASE_URL: localOrigin,
      SUPABASE_PUBLISHABLE_KEY: settings.publishable,
      CATALOGUE_WORKSPACE_WRITE_KEY: writeKey,
    },
  });
  try {
    checkpoint = "start packaged Worker runtime";
    const origin = (await worker.ready).origin;
    const app = (path, options) => call(origin, path, options);
    const api = (path, options) => dataApi(settings, path, options);
    const login = (user) => app("/api/session", jsonRequest("POST", { email: user.email, password: user.password }, { Origin: origin }));
    let alice, bob;
    let profileA, profileB;
    let third;
    await step("public email signup is denied without creating an account", async () => {
      const email = "catalogue-signup-test@example.com";
      expectStatus(await api("/auth/v1/signup", jsonRequest("POST", {
        email, password: randomBytes(24).toString("base64url"),
      })), 422);
      check(query("select not exists (select 1 from auth.users where email = '" + email + "')") === "t",
        "A rejected public signup created an Auth user.");
    });
    await step("real sign-in, refresh rotation, and anonymous/unprovisioned denial", async () => {
      expectStatus(await app("/api/workspace"), 401);
      expectStatus(await api(workspacePath), [401, 403]);
      expectStatus(await login({ ...userA, password: randomBytes(24).toString("base64url") }), 401);
      const rejected = await login(unprovisioned);
      check(rejected.status === 403, "Unprovisioned email login expected HTTP 403, got " + rejected.status + ".");
      check(rejected.headers.getSetCookie().length === 0, "The unprovisioned Worker login issued cookies.");
      const thirdLogin = await api("/auth/v1/token?grant_type=password", jsonRequest("POST", {
        email: unprovisioned.email, password: unprovisioned.password,
      }));
      expectStatus(thirdLogin, 200);
      third = (await thirdLogin.json()).access_token;
      check(typeof third === "string" && third.includes("."), "Unprovisioned Auth login issued no user JWT.");
      await expectNoRows(await api(workspacePath, { token: third }));
      const responseA = await login(userA);
      expectStatus(responseA, 200);
      const oldCookies = sessionCookies(responseA);
      const signedIn = await responseA.json();
      check(Object.keys(signedIn).join() === "profile", "Worker exposed unexpected sign-in response fields.");
      const renewal = await app("/api/session", { headers: { Cookie: oldCookies.refresh } });
      expectStatus(renewal, 200);
      alice = sessionCookies(renewal);
      check(alice.refresh !== oldCookies.refresh, "Supabase did not rotate the refresh token.");
      profileA = (await renewal.json()).profile;
      assert.equal(profileA.business_name, userA.businessName);
      assert.deepEqual(profileA, signedIn.profile);
      const responseB = await login(userB);
      expectStatus(responseB, 200);
      bob = sessionCookies(responseB);
      profileB = (await responseB.json()).profile;
      assert.equal(profileB.business_name, userB.businessName);
    });

    const active = (session) => ({ Cookie: session.header });
    const write = (document, revision, profile = profileA.id, session = alice) =>
      app("/api/workspace", jsonRequest("PUT", document, {
        ...active(session), Origin: origin, "X-Revision": revision, "X-Owner-Profile": profile,
      }));
    const read = (session, path = "/api/workspace") => app(path, { headers: active(session) });
    const readOwnerA = () => api(workspacePath + "?owner_id=eq." + userA.id, { token: alice.token });
    const rpc = (document, revision, token, key) => api(rpcPath, {
      ...jsonRequest("POST", { expected_revision: revision, workspace_document: document },
        key ? { "X-Catalogue-Workspace-Write-Key": key } : {}),
      token,
    });

    await step("real private JPEG upload, download, tenant denial and SHA-256", async () => {
      const upload = await app("/api/photos", {
        method: "POST",
        headers: { ...active(alice), Origin: origin, "Content-Type": "image/jpeg", "X-Owner-Profile": profileA.id },
        body: photo,
      });
      expectStatus(upload, 200);
      assert.deepEqual(await upload.json(), { photo: photoRoute });
      const objectPath = "/storage/v1/object/authenticated/catalogue-media/" + userA.id + "/" + digest + ".jpg";
      for (const response of [await read(alice, photoRoute), await api(objectPath, { token: alice.token })]) {
        expectStatus(response, 200);
        assert.equal(response.headers.get("Content-Type")?.split(";")[0], "image/jpeg");
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.deepEqual(bytes, photo);
        assert.equal(sha256(bytes), digest);
      }
      expectStatus(await read(bob, photoRoute), 404);
      expectStatus(await app(photoRoute), 401);
      await expectStorageDenied(await api(objectPath, { token: bob.token }));
      await expectStorageDenied(await api(objectPath, { token: third }));
      await expectStorageDenied(await api(objectPath));
      // Use the actual Storage API, not direct metadata mutations. Recent
      // Storage versions reject direct SQL DELETE with a statement trigger
      // even when RLS matches zero rows. Verify the owner cannot mutate the
      // synthetic object through supported HTTP operations and its bytes stay exact.
      const mutationPath = "/storage/v1/object/catalogue-media/" + userA.id + "/" + digest + ".jpg";
      const replacement = Buffer.concat([photo, Buffer.from([0])]);
      for (const [label, options] of [
        ["replace", { method: "PUT", headers: { "Content-Type": "image/jpeg" }, body: replacement }],
        ["upsert", { method: "POST", headers: { "Content-Type": "image/jpeg", "x-upsert": "true" }, body: replacement }],
        ["delete", { method: "DELETE" }],
      ]) {
        const denied = await api(mutationPath, { ...options, token: alice.token });
        console.log("Storage " + label + " HTTP " + denied.status);
        await expectStorageDenied(denied);
        const preserved = await api(objectPath, { token: alice.token });
        expectStatus(preserved, 200);
        assert.deepEqual(Buffer.from(await preserved.arrayBuffer()), photo);
      }
      console.log("JPEG bytes " + photo.length + ", SHA-256 " + digest);
    });

    let current;
    let revision;
    await step("Worker-authorized save, direct REST write denial and tenant isolation", async () => {
      const doc = fixture(photoRoute);
      const first = await write(doc, "new");
      expectStatus(first, 200);
      ({ workspace: current, revision } = await first.json());
      assert.match(revision, revisionPattern);
      assert.deepEqual(current, doc);
      const result = await readOwnerA();
      expectStatus(result, 200);
      const [row] = await result.json();
      assert.equal(row.revision, revision);
      assert.deepEqual(row.document, doc);
      expectStatus(await api(workspacePath, {
        ...jsonRequest("POST", { owner_id: userB.id, revision, document: doc }), token: bob.token,
      }), 403);
      expectStatus(await api(workspacePath + "?owner_id=eq." + userA.id, {
        ...jsonRequest("PATCH", { document: doc }), token: alice.token,
      }), 403);
      expectStatus(await api(workspacePath + "?owner_id=eq." + userA.id, {
        method: "DELETE", token: alice.token,
      }), 403);
      expectStatus(await rpc(doc, revision, alice.token), 403);
      expectStatus(await rpc(doc, revision, alice.token, randomBytes(32).toString("hex")), 403);
      expectStatus(await rpc(doc, null, third, writeKey), 403);
      expectStatus(await write(doc, revision, profileB.id), 403);
      await expectNoRows(await api(workspacePath + "?owner_id=eq." + userA.id, { token: bob.token }));
      const bobWorkspace = await read(bob, "/api/workspace?owner_id=" + userA.id);
      expectStatus(bobWorkspace, 200);
      assert.equal(bobWorkspace.headers.get("X-Revision"), "new");
      assert.deepEqual((await bobWorkspace.json()).customers, []);
    });

    await step("concurrent Worker and PostgREST writes preserve exactly one winner", async () => {
      const candidates = ["Synthetic Winner One", "Synthetic Winner Two"].map((name) => ({
        ...current, customers: [{ ...current.customers[0], name }],
      }));
      const saves = await Promise.all(candidates.map((candidate) => write(candidate, revision)));
      assert.deepEqual(saves.map(({ status }) => status).sort(), [200, 409]);
      const workerWinner = saves.findIndex(({ status }) => status === 200);
      ({ revision } = await saves[workerWinner].json());
      const afterWorker = await read(alice);
      expectStatus(afterWorker, 200);
      assert.equal(afterWorker.headers.get("X-Revision"), revision);
      assert.deepEqual(await afterWorker.json(), candidates[workerWinner]);

      const rpcSaves = await Promise.all(candidates.map((candidate) => rpc(candidate, revision, alice.token, writeKey)));
      rpcSaves.forEach((response) => expectStatus(response, 200));
      const rpcResults = await Promise.all(rpcSaves.map((response) => response.json()));
      const rpcWinner = rpcResults.findIndex((value) => typeof value === "string" && revisionPattern.test(value));
      assert.ok(rpcWinner >= 0);
      assert.equal(rpcResults[1 - rpcWinner], null);
      assert.notEqual(rpcResults[rpcWinner], revision);
      revision = rpcResults[rpcWinner];
      const afterRpc = await readOwnerA();
      expectStatus(afterRpc, 200);
      const [row] = await afterRpc.json();
      assert.equal(row.revision, revision);
      assert.deepEqual(row.document, candidates[rpcWinner]);
      current = row.document;
      console.log("Worker HTTP 200/409. PostgREST returned one new revision and one null conflict.");
    });

    await step("exact quotation pricing, consent, catalogue history and snapshot immutability", async () => {
      const snapshot = { ...expectedQuote(), customerName: current.customers[0].name };
      const save = async (doc, status = 200) => {
        const response = await write(doc, revision);
        expectStatus(response, status);
        if (response.ok) ({ revision, workspace: current } = await response.json());
      };
      await save({ ...current, quoteSnapshots: [snapshot] }, 422);
      await save({ ...current, quoteDrafts: [draftQuote()] });
      const confirmation = { ...current, quoteDrafts: [], quoteSnapshots: [snapshot] };
      const changedQuote = structuredClone(confirmation);
      changedQuote.quoteSnapshots[0].lines[0].rate = "8.04";
      changedQuote.quoteSnapshots[0].lines[0].subtotal = "24.12";
      changedQuote.quoteSnapshots[0].total = "24.42";
      await save(changedQuote, 422);
      await save({ ...confirmation, customers: [{ ...current.customers[0], consent: false }] }, 422);
      const changedCatalogue = structuredClone(confirmation);
      changedCatalogue.families[0].variants[0].history = [];
      await save(changedCatalogue, 422);
      await save(confirmation);
      assert.deepEqual(current, confirmation);
      await save({ ...current, quoteSnapshots: [] }, 422);
      await save({ ...current, quoteSnapshots: [changedQuote.quoteSnapshots[0]] }, 422);
      const preview = buildBulkPreview(current, ["synthetic-pack"], "25.50");
      await save(applyBulkMarkup(current, preview, "2026-11-27T01:00:00.000Z"));
      assert.deepEqual(current.families[0].variants[0].history.map(({ rate }) => rate), ["10.00", "6.28"]);
      const evidence = await readOwnerA();
      expectStatus(evidence, 200);
      const [row] = await evidence.json();
      assert.deepEqual(row.document.quoteSnapshots, [snapshot]);
      assert.deepEqual(row.document.quoteDrafts, []);
      const buyer = await read(alice, "/api/buyer");
      expectStatus(buyer, 200);
      assert.ok((await buyer.json()).products.every((item) => !Object.hasOwn(item, "purchase")));
      console.log("Exact saved quotation total INR " + snapshot.total + ".");
    });

    await step("logout clears cookies and revokes access, refresh, writes and private media", async () => {
      const response = await app("/api/session", { method: "DELETE", headers: { ...active(alice), Origin: origin } });
      expectStatus(response, 204);
      check(response.headers.getSetCookie().length === 2 && response.headers.getSetCookie().every((cookie) => /; Max-Age=0\b/.test(cookie)), "Logout did not clear both cookies.");
      expectStatus(await read(alice), [401, 403]);
      expectStatus(await write(current, revision), [401, 403]);
      expectStatus(await read(alice, photoRoute), [401, 403]);
      expectStatus(await app("/api/session", { headers: { Cookie: alice.refresh } }), 401);
      await expectNoRows(await readOwnerA());
      expectStatus(await rpc(current, revision, alice.token, writeKey), 403);
      await expectStorageDenied(await api("/storage/v1/object/authenticated/catalogue-media/" + userA.id + "/" + digest + ".jpg", { token: alice.token }));
      expectStatus(await read(bob), 200);
    });

    await step("verified bundle recovery, real media staging and archive reconciliation without activation", async () => {
      const dir = await mkdtemp(join(process.env.RUNNER_TEMP, "catalogue-synthetic-rehearsal-"));
      try {
        const sourcePath = join(dir, "workspace.json");
        const mediaDirectory = join(dir, "source-media");
        const recoveryDirectory = join(dir, "recovery");
        await mkdir(mediaDirectory);
        await mkdir(recoveryDirectory);
        const doc = fixture(photoRoute);
        await writeFile(sourcePath, JSON.stringify(doc, null, 2) + "\n");
        await writeFile(join(mediaDirectory, digest), photo);
        const bundle = await createBundle({
          sourcePath, sourceRevision: "synthetic-rehearsal-1", mediaDirectory,
          backupDirectory: join(dir, "bundles"),
        });
        const recovery = await restoreBundle({
          bundleDirectory: bundle.bundleDirectory, expectedManifestSha256: bundle.manifestSha256,
          destinationDirectory: recoveryDirectory,
        });
        check(recovery.restored && recovery.manifestSha256 === bundle.manifestSha256, "Offline restoration did not verify.");
        const options = {
          bundleDirectory: recovery.bundleDirectory, expectedManifestSha256: recovery.manifestSha256,
          backupDirectory: join(dir, "staging-backups"),
          env: { CATALOGUE_LOCAL_SUPABASE_URL: localOrigin,
            CATALOGUE_SUPABASE_PUBLISHABLE_KEY: settings.publishable,
            CATALOGUE_IMPORT_ACCESS_TOKEN: bob.token },
        };
        const staged = await stageVerifiedBundle(options);
        assert.equal(staged.outcome, "staged");
        assert.equal(staged.differentFields, 0);
        assert.equal(staged.activated, false);
        assert.deepEqual(staged.media, { references: 1, uniquePhotos: 1, uploaded: 1, reused: 0, verified: 1 });
        const again = await stageVerifiedBundle(options);
        assert.equal(again.outcome, "already-staged");
        assert.equal(again.differentFields, 0);
        assert.equal(again.media.reused, 1);
        assert.equal(again.media.uploaded, 0);
        const archivePath = "/rest/v1/catalogue_workspace_imports?source_revision=eq.synthetic-rehearsal-1";
        const archive = await api(archivePath, { token: bob.token });
        expectStatus(archive, 200);
        const rows = await archive.json();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].owner_id, userB.id);
        assert.deepEqual(rows[0].document, doc);
        await expectNoRows(await api(archivePath, { token: third }));
        await expectNoRows(await api(workspacePath, { token: bob.token }));
        const unchanged = await read(bob);
        expectStatus(unchanged, 200);
        assert.equal(unchanged.headers.get("X-Revision"), "new");
        const recoveredPhoto = await read(bob, photoRoute);
        expectStatus(recoveredPhoto, 200);
        assert.deepEqual(Buffer.from(await recoveredPhoto.arrayBuffer()), photo);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    checkpoint = "start Chromium";
    await browserSmoke(origin, userA, userB, current.customers[0].name);
  } finally {
    await worker.dispose();
  }
}

try {
  const mode = process.argv[2];
  if (mode === "prepare-runtime") {
    checkpoint = "prepare immutable disposable database image";
    preparePinnedRuntime(localCommand, (message) => console.log(message));
    console.log("PASS " + checkpoint);
  } else {
    checkpoint = "verify running disposable database image";
    console.log("PASS " + checkpoint + " | " + verifyPinnedRuntime());
    checkpoint = "local stack configuration";
    const settings = localSettings();
    if (mode === "preflight") {
      await runtimePreflight();
      await reconcileFixture();
    } else if (mode === "migrate") await applyMigrations();
    else if (mode === undefined) await integrate(settings);
    else throw new GateFailure("Unknown disposable gate mode.");
  }
} catch (error) {
  // Do not print response bodies, command output, cookies, or error causes.
  const detail = (error instanceof GateFailure || error instanceof RuntimeFailure) ? error.message :
    error instanceof assert.AssertionError ? "Assertion failed at " + error.stack.split("\n")[1]?.trim() :
      "Unexpected " + (error instanceof Error ? error.name : "error") + ".";
  console.error("FAIL " + checkpoint + " — " + detail);
  process.exitCode = 1;
}
