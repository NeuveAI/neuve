import { test as bunTest } from "bun:test";
import { z } from "zod";

// Bun's --shard divides files. The two large installer files dominate the release suite, so CI divides their
// registrations across runners too. No declaration means the ordinary local suite runs whole.
const configured = process.env.NEUVE_RELEASE_CASE_SHARD;
const shard =
  configured === undefined
    ? undefined
    : z
        .string()
        .regex(/^[1-4]\/4$/)
        .parse(configured)
        .charCodeAt(0) - 49;
export const releaseTest = (test: typeof bunTest): typeof bunTest => {
  let index = 0;
  const divide = (register: typeof bunTest): typeof bunTest =>
    new Proxy(register, {
      apply(target, receiver, args) {
        const assigned = index++ % 4;
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
