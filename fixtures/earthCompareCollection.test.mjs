import test from "node:test";
import assert from "node:assert/strict";
import { collect } from "../scripts/benchmarks/earth-compare/run.mjs";

function fixture() {
  const calls = [], listeners = new Set();
  const emit = event => { for (const listener of listeners) listener(event); };
  const chrome = {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async send(method) {
      calls.push(method);
      if (method === "Runtime.evaluate") throw new Error("Navigation replaced the execution context");
      if (method === "Performance.getMetrics") return { metrics: [{ name: "Timestamp", value: 1 }, { name: "TaskDuration", value: 1 }, { name: "JSHeapUsedSize", value: 10 }] };
      if (method === "SystemInfo.getProcessInfo") return { processInfo: [] };
      if (method === "Page.captureScreenshot") {
        emit({ method: "Page.screencastFrame", sessionId: "page", params: { sessionId: 1, data: "aW1hZ2U=", metadata: { timestamp: Date.now() / 1000 } } });
        return { data: "aW1hZ2U=" };
      }
      if (method === "Tracing.end") emit({ method: "Tracing.tracingComplete", params: {} });
      return {};
    },
  };
  const ports = { sample: async () => ({ atMs: 1000, wallClock: "fixture", memory: null, thermal: null,
    processes: null, gpu: null, power: null, cpus: null, secondsSinceInput: null, costMs: 0 }) };
  return { chrome, calls, listeners, ports };
}

test("the final reference is captured while the screencast remains active", async () => {
  const f = fixture();
  const result = await collect(f.chrome, "page", { durationMs: 0, powerMode: "observe", contention: "shared", ports: f.ports });
  assert.ok(f.calls.indexOf("Page.captureScreenshot") < f.calls.indexOf("Page.stopScreencast"));
  assert.ok(result.frames.length >= 1);
  assert.equal(f.listeners.size, 0);
});

test("navigation polling failures cannot leave tracing or event listeners running", async () => {
  const f = fixture();
  const result = await collect(f.chrome, "page", { durationMs: 0, action: { poseTarget: "google-earth" },
    powerMode: "observe", contention: "shared", ports: f.ports });
  assert.ok(result.problems.includes("pose-or-power-poll-failed"));
  assert.ok(f.calls.includes("Tracing.end")); assert.ok(f.calls.includes("Page.stopScreencast"));
  assert.equal(f.listeners.size, 0);
});

test("an action failure still retires the trace and listener", async () => {
  const f = fixture();
  await assert.rejects(collect(f.chrome, "page", { durationMs: 0, action: { run: async () => { throw new Error("action failed"); } },
    powerMode: "observe", contention: "shared", ports: f.ports }), /action failed/);
  assert.ok(f.calls.includes("Tracing.end")); assert.equal(f.listeners.size, 0);
});

test("motion boundary poses are read from the page with measured times", async () => {
  const f = fixture(), send = f.chrome.send;
  f.chrome.send = async (method, ...args) => method === "Runtime.evaluate"
    ? { result: { value: "https://earth.google.com/web/@37,-121,0a,1500d,45y,0h,60t,0r" } } : send(method, ...args);
  const result = await collect(f.chrome, "page", { durationMs: 0, action: { poseTarget: "google-earth", run: async () => {} },
    powerMode: "observe", contention: "shared", ports: f.ports });
  assert.deepEqual(result.poses.filter(row => row.boundary).map(row => row.boundary), ["start", "end"]);
  assert.ok(result.poses.every(row => row.timeMs >= 0 && row.readSpanMs >= 0));
  assert.ok(result.poses.find(row => row.boundary === "end").timeMs >= result.actionEndMs);
});
