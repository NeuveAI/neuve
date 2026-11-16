// Synthetic latency on real filesystem operations, installed before loading the authority.
import * as fs from "node:fs";
import { mock } from "bun:test";

export const inspectionFilesystemProbe = (delayMs: number) => {
  const original = { ...fs };
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let active = false;
  const calls = new Map<string, { count: number; elapsedMs: number }>();
  const timed = <T>(name: string, operation: () => T): T => {
    if (!active) return operation();
    const start = performance.now();
    try {
      if (delayMs >= 0.1) Atomics.wait(sleeper, 0, 0, delayMs);
      else if (delayMs > 0) {
        const until = performance.now() + delayMs;
        while (performance.now() < until) {}
      }
      return operation();
    } finally {
      const prior = calls.get(name) ?? { count: 0, elapsedMs: 0 };
      prior.count++;
      prior.elapsedMs += performance.now() - start;
      calls.set(name, prior);
    }
  };
  mock.module("node:fs", () => ({
    ...original,
    existsSync: (...args: Parameters<typeof fs.existsSync>) =>
      timed("exists", () => original.existsSync(...args)),
    realpathSync: (...args: Parameters<typeof fs.realpathSync>) =>
      timed("realpath", () => original.realpathSync(...args)),
    statSync: (...args: Parameters<typeof fs.statSync>) =>
      timed("stat", () => original.statSync(...args)),
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) =>
      timed("lstat", () => original.lstatSync(...args)),
  }));
  return {
    start: () => {
      calls.clear();
      active = true;
    },
    stop: () => {
      active = false;
      return {
        delayMs,
        calls: Object.fromEntries(calls),
        count: [...calls.values()].reduce((n, c) => n + c.count, 0),
        elapsedMs: [...calls.values()].reduce((n, c) => n + c.elapsedMs, 0),
      };
    },
  };
};
