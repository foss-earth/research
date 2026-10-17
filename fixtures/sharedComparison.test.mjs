import test from "node:test";
import assert from "node:assert/strict";
import { sharedSchedule, sharedSummary, runSharedComparison } from "../scripts/benchmarks/earth-compare/shared.mjs";

test("shared schedules balance treatment order and position, reproducibly", () => {
  const schedule = sharedSchedule(12, 99);
  assert.deepEqual(schedule, sharedSchedule(12, 99));
  assert.notDeepEqual(schedule, sharedSchedule(12, 100));
  for (const name of ["a", "b", "control"]) for (const position of [0, 1, 2]) assert.equal(schedule.filter(row => row[position] === name).length, 4);
  for (const n of [0, 5, 13, Infinity]) assert.throws(() => sharedSchedule(n));
});

const trials = (candidate, control = 100) => Array.from({ length: 12 }, (_, pair) => [
  { pair, variant: "a", value: 100, digest: "same", valid: true },
  { pair, variant: "b", value: typeof candidate === "function" ? candidate(pair) : candidate, digest: "same", valid: true },
  { pair, variant: "control", value: typeof control === "function" ? control(pair) : control, digest: "same", valid: true },
]).flat();

test("a stable paired gain is detected but no absolute or W0 claim is produced", () => {
  const result = sharedSummary(trials(80));
  assert.equal(result.result, "candidate-faster"); assert.equal(result.effectPercent.median, -20);
  assert.equal(result.absolutePowerQualified, false); assert.equal(result.w0Qualified, false);
  assert.equal(sharedSummary(trials(120)).result, "candidate-slower");
});

test("noise, same-build drift, missing data and output mismatches remain inconclusive", () => {
  assert.equal(sharedSummary(trials(pair => pair % 2 ? 140 : 60)).result, "inconclusive");
  assert.ok(sharedSummary(trials(80, 140)).reasons.includes("same-build-control-too-noisy"));
  const data = trials(80); data[4].digest = "changed-pixels";
  assert.ok(sharedSummary(data).reasons.includes("incomplete-or-nonidentical-output-pairs"));
  assert.ok(sharedSummary(data.slice(0, 15)).reasons.includes("insufficient-complete-pairs"));
});

test("active-machine disturbances are retained and neither trigger an idle wait nor select results", async () => {
  const a = async () => ({ value: 100, digest: "same", disturbances: ["other-processes-busy", "user-input"] });
  const result = await runSharedComparison({ measureA: a, measureB: async () => ({ value: 80, digest: "same", disturbances: ["memory-pressure"] }) });
  assert.equal(result.trials.length, 36); assert.equal(result.summary.result, "candidate-faster");
  assert.ok(result.trials.every(row => row.disturbances.length));
});

test("the budget ends between complete pairs and failed measurements stay visible", async () => {
  let now = 0;
  const measureA = async () => { now += 400; return { value: 100, digest: "same" }; };
  const measureB = async () => { now += 400; throw new Error("private error must not be retained"); };
  const result = await runSharedComparison({ measureA, measureB, maximumSeconds: 1, clock: () => now });
  assert.equal(result.trials.length, 3); assert.equal(result.budgetExhausted, true);
  assert.equal(result.summary.result, "inconclusive");
  assert.ok(!JSON.stringify(result).includes("private error"));
});
