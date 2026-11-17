import type { test as bunTest } from "bun:test";
import { z } from "zod";
import timings from "../../tests/release/installer-case-timings.json";

// Bun's --shard divides files. The two large installer files dominate the release suite, so CI
// divides their registrations across runners using observed durations too. No declaration means the ordinary local suite runs whole.
const configured = process.env.NEUVE_RELEASE_CASE_SHARD;
const shard =
  configured === undefined
    ? undefined
    : z
        .string()
        .regex(/^[1-5]\/5$/)
        .parse(configured)
        .charCodeAt(0) - 49;
export const releaseTest = (test: typeof bunTest): typeof bunTest => {
  const loads = [0, 0, 0, 0, 0];
  const estimates: Readonly<Record<string, number>> = timings;
  const divide = (register: typeof bunTest): typeof bunTest =>
    new Proxy(register, {
      apply(target, receiver, args) {
        const assigned = loads.indexOf(Math.min(...loads));
        const name = args[0];
        loads[assigned]! +=
          typeof name === "string" ? (estimates[name] ?? 10_000) : 10_000;
        if (shard === undefined || shard === assigned)
          return Reflect.apply(target, receiver, args);
      },
      get(target, property, receiver) {
        if (property === "skipIf")
          return (condition: boolean) => divide(target.skipIf(condition));
        if (property === "skip") return divide(target.skip);
        return Reflect.get(target, property, receiver);
      },
    });
  return divide(test);
};
