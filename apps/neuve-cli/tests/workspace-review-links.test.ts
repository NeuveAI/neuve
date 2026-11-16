import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect } from "effect";
import {
  GitHubExternalRefSchema,
  RecordEvent,
  type ReviewOrigin,
} from "@neuve/records-schema";
import {
  Log,
  Store,
  mintUlid,
  sha256Hex,
  storeLocationIn,
} from "@neuve/records-core";
import {
  exactReviewUrl,
  aceReviewDestination,
  codingReturnUrl,
  reviewAt,
  reviewHistory,
} from "../src/workspace-review-links.ts";

test("Ace destinations use its exact cycle path and retain the coding return link", () => {
  const reference = "01K90000000000000000000000";
  const path = `/review/816fc349d3faebf805d1bed70fce7e14754cad5251c77dda31c414ee961a0bdd/cycles/${reference}`;
  expect(
    aceReviewDestination("http://127.0.0.1:4141/", "/repo", reference),
  ).toBe("http://127.0.0.1:4141" + path);
  const back =
    "http://127.0.0.1:4141/?project=%2Frepo&channel=fix&chat=1#channels";
  const destination = new URL(
    aceReviewDestination(
      "https://owner.tailnet.example:443/",
      "/repo",
      reference,
      back,
    ),
    "https://owner.tailnet.example:443/",
  );
  expect(destination.origin).toBe("https://owner.tailnet.example");
  expect(destination.pathname).toBe(path);
  expect(destination.searchParams.get("returnTo")).toBe(back);
  expect(() =>
    aceReviewDestination("http://127.0.0.1:4141/", "/repo", "../other"),
  ).toThrow();
});

test("coding return links keep the runtime origin and the review's actual channel or external item", () => {
  expect(
    codingReturnUrl("http://127.0.0.1:49123/", "/repo", {
      kind: "channel",
      host: "local",
      channel: "fix/auth",
      chat: 0,
      lane: "fix",
      items: [],
    }),
  ).toBe(
    "http://127.0.0.1:49123/?project=%2Frepo&channel=fix%2Fauth&chat=0#channels",
  );
  expect(
    codingReturnUrl("http://127.0.0.1:49123/", "/repo", {
      kind: "external",
      host: "local",
      items: [
        {
          provider: "github",
          repo: "githubnext/ace",
          kind: "pull-request",
          number: 711,
          url: "https://github.com/githubnext/ace/pull/711",
        },
      ],
    }),
  ).toBe(
    "http://127.0.0.1:49123/?project=%2Frepo&repo=githubnext%2Face&pull=711#prs",
  );
  const reference = mintUlid();
  const url = new URL(
    exactReviewUrl(
      "http://127.0.0.1:49001/",
      reference,
      "http://127.0.0.1:49123/?channel=fix&chat=1#channels",
    ),
  );
  expect(url.searchParams.get("cycle")).toBe(reference);
  expect(url.searchParams.get("returnTo")).toBe(
    "http://127.0.0.1:49123/?channel=fix&chat=1#channels",
  );
});

const root = mkdtempSync(join(tmpdir(), "workspace-review-links-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const initialized = Bun.spawnSync(["git", "init", "-q", root]);
if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString());

test("a recovered channel resolves its exact Records cycle rather than another review at the project root", async () => {
  const location = storeLocationIn(join(root, ".git"));
  const reference = mintUlid();
  const later = mintUlid();
  const association = mintUlid();
  const actor = sha256Hex("workspace-links-fixture");
  const range = {
    baseRef: "main",
    baseOid: "a".repeat(40),
    headOid: "b".repeat(40),
  };
  const at = new Date().toISOString();
  await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Log.append([
        {
          id: mintUlid(),
          idempotencyKey: `cycle:${reference}`,
          kind: "cycle.opened@1",
          actor,
          occurredAt: at,
          attribution: { cycleId: reference, range },
          payload: {},
        },
        {
          id: association,
          idempotencyKey: `origin:${reference}`,
          kind: "review.origin-recorded@1",
          actor,
          occurredAt: at,
          attribution: { cycleId: reference, range },
          payload: {
            identity: sha256Hex(reference),
            origin: {
              kind: "channel",
              host: "local",
              channel: "old-channel",
              chat: 1,
              lane: "fix",
              items: [],
            },
          },
        },
        {
          id: mintUlid(),
          idempotencyKey: `cycle:${later}`,
          kind: "cycle.opened@1",
          actor,
          occurredAt: at,
          attribution: {
            cycleId: later,
            range: { ...range, headOid: "c".repeat(40) },
          },
          payload: {},
        },
      ]),
    ).pipe(
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  expect(await reviewAt(root, reference)).toEqual({
    reference,
    base: range.baseOid,
    head: range.headOid,
  });
  expect(await reviewAt(root, mintUlid())).toBeUndefined();
  const history = await reviewHistory({
    project: root,
    channel: "old-channel",
    chat: 1,
  });
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    reference,
    association,
    base: range.baseOid,
    head: range.headOid,
  });
  expect(
    exactReviewUrl("http://127.0.0.1:4189/workspace?old=draft", reference),
  ).toBe(`http://127.0.0.1:4189/?cycle=${reference}`);
  expect(() =>
    exactReviewUrl("http://127.0.0.1:4189/", "other/root"),
  ).toThrow();
  expect(
    await reviewHistory({ project: root, channel: "missing-channel" }),
  ).toEqual([]);
});

test("an external item's history finds direct PR reviews and keeps one newest association per cycle", async () => {
  const location = storeLocationIn(join(root, ".git"));
  const item = GitHubExternalRefSchema.parse({
    provider: "github",
    repo: "githubnext/ace",
    kind: "pull-request",
    number: 711,
    url: "https://github.com/githubnext/ace/pull/711",
  });
  const actor = sha256Hex("workspace-item-links-fixture");
  const first = mintUlid();
  const second = mintUlid();
  const range = {
    baseRef: "main",
    baseOid: "d".repeat(40),
    headOid: "e".repeat(40),
  };
  const at = new Date().toISOString();
  const originEvent = (cycleId: string, origin: ReviewOrigin) =>
    RecordEvent.parse({
      id: mintUlid(),
      idempotencyKey: `item-origin:${cycleId}:${sha256Hex(JSON.stringify(origin))}`,
      kind: "review.origin-recorded@1",
      actor,
      occurredAt: at,
      attribution: { cycleId, range },
      payload: {
        identity: sha256Hex(`${cycleId}:${JSON.stringify(origin)}`),
        origin,
      },
    });
  const direct = originEvent(first, {
    kind: "external",
    host: "local",
    items: [item],
  });
  const newest = originEvent(first, {
    kind: "channel",
    host: "local",
    channel: "continued-pr",
    chat: 1,
    lane: "fix",
    items: [item],
  });
  const otherCycle = originEvent(second, {
    kind: "external",
    host: "local",
    items: [item],
  });
  const otherRepo = originEvent(first, {
    kind: "external",
    host: "local",
    items: [
      {
        ...item,
        repo: "other/project",
        url: "https://github.com/other/project/pull/711",
      },
    ],
  });
  const otherKind = originEvent(first, {
    kind: "external",
    host: "local",
    items: [
      {
        ...item,
        kind: "issue",
        url: "https://github.com/githubnext/ace/issues/711",
      },
    ],
  });
  await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Log.append([
        ...[first, second].map((cycleId) =>
          RecordEvent.parse({
            id: mintUlid(),
            idempotencyKey: `cycle:${cycleId}`,
            kind: "cycle.opened@1",
            actor,
            occurredAt: at,
            attribution: { cycleId, range },
            payload: {},
          }),
        ),
        direct,
        newest,
        otherCycle,
        otherRepo,
        otherKind,
      ]),
    ).pipe(
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  const reviews = await reviewHistory({ project: root, item });
  expect(reviews.map(({ reference }) => reference).sort()).toEqual(
    [first, second].sort(),
  );
  expect(reviews.find(({ reference }) => reference === first)).toMatchObject({
    association: newest.id,
    base: range.baseOid,
    head: range.headOid,
  });
  expect(reviews.find(({ reference }) => reference === second)).toMatchObject({
    association: otherCycle.id,
    origin: { kind: "external" },
  });
  expect(
    await reviewHistory({
      project: root,
      item: {
        ...item,
        number: 712,
        url: "https://github.com/githubnext/ace/pull/712",
      },
    }),
  ).toEqual([]);
  expect(
    await reviewHistory({ project: root, channel: "continued-pr", chat: 1 }),
  ).toHaveLength(1);
  const recorded = await Effect.runPromise(
    Log.history({ kind: "review.origin-recorded@1", limit: 20 }).pipe(
      Effect.provide(Store.layer(location, { create: false })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  expect(
    recorded.filter(
      ({ event }) =>
        event.attribution?.cycleId === first ||
        event.attribution?.cycleId === second,
    ),
  ).toHaveLength(5);
});
