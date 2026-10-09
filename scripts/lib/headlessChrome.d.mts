import type { ChildProcess, SpawnOptions } from "node:child_process";
export interface HeadlessChromePorts {
  access?(path: string): Promise<unknown>;
  spawn?(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  setTimeout?(work: () => void, milliseconds: number): unknown;
  clearTimeout?(handle: unknown): void;
}
export interface HeadlessChrome {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  onEvent(listener: (message: unknown) => void): () => void;
  /** Asks Chrome to close, then awaits natural exit; sends no process signal. */
  close(): Promise<void>;
}
export function openHeadlessChrome(profileDirectory: string, explicitBinary?: string, extraArgs?: readonly string[], ports?: HeadlessChromePorts): Promise<HeadlessChrome>;
/** Supplied child must have the stderr and pipe descriptors used by openHeadlessChrome. */
export function connectHeadlessChrome(child: ChildProcess, ports?: HeadlessChromePorts): HeadlessChrome;
export function evaluate(chrome: HeadlessChrome, sessionId: string, expression: string): Promise<unknown>;
export function waitForExpression(chrome: HeadlessChrome, sessionId: string, expression: string, timeoutMs?: number): Promise<void>;
