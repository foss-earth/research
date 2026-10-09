import type { ChildProcess } from "node:child_process";
import { openHeadlessChrome, connectHeadlessChrome, evaluate, waitForExpression, type HeadlessChrome, type HeadlessChromePorts } from "@foss-earth/research/headless-chrome";
import { newOutputDirectory } from "@foss-earth/research/output-directory";
/** Declaration-only call shapes: this function is never invoked by the harness. */
export async function publicHelperCallShapes(child: ChildProcess, ports: HeadlessChromePorts) {
  const chrome: HeadlessChrome = await openHeadlessChrome("build/validation/profile", "supplied-installed-binary", ["--headless=new"], ports);
  const connected: HeadlessChrome = connectHeadlessChrome(child, ports);
  const stop = chrome.onEvent((message: unknown) => { void message; });
  try {
    const value: unknown = await evaluate(chrome, "fixture-session", "1");
    await waitForExpression(chrome, "fixture-session", "true", 1000);
    const response: unknown = await connected.send("Fixture.method", { fixture: true }, "fixture-session");
    const output: string = newOutputDirectory("validation", "fixture");
    return { value, response, output };
  } finally { stop(); await chrome.close(); }
}
const ports: HeadlessChromePorts = { setTimeout: work => ({ work }), clearTimeout: () => {} };
void ports;
