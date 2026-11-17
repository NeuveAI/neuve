// Why: `review.route: "claude"` lets a Claude subscriber set Neuve up once instead of passing
// `--route claude` on each review. The desk freezes `settingsRoute()` and the CLI's flag freezes
// `resolveNamedRoute`, so the two must give byte for byte the same route and run key, or a desk
// request and a CLI request for one range would start two jobs instead of sharing one (record
// 0016). The CLI's directory is the real account store, here in a scratch home.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { canonicalJson } from "@neuve/records-core";
import { AccountStore, RESERVED_ACCOUNT_NAMES } from "@neuve/runtime";
import { defaultConfig, runKeyFor } from "../src/config.ts";
import { resolveNamedRoute, settingsRoute } from "../src/request.ts";
import { OPUS_ROUTE, RouteName, SOL_ROUTE } from "../src/route.ts";
import { ReviewRouteName, Settings } from "../src/settings.ts";

const homes: string[] = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

const range = {
  baseRef: "main",
  baseOid: "a".repeat(40),
  headOid: "b".repeat(40),
};

const settings = (review: Record<string, unknown>) =>
  Option.some(Settings.parse({ version: 1, review }));

/** What `neuve review --route <name>` freezes, through the account store of a scratch home. */
const fromFlag = (name: string, from: Option.Option<Settings>) => {
  const home = mkdtempSync(join(tmpdir(), "neuve-claude-route-"));
  homes.push(home);
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* AccountStore.make(home);
        return yield* resolveNamedRoute(name, store.directory, from);
      }),
    ),
  );
};

test("review.route accepts claude and still refuses an added account's name", () => {
  expect(settings({ route: "claude" })).toEqual(
    Option.some({ version: 1, review: { route: "claude" } }),
  );
  expect(
    Settings.safeParse({ version: 1, review: { route: "work" } }).success,
  ).toBe(false);
});

test.each([
  ["the route's own effort", { route: "claude" }],
  [
    "the settings' effort and step efforts",
    { route: "claude", effort: "high", stepEffort: { assess: "low" } },
  ],
  ["an empty step-effort map", { route: "claude", stepEffort: {} }],
] as const)(
  "review.route claude freezes what --route claude freezes, at %s",
  async (_, review) => {
    const from = settings(review);
    const flag = await fromFlag("claude", from);
    const configured = settingsRoute(from);
    expect(configured).toMatchObject({
      provider: "claude",
      account: { name: "claude", kind: "claude-subscription" },
      model: OPUS_ROUTE.model,
      effort: "effort" in review ? review.effort : OPUS_ROUTE.effort,
    });
    expect(canonicalJson(configured)).toBe(canonicalJson(flag));
    expect(runKeyFor(range, defaultConfig(undefined, configured))).toBe(
      runKeyFor(range, defaultConfig(undefined, flag)),
    );
  },
);

// Why: existing runs on the direct routes must keep joining their jobs.
test("the direct routes from the settings are unchanged", () => {
  expect(settingsRoute(Option.none())).toEqual(OPUS_ROUTE);
  expect(settingsRoute(settings({ route: "anthropic" }))).toEqual(OPUS_ROUTE);
  expect(settingsRoute(settings({ route: "openai" }))).toEqual(SOL_ROUTE);
});

// Why: `--route <name>` reads route names first, so an account under one could never be reached.
test("every name a route answers to is refused as an account name", () => {
  for (const name of [...RouteName.options, ...ReviewRouteName.options])
    expect(RESERVED_ACCOUNT_NAMES).toContain(name);
});
