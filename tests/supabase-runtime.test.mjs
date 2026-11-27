import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { databaseContainer, disposableProject, preparePinnedRuntime, RuntimeFailure, verifyPinnedRuntime } from "./integration/supabase-runtime.mjs";

const { cli, database } = JSON.parse(readFileSync(new URL("./integration/supabase-runtime.json", import.meta.url), "utf8"));
const pinned = database.repository + "@" + database.manifestDigest;
const mirror = database.mirrorRepository + "@" + database.manifestDigest;
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
    if (args[0] === "image" && args[1] === "pull") return overrides.pulls?.[args.at(-1)] ?? success();
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
  const reports = [];
  preparePinnedRuntime(run, (message) => reports.push(message));
  assert.deepEqual(reports, ["Docker pull public.ecr.aws: completed"]);
  assert.equal(calls.filter(({ args }) => args[1] === "pull").length, 1);
  assert.deepEqual(calls[2].args, ["image", "pull", "--quiet", "--platform", database.platform, pinned]);
  assert.equal(calls[2].timeout, 150000);
  assert.deepEqual(calls[4].args, ["image", "tag", pinned, tagged]);
  assert.equal(calls[5].args.at(-1), tagged);
}));

test("runtime preparation can use the same immutable manifest from the official mirror", () => localEnvironment(() => {
  const { run, calls } = fixture({ pulls: { [pinned]: failure } });
  const reports = [];
  preparePinnedRuntime(run, (message) => reports.push(message));
  assert.deepEqual(reports, [
    "Docker pull public.ecr.aws: exit 1 | unrecognized stderr",
    "Docker pull ghcr.io: completed",
  ]);
  assert.equal(calls.filter(({ args }) => args[1] === "pull").length, 2);
  assert.deepEqual(calls[3].args, ["image", "pull", "--quiet", "--platform", database.platform, mirror]);
  assert.equal(calls[3].timeout, 150000);
  assert.equal(calls[4].args.at(-1), mirror);
  assert.deepEqual(calls[5].args, ["image", "tag", mirror, tagged]);
  assert.equal(calls[6].args.at(-1), tagged);

  const wrongImage = fixture({ pulls: { [pinned]: failure }, image: "sha256:unexpected|linux/amd64" });
  assert.throws(() => preparePinnedRuntime(wrongImage.run), /differs from the runtime pin/);
  assert.equal(wrongImage.calls.some(({ args }) => args[1] === "tag"), false);
}));

test("runtime pull failure reports allowlisted categories without leaking subprocess output", () => localEnvironment(() => {
  const cases = [
    ["unexpected status from HEAD request to https://example.test/image: 429 Too Many Requests", "exit 1 | HTTP 429 | registry rate limited"],
    ["received status code: 401", "exit 1 | HTTP 401 | registry denied access"],
    ["HTTP/1.1 403 Forbidden", "exit 1 | HTTP 403 | registry denied access"],
    ["manifest unknown", "exit 1 | image or manifest unavailable"],
    ["HTTP 404", "exit 1 | HTTP 404 | image or manifest unavailable"],
    ["unexpected status: 503", "exit 1 | HTTP 503 | registry server error"],
    ["dial tcp: unexpected EOF", "exit 1 | network error"],
    ["filesystem layer verification failed", "exit 1 | digest or content integrity error"],
    ["no matching manifest for linux/amd64", "exit 1 | platform unavailable"],
    ["no space left on device", "exit 1 | insufficient disk space"],
    ["Cannot connect to the Docker daemon", "exit 1 | Docker daemon unavailable"],
    ["unclassified error mentioning account 429", "exit 1 | unrecognized stderr"],
    ["", "exit 1 | empty stderr"],
  ];
  for (const [stderr, expected] of cases) {
    const { run, calls } = fixture({ pulls: {
      [pinned]: { ...failure, stderr: stderr && stderr + "\nAuthorization: Bearer fixture-secret" },
      [mirror]: { ...failure, status: null, error: { code: "ETIMEDOUT", message: "fixture-secret" }, stderr: "" },
    } });
    const reports = [];
    assert.throws(() => preparePinnedRuntime(run, (message) => reports.push(message)),
      /Neither registry supplied the pinned Supabase database image/);
    assert.deepEqual(reports, [
      "Docker pull public.ecr.aws: " + expected,
      "Docker pull ghcr.io: timed out | empty stderr",
    ]);
    assert.equal(calls.filter(({ args }) => args[1] === "pull").length, 2);
    assert.equal(calls.some(({ args }) => args[1] === "tag"), false);
  }
}));

test("runtime preparation rejects incompatible CLI, remote Docker, and mismatched images", () => localEnvironment(() => {
  for (const overrides of [{ version: "0.0.0" }, { socket: "tcp://example.invalid:2375" }, { image: "sha256:unexpected|linux/amd64" }]) {
    const { run, calls } = fixture(overrides);
    assert.throws(() => preparePinnedRuntime(run), RuntimeFailure);
    assert.equal(calls.some(({ args }) => args[0] === "image" && args[1] === "tag"), false);
  }
}));

test("runtime verification requires exact running local container image and project label", () => localEnvironment(() => {
  const { run, calls } = fixture();
  assert.match(verifyPinnedRuntime(run), /linux\/amd64 manifest sha256:/);
  assert.equal(calls[2].args.at(-1), database.configDigest);
  assert.equal(calls.at(-1).args.at(-1), databaseContainer);
  for (const container of [database.configDigest + "|exited|" + disposableProject, database.configDigest + "|running|unrelated", "sha256:unexpected|running|" + disposableProject]) {
    assert.throws(() => verifyPinnedRuntime(fixture({ container }).run), RuntimeFailure);
  }
}));
