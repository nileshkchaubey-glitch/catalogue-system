import { spawnSync } from "node:child_process";

const clientMessages = [
  [/server closed the connection unexpectedly|connection to server was lost|could not receive data from server|connection reset by peer/i, "connection lost"],
  [/the database system is (?:starting up|in recovery mode|shutting down)/i, "database unavailable"],
  [/connection refused|no such file or directory/i, "socket unavailable"],
  [/password authentication failed|no password supplied|peer authentication failed/i, "authentication failed"],
  [/invalid byte sequence|invalid input syntax for .*encoding/i, "encoding error"],
  [/statement timeout|lock timeout|canceling statement/i, "statement canceled"],
  [/container .* is (?:not running|restarting)|no such container/i, "container unavailable"],
  [/cannot connect to the docker daemon|error during connect/i, "Docker unavailable"],
];

const serverMessages = [
  [/^LOG: server process \(PID \d+\) was terminated by signal 11\b/im, "backend SIGSEGV"],
  [/^(?:LOG: server process \(PID \d+\) was terminated by signal 9\b|(?:PANIC|FATAL|ERROR): out of memory)/im, "kill or memory pressure"],
  [/^LOG: server process \(PID \d+\) (?:was terminated by signal (?!9\b|11\b)\d+|exited with exit code)/im, "backend terminated"],
  [/^LOG: (?:terminating any other active server processes|all server processes terminated; reinitializing)/im, "server reinitializing"],
  [/^(?:LOG: (?:database system was interrupted|database system was not properly shut down; automatic recovery in progress)|FATAL: the database system is in recovery mode)/im, "recovery"],
  [/^LOG: database system is ready to accept connections/im, "ready"],
  [/^(?:LOG: (?:received .* shutdown request|database system is shut down)|FATAL: terminating connection due to administrator command)/im, "shutdown"],
  [/^(?:PANIC|FATAL|ERROR): could not (?:resize|create|map) shared memory segment/im, "shared memory error"],
];

const processErrors = {
  ETIMEDOUT: "timed out",
  ENOBUFS: "output limit exceeded",
  ENOENT: "executable unavailable",
  EACCES: "permission denied launching process",
  EPERM: "permission denied launching process",
  EPIPE: "input pipe closed",
};

export function localCommand(command, args, input, timeout = 25000, maxBuffer = 1024 * 1024) {
  return spawnSync(command, args, { input, encoding: "utf8", timeout, maxBuffer, windowsHide: true });
}

function psqlArgs(container) {
  return [
    "exec", "-i", "-e", "LC_ALL=C", "-e", "PGCLIENTENCODING=UTF8", container,
    "psql", "-X", "-w", "-qAt", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate",
    "-U", "postgres", "-d", "postgres",
  ];
}

export function migrationPsqlArgs(container) {
  // Keep the input echo private. Discard row output so it cannot be mistaken for input.
  return [...psqlArgs(container), "--echo-all", "-o", "/dev/null", "-1", "-f", "-"];
}

export function commandStatus(result) {
  if (result.error) return Object.hasOwn(processErrors, result.error.code)
    ? processErrors[result.error.code] : "process error";
  if (/^SIG[A-Z0-9]+$/.test(result.signal ?? "")) return result.signal;
  return Number.isSafeInteger(result.status) ? "exit " + result.status : "process did not complete";
}

function categories(output, messages) {
  return messages.filter(([pattern]) => pattern.test(output)).map(([, category]) => category);
}

function lastEchoedLine(stdout, inputLines) {
  const echoed = (stdout ?? "").split(/\r?\n/);
  // A killed child can leave a partial final line.
  echoed.pop();
  const nonempty = echoed.filter((line) => line !== "");
  let cursor = 0;
  let lastLine;
  for (const [index, line] of inputLines.entries()) {
    if (cursor === nonempty.length) return lastLine;
    if (line === "") continue;
    if (nonempty[cursor] !== line) return undefined;
    cursor++;
    lastLine = index + 1;
  }
  return cursor === nonempty.length ? lastLine : undefined;
}

export function describeMigrationError(result, input, sourceLineCount) {
  const inputLines = input.toString().split(/\r?\n/);
  if (inputLines.at(-1) === "") inputLines.pop();
  const stderr = result.stderr ?? "";
  const state = stderr.match(/^(?:psql:(?:<stdin>|-):(\d+): )?(?:psql: error: |error: )?(?:ERROR|FATAL|PANIC):[ \t]+([A-Z0-9]{5})[ \t]*\r?$/m);
  const clientLine = stderr.match(/^psql:(?:<stdin>|-):(\d+): (?:error: )?(?:server closed the connection unexpectedly|connection to server was lost|could not receive data from server)/m);
  const reported = Number(state?.[1] ?? clientLine?.[1]);
  const line = reported > 0 && reported <= inputLines.length ? reported : lastEchoedLine(result.stdout, inputLines);
  const parts = ["docker exec/psql " + commandStatus(result), state ? "SQLSTATE " + state[2] : "no SQLSTATE"];
  if (line !== undefined) {
    const location = sourceLineCount === undefined ? "history setup line " + line :
      line <= sourceLineCount ? "migration SQL line " + line : "history insert input line " + line;
    parts.push((line === reported ? "psql reported " : "last echoed ") + location);
  }
  const observed = categories(stderr, clientMessages);
  parts.push("stderr " + (observed.length ? observed.join(", ") : stderr.trim() ? "uncategorized" : "empty"));
  parts.push("input " + Buffer.byteLength(input) + " bytes");
  return parts.join(" | ");
}

function describeContainer(result) {
  if (result.status !== 0 || result.error) return commandStatus(result);
  const match = result.stdout?.trim().match(/^(\S+)\|(sha256:[a-f0-9]{64})\|(created|restarting|running|removing|paused|exited|dead)\|(\d{1,3})\|(true|false)\|(\d{1,9})$/);
  if (!match) return "unexpected response";
  const [, image, id, status, exit, oom, restarts] = match;
  const tag = /^(?:(?:public\.ecr\.aws|ghcr\.io|docker\.io)\/)?supabase\/postgres:[0-9]+(?:\.[0-9]+)+$/.test(image)
    ? image + " " : "";
  return tag + id + " " + status + ", exit " + exit + ", OOM " + oom + ", restarts " + restarts;
}

export function migrationFailure(container, result, input, sourceLineCount, startedAt, run = localCommand) {
  const inspect = run("docker", [
    "inspect", "--type", "container", "--format",
    "{{.Config.Image}}|{{.Image}}|{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.RestartCount}}",
    container,
  ], undefined, 4000);
  const probe = run("docker", [
    ...psqlArgs(container), "-c",
    "select current_setting('server_version_num'), rolsuper from pg_roles where rolname = current_user",
  ], undefined, 4000);
  const version = probe.stdout?.trim().match(/^([1-9]\d{4,5})\|([tf])$/);
  const probeResult = probe.status === 0 && !probe.error
    ? (version ? "online, PostgreSQL " + version[1] + ", superuser " + (version[2] === "t") : "unexpected response")
    : [commandStatus(probe), ...categories(probe.stderr ?? "", clientMessages)].join(", ");
  const logs = run("docker", ["logs", "--since", startedAt, "--tail", "80", container], undefined, 4000, 256 * 1024);
  const messages = ((logs.stdout ?? "") + "\n" + (logs.stderr ?? ""))
    .split(/\r?\n/)
    .map((line) => {
      const fields = line.match(/^ *(?:(?:\S+ )?\d{4}-\d\d-\d\d[ T][\d:.]+ UTC \[\d+\] (?:\S+ )?)?(LOG|FATAL|PANIC|ERROR):[ \t]+(.+)$/);
      return fields ? fields[1] + ": " + fields[2] : "";
    })
    .join("\n");
  const logResult = logs.status === 0 && !logs.error
    ? categories(messages, serverMessages).join(", ") || "no recognized events"
    : commandStatus(logs);

  return [
    describeMigrationError(result, input, sourceLineCount),
    "database container " + describeContainer(inspect),
    "socket probe " + probeResult,
    "recent database logs " + logResult,
  ].join(" | ");
}
