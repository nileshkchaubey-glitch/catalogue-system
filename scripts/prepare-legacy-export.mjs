import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { join, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { upgrade, valid } from "../server/worker.mjs";
import { createBundle } from "./verify-migration-backup.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jpegLimit = 5 * 1024 * 1024;
const jsonLimit = 12 * 1024 * 1024;
const reference = /^\/api\/photos\/([a-f0-9]{64})$/;
const inline = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;
const repo = fileURLToPath(new URL("../", import.meta.url));
function check(condition, message) {
  if (!condition) throw Error(message);
}
function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep));
}
async function directory(path) {
  const info = await lstat(path);
  check(info.isDirectory() && !info.isSymbolicLink(), "Expected a regular private directory.");
  return realpath(path);
}
async function readRegular(path, limit) {
  const info = await lstat(path);
  check(info.isFile() && !info.isSymbolicLink() && info.size <= limit, "Invalid source file or size.");
  const bytes = await readFile(path);
  check(bytes.length === info.size && bytes.length <= limit, "Source file changed.");
  return bytes;
}
async function saveNew(path, bytes) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  check((await readRegular(path, Math.max(bytes.length, 1))).equals(bytes), "Private copy verification failed.");
}
function assertKnownKeys(object, allowed) {
  check(object && typeof object === "object" && !Array.isArray(object) &&
    Object.keys(object).every(key => allowed.includes(key)), "Unknown legacy fields require manual review.");
}
function convert(raw) {
  check(raw && typeof raw === "object" && !Array.isArray(raw), "Invalid source workspace.");
  const schema = raw.schema ?? 1;
  if (schema === 1) {
    // The old upgrader accepts unversioned flat records only. Never discard
    // additional source fields by passing them through its fixed projection.
    check(raw.schema == null && Array.isArray(raw.products) && Array.isArray(raw.customers), "Unsupported legacy format.");
    assertKnownKeys(raw, ["schema", "products", "customers"]);
    for (const product of raw.products)
      assertKnownKeys(product, ["id","name","category","photo","variant","unit","rate","history","ready"]);
  } else if (schema === 2) {
    check(Array.isArray(raw.families), "Invalid schema 2 families.");
    check(!Object.hasOwn(raw, "departments"), "Unexpected legacy departments; review required.");
    for (const family of raw.families) {
      check(family && !Object.hasOwn(family, "gallery") && Array.isArray(family.variants), "Unexpected legacy gallery or variants.");
      for (const variant of family.variants)
        check(variant && !Object.hasOwn(variant, "purchase"), "Unexpected legacy purchase value; review required.");
    }
  } else check(schema === 3, "Unsupported source schema.");
  const doc = upgrade(structuredClone(raw));
  check(valid(doc), "Derived schema 3 validation failed; review the source without altering it.");
  if (schema === 1) {
    check(doc.families.length === raw.products.length && isDeepStrictEqual(doc.customers, raw.customers),
      "Flat legacy reconciliation failed.");
    for (const [i, product] of raw.products.entries()) {
      const family = doc.families[i], variant = family.variants[0];
      for (const key of ["id","name","category","photo"])
        check(isDeepStrictEqual(family[key], product[key]), "Flat legacy family field mismatch.");
      for (const key of ["id","variant","unit","rate","history","ready"])
        check(isDeepStrictEqual(variant[key], product[key]), "Flat legacy variant field mismatch.");
    }
  } else if (schema === 2) {
    // Reverse only the explicitly introduced schema 3 fields; every old field
    // (including unknown but preserved metadata) must compare exactly.
    const reversed = structuredClone(doc);
    reversed.schema = 2;
    delete reversed.departments;
    for (const family of reversed.families) {
      delete family.gallery;
      for (const variant of family.variants) delete variant.purchase;
    }
    check(isDeepStrictEqual(reversed, raw), "Legacy field reconciliation failed.");
  }
  return { doc, schema };
}
function photoCheck(bytes, expected) {
  check(bytes.length >= 4 && bytes.length <= jpegLimit && bytes[0] === 255 &&
    bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217 &&
    digest(bytes) === expected, "Invalid or mismatched JPEG bytes.");
}

// Offline only: no network, credentials or database. The caller must capture
// a stable authorized source revision and privately store its original bytes.
export async function prepareLegacyExport({ sourcePath, sourceRevision, mediaDirectory, destinationDirectory }) {
  check(typeof sourceRevision === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sourceRevision), "Exact source revision required.");
  const outputRoot = await directory(destinationDirectory);
  const mediaRoot = await directory(mediaDirectory);
  const source = await realpath(sourcePath);
  check(!inside(await realpath(repo), outputRoot), "Use an owner-controlled destination outside the repository.");
  check(!inside(mediaRoot, outputRoot) && !inside(outputRoot, mediaRoot) &&
    !inside(outputRoot, source), "Separate the private source and destination.");
  const original = await readRegular(sourcePath, jsonLimit);
  let raw;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(original)); }
  catch { throw Error("Invalid UTF-8 JSON source."); }
  const { doc, schema } = convert(raw);
  const output = join(outputRoot, "catalogue-prepared-" + randomUUID());
  await mkdir(output, { mode: 0o700 });
  await saveNew(join(output, "original-workspace.json"), original);
  const media = join(output, "media");
  await mkdir(media, { mode: 0o700 });
  const checked = new Map(), checkedExternal = new Set();
  let inlineReferences = 0, externalReferences = 0;
  async function materialize(value) {
    if (!value) return value;
    const match = reference.exec(value);
    let bytes, sha;
    if (match) {
      sha = match[1]; externalReferences++;
      if (!checkedExternal.has(sha)) {
        bytes = await readRegular(join(mediaRoot, sha), jpegLimit);
        checkedExternal.add(sha);
      }
    } else {
      const encoded = inline.exec(value);
      check(encoded && encoded[1].length <= Math.ceil(jpegLimit / 3) * 4, "Invalid inline JPEG.");
      bytes = Buffer.from(encoded[1], "base64");
      check(bytes.toString("base64") === encoded[1], "Noncanonical inline JPEG; review required.");
      sha = digest(bytes); inlineReferences++;
    }
    if (bytes) {
      photoCheck(bytes, sha);
      if (checked.has(sha)) check(checked.get(sha) === bytes.length, "Conflicting media bytes.");
      else {
        await saveNew(join(media, sha), bytes);
        checked.set(sha, bytes.length);
      }
    }
    return "/api/photos/" + sha;
  }
  for (const family of doc.families) {
    family.photo = await materialize(family.photo);
    for (let i = 0; i < family.gallery.length; i++) family.gallery[i] = await materialize(family.gallery[i]);
    for (const variant of family.variants) variant.overridePhoto = await materialize(variant.overridePhoto);
  }
  // Reject a normalized collision instead of silently removing a gallery entry.
  check(valid(doc), "Normalized schema 3 validation failed; manual review required.");
  const derivedPath = join(output, "schema3-workspace.json");
  const derived = Buffer.from(JSON.stringify(doc, null, 2) + "\n");
  check(derived.length <= jsonLimit, "Derived workspace exceeds the verified staging limit.");
  await saveNew(derivedPath, derived);
  const bundle = await createBundle({ sourcePath: derivedPath, sourceRevision, mediaDirectory: media,
    backupDirectory: join(output, "verified-bundles") });
  check((await readRegular(sourcePath, jsonLimit)).equals(original), "Original export changed during preparation.");
  const receipt = {
    format: 1, sourceRevision, sourceSchema: schema, originalSha256: digest(original),
    derivedSha256: digest(derived), manifestSha256: bundle.manifestSha256,
    departmentOrder: Object.keys(doc.departments), inlineReferences, externalReferences,
    uniquePhotos: checked.size, verified: true, activated: false,
  };
  // Receipt includes private department names; keep it outside public source.
  await saveNew(join(output, "preparation-receipt.json"), Buffer.from(JSON.stringify(receipt, null, 2) + "\n"));
  return { ...receipt, output, bundleDirectory: bundle.bundleDirectory };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [sourcePath, sourceRevision, mediaDirectory, destinationDirectory] = process.argv.slice(2);
    check(process.argv.length === 6, "Expected source JSON, revision, media directory, private destination.");
    const result = await prepareLegacyExport({ sourcePath, sourceRevision, mediaDirectory, destinationDirectory });
    // Do not print paths, taxonomy names or raw records.
    const { sourceSchema, originalSha256, derivedSha256, manifestSha256, inlineReferences, externalReferences, uniquePhotos } = result;
    console.log(JSON.stringify({ sourceSchema, originalSha256, derivedSha256, manifestSha256,
      inlineReferences, externalReferences, uniquePhotos, verified: true, activated: false }, null, 2));
  } catch {
    console.error("Preparation stopped; no verified result. Inspect the private source and local output.");
    process.exitCode = 1;
  }
}
