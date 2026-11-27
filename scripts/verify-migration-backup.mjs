import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { valid } from "../server/worker.mjs";

const backupRoot = fileURLToPath(new URL("../backups/", import.meta.url));
const digestPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const photoPattern = /^\/api\/photos\/([a-f0-9]{64})$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const workspaceLimit = 12 * 1024 * 1024;
const photoLimit = 5 * 1024 * 1024;
const manifestLimit = 16 * 1024 * 1024;

function requireCheck(condition, message) {
  if (!condition) throw Error(message);
}

async function directory(path) {
  const info = await lstat(path);
  requireCheck(info.isDirectory() && !info.isSymbolicLink(), "Expected a regular backup or media directory.");
}

async function bytesAt(path, limit) {
  const info = await lstat(path);
  requireCheck(info.isFile() && !info.isSymbolicLink() && info.size <= limit, "Expected a regular file within the size limit.");
  const bytes = await readFile(path);
  requireCheck(bytes.length <= limit && bytes.length === info.size, "File size changed during verification.");
  return bytes;
}

function parse(bytes) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw Error("Invalid UTF-8 JSON.");
  }
}

function references(document) {
  let acceptable = false;
  try { acceptable = valid(document); } catch {}
  requireCheck(acceptable, "Workspace failed schema 3 validation.");
  const items = document.families.flatMap((family) => [
    family.photo, ...family.gallery, ...family.variants.map((variant) => variant.overridePhoto),
  ]).filter(Boolean);
  const digests = items.map((item) => {
    const match = photoPattern.exec(item);
    requireCheck(match, "Materialize inline photos in an isolated copy before backing up the workspace.");
    return match[1];
  });
  return { count: items.length, unique: [...new Set(digests)].sort() };
}

function checkPhoto(bytes, digest) {
  requireCheck(bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216, "Media is not a JPEG object.");
  requireCheck(hash(bytes) === digest, "Media digest does not match its content-addressed reference.");
}

async function writeNew(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function verifyBundle({ bundleDirectory, expectedManifestSha256 }) {
  requireCheck(typeof expectedManifestSha256 === "string" && digestPattern.test(expectedManifestSha256),
    "Provide the separately recorded manifest SHA-256.");
  await directory(bundleDirectory);
  const manifestBytes = await bytesAt(join(bundleDirectory, "manifest.json"), manifestLimit);
  requireCheck(hash(manifestBytes) === expectedManifestSha256, "Manifest digest mismatch.");
  const manifest = parse(manifestBytes);
  requireCheck(manifest?.format === 1 && typeof manifest.sourceRevision === "string" && revisionPattern.test(manifest.sourceRevision),
    "Invalid backup manifest.");
  const workspace = await bytesAt(join(bundleDirectory, "workspace.json"), workspaceLimit);
  requireCheck(manifest.workspace?.bytes === workspace.length && manifest.workspace?.sha256 === hash(workspace),
    "Workspace byte count or digest mismatch.");
  const refs = references(parse(workspace));
  requireCheck(manifest.mediaReferences === refs.count && Array.isArray(manifest.photos) &&
    manifest.photos.length === refs.unique.length &&
    manifest.photos.every((photo, index) => photo?.sha256 === refs.unique[index] && Number.isSafeInteger(photo.bytes) && photo.bytes >= 4 && photo.bytes <= photoLimit),
    "Manifest photo inventory does not match the workspace.");
  const media = join(bundleDirectory, "media");
  await directory(media);
  const actual = (await readdir(media)).sort();
  requireCheck(actual.length === refs.unique.length && actual.every((file, index) => file === refs.unique[index]),
    "Backup contains missing or unexpected media files.");
  for (const entry of manifest.photos) {
    const bytes = await bytesAt(join(media, entry.sha256), photoLimit);
    requireCheck(bytes.length === entry.bytes, "Backup media byte count mismatch.");
    checkPhoto(bytes, entry.sha256);
  }
  return {
    sourceRevision: manifest.sourceRevision, manifestSha256: expectedManifestSha256,
    workspaceSha256: manifest.workspace.sha256, mediaReferences: refs.count,
    uniquePhotos: refs.unique.length, verified: true,
  };
}

export async function createBundle({ sourcePath, sourceRevision, mediaDirectory, backupDirectory = backupRoot }) {
  requireCheck(typeof sourceRevision === "string" && revisionPattern.test(sourceRevision), "Provide an exact source revision.");
  const workspace = await bytesAt(sourcePath, workspaceLimit);
  const refs = references(parse(workspace));
  await directory(mediaDirectory);
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await directory(backupDirectory);
  const bundleDirectory = resolve(backupDirectory, "catalogue-" + randomUUID());
  await mkdir(bundleDirectory, { mode: 0o700 });
  const media = join(bundleDirectory, "media");
  await mkdir(media, { mode: 0o700 });
  await writeNew(join(bundleDirectory, "workspace.json"), workspace);
  const photos = [];
  for (const digest of refs.unique) {
    const bytes = await bytesAt(join(mediaDirectory, digest), photoLimit);
    checkPhoto(bytes, digest);
    await writeNew(join(media, digest), bytes);
    photos.push({ sha256: digest, bytes: bytes.length });
  }
  // The manifest is written last. A partial backup is never reported as verified.
  const manifest = {
    format: 1, sourceRevision,
    workspace: { sha256: hash(workspace), bytes: workspace.length },
    mediaReferences: refs.count, photos,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  requireCheck(manifestBytes.length <= manifestLimit, "Backup manifest exceeds its size limit.");
  await writeNew(join(bundleDirectory, "manifest.json"), manifestBytes);
  const verified = await verifyBundle({ bundleDirectory, expectedManifestSha256: hash(manifestBytes) });
  return { bundleDirectory, ...verified };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [mode, first, second, third] = process.argv.slice(2);
    let result;
    if (mode === "create" && process.argv.length === 6) {
      result = await createBundle({ sourcePath: first, sourceRevision: second, mediaDirectory: third });
    } else if (mode === "verify" && process.argv.length === 5) {
      result = await verifyBundle({ bundleDirectory: first, expectedManifestSha256: second });
    } else {
      throw Error("Usage: create <export.json> <source-revision> <media-dir> | verify <bundle-dir> <manifest-sha256>.");
    }
    console.log(JSON.stringify(result, null, 2));
  } catch {
    // Filesystem errors can contain private paths. Do not print raw exception messages.
    console.error("Backup stopped; no verified result. Check source, media and manifest in the private checkout.");
    process.exitCode = 1;
  }
}
