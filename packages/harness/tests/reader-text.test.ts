import { Effect } from "effect";
import { fill, link } from "../src/link.ts";
import {
  frame,
  mapOf,
  manifestOf,
  hunk,
  put,
  storeFixture,
} from "./fixtures/link.ts";
// Why (the owner, 23 October 2026): a real batch's briefing listed "Recorded limitations" that code
// wrote with internal codes, such as "no PR text: Neuve reads no code host in M3", a reference by
// its handle and scope handle, and "History is not consulted in M3 (10.3)". A reader can't act on
// a milestone code, a decision number or a handle. Nothing else catches it: every check passes and
// the text reads fine to whoever wrote it. This guard runs a realistic Assemble and Publish (a unit
// that owns nothing, one never assessed, one whose review was cut off, a missing digest, a scope
// source Records can't hold, a candidate batch that never assembled), reads the packet back as the
// desk does, and fails on any internal ID in the published prose. Citations are left out: a link's
// target, a cite list and inline code may carry IDs by design.
import { expect, test } from "bun:test";

import { PublishedPackets } from "@neuve/records-core";

import { publishPacket } from "../src/publish.ts";

/** Internal IDs a reader can't interpret, by what they are. */
const INTERNAL_IDS: ReadonlyArray<readonly [string, RegExp]> = [
  ["milestone code", /\bM\d+\b/g],
  // (10.3), (4.4, 10.42): a decision number alone or in a parenthesised list.
  [
    "decision number",
    /\((?:[^()]*[,;]\s*)?\d+\.\d+[a-z]?(?:\s*[,;][^()]*)?\)/g,
  ],
  // "by 4.4 and 10.42": a bare decision number, which no unit (1.5 s) or version (1.169.3) is.
  [
    "decision number",
    /(?<![\w.])\d{1,2}\.\d{1,3}(?![\w.]|\s*(?:s|ms|seconds?|minutes?|%)(?!\w))/g,
  ],
  // b1.r23, b1.o1, p1.e3, b1.u2: entry, reference, obligation and unit handles.
  ["entry handle", /\b[a-z]\d+\.[a-z]?\d+\b/g],
  ["ledger entry", /\be\d+\b/g],
  // Real hunk IDs are h and eight or more hex digits (h47dffd0a); test fixtures use h1.
  ["hunk handle", /\bh(?:[0-9a-f]{7,}|\d+)\b/g],
  ["scope handle", /\bscope:S\d|\bS\d+\.\d+\b/g],
  ["record ID", /\b[0-9A-HJKMNP-TV-Z]{26}\b/g],
];

/** The desk's `LOCAL_ID` (apps/neuve-web projection.ts): what `withoutLocalIds` drops. */
const LOCAL_ID =
  /^(?:h[0-9a-f]{8,}|[a-z]\d+\.[a-z]\d+|p\d+\.e\d+|b\d+\.[a-z]+\d+|S\d+(?:\.\d+)*)$/;

/** The desk's `withoutLocalIds`: a parenthesis of bare local IDs is dropped; any other stays. */
const withoutLocalIds = (text: string) =>
  text
    .replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => {
      const parts = inner.split(/[,;]\s*/).map((part) => part.trim());
      return parts.length > 0 && parts.every((part) => LOCAL_ID.test(part))
        ? ""
        : whole;
    })
    .replace(/\s+([.,;:])/g, "$1");

/**
 * Internal IDs in reader prose as the desk shows it: outside a link's target (a chip), inline or
 * fenced code, and the parenthesised local IDs the desk drops.
 */
const internalIdsIn = (text: string) => {
  const prose = withoutLocalIds(
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/\]\([^)]*\)/g, "]"),
  );
  return INTERNAL_IDS.flatMap(([what, pattern]) =>
    [...prose.matchAll(pattern)].map((match) => `${what}: ${match[0]}`),
  );
};

/** Fields whose strings a reader reads: every other field is an ID, a key, a code or a count. */
const PROSE = new Set([
  "title",
  "focus",
  "detail",
  "summary",
  "why",
  "beforeYouDecide",
  "note",
  "notes",
  "body",
  "message",
  "text",
  "digest",
  "verification",
  "uncertainty",
  "limitations",
  "before",
  "after",
  "meaning",
  "does",
  "disagreement",
  "finding",
  "requirement",
  "reason",
  "rationale",
  "gaps",
  // The Guided stop's proof line; a disposition's `proof` is a list of record IDs, never prose.
  "proof",
]);

/** How the packet's IDs resolved: the reader's model's bookkeeping, not text a reader is shown. */
const NOT_SHOWN = new Set(["citations", "digestCitations"]);

const proseOf = (value: unknown, out: Array<string> = []) => {
  if (Array.isArray(value)) for (const item of value) proseOf(item, out);
  else if (value !== null && typeof value === "object")
    for (const [key, field] of Object.entries(value)) {
      if (NOT_SHOWN.has(key)) continue;
      if (PROSE.has(key) && typeof field === "string") out.push(field);
      else if (
        PROSE.has(key) &&
        key !== "proof" &&
        Array.isArray(field) &&
        field.every((item) => typeof item === "string")
      )
        out.push(...field);
      else proseOf(field, out);
    }
  return out;
};

const offenders = (texts: ReadonlyArray<string>) =>
  texts.flatMap((text) => {
    const found = internalIdsIn(text);
    return found.length === 0 ? [] : [{ text, found }];
  });

test("the guard sees the strings the owner flagged, and leaves citations and code alone", () => {
  expect(
    internalIdsIn("no PR text: Neuve reads no code host in M3"),
  ).not.toEqual([]);
  expect(
    internalIdsIn(
      "b1.r23 (scope:S10/S10.1) has no git or URL provenance Records can hold.",
    ),
  ).not.toEqual([]);
  expect(internalIdsIn("History is not consulted in M3 (10.3).")).not.toEqual(
    [],
  );
  expect(internalIdsIn("(4.4, 10.42)")).not.toEqual([]);
  expect(internalIdsIn("by 4.4 and 10.42 it goes to a person")).not.toEqual([]);
  expect(internalIdsIn("hunk h47dffd0a owns nothing")).not.toEqual([]);
  expect(
    internalIdsIn("rests on 01JZ0000000000000000000S01 (stale)"),
  ).not.toEqual([]);
  expect(internalIdsIn("Unit b1.u2 was not assessed.")).not.toEqual([]);
  expect(
    internalIdsIn(
      "[The revocation check](b1.u1) reads `e1` and `parse_v2.e3` from the cache (lines 10-12, 1.5 s, react 1.169.3); the flag is read first (h47dffd0a, b1.r3).",
    ),
  ).toEqual([]);
});

test("code fill publishes plain reader prose", async () => {
  const w = storeFixture("reader-text");
  const packet = await w.run(
    Effect.gen(function* () {
      const ctx = yield* w.ctx();
      const hunks = [hunk("h1", "widget.ts"), hunk("h2", "other.ts")];
      const frameKey = yield* put("reader.frame", frame);
      const mapKey = yield* put("reader.map", {
        ...mapOf(hunks),
        frame: frameKey,
      });
      const manifestKey = yield* put("reader.manifest", manifestOf(hunks));
      const setup = {
        precompute: "unused",
        scopeKey: null,
        refreshKey: null,
        pins: [],
        disclosures: [],
      };
      const filled = yield* fill(ctx, { mapKey, manifestKey, setup });
      const linked = yield* link(ctx, {
        frameKey,
        mapKey,
        manifestKey,
        setup,
        fill: filled,
      });
      yield* publishPacket(ctx, {
        candidates: linked.candidates,
        stages: [filled.record, linked.record],
        sources: {
          manifest: manifestKey,
          changeMap: linked.changeMapKey,
          scope: null,
        },
        strongestStratum: frame.stratum,
        disclosures: linked.disclosures,
      });
      return yield* PublishedPackets.runPacket(ctx.runId);
    }),
  );
  expect(packet).toBeDefined();
  // Inspect all reader prose and leave structured citation targets and identity fields alone.
  const texts: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (
        [
          "text",
          "title",
          "digest",
          "verification",
          "rationale",
          "detail",
          "reason",
          "laneNote",
          "proofNote",
        ].includes(key) &&
        typeof item === "string"
      )
        texts.push(item);
      else if (
        ["uncertainty", "limitations"].includes(key) &&
        Array.isArray(item)
      )
        texts.push(...item.filter((s): s is string => typeof s === "string"));
      else visit(item);
    }
  };
  visit(packet);
  expect(texts.length).toBeGreaterThan(10);
  expect(offenders(texts)).toEqual([]);
});

// Why: cut-off disclosures must identify each live stage and finder.
import { stepName, cutOffDisclosure } from "../src/reader-text.ts";
test("reader text names the fixed review stages and finders", () => {
  expect(
    ["frame", "map", "verify", "link"].map((stage) => stepName(stage)),
  ).toEqual([
    "the frame step",
    "the map step",
    "the verify step",
    "the link step",
  ]);
  expect(
    ["scope-fit", "correctness", "risky-edges", "tests"].map((lens) =>
      stepName("find", `find.${lens}`),
    ),
  ).toEqual([
    "the scope fit finder",
    "the correctness finder",
    "the risky edges finder",
    "the tests finder",
  ]);
  expect(cutOffDisclosure("find", "find.tests", "skipped")).toContain(
    "The tests finder didn't start",
  );
});
