import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const pin = JSON.parse(readFileSync(join(root, "tests/integration/supabase-runtime.json"), "utf8"));
const project = "catalogue-api-gate-disposable";
const label = "label=com.supabase.cli.project=" + project;
const env = { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" };
const gateScript = join(root, "tests/integration/supabase-api.mjs");

function run(executable, args, timeout = 30000) {
  const result = spawnSync(executable, args, {
    cwd: root, env, timeout, encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  return { ok: result.status === 0 && !result.error, stdout: result.stdout ?? "" };
}
function requireOk(condition, message) {
  if (!condition) throw new Error(message);
}
function prerequisites() {
  const cli = run("supabase", ["--version"]);
  const docker = run("docker", ["--version"]);
  const platform = process.platform === "linux" && process.arch === "x64";
  console.log("Linux amd64: " + (platform ? "PASS" : "UNAVAILABLE"));
  console.log("Pinned Supabase CLI: " + (cli.ok && cli.stdout.trim() === pin.cli.version ? "PASS" : "UNAVAILABLE"));
  console.log("Docker CLI: " + (docker.ok ? "PASS" : "UNAVAILABLE"));
  requireOk(platform && cli.ok && cli.stdout.trim() === pin.cli.version && docker.ok,
    "A dedicated disposable Linux amd64 host with the pinned CLI and Docker is required.");
  requireOk(!(env.DOCKER_HOST && env.DOCKER_CONTEXT), "Conflicting Docker context settings.");
  const context = env.DOCKER_HOST ? { ok: true, stdout: env.DOCKER_HOST } :
    run("docker", ["context", "inspect", "--format", "{{(index .Endpoints \"docker\").Host}}"]);
  requireOk(context.ok && context.stdout.trim().startsWith("unix:///"), "A local Unix Docker socket is required.");
  requireOk(run("docker", ["info"]).ok, "Local Docker daemon unavailable.");
}
function emptyProject() {
  for (const args of [
    ["ps", "-aq", "--filter", label],
    ["volume", "ls", "-q", "--filter", label],
    ["network", "ls", "-q", "--filter", label],
  ]) {
    const result = run("docker", args);
    requireOk(result.ok && !result.stdout.trim(), "Disposable project resources already exist or cannot be inspected.");
  }
}
function stage(name, args, timeout) {
  const result = run(process.execPath, [gateScript, ...args], timeout);
  // The existing gate emits allowlisted status and diagnostic lines.
  for (const line of result.stdout.split(/\r?\n/)) {
    if (/^(PASS |START )/.test(line)) console.log(line);
  }
  requireOk(result.ok, name + " failed; no raw output is published.");
}
function acceptance() {
  prerequisites();
  requireOk(existsSync(join(root, "dist/server/index.js")), "Build artifact missing; build the exact candidate first.");
  const lock = join(tmpdir(), project + "-acceptance-lock");
  mkdirSync(lock, { mode: 0o700 });
  let temp, gate, startAttempted = false, preserve = false;
  try {
    emptyProject();
    temp = mkdtempSync(join(tmpdir(), project + "-"));
    env.RUNNER_TEMP = temp;
    gate = join(temp, "catalogue-supabase-gate");
    mkdirSync(join(gate, "supabase"), { recursive: true, mode: 0o700 });
    const config = readFileSync(join(root, "supabase/config.toml"), "utf8");
    requireOk(/^project_id = "[^"]+"/m.test(config), "Project ID missing from local config.");
    writeFileSync(join(gate, "supabase/config.toml"),
      config.replace(/^project_id = "[^"]+"/m, 'project_id = "' + project + '"'), { mode: 0o600 });
    stage("Pinned runtime preparation", ["prepare-runtime"], 360000);
    emptyProject();
    startAttempted = true;
    requireOk(run("supabase", ["--workdir", gate, "start", "--exclude",
      "studio,pgmeta,edge-runtime,realtime,imgproxy,logflare,vector,supavisor"], 480000).ok,
      "Disposable stack startup failed.");
    stage("Runtime and reconciliation preflight", ["preflight"], 120000);
    stage("Versioned migrations", ["migrate"], 120000);
    stage("Real API and browser acceptance", [], 300000);
    console.log("Real API and browser acceptance: PASS");
  } finally {
    try {
      if (startAttempted) {
        preserve = true;
        requireOk(run("supabase", ["--workdir", gate, "stop", "--no-backup"], 90000).ok,
          "Disposable cleanup failed; retained temporary configuration for recovery.");
        emptyProject();
        preserve = false;
        console.log("Disposable cleanup: PASS");
      }
    } finally {
      if (temp && !preserve) rmSync(temp, { recursive: true, force: true });
      if (preserve) console.error("Cleanup incomplete; retained dedicated temporary configuration.");
      rmSync(lock, { recursive: true, force: true });
    }
  }
}
try {
  if (process.argv.length !== 3) throw new Error("Use --check or --execute-isolated.");
  if (process.argv[2] === "--check") prerequisites();
  else if (process.argv[2] === "--execute-isolated") acceptance();
  else throw new Error("Use --check or --execute-isolated.");
} catch (error) {
  // Do not expose subprocess output, environment or credentials.
  console.error("Acceptance stopped: " + (error instanceof Error && error.message.startsWith("Use --") ?
    error.message : "one or more prerequisites, stages, or cleanup checks failed."));
  process.exitCode = 1;
}
