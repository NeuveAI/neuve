import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  SharedWork,
  KeyHeld,
  type SharedOutcome,
  type SharedWorkTransport,
} from "@neuve/records-core/shared-work";
import {
  canonicalStoreIdentity,
  sharedWorkSocket,
  storedSharedOutcome,
} from "@neuve/records-core/shared-work-socket";
import {
  budgetSharedWork,
  workerBudget,
  hostBudget,
} from "../../src/budget/local.ts";
const Config = z.object({
  directory: z.string(),
  store: z.string(),
  key: z.string().default("operation@1:input"),
  repository: z.string().optional(),
  insideGrant: z.boolean().default(false),
  keepRunning: z.boolean().default(false),
  pauseRun: z.boolean().default(true),
  pausePublish: z.boolean().default(false),
  pauseRead: z.boolean().default(false),
  pauseClaim: z.boolean().default(false),
  failPublication: z.boolean().default(false),
  failed: z.boolean().default(false),
  worker: z.boolean().default(false),
  host: z.boolean().default(false),
  gatedRecovery: z.boolean().default(false),
  gateSecondLoss: z.boolean().default(false),
  locals: z.int().positive().default(1),
});
const config = Config.parse(JSON.parse(process.env.SHARED_WORK_TEST ?? "{}"));
const emit = (event: string, fields: object = {}) =>
  console.info(JSON.stringify({ event, ...fields }));
const commands = new Map<
  string,
  ReturnType<typeof Promise.withResolvers<void>>
>();
const command = (name: string) => {
  let gate = commands.get(name);
  if (!gate) {
    gate = Promise.withResolvers<void>();
    commands.set(name, gate);
  }
  return gate;
};
const controllers = Array.from(
  { length: config.locals },
  () => new AbortController(),
);
void (async () => {
  const reader = Bun.stdin
    .stream()
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let buffer = "";
  while (true) {
    const next = await reader.read();
    if (next.done) return;
    buffer += next.value;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line === "cancel") controllers[0]?.abort();
      else if (line === "cancel-all")
        controllers.forEach((controller) => controller.abort());
      else command(line).resolve();
    }
  }
})();
if (config.host) {
  const host = await hostBudget({
    directory: config.directory,
    threads: 2,
    fixed: 4,
  });
  if (!host) throw new Error("Host election failed");
  emit("host");
  await host.claims.ready;
  emit("ready");
  await command("close").promise;
  await host.close();
  process.exit(0);
}
const transport = config.worker
  ? budgetSharedWork(await workerBudget(config.directory), config.directory)
  : sharedWorkSocket({
      directory: config.directory,
      ...(config.gatedRecovery
        ? {
            recover: async () => {
              emit("recovering");
              await command("recover").promise;
            },
          }
        : {}),
    });
let losses = 0;
const observed: SharedWorkTransport = {
  ...(transport.recover ? { recover: transport.recover } : {}),
  claim: async (input) => {
    if (config.pauseClaim) {
      emit("before-claim");
      await command("claim").promise;
    }
    const result = await transport.claim(input);
    emit("connection", { kind: result.kind, redeclare: input.redeclare });
    if (result.kind === "floor") return result;
    const claim = result.claim;
    return {
      kind: "connected",
      claim: {
        ...claim,
        next: async () => {
          const next = await claim.next();
          emit("push", next);
          if (next.kind === "lost" && ++losses === 2 && config.gateSecondLoss) {
            emit("before-second-loss");
            await command("second-loss").promise;
          }
          if (input.redeclare && next.kind === "claimed") emit("redeclared");
          return next;
        },
        settle: async (outcome, publication) => {
          emit("settle", { outcome });
          await claim.settle(outcome, publication);
        },
      },
    };
  },
};
const store = config.repository
  ? await canonicalStoreIdentity(config.repository)
  : config.store;
const resultPath = join(
  config.store,
  `result-${Buffer.from(config.key).toString("hex").slice(0, 160)}`,
);
const Outcome = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("succeeded"), value: z.string() }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
]);
const Published = z.object({ publication: z.string(), outcome: Outcome });
let reads = 0;
const adapter = storedSharedOutcome<string, string>({
  read: async (publication) => {
    emit("read", { reads: ++reads });
    if (publication && config.pauseRead) {
      emit("before-read");
      await command("read").promise;
    }
    const path = publication
      ? join(config.store, `published-${publication}`)
      : resultPath;
    return existsSync(path)
      ? Published.parse(JSON.parse(readFileSync(path, "utf8")))
      : undefined;
  },
  publish: async (outcome) => {
    emit("before-publish");
    if (config.pausePublish) await command("publish").promise;
    if (config.failPublication) throw new Error("Store commit failed");
    writeFileSync(
      join(config.store, `published-${outcome.publication}`),
      JSON.stringify(outcome),
    );
    const temporary = `${resultPath}.${process.pid}`;
    writeFileSync(temporary, JSON.stringify(outcome));
    renameSync(temporary, resultPath);
    emit("published", { outcome: outcome.outcome.kind });
  },
});
const work = new SharedWork<string, string>();
const run = adapter.run(
  async (signal): Promise<SharedOutcome<string, string>> => {
    appendFileSync(join(config.store, "executions"), "1\n");
    emit("run");
    if (config.pauseRun)
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          emit("cancelled-run");
          reject(signal.reason);
        };
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        void command("run").promise.then(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
      });
    return config.failed
      ? { kind: "failed", error: "attempt-failed" }
      : { kind: "succeeded", value: "stored-result" };
  },
);
await Promise.all(
  controllers.map(async (controller, index) => {
    try {
      const result = await work.run({
        scope: store,
        key: config.key,
        run,
        signal: controller.signal,
        insideGrant: config.insideGrant,
        keepRunning: config.keepRunning,
        crossProcess: { store, transport: observed, read: adapter.read },
        onTakeover: async () => {
          appendFileSync(join(config.store, "takeovers"), "1\n");
          emit("takeover-hook");
        },
        onEvent: (event) => emit("role", { ...event, index }),
      });
      emit("result", { index, ...result, reads });
    } catch (cause) {
      emit("rejected", {
        index,
        kind:
          cause instanceof KeyHeld
            ? "KeyHeld"
            : controller.signal.aborted
              ? "aborted"
              : "publication",
      });
    }
  }),
);
emit("complete");
// Keep the claimant alive when its own subscribers have left but another process still needs it.
await command("exit").promise;
process.exit(0);
