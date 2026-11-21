// Why: a refused record under a future folder-name grammar must not disable siblings, defaults or API-key reviews.
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { AccountName } from "../../src/index.ts";
import { OPUS_ROUTE } from "../../../harness/src/route.ts";
import { routeReadiness } from "../../../harness/src/route-provider.ts";
import {
  AccountStore,
  RuntimeRegistry,
  fakeRuntime,
  provideRegistry,
  scratch,
} from "./fixtures.ts";

for (const appears of ["before-open", "after-open"] as const) {
  test(`unnameable refused folders ${appears} stay stored without breaking the directory`, async () => {
    const temp = scratch();
    const notices: string[] = [];
    const stderr = spyOn(process.stderr, "write").mockImplementation((line) => {
      notices.push(String(line));
      return true;
    });
    const keyVariable = "NEUVE_TEST_UNNAMEABLE_KEY";
    const previous = process.env[keyVariable];
    process.env[keyVariable] = "fake-key";
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const setup = yield* AccountStore.make(temp.home);
            const sibling = yield* setup.add("claude", "sibling");
            let store = appears === "after-open" ? setup : undefined;
            const folders = ["future_name", "future_other"];
            for (const name of folders) {
              const folder = join(AccountStore.accountsPath(temp.home), name);
              mkdirSync(folder, { mode: 0o700 });
              writeFileSync(
                join(folder, "default.active.json"),
                '{"version":2,"secret":"do-not-print"}',
                { mode: 0o600 },
              );
            }
            store ??= yield* AccountStore.make(temp.home);
            const calls: string[] = [];
            const fake = fakeRuntime({ calls });
            const registry = yield* RuntimeRegistry.pipe(
              Effect.provide(
                provideRegistry(store, [
                  fake,
                  {
                    ...fake,
                    kind: "pi",
                    capabilities: () =>
                      Effect.succeed({
                        ownsLoop: false,
                        toolEndsTurn: false,
                        resumeInTurn: false,
                        perMessageUsage: false,
                        resume: true,
                        fork: true,
                        interrupt: false,
                        modelSwitchInSession: false,
                        structuredOutput: true,
                        steering: false,
                        approvals: false,
                        perRequestTelemetry: false,
                        ownTools: false,
                        byteExactCapture: false,
                        nativeToolServer: false,
                        statusProbe: false,
                        internalRetries: false,
                      }),
                  },
                ]),
              ),
            );
            for (let read = 0; read < 3; read++) {
              expect(
                yield* store.directory.lookup(sibling.name, "use"),
              ).toEqual(sibling);
              expect(yield* registry.capabilities(sibling.name)).toMatchObject({
                ownsLoop: true,
              });
              expect(
                yield* store.directory.lookup(
                  AccountName.parse("anthropic"),
                  "use",
                ),
              ).toMatchObject({ kind: "anthropic-api-key" });
              expect(
                yield* routeReadiness(
                  { ...OPUS_ROUTE, credentialVariable: keyVariable },
                  registry,
                  Effect.die("API-key routes must not read statuses"),
                ),
              ).toEqual({ ready: true, credential: keyVariable });
              expect(
                (yield* store.list).map((account) => String(account.name)),
              ).not.toContain("future_name");
            }
            expect(notices).toEqual([
              `${AccountStore.accountsPath(temp.home)} holds 2 account folders this build can't name; leaving them as stored.\n`,
            ]);
            expect(notices.join("")).not.toContain("future_name");
            expect(notices.join("")).not.toContain("future_other");
            expect(notices.join("")).not.toContain("do-not-print");
            for (const name of folders) {
              const folder = join(AccountStore.accountsPath(temp.home), name);
              expect(readdirSync(folder)).toEqual(["default.active.json"]);
              expect(
                readFileSync(join(folder, "default.active.json"), "utf8"),
              ).toBe('{"version":2,"secret":"do-not-print"}');
            }
            expect(calls).toEqual([]);
          }),
        ),
      );
    } finally {
      if (previous === undefined) delete process.env[keyVariable];
      else process.env[keyVariable] = previous;
      stderr.mockRestore();
      temp.close();
    }
  });
}
