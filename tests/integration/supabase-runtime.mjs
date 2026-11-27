import { readFileSync } from "node:fs";
import { commandStatus, localCommand } from "./supabase-migration-diagnostics.mjs";

export const disposableProject = "catalogue-api-gate-disposable";
export const databaseContainer = "supabase_db_" + disposableProject;

const { cli, database } = JSON.parse(readFileSync(new URL("./supabase-runtime.json", import.meta.url), "utf8"));
const taggedImage = database.repository + ":" + database.tag;
const imageFormat = "{{.Id}}|{{.Os}}/{{.Architecture}}";
const pullTimeout = 150000; // Two attempts share the original five-minute pull budget.
const pullErrors = [
  [/cannot connect to the docker daemon|is the docker daemon running|error during connect|permission denied.*docker daemon|docker daemon.*permission denied/i, "Docker daemon unavailable"],
  [/no space left on device|disk quota exceeded|not enough disk space/i, "insufficient disk space"],
  [/no matching manifest for|does not match the specified platform|no match for platform|unsupported platform/i, "platform unavailable"],
  [/digest mismatch|unexpected digest|checksum mismatch|filesystem layer verification failed|failed size validation|digest[^\r\n]*(?:verification failed|does not match)/i, "digest or content integrity error"],
  [/toomanyrequests|too many requests|rate (?:limit|exceeded)/i, "registry rate limited"],
  [/unauthorized|access denied|pull access denied|forbidden|authentication required|insufficient.scope/i, "registry denied access"],
  [/manifest unknown|name unknown|manifest[^\r\n]*not found|repository[^\r\n]*not found/i, "image or manifest unavailable"],
  [/no such host|temporary failure in name resolution|timed? out|deadline exceeded|connection refused|connection reset|TLS handshake|x509:|unexpected EOF|proxyconnect|dial tcp/i, "network error"],
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

function describePullFailure(result) {
  const stderr = result.stderr ?? "";
  const http = stderr.match(/\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|(?:unexpected|returned|received) status(?: code)?[:=]?\s+)([45]\d\d)\b/i)?.[1] ??
    stderr.match(/:\s*([45]\d\d)\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i)?.[1];
  const responseCategory = {
    401: "registry denied access",
    403: "registry denied access",
    404: "image or manifest unavailable",
    429: "registry rate limited",
  }[http];
  const stderrCategory = pullErrors.find(([pattern]) => pattern.test(stderr))?.[1];
  const category = stderrCategory ?? responseCategory ?? (http?.startsWith("5") ? "registry server error" : undefined);
  const evidence = [commandStatus(result)];
  if (http) evidence.push("HTTP " + http);
  evidence.push(category ?? (stderr.trim() ? "unrecognized stderr" : "empty stderr"));
  return evidence.join(" | ");
}

export function preparePinnedRuntime(run = localCommand, report = () => {}) {
  assertLocalTools(run);
  for (const repository of [database.repository, database.mirrorRepository]) {
    const registry = repository.split("/")[0];
    const image = repository + "@" + database.manifestDigest;
    const result = run("docker", ["image", "pull", "--quiet", "--platform", database.platform, image], undefined, pullTimeout);
    if (result.status === 0 && !result.error) {
      report("Docker pull " + registry + ": completed");
      assertImage(run, image);
      // Populate the default CLI tag regardless of which registry served the bytes.
      command(run, "docker", ["image", "tag", image, taggedImage],
        "Could not cache the pinned image under the CLI's database tag.");
      assertImage(run, taggedImage);
      return;
    }

    // Docker output may include credentials or signed URLs. Report only classified evidence.
    report("Docker pull " + registry + ": " + describePullFailure(result));
  }
  throw new RuntimeFailure("Neither registry supplied the pinned Supabase database image.");
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
