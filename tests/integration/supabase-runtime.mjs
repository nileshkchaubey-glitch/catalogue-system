import { readFileSync } from "node:fs";
import { localCommand } from "./supabase-migration-diagnostics.mjs";

export const disposableProject = "catalogue-api-gate-disposable";
export const databaseContainer = "supabase_db_" + disposableProject;

const { cli, database } = JSON.parse(readFileSync(new URL("./supabase-runtime.json", import.meta.url), "utf8"));
const taggedImage = database.repository + ":" + database.tag;
const imageFormat = "{{.Id}}|{{.Os}}/{{.Architecture}}";
const pullTimeout = 150000; // Two attempts share the original five-minute pull budget.
const pullErrors = [
  [/toomanyrequests|too many requests|rate (?:limit|exceeded)|\b429\b/i, "registry rate limited"],
  [/unauthorized|denied|forbidden|\b40[13]\b/i, "registry denied access"],
  [/manifest unknown|no matching manifest|manifest.*not found/i, "manifest unavailable"],
  [/no such host|timed? out|connection refused|connection reset|TLS handshake|unexpected EOF/i, "network error"],
];

export class RuntimeFailure extends Error {}

function command(run, executable, args, failure, timeout) {
  const result = run(executable, args, undefined, timeout);
  if (result.status !== 0 || result.error) throw new RuntimeFailure(failure);
  return result.stdout.trim();
}

function assertLocalTools(run) {
  const version = command(run, "supabase", ["--version"],
    "The pinned Supabase CLI is unavailable.");
  if (version !== cli.version) throw new RuntimeFailure("Expected Supabase CLI " + cli.version + ".");

  const socket = process.env.DOCKER_HOST || command(run, "docker", [
    "context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}',
  ], "The local Docker context is unavailable.");
  if (!/^(unix:\/\/\/|npipe:\/\/\/\/\.\/pipe\/)/.test(socket) || process.env.DOCKER_HOST && process.env.DOCKER_CONTEXT) {
    throw new RuntimeFailure("Use a local Docker socket with one context selection.");
  }
}

function assertImage(run, reference) {
  const actual = command(run, "docker", ["image", "inspect", "--format", imageFormat, reference],
    "The pinned Docker image reference is unavailable.");
  if (actual !== database.configDigest + "|" + database.platform) {
    throw new RuntimeFailure("The database image ID or platform differs from the runtime pin.");
  }
}

export function preparePinnedRuntime(run = localCommand) {
  assertLocalTools(run);
  const failures = [];
  for (const repository of [database.repository, database.mirrorRepository]) {
    const image = repository + "@" + database.manifestDigest;
    const result = run("docker", ["image", "pull", "--quiet", "--platform", database.platform, image], undefined, pullTimeout);
    if (result.status === 0 && !result.error) {
      assertImage(run, image);
      // Populate the default CLI tag regardless of which registry served the bytes.
      command(run, "docker", ["image", "tag", image, taggedImage],
        "Could not cache the pinned image under the CLI's database tag.");
      assertImage(run, taggedImage);
      return;
    }

    // Expose only fixed categories; Docker output can contain sensitive URLs.
    const category = result.error?.code === "ETIMEDOUT" ? "timed out" :
      pullErrors.find(([pattern]) => pattern.test(result.stderr ?? ""))?.[1] ?? "pull failed";
    failures.push(repository.split("/")[0] + ": " + category);
  }
  throw new RuntimeFailure("Could not pull the immutable Supabase database image (" + failures.join(", ") + ").");
}

export function verifyPinnedRuntime(run = localCommand) {
  assertLocalTools(run);
  assertImage(run, database.configDigest);
  const actual = command(run, "docker", [
    "inspect", "--type", "container", "--format",
    '{{.Image}}|{{.State.Status}}|{{index .Config.Labels "com.supabase.cli.project"}}',
    databaseContainer,
  ], "The disposable Supabase database container is unavailable.");
  if (actual !== database.configDigest + "|running|" + disposableProject) {
    throw new RuntimeFailure("The running disposable database differs from the runtime pin.");
  }
  return database.platform + " manifest " + database.manifestDigest + " | running image ID " + database.configDigest;
}
