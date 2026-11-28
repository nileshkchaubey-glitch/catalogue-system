import assert from "node:assert/strict";
import test from "node:test";
import { handleProtectedAPI } from "../server/gateway.mjs";
import { buildQuoteSnapshot } from "../shared/quote-pricing.mjs";

const origin = "https://catalogue.example.invalid";
const env = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_gateway",
  CATALOGUE_WORKSPACE_WRITE_KEY: "ab".repeat(32),
};
const ownerId = "a0000000-0000-4000-8000-000000000001";
const otherOwnerId = "a0000000-0000-4000-8000-000000000002";
const otherProfileId = "b0000000-0000-4000-8000-000000000002";
const profile = {
  id: "b0000000-0000-4000-8000-000000000001", owner_id: ownerId,
  business_name: "Synthetic catalogue", currency: "INR",
};
const user = { id: ownerId, role: "authenticated", is_anonymous: false };
const sessionCookie = "catalogue_access=synthetic-access; catalogue_refresh=synthetic-refresh";
const revision = "c0000000-0000-4000-8000-000000000001";
const nextRevision = "c0000000-0000-4000-8000-000000000002";
const digest = "a".repeat(64);
const photoRoute = `/api/photos/${digest}`;
const photoPath = `/storage/v1/object/authenticated/catalogue-media/${ownerId}/${digest}.jpg`;
const userPath = "/auth/v1/user";
const profilesPath = "/rest/v1/business_profiles";
const workspacePath = "/rest/v1/catalogue_workspaces";
const savePath = "/rest/v1/rpc/save_catalogue_workspace";
const writeKeyHeader = "X-Catalogue-Workspace-Write-Key";
const authPaths = [userPath, profilesPath];

function workspaceFixture() {
  return {
    schema: 3,
    departments: { Sample: ["Synthetic category"] },
    collections: [],
    families: [{
      id: "family-one", name: "Synthetic product", category: "Synthetic category",
      photo: photoRoute, gallery: [], collections: [],
      variants: [{
        id: "variant-one", variant: "Single", unit: "Box", ready: true,
        overridePhoto: "", rate: "8.00", purchase: "5.00", history: [],
      }],
    }],
    customers: [{
      id: "customer-one", name: "Synthetic buyer", phone: "0000000100",
      collection: "Full catalog", consent: true,
    }],
    quoteDrafts: [{
      id: "draft-one", customerId: "customer-one",
      lines: [{ variantId: "variant-one", quantity: "3", rateOverride: "" }],
    }],
  };
}

function gateway(upstream, bindings = env) {
  const calls = [];
  const fetchUpstream = (input, options) => {
    const url = new URL(input);
    const call = {
      origin: url.origin, path: url.pathname, query: url.searchParams,
      method: options.method ?? "GET", headers: options.headers,
      body: options.body, cache: options.cache, redirect: options.redirect,
    };
    calls.push(call);
    return upstream(call);
  };
  const request = (path, { cookie = sessionCookie, headers = {}, ...options } = {}) => {
    const requestHeaders = new Headers(headers);
    if (cookie) requestHeaders.set("Cookie", cookie);
    return handleProtectedAPI(
      new Request(origin + path, { ...options, headers: requestHeaders }),
      bindings,
      fetchUpstream,
    );
  };
  return {
    calls,
    request,
    save(document, expectedRevision = revision, headers = {}) {
      return request("/api/workspace", {
        method: "PUT",
        headers: {
          Origin: origin, "Content-Type": "application/json", "X-Owner-Profile": profile.id,
          "X-Revision": expectedRevision, ...headers,
        },
        body: JSON.stringify(document),
      });
    },
  };
}

function ownerGateway(backend, { account = user, profiles = [profile], bindings } = {}) {
  return gateway((call) => {
    if (call.path === userPath) return Response.json(account);
    if (call.path === profilesPath) return Response.json(profiles);
    return backend(call);
  }, bindings);
}

function assertPrivate(response, status, label) {
  assert.equal(response.status, status, label);
  assert.equal(response.headers.get("Cache-Control"), "no-store", label);
}

function assertCookiesCleared(response) {
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.deepEqual(cookies.map((cookie) => cookie.split(";", 1)[0]).sort(), ["catalogue_access=", "catalogue_refresh="]);
  for (const cookie of cookies) assert.match(cookie, /; Max-Age=0$/);
}

test("Gateway rejects missing credentials, cross-origin saves, and unsafe upstream configuration", async () => {
  const app = ownerGateway(() => Response.json({ private: "unexpected response" }));
  for (const path of ["/api/workspace", "/api/buyer", photoRoute]) {
    const response = await app.request(path, {
      cookie: "", headers: { Authorization: "Bearer synthetic-access" },
    });
    assertPrivate(response, 401);
  }
  assertPrivate(await app.save(workspaceFixture(), revision, { Origin: "https://other.example.invalid" }), 403);
  assert.deepEqual(app.calls, []);

  for (const bindings of [
    { ...env, SUPABASE_URL: "https://other.example.invalid" },
    { ...env, SUPABASE_URL: "http://127.0.0.1:54321/extra" },
    { ...env, SUPABASE_PUBLISHABLE_KEY: "sb_secret_synthetic_placeholder" },
  ]) {
    const misconfigured = ownerGateway(() => Response.json({ private: "unexpected response" }), { bindings });
    assertPrivate(await misconfigured.request("/api/workspace"), 503);
    assert.deepEqual(misconfigured.calls, []);
  }

  for (const key of [undefined, "invalid-key"]) {
    const misconfigured = ownerGateway(() => Response.json({ private: "unexpected response" }), {
      bindings: { ...env, CATALOGUE_WORKSPACE_WRITE_KEY: key },
    });
    const response = await misconfigured.save(workspaceFixture(), revision, {
      [writeKeyHeader]: env.CATALOGUE_WORKSPACE_WRITE_KEY,
    });
    assertPrivate(response, 503);
    assert.deepEqual(misconfigured.calls.map(({ path }) => path), authPaths);
  }
});

test("Hosted binding permits only the independently approved canonical HTTPS project", async () => {
  const approved = "https://abcdefghijklmnopqrst.supabase.co";
  const bindings = { ...env, SUPABASE_URL: approved, CATALOGUE_APPROVED_SUPABASE_ORIGIN: approved };
  const app = ownerGateway(() => Response.json([]), { bindings });
  assertPrivate(await app.request("/api/workspace"), 200);
  assert.ok(app.calls.length > 0);
  for (const call of app.calls) {
    assert.equal(call.origin, approved);
    assert.equal(call.redirect, "manual");
  }
  for (const invalid of [
    { ...bindings, CATALOGUE_APPROVED_SUPABASE_ORIGIN: undefined },
    { ...bindings, CATALOGUE_APPROVED_SUPABASE_ORIGIN: "" },
    { ...bindings, SUPABASE_URL: "http://abcdefghijklmnopqrst.supabase.co" },
    { ...bindings, SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co:444" },
    { ...bindings, SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co.evil.invalid" },
    { ...bindings, SUPABASE_URL: "https://zyxwvutsrqponmlkjihg.supabase.co" },
    { ...bindings, SUPABASE_URL: "http://127.0.0.1:54321" },
    { ...bindings, SUPABASE_URL: approved + "/extra" },
    { ...bindings, CATALOGUE_APPROVED_SUPABASE_ORIGIN: approved + "/" },
  ]) {
    const denied = ownerGateway(() => Response.json([]), { bindings: invalid });
    assertPrivate(await denied.request("/api/workspace"), 503);
    assert.deepEqual(denied.calls, []);
  }
  const redirect = gateway(() => Response.redirect("https://other.example.invalid", 307), bindings);
  assertPrivate(await redirect.request("/api/workspace"), 503);
  assert.equal(redirect.calls.length, 1);
  assert.equal(redirect.calls[0].origin, approved);
});

test("Gateway denies private routes when session or owner provisioning is no longer valid", async () => {
  const app = ownerGateway(() => Response.json({ private: "unexpected response" }), { profiles: [] });
  for (const path of ["/api/workspace", "/api/buyer", photoRoute]) {
    assertPrivate(await app.request(path), 403);
  }
  assertPrivate(await app.save(workspaceFixture()), 403);
  assertPrivate(await app.request("/api/photos", {
    method: "POST", headers: { Origin: origin, "Content-Type": "image/jpeg", "X-Owner-Profile": profile.id },
    body: Uint8Array.of(255, 216, 255, 217),
  }), 403);
  const denied = await app.request("/api/session");
  assertPrivate(denied, 403);
  assertCookiesCleared(denied);
  assert.deepEqual(app.calls.map(({ path }) => path), Array.from({ length: 6 }, () => authPaths).flat());

  const revoked = gateway(() => Response.json({ reason: "Synthetic expired session" }, { status: 401 }));
  assertPrivate(await revoked.request("/api/workspace"), 401);
  const expired = await revoked.request("/api/session");
  assertPrivate(expired, 401);
  assert.deepEqual(revoked.calls.map(({ method, path }) => [method, path]), [
    ["GET", userPath], ["GET", userPath], ["POST", "/auth/v1/token"],
  ]);
  assert.equal(revoked.calls.at(-1).query.get("grant_type"), "refresh_token");
  assertCookiesCleared(expired);
});

test("Gateway revokes a refreshed session at logout and surfaces an upstream failure", async () => {
  const logoutPath = "/auth/v1/logout";
  const tokenPath = "/auth/v1/token";
  for (const upstreamStatus of [204, 503]) {
    const app = gateway(({ path, headers }) => {
      if (path === tokenPath) return Response.json({
        access_token: "renewed-synthetic-access", refresh_token: "renewed-synthetic-refresh", expires_in: 3600,
      });
      if (headers.get("Authorization") === "Bearer synthetic-access") return new Response(null, { status: 401 });
      return new Response(null, { status: upstreamStatus });
    });
    const response = await app.request("/api/session", { method: "DELETE", headers: { Origin: origin } });
    assertPrivate(response, upstreamStatus);
    assertCookiesCleared(response);
    assert.deepEqual(app.calls.map(({ method, path, headers }) => [method, path, headers.get("Authorization")]), [
      ["POST", logoutPath, "Bearer synthetic-access"],
      ["POST", tokenPath, null],
      ["POST", logoutPath, "Bearer renewed-synthetic-access"],
    ]);
    assert.equal(app.calls[0].query.get("scope"), "local");
    assert.equal(app.calls[1].query.get("grant_type"), "refresh_token");
    assert.deepEqual(JSON.parse(app.calls[1].body), { refresh_token: "synthetic-refresh" });
    assert.equal(app.calls[2].query.get("scope"), "local");
  }
});

test("Gateway checks owner provisioning and profile pins before accessing workspace or media", async () => {
  for (const deniedIdentity of [
    { account: { ...user, is_anonymous: true } },
    { profiles: [{ ...profile, owner_id: otherOwnerId }] },
    { profiles: [profile, profile] },
  ]) {
    const app = ownerGateway(() => Response.json({ private: "unexpected response" }), deniedIdentity);
    assertPrivate(await app.request("/api/workspace"), 403);
    assert.deepEqual(app.calls.map(({ path }) => path), deniedIdentity.account ? [userPath] : authPaths);
  }

  const app = ownerGateway(() => Response.json({ private: "unexpected response" }));
  for (const profileHeaders of [{}, { "X-Owner-Profile": otherProfileId }]) {
    for (const [path, method, body, extraHeaders] of [
      ["/api/workspace", "PUT", JSON.stringify(workspaceFixture()), { "Content-Type": "application/json", "X-Revision": revision }],
      ["/api/photos", "POST", Uint8Array.of(255, 216, 255, 217), { "Content-Type": "image/jpeg" }],
    ]) {
      const response = await app.request(path, {
        method, body, headers: { Origin: origin, ...extraHeaders, ...profileHeaders },
      });
      assertPrivate(response, 403);
    }
  }
  assert.deepEqual(app.calls.map(({ path }) => path), Array.from({ length: 4 }, () => authPaths).flat());
});

test("Gateway scopes workspace, buyer, and media reads to the authenticated owner", async () => {
  const document = workspaceFixture();
  const jpeg = Uint8Array.of(255, 216, 255, 217);
  const app = ownerGateway(({ path }) => {
    if (path === workspacePath) return Response.json([{ owner_id: ownerId, revision, document }]);
    if (path === photoPath) return new Response(jpeg, { headers: { "Content-Type": "image/jpeg" } });
    return new Response(null, { status: 404 });
  });
  const selector = `?owner_id=${otherOwnerId}`;
  const workspace = await app.request("/api/workspace" + selector);
  assertPrivate(workspace, 200);
  assert.equal(workspace.headers.get("X-Revision"), revision);
  assert.deepEqual(await workspace.json(), document);

  const buyer = await app.request("/api/buyer" + selector);
  assertPrivate(buyer, 200);
  assert.deepEqual(await buyer.json(), { products: [{
    id: "variant-one", familyId: "family-one", name: "Synthetic product", category: "Synthetic category",
    variant: "Single", unit: "Box", photo: photoRoute, gallery: [],
  }] });

  const photo = await app.request(photoRoute + selector);
  assertPrivate(photo, 200);
  assert.equal(photo.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(new Uint8Array(await photo.arrayBuffer()), jpeg);
  assert.deepEqual(app.calls.map(({ path }) => path), [
    userPath, profilesPath, workspacePath, userPath, profilesPath, workspacePath, userPath, profilesPath, photoPath,
  ]);
  for (const call of app.calls) {
    assert.equal(call.origin, env.SUPABASE_URL);
    assert.equal(call.method, "GET");
    assert.equal(call.cache, "no-store");
    assert.equal(call.redirect, "manual");
    assert.equal(call.headers.get("apikey"), env.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(call.headers.get("Authorization"), "Bearer synthetic-access");
    assert.equal(call.headers.has(writeKeyHeader), false);
    if ([profilesPath, workspacePath].includes(call.path)) assert.equal(call.query.get("owner_id"), `eq.${ownerId}`);
    if (call.path === workspacePath) assert.ok(call.query.get("select").split(",").includes("owner_id"));
  }
});

test("Gateway rejects a workspace response whose owner, revision, or shape cannot be verified", async () => {
  const document = workspaceFixture();
  for (const rows of [
    { length: 0 },
    [{ owner_id: otherOwnerId, revision, document }],
    [{ revision, document }],
    [{ owner_id: ownerId, revision: "unexpected-revision", document }],
    [{ owner_id: ownerId, revision, document: { ...document, quoteDrafts: [null] } }],
  ]) {
    const app = ownerGateway(() => Response.json(rows));
    const response = await app.request("/api/workspace");
    assertPrivate(response, 503);
    assert.equal(response.headers.has("X-Revision"), false);
    assert.deepEqual(Object.keys(await response.json()), ["error"]);
    assert.deepEqual(app.calls.map(({ path }) => path), [userPath, profilesPath, workspacePath]);
  }
});

test("Gateway saves via owner-scoped RPC, checks its receipt, and rejects stale revisions", async () => {
  const document = workspaceFixture();
  const updated = { ...document, collections: ["Synthetic collection"] };
  for (const [label, savedRow, requestRevision, receipt, expectedStatus, shouldWrite] of [
    ["missing revision", true, "", nextRevision, 428, false],
    ["stale revision", true, nextRevision, nextRevision, 409, false],
    ["concurrent save", true, revision, null, 409, true],
    ["upstream redirect", true, revision, Response.redirect("https://unrelated.example.invalid", 307), 503, true],
    ["unverified receipt", true, revision, { revision: nextRevision }, 503, true],
    ["unchanged revision receipt", true, revision, revision, 503, true],
    ["existing row", true, revision, nextRevision, 200, true],
    ["first save", false, "new", nextRevision, 200, true],
  ]) {
    const app = ownerGateway(({ path }) => {
      if (path === workspacePath) return Response.json(savedRow ? [{ owner_id: ownerId, revision, document }] : []);
      if (path === savePath) return receipt instanceof Response ? receipt : Response.json(receipt);
      return new Response(null, { status: 404 });
    });
    const response = await app.save(updated, requestRevision, { [writeKeyHeader]: "synthetic-client-value" });
    assertPrivate(response, expectedStatus, label);
    const result = await response.json();
    if (expectedStatus === 200) assert.deepEqual(result, { revision: nextRevision, workspace: updated });
    else assert.deepEqual(Object.keys(result), ["error"]);
    assert.equal(JSON.stringify(result).includes(env.CATALOGUE_WORKSPACE_WRITE_KEY), false, label);
    const expectedCalls = [["GET", userPath], ["GET", profilesPath]];
    if (requestRevision) expectedCalls.push(["GET", workspacePath]);
    if (shouldWrite) expectedCalls.push(["POST", savePath]);
    assert.deepEqual(app.calls.map(({ method, path }) => [method, path]), expectedCalls, label);
    for (const call of app.calls) {
      assert.equal(call.headers.get(writeKeyHeader), call.path === savePath ? env.CATALOGUE_WORKSPACE_WRITE_KEY : null);
      assert.equal(call.headers.get("Authorization"), "Bearer synthetic-access");
    }
    if (shouldWrite) assert.deepEqual(JSON.parse(app.calls.at(-1).body), {
      expected_revision: savedRow ? revision : null,
      workspace_document: updated,
    });
  }
});

test("Gateway prevents invalid drafts, altered quotations, and edits during confirmation from reaching the write RPC", async () => {
  const document = workspaceFixture();
  const snapshot = buildQuoteSnapshot(document, document.quoteDrafts[0], "2026-11-27T00:00:00.000Z");
  const confirmation = { ...document, quoteDrafts: [], quoteSnapshots: [snapshot] };
  const invalidDraft = structuredClone(document);
  invalidDraft.quoteDrafts[0].lines[0].quantity = "0";
  const adjusted = structuredClone(confirmation);
  adjusted.quoteSnapshots[0].lines[0].rate = "7.00";
  adjusted.quoteSnapshots[0].lines[0].subtotal = "21.00";
  adjusted.quoteSnapshots[0].total = "21.00";
  const withoutConsent = structuredClone(confirmation);
  withoutConsent.customers[0].consent = false;
  const editedWhileConfirming = structuredClone(confirmation);
  editedWhileConfirming.families[0].gallery.push("data:image/jpeg;base64,/9j/2Q==");

  for (const [label, previous, incoming] of [
    ["invalid draft", document, invalidDraft],
    ["inconsistent with saved draft", document, adjusted],
    ["withdrawn consent", document, withoutConsent],
    ["unrelated workspace edit", document, editedWhileConfirming],
    ["removed saved snapshot", confirmation, document],
  ]) {
    const app = ownerGateway(() => Response.json([{ owner_id: ownerId, revision, document: previous }]));
    const response = await app.save(incoming);
    assertPrivate(response, 422, label);
    const paths = incoming === invalidDraft ? authPaths : [...authPaths, workspacePath];
    assert.deepEqual(app.calls.map(({ method, path }) => [method, path]), paths.map((path) => ["GET", path]), label);
  }
});
