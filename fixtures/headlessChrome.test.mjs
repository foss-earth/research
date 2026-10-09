import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { connectHeadlessChrome, openHeadlessChrome } from "../scripts/lib/headlessChrome.mjs";

function fakeChild() {
  const child = new EventEmitter(); child.pid = 123;
  child.stderr = new EventEmitter(); child.stdio = Array.from({ length: 5 }, () => new EventEmitter());
  const sent = [], timers = new Map(); let next = 0, signals = 0;
  child.kill = () => { signals++; throw new Error("A signal must never be sent."); };
  child.stdio[3].write = text => { sent.push(JSON.parse(text.slice(0, -1))); };
  const ports = { setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); } };
  const reply = (message, result = {}) => child.stdio[4].emit("data", Buffer.from(JSON.stringify({ id: message.id, result }) + "\0"));
  const expire = () => { const entries = [...timers]; timers.clear(); for (const [, callback] of entries) callback(); };
  return { child, sent, ports, reply, expire, signals: () => signals };
}
test("close waits for natural exit after a successful Browser.close response", async () => {
  const f = fakeChild(), chrome = connectHeadlessChrome(f.child, f.ports);
  let returned = false; const pending = chrome.close().then(() => { returned = true; });
  assert.equal(f.sent[0].method, "Browser.close"); f.reply(f.sent[0]);
  await Promise.resolve(); await Promise.resolve(); assert.equal(returned, false);
  f.expire(); assert.equal(f.signals(), 0); assert.equal(returned, false);
  f.child.emit("exit", 0); await pending; await chrome.close(); assert.equal(f.sent.length, 1);
});
test("a close protocol timeout still waits and never kills the browser", async () => {
  const f = fakeChild(), chrome = connectHeadlessChrome(f.child, f.ports);
  let returned = false; const pending = chrome.close().then(() => { returned = true; });
  f.expire(); await Promise.resolve(); await Promise.resolve();
  assert.equal(returned, false); assert.equal(f.signals(), 0);
  f.child.emit("exit", 0); await pending;
});
test("initial probe failure requests Browser.close and waits for natural exit", async () => {
  const f = fakeChild();
  const pending = openHeadlessChrome("unused-test-profile", "fake", [], { ...f.ports, access: async () => {}, spawn: () => f.child });
  const rejected = assert.rejects(pending, /Browser.getVersion/);
  await Promise.resolve(); await Promise.resolve(); f.expire();
  await Promise.resolve(); await Promise.resolve();
  const close = f.sent.find(message => message.method === "Browser.close"); assert.ok(close); f.reply(close);
  assert.equal(f.signals(), 0); f.child.emit("exit", 0); await rejected;
});
