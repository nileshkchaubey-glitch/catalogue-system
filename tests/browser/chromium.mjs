import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function waitFor(check, description, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw Error("Timed out waiting for " + description);
}

function findChromium() {
  const configured = process.env.CHROMIUM_PATH;
  const candidates = configured ? [configured] : [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const executable = candidates.find(existsSync);
  if (!executable) throw Error("Set CHROMIUM_PATH to a local Chromium executable.");
  return executable;
}

function debuggerFor(socket) {
  let nextId = 0;
  const pending = new Map();
  const sessions = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(Error(request.method + ": " + message.error.message));
      else request.resolve(message.result);
    } else {
      sessions.get(message.sessionId)?.(message.method, message.params);
    }
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(Error("Chromium disconnected during " + request.method));
    }
    pending.clear();
  });
  return {
    sessions,
    send(method, params = {}, sessionId) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error("Chromium did not answer " + method));
        }, 5000);
        pending.set(id, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
  };
}

export async function launchChromium({ executable = findChromium() } = {}) {
  const profile = await mkdtemp(join(tmpdir(), "catalogue-browser-"));
  let child;
  try {
    child = spawn(executable, [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-crash-reporter",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-proxy-server",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  } catch (error) {
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  let startupError;
  let processStopped = false;
  let socket;
  let debug;
  const stopped = new Promise((resolve) => {
    child.once("error", (error) => { startupError = error; processStopped = true; resolve(); });
    child.once("close", () => { processStopped = true; resolve(); });
  });
  let closing;
  function close() {
    return closing ??= (async () => {
      if (debug) await debug.send("Browser.close").catch(() => {});
      socket?.close();
      await Promise.race([stopped, delay(2000, undefined, { ref: false })]);
      if (!processStopped && child.pid) {
        child.kill();
        await Promise.race([stopped, delay(2000, undefined, { ref: false })]);
      }
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    })();
  }
  try {
    const [port, route] = await waitFor(async () => {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw Error("Chromium exited during startup with code " + child.exitCode +
          (child.signalCode ? " and signal " + child.signalCode : ""));
      try {
        const lines = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).trim().split(/\r?\n/);
        return lines.length >= 2 && lines;
      } catch (error) {
        // Chrome briefly holds this file exclusively while publishing the debugger port on Windows.
        if (!["ENOENT", "EBUSY"].includes(error.code)) throw error;
      }
    }, "Chromium startup", 12000);
    socket = new WebSocket("ws://127.0.0.1:" + port + route);
    let connectionError;
    socket.addEventListener("error", () => { connectionError = Error("Chromium debugger connection failed"); });
    await waitFor(() => {
      if (connectionError) throw connectionError;
      if (socket.readyState === WebSocket.CLOSED) throw Error("Chromium debugger connection closed");
      return socket.readyState === WebSocket.OPEN;
    }, "Chromium debugger connection");
    debug = debuggerFor(socket);
    const version = (await debug.send("Browser.getVersion")).product;
    return {
      close,
      version,
      newPage: (origin, viewport) => newPage(debug, origin, viewport),
    };
  } catch (error) {
    let cleanupIssue = "";
    await close().catch((issue) => { cleanupIssue = "\nTemporary profile cleanup failed: " + issue.message; });
    const permissionHint = process.platform === "win32" &&
      (error.code === "EPERM" || /crash server failed to launch|TransactNamedPipe/i.test(stderr))
      ? "\nIf using a restricted Windows runner, rerun with approved normal process permissions. Keep the browser sandbox enabled."
      : "";
    throw new Error("Could not start Chromium at " + executable + ": " + error.message +
      (stderr.trim() ? "\nBrowser stderr:\n" + stderr.trim() : "") + permissionHint + cleanupIssue, { cause: error });
  }
}

const keys = { Tab: 9, Enter: 13, Escape: 27, Space: 32, KeyS: 83 };

async function newPage(debug, origin, { width, height, mobile = false }) {
  const { browserContextId } = await debug.send("Target.createBrowserContext");
  const { targetId } = await debug.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await debug.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => debug.send(method, params, sessionId);
  const errors = [];
  const outside = [];
  debug.sessions.set(sessionId, (method, params) => {
    if (method === "Runtime.exceptionThrown")
      errors.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
    if (method !== "Fetch.requestPaused") return;
    const { url } = params.request;
    const requestId = params.requestId;
    const allowed = new URL(url).origin === origin || url.startsWith("data:");
    const order = allowed ? send("Fetch.continueRequest", { requestId }) :
      send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    if (!allowed) outside.push(url);
    order.catch((error) => errors.push(error.message));
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Fetch.enable", { patterns: [{ urlPattern: "http*" }] });
  await send("Emulation.setDeviceMetricsOverride", { width, height, mobile, deviceScaleFactor: 1 });
  if (mobile) await send("Emulation.setTouchEmulationEnabled", { enabled: true });

  async function evaluate(expression) {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails)
      throw Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  async function visible(expression) {
    return evaluate("Boolean(" + expression + ")");
  }
  async function navigate(path = "/") {
    const previous = await evaluate("performance.timeOrigin");
    await send("Page.navigate", { url: origin + path });
    await waitFor(async () => {
      try {
        return await evaluate("location.pathname === " + JSON.stringify(path) +
          " && document.readyState === 'complete' && performance.timeOrigin !== " + previous);
      } catch (error) {
        if (!error.message.includes("context")) throw error;
      }
    }, "document load");
  }
  async function focus(expression) {
    await waitFor(() => visible(expression), "focus target " + expression);
    await evaluate("(" + expression + ").focus()");
  }
  async function click(expression) {
    await waitFor(() => visible(expression), "click target " + expression);
    const point = await evaluate(`(() => {
      const element = (${expression});
      element.scrollIntoView({ block: "center", inline: "center" });
      const box = element.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    if (mobile) {
      await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
    }
  }
  return {
    errors, outside, navigate, evaluate, visible, click, focus,
    type: (text) => send("Input.insertText", { text }),
    async key(code, modifiers = 0) {
      const event = { code, key: code === "Space" ? " " : code === "KeyS" ? "s" : code,
        windowsVirtualKeyCode: keys[code], modifiers };
      // Enter and Space need a character event for native form and control activation.
      const text = code === "Enter" ? "\r" : code === "Space" ? " " : "";
      await send("Input.dispatchKeyEvent", text
        ? { ...event, type: "keyDown", text, unmodifiedText: text }
        : { ...event, type: "rawKeyDown" });
      await send("Input.dispatchKeyEvent", { ...event, type: "keyUp" });
    },
    async close() {
      debug.sessions.delete(sessionId);
      await debug.send("Target.disposeBrowserContext", { browserContextId });
    },
  };
}
