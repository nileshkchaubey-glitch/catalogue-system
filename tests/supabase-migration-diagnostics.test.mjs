import assert from "node:assert/strict";
import test from "node:test";
import {
  describeMigrationError, localCommand, migrationFailure, migrationPsqlArgs,
} from "./integration/supabase-migration-diagnostics.mjs";

const secret = "postgres://gate:synthetic-secret@localhost/test";
const sql = Buffer.from("-- é\n\ncreate role example;\nselect 'synthetic-secret';\n");
const container = "supabase_db_catalogue-api-gate-disposable";

test("migration command keeps psql atomic and gives the original UTF-8 input to the child", () => {
  const args = migrationPsqlArgs(container);
  assert.deepEqual(args.slice(0, 7), ["exec", "-i", "-e", "LC_ALL=C", "-e", "PGCLIENTENCODING=UTF8", container]);
  assert.ok(args.includes("ON_ERROR_STOP=1"));
  assert.ok(args.includes("VERBOSITY=sqlstate"));
  assert.deepEqual(args.slice(-6), ["--echo-all", "-o", "/dev/null", "-1", "-f", "-"]);

  const result = localCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], sql);
  assert.equal(result.status, 0);
  assert.deepEqual(Buffer.from(result.stdout), sql);
});

test("SQLSTATE and reported line are allowlisted even with private stderr", () => {
  const result = describeMigrationError({
    status: 3,
    stderr: "psql:<stdin>:4: ERROR:  42501\r\nDETAIL: " + secret,
  }, sql, 3);
  assert.match(result, /exit 3 .* SQLSTATE 42501 .* psql reported history insert input line 4/);
  assert.doesNotMatch(result, /synthetic-secret|DETAIL|localhost/);
});

test("disconnects identify the last echoed migration line without printing SQL", () => {
  const result = describeMigrationError({
    status: 2,
    stdout: "-- é\ncreate role example;\nselect 'synthetic",
    stderr: "server closed the connection unexpectedly\n" + secret,
  }, sql, 4);
  assert.match(result, /exit 2 .* no SQLSTATE .* last echoed migration SQL line 3 .* connection lost/);
  assert.doesNotMatch(result, /synthetic|create role|-- é/);
  assert.match(describeMigrationError({
    status: 2,
    stderr: "psql:<stdin>:3: error: connection to server was lost",
  }, sql, 4), /psql reported migration SQL line 3/);
  assert.doesNotMatch(describeMigrationError({
    status: 2, stdout: "unrecognized-output\n",
  }, sql, 4), /migration SQL line/);
});

test("command timeout, output cap, signal and launch failures remain distinct", () => {
  const timeout = localCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], undefined, 150);
  assert.match(describeMigrationError(timeout, sql, 4), /timed out/);
  const overflow = localCommand(process.execPath, ["-e", "console.log('x'.repeat(50000))"], undefined, 5000, 1024);
  assert.match(describeMigrationError(overflow, sql, 4), /output limit exceeded/);
  assert.match(describeMigrationError({ status: null, signal: "SIGTERM" }, sql, 4), /SIGTERM/);
  assert.match(describeMigrationError({ status: null, error: { code: "ENOENT", message: secret } }, sql, 4), /executable unavailable/);
  assert.doesNotMatch(describeMigrationError({ status: null, error: { code: secret } }, sql, 4), /synthetic-secret/);
});

test("failure collection bounds Docker evidence and emits only fixed fields and categories", () => {
  const startedAt = "2026-11-27T18:32:54.000Z";
  const digest = "sha256:" + "a".repeat(64);
  const responses = [
    { status: 0, stdout: "public.ecr.aws/supabase/postgres:17.6.1.106|" + digest + "|running|0|false|0\n" },
    { status: 0, stdout: "170006|f\n" },
    {
      status: 0,
      stdout: "2026-11-27 18:32:54.000 UTC [1] LOG:  server process (PID 922) was terminated by signal 11: Segmentation fault\n",
      stderr: "DETAIL:  Failed process was running: " + secret +
        "\nLOG:  database system was not properly shut down; automatic recovery in progress" +
        "\n172.18.0.10 2026-11-27 18:32:54.020 UTC [3] auth@postgres FATAL:  could not map shared memory segment" +
        "\nERROR:  server process (PID 555) was terminated by signal 9\n",
    },
  ];
  const commands = [];
  const result = migrationFailure(container, { status: 2 }, sql, 4, startedAt, (command, args, input, timeout, maxBuffer) => {
    commands.push({ command, args, input, timeout, maxBuffer });
    return responses.shift();
  });
  assert.equal(commands.length, 3);
  assert.ok(commands.every(({ command, args, input, timeout }) =>
    command === "docker" && args.includes(container) && input === undefined && timeout === 4000));
  assert.deepEqual(commands[2].args, ["logs", "--since", startedAt, "--tail", "80", container]);
  assert.equal(commands[2].maxBuffer, 256 * 1024);
  assert.match(commands[1].args.at(-1), /^select /);
  assert.match(result, /17\.6\.1\.106.*running, exit 0, OOM false, restarts 0/);
  assert.match(result, /socket probe online, PostgreSQL 170006, superuser false/);
  assert.match(result, /recent database logs backend SIGSEGV, recovery, shared memory error/);
  assert.doesNotMatch(result, /synthetic-secret|922|DETAIL|172\.18|kill or memory pressure/);
});

test("failed diagnostics preserve the original failure and do not disclose command output", () => {
  const results = [
    { status: 1, stdout: secret },
    { status: 2, stderr: "connection refused " + secret },
    { status: null, error: { code: "ETIMEDOUT", message: secret } },
  ];
  const result = migrationFailure(container, { status: 2 }, sql, 4, "2026-11-27T18:32:54.000Z", () => results.shift());
  assert.match(result, /docker exec\/psql exit 2.*database container exit 1.*socket probe exit 2, socket unavailable.*database logs timed out/);
  assert.doesNotMatch(result, /synthetic-secret/);
});
