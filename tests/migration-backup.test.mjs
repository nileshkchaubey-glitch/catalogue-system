import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBundle, verifyBundle } from "../scripts/verify-migration-backup.mjs";

const jpeg = Buffer.from([255, 216, 255, 217]);
const hash = createHash("sha256").update(jpeg).digest("hex");
const reference = "/api/photos/" + hash;
const workspace = {
  schema: 3, departments: { Test: ["Containers"] }, collections: ["Sample range"], customers: [],
  families: [{
    id: "synthetic-family", name: "Synthetic Tray", category: "Containers",
    photo: reference, gallery: [reference], collections: ["Sample range"],
    variants: [{
      id: "synthetic-variant", variant: "Standard", unit: "Pack", purchase: "4.27",
      rate: "8.71", ready: true, overridePhoto: reference, history: [],
    }],
  }],
};

async function fixture(context) {
  const dir = await mkdtemp(join(tmpdir(), "catalogue-backup-test-"));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const sourcePath = join(dir, "source.json");
  const mediaDirectory = join(dir, "media");
  await mkdir(mediaDirectory);
  await writeFile(sourcePath, JSON.stringify(workspace, null, 2) + "\n");
  await writeFile(join(mediaDirectory, hash), jpeg);
  return { sourcePath, sourceRevision: "synthetic-revision-1", mediaDirectory, backupDirectory: join(dir, "backups") };
}

const options = (result) => ({ bundleDirectory: result.bundleDirectory, expectedManifestSha256: result.manifestSha256 });

test("backup preserves exact workspace bytes and deduplicates all three photo reference types", async (context) => {
  const input = await fixture(context);
  const result = await createBundle(input);
  assert.equal(result.verified, true);
  assert.equal(result.mediaReferences, 3);
  assert.equal(result.uniquePhotos, 1);
  assert.deepEqual(await readFile(join(result.bundleDirectory, "workspace.json")), await readFile(input.sourcePath));
  assert.deepEqual(await readFile(join(result.bundleDirectory, "media", hash)), jpeg);
  assert.equal((await verifyBundle(options(result))).verified, true);
  const repeat = await createBundle(input);
  assert.notEqual(result.bundleDirectory, repeat.bundleDirectory);
  assert.equal(result.manifestSha256, repeat.manifestSha256);
});

test("missing, corrupt, and inline media fail closed before a backup can verify", async (context) => {
  const input = await fixture(context);
  await rm(join(input.mediaDirectory, hash));
  await assert.rejects(createBundle(input));
  await writeFile(join(input.mediaDirectory, hash), Buffer.from([255, 216, 1, 217]));
  await assert.rejects(createBundle(input), /digest/);
  const inline = structuredClone(workspace);
  inline.families[0].photo = "data:image/jpeg;base64,/9j/2Q==";
  await writeFile(input.sourcePath, JSON.stringify(inline));
  await assert.rejects(createBundle(input), /inline photos/);
});

test("backup verification detects changed media, workspace and untrusted manifest", async (context) => {
  const input = await fixture(context);
  const result = await createBundle(input);
  const args = options(result);
  const media = join(result.bundleDirectory, "media", hash);
  await writeFile(media, Buffer.from([255, 216, 1, 217]));
  await assert.rejects(verifyBundle(args), /digest/);
  await writeFile(media, jpeg);
  const source = join(result.bundleDirectory, "workspace.json");
  const original = await readFile(source);
  await writeFile(source, Buffer.concat([original, Buffer.from(" ")]));
  await assert.rejects(verifyBundle(args), /Workspace byte count or digest/);
  await writeFile(source, original);
  await assert.rejects(verifyBundle({ ...args, expectedManifestSha256: "0".repeat(64) }), /Manifest digest/);
  await writeFile(join(result.bundleDirectory, "media", "unexpected"), jpeg);
  await assert.rejects(verifyBundle(args), /unexpected media/);
});
