import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { databaseContainer, disposableProject, preparePinnedRuntime, RuntimeFailure, verifyPinnedRuntime } from "./integration/supabase-runtime.mjs";

const { cli, database } = JSON.parse(readFileSync(new URL("./integration/supabase-runtime.json", import.meta.url), "utf8"));
const pinned = database.repository + "@" + database.manifestDigest;
const tagged = database.repository + ":" + database.tag;
const image = database.configDigest + "|" + database.platform;
const success = (stdout = "") => ({ status: 0, stdout });
const failure = { status: 1, stdout: "", stderr: "private fixture output" };

function fixture(overrides = {}) {
  const calls = [];
  const run = (command, args, input, timeout) => {
    calls.push({ command, args, input, timeout });
    if (command === "supabase") return success(overrides.version ?? cli.version);
    if (args[0] === "context") return success(overrides.socket ?? "unix:///var/run/docker.sock");
    if (args[0] === "image" && args[1] === "pull") return overrides.pullFailure ? failure : success();
    if (args[0] === "image" && args[1] === "tag") return success();
    if (args[0] === "image" && args[1] === "inspect") return success(overrides.image ?? image);
    if (args[0] === "inspect") return success(overrides.container ?? database.configDigest + "|running|" + disposableProject);
    throw Error("Unexpected synthetic command");
  };
  return { run, calls };
}

function localEnvironment(run) {
  const prior = [process.env.DOCKER_HOST, process.env.DOCKER_CONTEXT];
  delete process.env.DOCKER_HOST;
  delete process.env.DOCKER_CONTEXT;
  try { return run(); } finally {
    for (const [index, key] of ["DOCKER_HOST", "DOCKER_CONTEXT"].entries()) {
      if (prior[index] === undefined) delete process.env[key];
      else process.env[key] = prior[index];
    }
  }
}

test("runtime pin uses immutable image pull and validates both image references", () => localEnvironment(() => {
  const { run, calls } = fixture();
  preparePinnedRuntime(run);
  assert.deepEqual(calls[2].args, ["image", "pull", "--platform", database.platform, pinned]);
  assert.equal(calls[2].timeout, 300000);
  assert.deepEqual(calls[4].args, ["image", "tag", pinned, tagged]);
  assert.equal(calls[5].args.at(-1), tagged);
}));

test("runtime preparation rejects incompatible CLI, remote Docker, mismatched image or failed pull", () => localEnvironment(() => {
  for (const overrides of [{ version: "0.0.0" }, { socket: "tcp://example.invalid:2375" }, { image: "sha256:unexpected|linux/amd64" }, { pullFailure: true }]) {
    const { run, calls } = fixture(overrides);
    assert.throws(() => preparePinnedRuntime(run), RuntimeFailure);
    assert.equal(calls.some(({ args }) => args[0] === "image" && args[1] === "tag"), false);
  }
}));

test("runtime verification requires exact running local container image and project label", () => localEnvironment(() => {
  const { run, calls } = fixture();
  assert.match(verifyPinnedRuntime(run), /linux\/amd64 manifest sha256:/);
  assert.equal(calls.at(-1).args.at(-1), databaseContainer);
  for (const container of [database.configDigest + "|exited|" + disposableProject, database.configDigest + "|running|unrelated", "sha256:unexpected|running|" + disposableProject]) {
    assert.throws(() => verifyPinnedRuntime(fixture({ container }).run), RuntimeFailure);
  }
}));