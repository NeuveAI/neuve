// Why: the review request takes its requester as an input (M5, ST1), because the web app must
// request as the person git names and never as whatever agent session started `bun run dev` (ID1).
// This pins that boundary in the log: a given human is registered and attributed as given (not the
// repository's own git user, which a request resolving its caller would fall back to), a given actor
// is attributed with no registration, and an unresolved requester stays unresolved.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Identity,
  JobQueue,
  Log,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { requestReview, type Requester } from "../src/request.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-requester-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const repository = join(directory, "repo");
const git = (...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

test("a request is attributed to the requester it is given, never to one it resolves", async () => {
  Bun.spawnSync(["git", "init", "-q", repository]);
  git("config", "user.email", "git.human@example.test");
  git("config", "user.name", "Git Human");
  for (const text of ["one\n", "two\n", "three\n", "four\n"]) {
    writeFileSync(join(repository, "file.txt"), text);
    git("add", ".");
    git("commit", "-q", "-m", text.trim());
  }
  const location = storeLocationIn(join(directory, "store"));
  const request = (range: string, requester: Requester) =>
    requestReview({
      location,
      repository,
      range,
      requester,
      search: {},
      stack: undefined,
    });
  const agent = Identity.agentFingerprint({
    harness: "claude-code",
    sessionId: "session-1",
  });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      const human = yield* request("HEAD~3..HEAD~2", {
        _tag: "Human",
        email: "Given.Human@Example.test",
        displayName: "Given Human",
      });
      const actor = yield* request("HEAD~2..HEAD~1", {
        _tag: "Actor",
        actorId: agent,
      });
      const unresolved = yield* request("HEAD~1..HEAD", {
        _tag: "Unresolved",
      });
      const requested = yield* Log.history({
        kind: "review.requested@1",
        limit: 10,
      });
      const registered = yield* Log.history({
        kind: "actor.registered@1",
        limit: 10,
      });
      return { human, actor, unresolved, requested, registered };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          JobQueue.layer,
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
      ),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );

  const givenHuman = Identity.humanFingerprint("given.human@example.test");
  expect(givenHuman).not.toBe(
    Identity.humanFingerprint("git.human@example.test"),
  );
  expect(result.human.actor).toBe(givenHuman);
  expect(result.actor.actor).toBe(agent);
  expect(result.unresolved.actor).toBe(Identity.UNRESOLVED_ACTOR);
  // What the log holds: each request event under its requester, and one registration, the human's.
  expect(
    result.requested.map((entry) => [
      entry.event.actor,
      entry.event.kind === "review.requested@1"
        ? entry.event.attribution.range.headOid
        : null,
    ]),
  ).toEqual([
    [givenHuman, result.human.range.headOid],
    [agent, result.actor.range.headOid],
    [Identity.UNRESOLVED_ACTOR, result.unresolved.range.headOid],
  ]);
  expect(
    result.registered.map((entry) => [entry.event.actor, entry.event.payload]),
  ).toEqual([
    [
      givenHuman,
      {
        actorKind: "human",
        harness: "git",
        email: "given.human@example.test",
        displayName: "Given Human",
      },
    ],
  ]);
});
