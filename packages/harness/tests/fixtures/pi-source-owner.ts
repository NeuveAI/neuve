import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openReviewHost } from "../../src/pi/host.ts";
import { SourceOwned, SourceOwnership } from "../../src/pi/source-ownership.ts";

const source = process.argv[2];
if (source === undefined) throw new Error("source required");
try {
  const ownership = SourceOwnership.acquire(source);
  if (process.argv[3] !== "native") {
    ownership.release();
    console.log("acquired");
  } else {
    mkdirSync(source, { recursive: true });
    const unused = async (): Promise<never> => {
      throw new Error("unused");
    };
    await openReviewHost(
      {
        ownership,
        storage: await openNodeSqliteStorage(join(source, "pi.sqlite")),
        models: createModels(),
        registry: createRegistry(),
        slots: { acquire: async () => () => {} },
        createRouteProvider: () => {
          throw new Error("no network");
        },
        claim: { jobSeq: 1, attempt: 1, claimedAt: "child" },
        run: {
          runId: "child",
          runKey: "key",
          generation: 1,
          cycleId: "cycle",
          range: {
            baseRef: "main",
            baseOid: "a".repeat(40),
            headOid: "b".repeat(40),
          },
          config: {} as never,
          cutoffAt: Date.now() + 3_600_000,
        },
        stages: () => ({
          extension: defineExtension({ name: "owner-fixture" }),
          port: {
            precompute: async () => {
              console.log("native-started");
              await new Promise<void>(() => {});
              return {
                record: {
                  stage: "precompute" as const,
                  status: "computed" as const,
                  wallMs: 0,
                },
              };
            },
            front: unused,
            finder: unused,
            fill: unused,
            link: unused,
            publish: unused,
          },
        }),
        onClose: async () => "closed",
      },
      context,
    );
    ownership.release();
    await new Promise(() => setInterval(() => {}, 60_000));
  }
} catch (error) {
  if (!(error instanceof SourceOwned)) throw error;
  console.log(error._tag);
}
