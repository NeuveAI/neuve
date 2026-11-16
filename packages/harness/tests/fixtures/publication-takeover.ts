import { mock } from "bun:test";
import * as filesystem from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { publicationHost } from "./publication-host.ts";

const hostId = z.uuid().parse(Bun.argv[2]);
const phase = z.enum(["ready", "retired"]).parse(Bun.argv[3] ?? "ready");
const original = { ...filesystem };
mock.module("node:fs/promises", () => ({
  ...original,
  rename: async (from: string, to: string) => {
    if (phase === "ready" && String(from).includes("/ready-")) {
      process.stdout.write("interrupted-after-ready-write\n");
      process.exit(23);
    }
    const result = await original.rename(from, to);
    if (phase === "retired" && String(to).includes("/retired-")) {
      process.stdout.write("interrupted-after-retirement\n");
      process.exit(23);
    }
    return result;
  },
}));
const { sharedPublication } = await import("../../src/shared-publication.ts");
const host = publicationHost(process.env.NEUVE_BUDGET_DIRECTORY ?? "");
const copy = sharedPublication({
  namespace: "shared-indexes-v4",
  scope: "store",
  key: "same-key",
  group: "tree",
  schema: z.object({
    publication: z.uuid(),
    outcome: z.object({ kind: z.literal("succeeded"), value: z.number() }),
  }),
  reusable: () => false,
  authority: (scope) => ({ ...host.authority(scope), host: () => hostId }),
});
await copy.publish({
  publication: randomUUID(),
  outcome: { kind: "succeeded", value: 1 },
});
if (phase === "retired")
  await copy.publish({
    publication: randomUUID(),
    outcome: { kind: "succeeded", value: 2 },
  });
