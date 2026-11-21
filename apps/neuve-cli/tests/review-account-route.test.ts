// Why: the CLI must freeze an account route and validate its runtime before storing a request.
import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Option, Stream } from "effect";
import {
  Account,
  AccountName,
  DEFAULT_ACCOUNTS,
  RuntimeRegistry,
  inMemoryAccountDirectoryLayer,
} from "@neuve/runtime";
import { Starter } from "@neuve/records-core";
import { Route, Settings } from "@neuve/harness";
import * as runtimes from "@neuve/harness/runtimes";
import { requestRangeReview } from "../src/review-cli.ts";
import {
  fakeRuntime,
  route as claude,
} from "../../../packages/harness/tests/pi/stages/contract-fixture.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

for (const choice of [
  "fake-claude",
  "missing",
  "chatgpt",
  "anthropic",
  "openai",
  "mismatch",
] as const) {
  test(`--route ${choice} freezes or refuses before storage`, async () => {
    const root = mkdtempSync(join(tmpdir(), "review-account-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const repository = join(root, "repo");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args]);
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    git("init", "-q", repository);
    git(
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "initial",
    );
    const accounts = [
      ...DEFAULT_ACCOUNTS,
      Account.parse({
        ...claude.account,
        runtime: "claude-code",
        credential: { kind: "claude-config-folder" },
      }),
    ];
    const directory = inMemoryAccountDirectoryLayer(accounts);
    const settings = spyOn(Settings, "readSettings").mockReturnValue(
      Option.some({ version: 1, review: { effort: "high" } }),
    );
    cleanups.push(() => settings.mockRestore());
    const options = spyOn(runtimes, "workerRuntimeOptions").mockReturnValue({
      accountDirectory: directory,
      claude: { cwd: runtimes.defaultClaudeWorkingFolder(root) },
      codex: false,
    });
    cleanups.push(() => options.mockRestore());
    const fake = fakeRuntime([]);
    const checked: string[] = [];
    let closed = false;
    const layer = spyOn(runtimes, "harnessRuntimes").mockReturnValue(
      Layer.effect(
        RuntimeRegistry,
        Effect.acquireRelease(
          Effect.succeed({
            ...fake.registry,
            accountEvents: Stream.empty,
            capabilities: (name: AccountName) => {
              checked.push(name);
              const db = new Database(
                join(repository, ".git", "neuve", "records.sqlite"),
                { readonly: true },
              );
              try {
                expect(
                  db
                    .query(
                      "SELECT count(*) AS n FROM events WHERE kind = 'review.requested@1'",
                    )
                    .get(),
                ).toEqual({ n: 0 });
              } finally {
                db.close();
              }
              return fake.registry.capabilities(claude.account.name).pipe(
                Effect.map((caps) => ({
                  ...caps,
                  ownsLoop: choice === "fake-claude",
                })),
              );
            },
          }),
          () =>
            Effect.sync(() => {
              closed = true;
            }),
        ),
      ),
    );
    cleanups.push(() => layer.mockRestore());
    const starter = spyOn(Starter, "ensureWorker").mockReturnValue(
      Effect.succeed({ status: "running", socket: "(fixture)" }),
    );
    cleanups.push(() => starter.mockRestore());
    // A direct route's credential presence controls only waking a worker, not its frozen config.
    const presence = spyOn(
      (await import("@neuve/harness")).RouteProvider,
      "credentialPresent",
    ).mockReturnValue(false);
    cleanups.push(() => presence.mockRestore());
    const selected = choice === "mismatch" ? "fake-claude" : choice;
    if (["missing", "chatgpt", "mismatch"].includes(choice)) {
      const rejected = requestRangeReview(repository, "HEAD..HEAD", {
        route: selected,
      });
      await expect(rejected).rejects.toThrow(
        choice === "mismatch" ? "disagrees" : "Unknown review route",
      );
      if (choice !== "mismatch")
        await expect(rejected).rejects.toMatchObject({
          message: `Unknown review route ${JSON.stringify(selected)}. Choose anthropic, openai or a Claude subscription account name.`,
        });
      expect(checked).toEqual(choice === "mismatch" ? ["fake-claude"] : []);
      expect(starter).not.toHaveBeenCalled();
      const database = join(repository, ".git", "neuve", "records.sqlite");
      if (existsSync(database)) {
        const db = new Database(database, { readonly: true });
        try {
          expect(
            db
              .query(
                "SELECT count(*) AS n FROM events WHERE kind = 'review.requested@1'",
              )
              .get(),
          ).toEqual({ n: 0 });
        } finally {
          db.close();
        }
      }
    } else {
      const result = await requestRangeReview(repository, "HEAD..HEAD", {
        route: selected,
      });
      expect(result.request.config.route).toEqual(
        choice === "fake-claude"
          ? { ...claude, effort: "high" }
          : {
              ...(choice === "anthropic" ? Route.OPUS_ROUTE : Route.SOL_ROUTE),
              effort: "high",
            },
      );
      expect(result.route).toEqual(result.request.config.route);
      expect(checked).toEqual([choice === "openai" ? "chatgpt" : choice]);
      if (choice === "fake-claude") expect(starter).toHaveBeenCalledTimes(1);
    }
    expect(closed).toBe(true);
    expect(fake.opens()).toBe(0);
    expect(fake.probes()).toBe(0);
    expect(existsSync(runtimes.defaultClaudeWorkingFolder(root))).toBe(false);
  });
}
