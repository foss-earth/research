/**
 * Runs a script's own worker mode in several processes: half the cores by
 * default, as the repository's rules ask, and fewer where that many would not
 * fit in memory.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scratchDirectory } from "./environment.mjs";

/**
 * What one worker may need, in GiB, by script: the largest worker measured
 * (0.48, 0.81, 1.18, 1.34 and 3.44 GiB; every run prints its own) and some
 * room. A worker holds a 6144 × 3072 source and its pyramid and one
 * representation's whole hierarchy; the network experiment's grow with the
 * length of the camera trace.
 */
const WORKER_GIB = { "run-reconstruction": 0.6, "run-codec": 1, "run-hierarchy": 1.5, "run-progressive": 1.6, "run-network": 3.5 };
/** The share of the machine's memory the workers together may plan to use. */
const MEMORY_SHARE = 0.5;

const totalGiB = os.totalmem() / 2 ** 30;
const workerGiB = WORKER_GIB[path.basename(process.argv[1] ?? "", ".mjs")] ?? Math.max(...Object.values(WORKER_GIB));
export const defaultProcesses = Math.max(1, Math.min(Math.floor(os.cpus().length / 2), Math.floor(totalGiB * MEMORY_SHARE / workerGiB)));

/**
 * Starts `scriptUrl` once per task with `--worker=<file>`; the worker reads
 * its task with `workerTask()` and answers with `workerDone(result)`. Returns
 * the results in task order.
 */
export async function runWorkers(scriptUrl, tasks, { processes = defaultProcesses, label = "task" } = {}) {
  const script = fileURLToPath(scriptUrl);
  const directory = path.join(scratchDirectory, "workers", `${path.basename(script, ".mjs")}-${process.pid}`);
  mkdirSync(directory, { recursive: true });
  const results = new Array(tasks.length);
  const lanes = Math.min(processes, tasks.length);
  console.log(`  ${lanes} processes at once (${os.cpus().length} cores, ${totalGiB.toFixed(0)} GiB; --processes=N to change)`);
  if (lanes * workerGiB > totalGiB * MEMORY_SHARE) console.log(`  (${lanes} workers may need ${(lanes * workerGiB).toFixed(1)} GiB between them, more than ${MEMORY_SHARE * 100}% of this machine's memory)`);
  let next = 0, largestGiB = 0;
  const started = performance.now();
  async function lane() {
    while (next < tasks.length) {
      const index = next++;
      const file = path.join(directory, `${index}.json`);
      writeFileSync(file, JSON.stringify({ task: tasks[index] }));
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--max-old-space-size=6144", script, `--worker=${file}`], { stdio: ["ignore", "inherit", "inherit"] });
        child.on("error", reject);
        child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`${label} ${index} exited with ${code}`))));
      });
      const answer = JSON.parse(readFileSync(file, "utf8"));
      results[index] = answer.result;
      largestGiB = Math.max(largestGiB, answer.peakGiB ?? 0);
      console.log(`  ${label} ${index + 1}/${tasks.length} done, ${((performance.now() - started) / 1000).toFixed(0)} s elapsed, ${(answer.peakGiB ?? 0).toFixed(2)} GiB at its largest`);
    }
  }
  await Promise.all(Array.from({ length: lanes }, lane));
  console.log(`  largest worker: ${largestGiB.toFixed(2)} GiB`);
  rmSync(directory, { recursive: true, force: true });
  return results;
}

const workerFile = process.argv.find(argument => argument.startsWith("--worker="))?.slice("--worker=".length);
export const isWorker = Boolean(workerFile);
export const workerTask = () => JSON.parse(readFileSync(workerFile, "utf8")).task;
export function workerDone(result) {
  // maxRSS is in kibibytes on every platform Node runs on.
  writeFileSync(workerFile, JSON.stringify({ result, peakGiB: process.resourceUsage().maxRSS / 2 ** 20 }));
}
