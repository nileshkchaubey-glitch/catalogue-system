import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBundle } from "../scripts/verify-migration-backup.mjs";
import { stageVerifiedBundle } from "../scripts/stage-workspace.mjs";
import { photo } from "./browser/local-fixture.mjs";

const owner = "10000000-0000-4000-8000-000000000001";
const digest = createHash("sha256").update(photo).digest("hex");
const reference = "/api/photos/" + digest;
const source = {
  schema: 3, departments: { Samples: ["Containers"] }, collections: [], customers: [],
  families: [{
    id: "synthetic-family", name: "Synthetic tray", category: "Containers",
    photo: reference, gallery: [reference], collections: [],
    variants: [{ id: "synthetic-variant", variant: "Pack", unit: "Pack", purchase: "4.20",
      rate: "8.70", ready: true, history: [], overridePhoto: reference }],
  }],
  quoteDrafts: [], quoteSnapshots: [],
};
const env = {
  CATALOGUE_LOCAL_SUPABASE_URL: "http://127.0.0.1:54321",
  CATALOGUE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_test",
  CATALOGUE_IMPORT_ACCESS_TOKEN: "synthetic.local.user",
};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "catalogue-verified-stage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, "source.json");
  const mediaDirectory = join(dir, "media");
  await mkdir(mediaDirectory);
  await writeFile(sourcePath, JSON.stringify(source, null, 2) + "\n");
  await writeFile(join(mediaDirectory, digest), photo);
  const bundle = await createBundle({
    sourcePath, sourceRevision: "synthetic-source-1", mediaDirectory,
    backupDirectory: join(dir, "bundles"),
  });
  return {
    bundleDirectory: bundle.bundleDirectory, expectedManifestSha256: bundle.manifestSha256,
    backupDirectory: join(dir, "workspace-backups"), env,
  };
}

function fake({ existing, existingRow, denyRead = false, corruptUpload = false, race = false, unprovisioned = false } = {}) {
  let media = existing;
  let row = existingRow;
  const calls = [];
  const readPath = "/storage/v1/object/authenticated/catalogue-media/" + owner + "/" + digest + ".jpg";
  const writePath = "/storage/v1/object/catalogue-media/" + owner + "/" + digest + ".jpg";
  return { calls, async fetcher(url, options) {
    const method = options.method ?? "GET";
    const path = url.pathname;
    calls.push([method, path]);
    assert.equal(url.origin, env.CATALOGUE_LOCAL_SUPABASE_URL);
    assert.equal(options.headers.apikey, env.CATALOGUE_SUPABASE_PUBLISHABLE_KEY);
    assert.equal(options.headers.Authorization, "Bearer " + env.CATALOGUE_IMPORT_ACCESS_TOKEN);
    assert.equal(options.redirect, "error");
    if (path === "/auth/v1/user") return Response.json({ id: owner, role: "authenticated", is_anonymous: false });
    if (path === "/rest/v1/business_profiles") return Response.json(unprovisioned ? [] : [{ owner_id: owner }]);
    if (path === readPath && method === "GET") {
      if (denyRead) return Response.json({ statusCode: "403" }, { status: 400 });
      return media ? new Response(media, { headers: { "Content-Type": "image/jpeg" } })
        : Response.json({ statusCode: "404" }, { status: 400 });
    }
    if (path === writePath && method === "POST") {
      assert.equal(options.headers["x-upsert"], "false");
      assert.equal(options.headers["Content-Type"], "image/jpeg");
      assert.deepEqual(options.body, photo);
      assert.equal(media, undefined);
      media = corruptUpload ? Buffer.from([255,216,0,217]) : Buffer.from(options.body);
      return new Response(null, { status: race ? 409 : 200 });
    }
    assert.equal(path, "/rest/v1/catalogue_workspace_imports");
    if (method === "POST") {
      assert.deepEqual(media, photo, "media must be reconciled before archive insert");
      assert.equal(row, undefined);
      row = JSON.parse(options.body);
      assert.equal(row.owner_id, owner);
      assert.equal(row.source_revision, "synthetic-source-1");
      assert.deepEqual(row.document, source);
      return new Response(null, { status: 201 });
    }
    return Response.json(row ? [row] : []);
  } };
}

test("verified bundle stages exact fields and deduplicated media without activating a workspace", async t => {
  const options = await fixture(t);
  const api = fake();
  const result = await stageVerifiedBundle({ ...options, ...api });
  assert.equal(result.differentFields, 0);
  assert.equal(result.activated, false);
  assert.deepEqual(result.media, { references: 3, uniquePhotos: 1, uploaded: 1, reused: 0, verified: 1 });
  assert.deepEqual(await readFile(result.backupPath), await readFile(join(options.bundleDirectory, "workspace.json")));
  const again = await stageVerifiedBundle({ ...options, ...api });
  assert.equal(again.outcome, "already-staged");
  assert.equal(again.media.reused, 1);
  assert.equal(again.media.uploaded, 0);
  assert.equal(api.calls.filter(([method]) => method === "POST").length, 2);
});

test("verified bundle accepts a racing upload only after exact byte readback", async t => {
  const options = await fixture(t);
  const api = fake({ race: true });
  const result = await stageVerifiedBundle({ ...options, ...api });
  assert.deepEqual(result.media, { references: 3, uniquePhotos: 1, uploaded: 0, reused: 1, verified: 1 });
});

test("a corrupt existing or newly uploaded object and denied reads stop archive writes", async t => {
  const options = await fixture(t);
  for (const flags of [{ existing: Buffer.from([255,216,0,217]) }, { corruptUpload: true }, { denyRead: true }]) {
    const api = fake(flags);
    await assert.rejects(stageVerifiedBundle({ ...options, ...api }), /Local media/);
    assert.equal(api.calls.some(([method, path]) => method === "POST" && path.endsWith("catalogue_workspace_imports")), false);
  }
});

test("untrusted bundle, hosted origin, missing owner and conflicting archive are rejected before writes", async t => {
  const options = await fixture(t);
  const api = fake();
  await assert.rejects(stageVerifiedBundle({ ...options, ...api, expectedManifestSha256: "0".repeat(64) }), /Manifest digest/);
  await assert.rejects(stageVerifiedBundle({ ...options, ...api, env: { ...env, CATALOGUE_LOCAL_SUPABASE_URL: "https://example.invalid" } }), /numeric loopback/);
  assert.deepEqual(api.calls, []);
  const denied = fake({ unprovisioned: true });
  await assert.rejects(stageVerifiedBundle({ ...options, ...denied }), /Provision exactly one/);
  assert.equal(denied.calls.some(([method]) => method === "POST"), false);
  const conflict = fake({ existingRow: { owner_id: owner, source_revision: "synthetic-source-1",
    document: { ...source, collections: ["Different"] } } });
  await assert.rejects(stageVerifiedBundle({ ...options, ...conflict }), /Existing archive revision differs/);
  assert.equal(conflict.calls.some(([method]) => method === "POST"), false);
});
