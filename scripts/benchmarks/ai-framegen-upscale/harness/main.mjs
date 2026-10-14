/** Page start/poll protocol: long jobs never occupy one CDP evaluate call. */
import { getContext, parityJob, coldLoad } from "./parity.mjs";

const jobs = new Map();
let serial = 0, busy = false;
window.aiHarness = {
  ready: true,
  start(kind, params = {}) {
    if (busy) throw new Error("harness already has a running job");
    const id = `job-${++serial}`;
    const state = { done: false, ok: false, progress: "starting" };
    jobs.set(id, state); busy = true;
    const progress = value => { state.progress = value; };
    Promise.resolve().then(async () => {
      if (kind === "init") { const gpu = await getContext(); return { gpu: gpu.record, errors: gpu.errors, isolated: crossOriginIsolated, secure: isSecureContext }; }
      if (kind === "parity") return parityJob(params, progress);
      if (kind === "deviceParity" || kind === "fullPath" || kind === "conversionSelfTest") return parityJob({ ...params, action: kind }, progress);
      if (kind === "coldLoad") return coldLoad(params, progress);
      if (kind.startsWith("timing")) {
        const pipelines = await import("./pipelines.mjs");
        if (typeof pipelines[kind] !== "function") throw new Error(`unsupported timing job ${kind}`);
        return pipelines[kind](params, progress);
      }
      throw new Error(`unknown job ${kind}`);
    }).then(value => { state.value = value; state.ok = true; }).catch(error => { state.error = String(error.stack ?? error); }).finally(() => { state.done = true; busy = false; });
    return id;
  },
  poll(id) {
    const state = jobs.get(id);
    if (!state) throw new Error(`unknown job ${id}`);
    // Keep completed jobs bounded, while retaining the requested state for polling.
    if (jobs.size > 8) for (const [key, value] of jobs) if (key !== id && value.done) { jobs.delete(key); break; }
    return state;
  },
};
