import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

/**
 * Headless Chrome control through inherited pipes; no HTTP server or
 * listener. Commands time out; close waits for natural process exit.
 * `extraArgs` adds command-line switches, such as
 * `--enable-webgpu-developer-features`. Adapted from the retained Earth helper; no process signals are sent.
 */
export async function openHeadlessChrome(profileDirectory, explicitBinary = process.env.CHROME_BIN, extraArgs = [], ports = {}) {
  const candidates = explicitBinary ? [explicitBinary] : [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome", "/usr/bin/chromium",
  ];
  let executable;
  for (const candidate of candidates) {
    try { await (ports.access ?? access)(candidate); executable = candidate; break; } catch { /* Try the next installed binary. */ }
  }
  if (!executable) throw new Error("No installed Chrome found; set CHROME_BIN to an existing executable.");
  const child = (ports.spawn ?? spawn)(executable, [
    "--headless=new", "--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-extensions",
    "--disable-sync", "--mute-audio", "--user-data-dir=" + profileDirectory, ...extraArgs, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const chrome = connectHeadlessChrome(child, ports);
  try { await chrome.send("Browser.getVersion"); }
  catch (error) { try { throw error; } finally { await chrome.close(); } }
  return chrome;
}

/** Pipe protocol with injected child/timers for causal source tests, never signals a process. */
export function connectHeadlessChrome(child, ports = {}) {
  const schedule = ports.setTimeout ?? setTimeout, unschedule = ports.clearTimeout ?? clearTimeout;
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1, buffer = "", stderr = "", closed = false, closing;
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-16000); });
  const rejectAll = error => {
    for (const item of pending.values()) { unschedule(item.timer); item.reject(error); }
    pending.clear();
  };
  child.on("error", error => {
    rejectAll(error);
    // A failed spawn has no process to wait for. An error after spawn still
    // needs an observed natural exit; it never authorizes a signal.
    if (child.pid === undefined) { closed = true; resolveExit(); }
  });
  child.on("exit", code => {
    closed = true;
    resolveExit();
    rejectAll(new Error("Headless Chrome exited (" + code + "): " + stderr));
  });
  child.stdio[4].on("data", bytes => {
    buffer += bytes.toString();
    let separator;
    while ((separator = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 1);
      if (message.id) {
        const item = pending.get(message.id);
        if (!item) continue;
        pending.delete(message.id); unschedule(item.timer);
        if (message.error) item.reject(new Error(message.error.message));
        else item.resolve(message.result);
      } else for (const listener of listeners) listener(message);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("Headless Chrome is closed")); return; }
    const id = nextId++;
    const timer = schedule(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for Chrome " + method));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  return {
    send,
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() {
      if (!closing) closing = (async () => {
        try {
          if (!closed) { try { await send("Browser.close"); } catch { /* The pipe may close before its response. */ } }
        } finally {
          // Chrome removes its code-sign clone while shutting down. Even a
          // protocol timeout cannot authorize a signal or an early return.
          await exited;
        }
      })();
      return closing;
    },
  };
}

export async function evaluate(chrome, sessionId, expression) {
  const result = await chrome.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

export async function waitForExpression(chrome, sessionId, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(chrome, sessionId, expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("Headless condition did not become true: " + expression);
}
