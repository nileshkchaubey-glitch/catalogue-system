import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageWorkspace } from "../scripts/stage-workspace.mjs";

const owner = "10000000-0000-4000-8000-000000000001";
const env = {
  CATALOGUE_LOCAL_SUPABASE_URL: "http://127.0.0.1:54321",
  CATALOGUE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_test",
  CATALOGUE_IMPORT_ACCESS_TOKEN: "synthetic.local.user",
};
const photo = `/api/photos/${"a".repeat(64)}`;
const synthetic = {
  schema: 3,
  departments: { Test: ["Containers"] },
  collections: ["Sample range"],
  customers: [{ id: "sample-customer", name: "Synthetic Buyer", phone: "00000000000", collection: "Sample range", consent: true }],
  families: [{
    id: "sample-family", name: "Sample Tray", category: "Containers", photo,
    gallery: [], collections: ["Sample range"],
    variants: [{
      id: "sample-variant", variant: "Standard", unit: "Pack", purchase: "4.27",
      rate: "8.71", ready: true, overridePhoto: "",
      history: [{ at: "2026-02-15T09:00:00.000Z", rate: "8.30" }],
    }],
  }],
};

async function fixture(context) {
  const dir = await mkdtemp(join(tmpdir(), "catalogue-stage-"));
  const sourcePath = join(dir, "synthetic.json");
  const backupDirectory = join(dir, "backups");
  context.after(async () => {
    if ((await readdir(dir)).includes("backups")) {
      if ((await lstat(backupDirectory)).isDirectory()) {
        for (const file of await readdir(backupDirectory)) await unlink(join(backupDirectory, file));
        await rmdir(backupDirectory);
      } else {
        await unlink(backupDirectory);
      }
    }
    await unlink(sourcePath);
    await rmdir(dir);
  });
  await writeFile(sourcePath, JSON.stringify(synthetic, null, 2) + "\n");
  return { sourcePath, sourceRevision: "synthetic-etag-1", backupDirectory, env };
}

function mockSupabase({ stored, verifyWrite, anonymous = false, missingProfile = false,
  racingInsert = false } = {}) {
  let row = stored;
  const calls = [];
  return {
    calls,
    async fetcher(url, options) {
      const { pathname, searchParams } = url;
      assert.equal(url.origin, env.CATALOGUE_LOCAL_SUPABASE_URL);
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.apikey, env.CATALOGUE_SUPABASE_PUBLISHABLE_KEY);
      assert.equal(options.headers.Authorization, `Bearer ${env.CATALOGUE_IMPORT_ACCESS_TOKEN}`);
      calls.push({ method: options.method ?? "GET", pathname });
      if (pathname === "/auth/v1/user") {
        return Response.json({ id: owner, role: "authenticated", is_anonymous: anonymous });
      }
      if (pathname === "/rest/v1/business_profiles") {
        assert.equal(searchParams.get("owner_id"), `eq.${owner}`);
        return Response.json(missingProfile ? [] : [{ owner_id: owner }]);
      }
      assert.equal(pathname, "/rest/v1/catalogue_workspace_imports");
      if (options.method === "POST") {
        assert.equal(row, undefined);
        row = JSON.parse(options.body);
        await verifyWrite?.(row);
        // JSONB does not preserve object key order. Array order and values do survive.
        row.document = Object.fromEntries(Object.entries(row.document).reverse());
        return new Response(null, { status: racingInsert ? 409 : 201 });
      }
      assert.equal(searchParams.get("owner_id"), `eq.${owner}`);
      assert.equal(searchParams.get("source_revision"), "eq.synthetic-etag-1");
      return Response.json(row ? [row] : []);
    },
  };
}

test("staging keeps stable IDs and all fields, verifies backup before insert and is idempotent", async (context) => {
  const options = await fixture(context);
  const mock = mockSupabase({ async verifyWrite(row) {
    const [backup] = await readdir(options.backupDirectory);
    assert.deepEqual(await readFile(join(options.backupDirectory, backup)), await readFile(options.sourcePath));
    assert.equal(row.owner_id, owner);
    assert.equal(row.source_revision, options.sourceRevision);
    assert.deepEqual(row.document, synthetic);
  } });
  const result = await stageWorkspace({ ...options, ...mock });
  assert.equal(result.outcome, "staged");
  assert.equal(result.differentFields, 0);
  assert.deepEqual(result.sourceCounts, result.stagedCounts);
  assert.deepEqual(result.sourceCounts, {
    departments: 1, categories: 1, collections: 1, collectionMemberships: 1,
    families: 1, variants: 1, customers: 1, rateHistoryEntries: 1,
    mediaReferences: 1, uniqueMediaReferences: 1, quoteDrafts: 0, quoteSnapshots: 0,
  });
  assert.match(result.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(await readFile(result.backupPath), await readFile(options.sourcePath));
  const second = await stageWorkspace({ ...options, ...mock });
  assert.equal(second.outcome, "already-staged");
  assert.equal(mock.calls.filter((call) => call.method === "POST").length, 1);
});

test("staging reconciles a simultaneous matching insert without overwriting it", async (context) => {
  const options = await fixture(context);
  const mock = mockSupabase({ racingInsert: true });
  const result = await stageWorkspace({ ...options, ...mock });
  assert.equal(result.outcome, "already-staged");
  assert.equal(result.differentFields, 0);
  assert.equal(mock.calls.filter((call) => call.method === "POST").length, 1);
});

test("changed fields in an existing staging revision are detected even at matching counts", async (context) => {
  const options = await fixture(context);
  const document = structuredClone(synthetic);
  document.families[0].variants[0].purchase = "5.09";
  const vaultKey = "Non-schema synthetic private field key";
  document[vaultKey] = "Synthetic extended field";
  await writeFile(options.sourcePath, JSON.stringify({ ...synthetic, [vaultKey]: "Original synthetic extended field" }));
  const mock = mockSupabase({ stored: { owner_id: owner, source_revision: options.sourceRevision, document } });
  await assert.rejects(stageWorkspace({ ...options, ...mock }), (problem) => {
    assert.match(problem.message, /2 field differences/);
    assert.deepEqual(problem.reconciliation.sourceCounts, problem.reconciliation.stagedCounts);
    assert.deepEqual(problem.reconciliation.differencePaths, ["workspace.families[0].variants[0].purchase", "workspace[field 5]"]);
    assert.doesNotMatch(JSON.stringify(problem.reconciliation), /Non-schema synthetic private field key/);
    return true;
  });
  assert.equal(mock.calls.some((call) => call.method === "POST"), false);
});

test("staging rejects nonlocal URLs, service keys, anonymous sessions and unprovisioned users", async (context) => {
  const options = await fixture(context);
  const mock = mockSupabase();
  await assert.rejects(stageWorkspace({ ...options, ...mock,
    env: { ...env, CATALOGUE_LOCAL_SUPABASE_URL: "https://nonlocal.example.test" },
  }), /numeric loopback/);
  await assert.rejects(stageWorkspace({ ...options, ...mock,
    env: { ...env, CATALOGUE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_synthetic_test" },
  }), /publishable key/);
  await assert.rejects(stageWorkspace({ ...options, ...mock, sourceRevision: "--dry-run" }), /source-revision/);
  assert.equal(mock.calls.length, 0);
  for (const fixtureOptions of [{ anonymous: true }, { missingProfile: true }]) {
    const denied = mockSupabase(fixtureOptions);
    await assert.rejects(stageWorkspace({ ...options, ...denied }), /authentication failed|Provision exactly one/);
    assert.equal(denied.calls.some((call) => call.pathname.endsWith("catalogue_workspace_imports")), false);
  }
  await assert.rejects(readdir(options.backupDirectory), { code: "ENOENT" });
});

test("a backup failure prevents staging writes", async (context) => {
  const options = await fixture(context);
  await writeFile(options.backupDirectory, "synthetic file blocks backup directory creation");
  const mock = mockSupabase();
  await assert.rejects(stageWorkspace({ ...options, ...mock }));
  assert.equal(mock.calls.some((call) => call.method === "POST"), false);
});
