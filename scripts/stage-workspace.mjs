import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { valid } from "../server/worker.mjs";
import { verifyBundle } from "./verify-migration-backup.mjs";

const maxBytes = 12 * 1024 * 1024;
const maxPhotoBytes = 5 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const photoRef = /^\/api\/photos\/([a-f0-9]{64})$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const imports = "/rest/v1/catalogue_workspace_imports";
const backupRoot = fileURLToPath(new URL("../backups/", import.meta.url));
const usage = "Use node scripts/stage-workspace.mjs <schema3-export.json> <source-revision>.";
const schemaFields = new Set([
  "schema", "departments", "collections", "families", "customers", "quoteDrafts", "quoteSnapshots",
  "id", "name", "category", "photo", "gallery", "variants", "variant", "unit", "purchase", "rate",
  "ready", "overridePhoto", "history", "at", "phone", "collection", "consent", "customerId",
  "customerName", "customerPhone", "confirmedAt", "lines", "variantId", "quantity", "rateOverride",
  "subtotal", "total",
]);

function connection(env) {
  const url = URL.parse(env.CATALOGUE_LOCAL_SUPABASE_URL ?? "");
  if (!url || url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || url.pathname !== "/" || url.username || url.password || url.search || url.hash || !url.port) {
    throw Error("Set CATALOGUE_LOCAL_SUPABASE_URL to the numeric loopback origin of local Supabase.");
  }
  const key = env.CATALOGUE_SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    throw Error("Set CATALOGUE_SUPABASE_PUBLISHABLE_KEY to a local publishable key.");
  }
  const token = env.CATALOGUE_IMPORT_ACCESS_TOKEN ?? "";
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw Error("Set CATALOGUE_IMPORT_ACCESS_TOKEN to a provisioned local owner's user access token.");
  }
  return { url, key, token };
}

function counts(document) {
  const variants = document.families.flatMap((family) => family.variants);
  const media = document.families.flatMap((family) => [
    family.photo, ...family.gallery, ...family.variants.map((variant) => variant.overridePhoto),
  ]).filter(Boolean);
  return {
    departments: Object.keys(document.departments).length,
    categories: Object.values(document.departments).flat().length,
    collections: document.collections.length,
    collectionMemberships: document.families.reduce((sum, family) => sum + family.collections.length, 0),
    families: document.families.length,
    variants: variants.length,
    customers: document.customers.length,
    rateHistoryEntries: variants.reduce((sum, variant) => sum + variant.history.length, 0),
    mediaReferences: media.length,
    uniqueMediaReferences: new Set(media).size,
    quoteDrafts: Array.isArray(document.quoteDrafts) ? document.quoteDrafts.length : 0,
    quoteSnapshots: Array.isArray(document.quoteSnapshots) ? document.quoteSnapshots.length : 0,
  };
}

function compare(expected, actual) {
  let differentFields = 0;
  const differencePaths = [];

  function walk(left, right, path) {
    if (left === right) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      for (let i = 0; i < Math.max(left.length, right.length); i++) walk(left[i], right[i], `${path}[${i}]`);
    } else if (left && right && typeof left === "object" && typeof right === "object"
      && !Array.isArray(left) && !Array.isArray(right)) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      let position = 0;
      for (const key of keys) {
        const leftValue = Object.hasOwn(left, key) ? left[key] : undefined;
        const rightValue = Object.hasOwn(right, key) ? right[key] : undefined;
        const child = schemaFields.has(key) ? `${path}.${key}` : `${path}[field ${position}]`;
        walk(leftValue, rightValue, child);
        position++;
      }
    } else {
      differentFields++;
      if (differencePaths.length < 20) differencePaths.push(path);
    }
  }

  walk(expected, actual, "workspace");
  const sourceCounts = counts(expected);
  const stagedCounts = valid(actual) ? counts(actual) : null;
  return { differentFields, differencePaths, sourceCounts, stagedCounts };
}

async function saveBackup(bytes, directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const backupPath = resolve(directory, `workspace-${randomUUID()}.json`);
  const backupFile = await open(backupPath, "wx", 0o600);
  try {
    await backupFile.writeFile(bytes);
    await backupFile.sync();
  } finally {
    await backupFile.close();
  }
  if (!(await readFile(backupPath)).equals(bytes)) throw Error("Local backup could not be verified.");
  return backupPath;
}

async function readPhotoResponse(response, expected) {
  if (response.status === 404) return false;
  if (response.status === 400) {
    // The Storage API can report a missing object with HTTP 400 and a 404
    // statusCode in its JSON response. A denial is never considered missing.
    const details = await response.json().catch(() => null);
    if (String(details?.statusCode) === "404") return false;
  }
  if (!response.ok || response.headers.get("Content-Type")?.split(";")[0] !== "image/jpeg" || !response.body)
    throw Error("Local media read was denied or did not return JPEG.");
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > expected.length || length > maxPhotoBytes) {
        await reader.cancel();
        throw Error("Local media byte count exceeds its verified source.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (!Buffer.concat(chunks).equals(expected)) throw Error("Local media differs from its verified source.");
  return true;
}

async function reconcileMedia(document, owner, request, bundleDirectory) {
  const references = document.families.flatMap((family) => [
    family.photo, ...family.gallery, ...family.variants.map((variant) => variant.overridePhoto),
  ]).filter(Boolean);
  const digests = [...new Set(references.map((reference) => {
    const match = photoRef.exec(reference);
    if (!match) throw Error("Expected a verified content-addressed media reference.");
    return match[1];
  }))].sort();
  let uploaded = 0, reused = 0;
  for (const digest of digests) {
    const path = join(bundleDirectory, "media", digest);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 4 || info.size > maxPhotoBytes)
      throw Error("Local media source is not a regular verified file.");
    const bytes = await readFile(path);
    if (bytes.length !== info.size || hash(bytes) !== digest || bytes[0] !== 255 || bytes[1] !== 216)
      throw Error("Local media source changed after verification.");
    const name = owner + "/" + digest + ".jpg";
    const readPath = "/storage/v1/object/authenticated/catalogue-media/" + name;
    if (await readPhotoResponse(await request(readPath), bytes)) {
      reused++;
      continue;
    }
    const response = await request("/storage/v1/object/catalogue-media/" + name, {
      method: "POST", headers: { "Content-Type": "image/jpeg", "x-upsert": "false" }, body: bytes,
    });
    if (!response.ok && ![400, 409].includes(response.status)) throw Error("Local media upload failed.");
    if (!(await readPhotoResponse(await request(readPath), bytes))) throw Error("Local media upload could not be verified.");
    if (response.ok) uploaded++;
    else reused++;
  }
  return { references: references.length, uniquePhotos: digests.length, uploaded, reused, verified: digests.length };
}

// The verified-bundle entry point is the migration rehearsal path. It never
// activates the staged document and never accepts a hosted Supabase origin.
export async function stageVerifiedBundle({ bundleDirectory, expectedManifestSha256, ...options }) {
  const verified = await verifyBundle({ bundleDirectory, expectedManifestSha256 });
  return stageWorkspace({
    ...options, sourcePath: join(bundleDirectory, "workspace.json"), sourceRevision: verified.sourceRevision,
    verifiedSource: { bundleDirectory, expectedManifestSha256, workspaceSha256: verified.workspaceSha256 },
  });
}

export async function stageWorkspace({ sourcePath, sourceRevision, env = process.env,
  backupDirectory = backupRoot, fetcher = fetch, verifiedSource }) {
  if (!sourcePath || typeof sourceRevision !== "string" || !revisionPattern.test(sourceRevision)) {
    throw Error(usage);
  }
  const { url, key, token } = connection(env);
  const source = await stat(sourcePath);
  if (!source.isFile() || source.size > maxBytes) throw Error("Select a schema 3 file no larger than 12 MiB.");
  const bytes = await readFile(sourcePath);
  if (bytes.length > maxBytes) throw Error("Select a schema 3 file no larger than 12 MiB.");
  let document;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw Error("Source must be a valid schema 3 JSON export.");
  }
  if (!valid(document)) throw Error("Source workspace failed schema 3 validation.");
  if (verifiedSource && hash(bytes) !== verifiedSource.workspaceSha256)
    throw Error("Verified workspace changed before staging.");

  function request(path, options = {}) {
    return fetcher(new URL(path, url), {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { apikey: key, Authorization: `Bearer ${token}`, ...options.headers },
    });
  }

  const identity = await request("/auth/v1/user");
  if (!identity.ok) throw Error("Local owner authentication failed.");
  const user = await identity.json();
  if (!user || typeof user.id !== "string" || !uuid.test(user.id)
    || user.role !== "authenticated" || user.is_anonymous !== false) {
    throw Error("Local owner authentication failed.");
  }
  const owner = user.id;
  const profiles = await request(`/rest/v1/business_profiles?select=owner_id&owner_id=eq.${owner}&limit=2`);
  if (!profiles.ok) throw Error("Provision exactly one profile for the local owner before staging.");
  const profileRows = await profiles.json();
  if (!Array.isArray(profileRows) || profileRows.length !== 1 || profileRows[0]?.owner_id !== owner) {
    throw Error("Provision exactly one profile for the local owner before staging.");
  }

  const query = `${imports}?${new URLSearchParams({ select: "owner_id,source_revision,document",
    owner_id: `eq.${owner}`, source_revision: `eq.${sourceRevision}` })}`;
  async function readStage() {
    const response = await request(query);
    if (!response.ok) throw Error(`Could not read local staging table (${response.status}).`);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length > 1 || (rows.length === 1
      && (rows[0]?.owner_id !== owner || rows[0]?.source_revision !== sourceRevision))) {
      throw Error("Local staging response did not match the requested owner and revision.");
    }
    return rows[0];
  }

  const current = await readStage();
  const backupPath = await saveBackup(bytes, backupDirectory);
  // Do not write media for an already-conflicting archive revision.
  if (verifiedSource && current) {
    const reconciliation = compare(document, current.document);
    if (reconciliation.differentFields !== 0 || reconciliation.stagedCounts === null)
      throw Error("Existing archive revision differs from the verified export.");
  }
  let media;
  if (verifiedSource) {
    media = await reconcileMedia(document, owner, request, verifiedSource.bundleDirectory);
    const verified = await verifyBundle(verifiedSource);
    if (verified.workspaceSha256 !== hash(bytes) || verified.sourceRevision !== sourceRevision ||
        verified.uniquePhotos !== media.uniquePhotos || verified.mediaReferences !== media.references)
      throw Error("Source changed during local migration rehearsal.");
  }
  let stored = current;
  let outcome = "already-staged";
  if (!current) {
    const response = await request(imports, {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ owner_id: owner, source_revision: sourceRevision, document }),
    });
    if (!response.ok && response.status !== 409) {
      throw Error(`Local staging insert failed (${response.status}).`);
    }
    if (response.ok) outcome = "staged";
    stored = await readStage();
  }
  if (!stored) throw Error("Local staging row could not be read back.");
  const reconciliation = compare(document, stored.document);
  if (reconciliation.differentFields !== 0 || reconciliation.stagedCounts === null) {
    const problem = Error(`Staged revision differs from the export (${reconciliation.differentFields} field differences). Both records were retained.`);
    problem.reconciliation = { backupPath, ...reconciliation };
    throw problem;
  }
  return {
    outcome, sourceRevision, backupPath,
    sourceSha256: hash(bytes),
    ...(media ? { media, activated: false } : {}),
    ...reconciliation,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [sourcePath, sourceRevision] = process.argv.slice(2);
  try {
    if (sourcePath === "--bundle" && process.argv.length === 5) {
      console.log(JSON.stringify(await stageVerifiedBundle({
        bundleDirectory: sourceRevision, expectedManifestSha256: process.argv[4],
      }), null, 2));
    } else {
      if (process.argv.length !== 4) throw Error(usage + " Or use --bundle <verified-bundle-dir> <manifest-sha256>.");
      console.log(JSON.stringify(await stageWorkspace({ sourcePath, sourceRevision }), null, 2));
    }
  } catch (problem) {
    console.error(`Staging stopped. ${problem.message}`);
    if (problem.reconciliation) console.error(JSON.stringify(problem.reconciliation, null, 2));
    process.exitCode = 1;
  }
}
