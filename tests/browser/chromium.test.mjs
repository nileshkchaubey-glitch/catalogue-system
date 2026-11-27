import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchChromium } from "./chromium.mjs";

test("Chromium startup exposes browser stderr and removes the failed profile", { timeout: 15000 }, async () => {
  // Node is an installed executable that rejects Chromium's command-line options.
  let failure;
  await assert.rejects(launchChromium({ executable: process.execPath }), (error) => {
    failure = error;
    assert.ok(error.message.includes(process.execPath));
    assert.match(error.message, /Chromium exited during startup with code/);
    assert.match(error.message, /Browser stderr:/);
    assert.match(error.message, /bad option: --headless=new/);
    assert.match(error.cause.message, /Chromium exited during startup/);
    return true;
  });
  const profile = /--user-data-dir=([^\r\n]+)/.exec(failure.message)?.[1];
  assert.ok(profile, "the failed executable reports its disposable profile path");
  await assert.rejects(access(profile), { code: "ENOENT" });
});

test("Chromium startup retains the original spawn error for a missing executable", { timeout: 15000 }, async () => {
  const executable = join(tmpdir(), "catalogue-missing-" + randomUUID() + ".exe");
  await assert.rejects(launchChromium({ executable }), (error) => {
    assert.ok(error.message.includes(executable));
    assert.equal(error.cause.code, "ENOENT");
    assert.doesNotMatch(error.message, /Temporary profile cleanup failed/);
    return true;
  });
});
