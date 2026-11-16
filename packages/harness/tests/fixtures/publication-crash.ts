import { mock } from "bun:test";
import * as filesystem from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { publicationHost } from "./publication-host.ts";
const original = { ...filesystem };
mock.module("node:fs/promises", () => ({
  ...original,
  rename: async (from: string, to: string) => {
    if (String(from).includes("/ready-")) {
      process.stdout.write(
        JSON.stringify({ killedBeforeInstall: String(from) }) + "\n",
      );
      process.exit(23);
    }
    return original.rename(from, to);
  },
}));
const { sharedPublication } = await import("../../src/shared-publication.ts");
const key = Bun.argv[2];
if (!key) throw new Error("Key required");
const authority = publicationHost(process.env.NEUVE_BUDGET_DIRECTORY ?? "");
await sharedPublication({
  namespace: "shared-indexes-v4",
  scope: "store",
  key,
  group: "tree",
  schema: z.object({ publication: z.uuid(), value: z.number() }),
  reusable: () => true,
  authority: authority.authority,
}).publish({ publication: randomUUID(), value: 1 });
