// A child process for index-keep.test.ts: `mock.module` replaces a module for the whole process and
// is never undone, so the planted refusal lives and dies here. It builds a real tree index whose
// declarations carry one key the strict publication schema does not know, and prints what the
// builder got, what it logged, and what a subscriber reads.
import { mock } from "bun:test";
import { join } from "node:path";
import { Effect } from "effect";
import { Computations, storeLocationIn } from "@neuve/records-core";
import { SharedWork } from "@neuve/records-core/shared-work";
import { publicationHost } from "./publication-host.ts";

const actual = await import("../../src/declarations.ts");
// Taken before mocking: the mock updates the module's live bindings, `actual`'s included.
const readDeclarations = actual.readDeclarations;
mock.module("../../src/declarations.ts", () => ({
  ...actual,
  readDeclarations: (options: Parameters<typeof readDeclarations>[0]) =>
    readDeclarations(options).pipe(
      Effect.map((read) => ({ ...read, planted: true })),
    ),
}));
const { treeIndex } = await import("../../src/search-index.ts");
const { PublicationPolicy } = await import("../../src/shared-publication.ts");
const { withCodeWork } = await import("../../src/code-work.ts");
const { runIn } = await import("../pi/capture/fixture.ts");

const [root, tree] = Bun.argv.slice(2);
if (!root || !tree) throw new Error("Arguments required");
const authority = publicationHost(process.env.NEUVE_BUDGET_DIRECTORY ?? "");
const original = SharedWork.prototype.run;
let publication: string | undefined;
let key: string | undefined;
let readPublished: Parameters<typeof original>[0]["crossProcess"];
SharedWork.prototype.run = new Proxy(original, {
  apply(target, receiver, args) {
    const options: Parameters<typeof original>[0] = args[0];
    if (!options.key.startsWith("tree-index@") || !options.crossProcess)
      return Reflect.apply(target, receiver, args);
    key = options.key;
    const crossProcess = {
      ...options.crossProcess,
      transport: authority.transport,
    };
    readPublished = crossProcess;
    return Reflect.apply(target, receiver, [
      {
        ...options,
        crossProcess,
        run: async (signal: AbortSignal) => {
          const stored = await options.run(signal);
          if ("publication" in stored) publication = stored.publication;
          return stored;
        },
      },
    ]);
  },
});
const logged: Array<string> = [];
const warn = console.warn;
console.warn = (...line: Array<unknown>) => {
  logged.push(line.map(String).join(" "));
};
const executable = join(root, "engine");
const location = storeLocationIn(join(root, "records"));
const exit = await runIn(location)(
  withCodeWork(
    location,
    false,
    treeIndex(root, tree, { executable, key: { unavailable: executable } }),
  ).pipe(
    Effect.provide(Computations.layer),
    Effect.provideService(PublicationPolicy, {
      ...PublicationPolicy.defaultValue(),
      authority: authority.authority,
    }),
  ),
);
console.warn = warn;
const delivered = await readPublished?.read(publication);
const failure =
  delivered?.outcome.kind === "failed" ? delivered.outcome.error : undefined;
process.stdout.write(
  `${JSON.stringify({
    built:
      exit._tag === "Success"
        ? { cached: exit.value.cached, tree: exit.value.index.tree }
        : { failed: String(exit.cause) },
    logged: logged.filter((line) =>
      line.includes('"tree-index.publication-failed"'),
    ),
    publication,
    key,
    delivered: {
      kind: delivered?.outcome.kind,
      tag:
        failure instanceof Computations.SharedAttemptFailed
          ? failure.tag
          : undefined,
    },
  })}\n`,
);
SharedWork.prototype.run = original;
authority.host.close();
process.exit(0);
