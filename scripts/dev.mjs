import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const port = args.includes("--port")
  ? args[args.indexOf("--port") + 1]
  : process.env.PORT || "5173";
const child = spawn(
  process.execPath,
  [
    fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    port,
    "--show-interactive-dev-session=false",
  ],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
