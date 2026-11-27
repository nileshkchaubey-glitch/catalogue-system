import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { valid } from "../server/worker.mjs";

const maxBytes = 12 * 1024 * 1024;
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

export async function stageWorkspace({ sourcePath, sourceRevision, env = process.env,
  backupDirectory = backupRoot, fetcher = fetch }) {
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
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    ...reconciliation,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [sourcePath, sourceRevision] = process.argv.slice(2);
  try {
    if (process.argv.length !== 4) throw Error(usage);
    console.log(JSON.stringify(await stageWorkspace({ sourcePath, sourceRevision }), null, 2));
  } catch (problem) {
    console.error(`Staging stopped. ${problem.message}`);
    if (problem.reconciliation) console.error(JSON.stringify(problem.reconciliation, null, 2));
    process.exitCode = 1;
  }
}
