import { spawn } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { connectHeadlessChrome } from "../../lib/headlessChrome.mjs";

/** Headed Chrome with a disposable, signed-out profile. No interception flags. */
export async function openChrome(directory, { binary = process.env.CHROME_BIN } = {}) {
  const executable = binary ?? (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome");
  await access(executable);
  const profile = path.join(directory, "profile");
  await mkdir(profile, { recursive: true });
  const child = spawn(executable, ["--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--disable-sync",
    "--disable-background-networking", "--disable-component-update",
    "--disable-extensions", "--user-data-dir=" + profile, "--window-size=1280,720", "about:blank"],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const chrome = connectHeadlessChrome(child);
  return { chrome, async close() { try { await chrome.close(); } finally { await rm(profile, { recursive: true, force: true }); } } };
}

/** Attach only to an explicitly supplied loopback debug port. Never closes the user's browser. */
export async function connectWatcher(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid debug port");
  const info = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000), redirect: "error" }).then(r => r.json());
  const address = new URL(info.webSocketDebuggerUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(address.hostname) || address.protocol !== "ws:") throw new Error("Debug endpoint must be loopback");
  const socket = new WebSocket(address);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { socket.close(); } catch { /* Connecting socket may reject close. */ } reject(new Error("Watcher connection timed out")); }, 10000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Watcher connection failed")); }, { once: true });
  });
  const pending = new Map(), listeners = new Set(); let next = 0;
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message)); else item.resolve(message.result);
    } else for (const listener of listeners) listener(message);
  });
  socket.addEventListener("close", () => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Watcher disconnected")); } pending.clear(); });
  return { send(method, params = {}, sessionId) { return new Promise((resolve, reject) => {
    const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  }); }, onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); }, async close() {
    if (socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Watcher disconnect timed out")), 5000);
      socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.close();
    });
  } };
}
