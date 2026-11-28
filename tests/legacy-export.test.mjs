import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareLegacyExport } from "../scripts/prepare-legacy-export.mjs";
import { verifyBundle } from "../scripts/verify-migration-backup.mjs";
import { photo } from "./browser/local-fixture.mjs";

const sha = createHash("sha256").update(photo).digest("hex");
const ref = "/api/photos/" + sha;
const data = "data:image/jpeg;base64," + photo.toString("base64");
const customer = { id: "synthetic-contact", name: "Synthetic buyer", phone: "00000000000",
  collection: "Full catalog", consent: true };
const variant = { id: "synthetic-variant", variant: "Small", unit: "Piece", rate: "8.71",
  history: [{ at: "2026-01-01", rate: "8.30" }], ready: true, overridePhoto: ref };
const legacy = { schema: 2, collections: [], customers: [customer], families: [{
  id: "synthetic-family", name: "Synthetic product", category: "Plastic containers",
  photo: data, collections: [], variants: [variant],
}] };
async function fixture(t, doc) {
  const root = await mkdtemp(join(tmpdir(), "catalogue-legacy-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "original.json");
  const mediaDirectory = join(root, "source-media"), destinationDirectory = join(root, "prepared");
  await mkdir(mediaDirectory); await mkdir(destinationDirectory);
  await writeFile(sourcePath, JSON.stringify(doc, null, 2) + "\n");
  await writeFile(join(mediaDirectory, sha), photo);
  return { sourcePath, sourceRevision: "synthetic-rev", mediaDirectory, destinationDirectory };
}
test("schema 2 exact original and stable fields preserved, inline JPEG materialized and deduplicated", async t => {
  const args = await fixture(t, legacy);
  const original = await readFile(args.sourcePath);
  const prepared = await prepareLegacyExport(args);
  assert.equal(prepared.sourceSchema, 2);
  assert.equal(prepared.inlineReferences, 1);
  assert.equal(prepared.externalReferences, 1);
  assert.equal(prepared.uniquePhotos, 1);
  assert.equal(prepared.activated, false);
  assert.deepEqual(await readFile(join(prepared.output, "original-workspace.json")), original);
  assert.deepEqual(await readFile(args.sourcePath), original);
  const doc = JSON.parse(await readFile(join(prepared.bundleDirectory, "workspace.json"), "utf8"));
  assert.deepEqual(doc.customers, [customer]);
  assert.equal(doc.families[0].id, legacy.families[0].id);
  assert.equal(doc.families[0].photo, ref);
  assert.deepEqual(doc.families[0].variants, [{ ...variant, purchase: "" }]);
  assert.deepEqual(await readFile(join(prepared.bundleDirectory, "media", sha)), photo);
  assert.equal((await verifyBundle({ bundleDirectory: prepared.bundleDirectory,
    expectedManifestSha256: prepared.manifestSha256 })).verified, true);
});
test("flat unversioned legacy fields and IDs survive conversion", async t => {
  const { overridePhoto, ...fields } = variant;
  const product = { ...fields, name: "Synthetic product", category: "Plastic containers", photo: ref };
  const args = await fixture(t, { products: [product], customers: [customer] });
  const result = await prepareLegacyExport(args);
  assert.equal(result.sourceSchema, 1);
  const doc = JSON.parse(await readFile(join(result.bundleDirectory, "workspace.json"), "utf8"));
  assert.equal(doc.families[0].id, product.id);
  assert.equal(doc.families[0].variants[0].id, product.id);
  assert.equal(doc.families[0].variants[0].rate, product.rate);
  assert.deepEqual(doc.families[0].variants[0].history, product.history);
});
test("unknown overwritten legacy fields, corrupt media and overlapping source are rejected", async t => {
  const altered = structuredClone(legacy);
  altered.families[0].variants[0].purchase = "1.00";
  const unsafe = await fixture(t, altered);
  await assert.rejects(prepareLegacyExport(unsafe), /Unexpected legacy purchase/);
  const good = await fixture(t, legacy);
  await assert.rejects(prepareLegacyExport({ ...good, destinationDirectory: good.mediaDirectory }), /Separate/);
  await writeFile(join(good.mediaDirectory, sha), Buffer.from([255,216,0,217]));
  // The cover's matching inline bytes must not hide a corrupt external object.
  await assert.rejects(prepareLegacyExport(good), /JPEG/);
});
