import { Effect } from "effect";
import { estimateTokens } from "./budget.ts";
import {
  dataBlock,
  sectionBody,
  sourceText,
  type LookupContext,
} from "./lookups.ts";
import type { RangeManifest } from "./manifest.ts";
import type { ChangeMap } from "./review-map.ts";

// Candidate obligations (10.39)

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
/** The desk's contract names "Done when" (10.67); acceptance criteria are its common synonym. */
const DONE_WHEN = /\bdone when\b|\bacceptance\b|\bdefinition of done\b/i;
const ITEM = /^\s{0,6}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/;

/**
 * Checklist items under "Done when" or acceptance headings of fetched scope, with their exact text,
 * as candidate obligations the agent confirms, merges or rejects (10.39).
 */
export const candidateObligations = (ctx: LookupContext) =>
  Effect.gen(function* () {
    const out: Array<ChangeMap["candidates"][number]> = [];
    for (const source of ctx.snapshot?.sources ?? []) {
      if (
        source.status !== "fetched" ||
        source.kind === "commit-text" ||
        source.contextOnly
      )
        continue;
      const read = yield* sourceText(ctx, source);
      if (read.text === undefined) continue;
      const lines = read.text.split("\n");
      let level: number | undefined;
      lines.forEach((line, index) => {
        const heading = HEADING.exec(line);
        if (heading !== null) {
          const depth = heading[1]!.length;
          if (level !== undefined && depth <= level) level = undefined;
          if (DONE_WHEN.test(heading[2]!)) level = depth;
          return;
        }
        if (level === undefined) return;
        const item = ITEM.exec(line);
        if (item === null || out.length >= 60) return;
        const section = source.sections.find(
          (entry) => entry.startLine <= index + 1 && entry.endLine >= index + 1,
        );
        if (section === undefined) return;
        out.push({
          id: `O${out.length + 1}`,
          sourceId: source.id,
          sectionId: section.id,
          text: item[1]!.trim().slice(0, 400),
        });
      });
    }
    return out;
  });

/** Which commits of the range touched each path, oldest first. */
export const commitsByPath = (
  manifest: RangeManifest,
  git: (args: ReadonlyArray<string>) => Effect.Effect<string, unknown>,
) =>
  Effect.map(
    git([
      "log",
      "--reverse",
      "--no-color",
      "--no-renames",
      "--name-only",
      "--format=%x00%H",
      `${manifest.range.mergeBase}..${manifest.range.headOid}`,
    ]),
    (out) => {
      const map = new Map<string, Array<string>>();
      for (const record of out.split("\0").slice(1)) {
        const [oid = "", ...paths] = record.trim().split("\n");
        for (const path of paths.filter((entry) => entry !== ""))
          map.set(path, [...(map.get(path) ?? []), oid]);
      }
      return map as ReadonlyMap<string, ReadonlyArray<string>>;
    },
  );

/**
 * The scope listing and the section bodies that fit Understand's 40,000 tokens, strongest stratum
 * first. Sections past the bound are listed and read with `scope_section`.
 */
export const scopeBlock = (
  ctx: LookupContext,
  bound: number,
  only?: ReadonlySet<string>,
  mode?: "frame",
) =>
  Effect.gen(function* () {
    const snapshot = ctx.snapshot;
    if (snapshot === undefined)
      return "No scope snapshot: the cycle's scope could not be fetched (a disclosed gap).";
    const listing: Array<string> = [
      `Scope snapshot of cycle ${snapshot.cycleId}, fetched ${snapshot.fetchedAt}; strongest stratum ${snapshot.strata.strongest}.`,
    ];
    const bodies: Array<string> = [];
    let tokens = 0;
    const order = [
      "plan-or-ticket-at-base",
      "plan-inside-range",
      "commit-or-pr-text",
      "nothing",
    ];
    const rank = (source: (typeof snapshot.sources)[number]) =>
      source.kind === "ticket" || source.kind === "pull-request"
        ? 0
        : source.ref.found.includes("commit") && source.kind !== "commit-text"
          ? 1
          : source.stratum === "plan-inside-range"
            ? 2
            : source.ref.path?.endsWith("AGENTS.md")
              ? 4
              : 3;
    const sources = [...snapshot.sources].sort((a, b) =>
      mode === "frame"
        ? rank(a) - rank(b)
        : order.indexOf(a.stratum) - order.indexOf(b.stratum),
    );
    for (const source of sources) {
      listing.push(
        `${source.id} ${source.kind} · ${source.contextOnly ? "context only" : source.stratum} · fetched ${source.fetchedAt} · ${source.title}${source.status === "gap" ? ` · gap: ${source.gap ?? ""}` : ""}`,
      );
      for (const section of mode === "frame" && source.kind === "commit-text"
        ? []
        : source.sections) {
        const wanted = only === undefined || only.has(section.id);
        let inlined = false;
        if (wanted && source.status === "fetched") {
          const cost = estimateTokens(section.bytes);
          if (tokens + cost <= bound) {
            const read = yield* sectionBody(ctx, source, section);
            if (read.text !== undefined) {
              tokens += cost;
              inlined = true;
              bodies.push(
                `${read.disclosure === undefined ? "" : `(Note: ${read.disclosure}.)\n`}${dataBlock("scope", { section: section.id, source: source.id, stratum: source.stratum, fetched: source.fetchedAt, title: section.title }, read.text)}`,
              );
            } else if (read.disclosure !== undefined)
              listing.push(`  ${section.id} not available: ${read.disclosure}`);
          }
        }
        if (only === undefined || only.has(section.id))
          ctx.handles.noteSeen(
            section.id,
            inlined ? "task:scope" : "task:scope-listing",
          );
        if (only === undefined || only.has(section.id))
          listing.push(
            `  ${section.id} "${section.title}" ${section.bytes} B${inlined ? " (below)" : mode === "frame" ? " (not included)" : " (scope_section)"}`,
          );
      }
    }
    for (const named of snapshot.named)
      listing.push(`named ${named.key} (${named.where}): ${named.status}`);
    for (const gap of snapshot.gaps) listing.push(`gap: ${gap}`);
    return [listing.join("\n"), ...bodies].join("\n\n");
  });
