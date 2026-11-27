import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const port = args.includes("--port")
  ? args[args.indexOf("--port") + 1]
  : process.env.PORT || "5173";
const child = spawn(
  "wrangler",
  [
    "dev",
    "--local",
    "--ip",
    "0.0.0.0",
    "--port",
    port,
    "--show-interactive-dev-session=false",
  ],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
