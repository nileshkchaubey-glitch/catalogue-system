import { readFileSync } from "node:fs";
import { localCommand } from "./supabase-migration-diagnostics.mjs";

export const disposableProject = "catalogue-api-gate-disposable";
export const databaseContainer = "supabase_db_" + disposableProject;

const { cli, database } = JSON.parse(readFileSync(new URL("./supabase-runtime.json", import.meta.url), "utf8"));
const taggedImage = database.repository + ":" + database.tag;
const pinnedImage = database.repository + "@" + database.manifestDigest;
const imageFormat = "{{.Id}}|{{.Os}}/{{.Architecture}}";

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
  command(run, "docker", ["image", "pull", "--platform", database.platform, pinnedImage],
    "Could not pull the immutable Supabase database image.", 300000);
  assertImage(run, pinnedImage);
  // The pinned CLI's default PostgreSQL tag uses the local cache when present.
  command(run, "docker", ["image", "tag", pinnedImage, taggedImage],
    "Could not cache the pinned image under the CLI's database tag.");
  assertImage(run, taggedImage);
}

export function verifyPinnedRuntime(run = localCommand) {
  assertLocalTools(run);
  assertImage(run, pinnedImage);
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
