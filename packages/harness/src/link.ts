import { Effect } from "effect";
import { z } from "zod";
import {
  Computations,
  Proofs,
  canonicalJson,
  sha256Hex,
} from "@neuve/records-core";
import {
  AssembledBatch,
  AssembledDigest,
  codeUnits,
  citationIndex,
  composeBatch,
  groupUnits,
  ownershipCheck,
  proofIndex,
  type BatchInputs,
  type AssembledUnit,
  type UnitsPlan,
} from "./compose.ts";
import { LinkedReview, anchorResolves, guidedBasis } from "./disposition.ts";
import { Frame } from "./frame.ts";
import { FindStored } from "./find.ts";
import { ReviewMap, ChangeMap } from "./review-map.ts";
import { RangeManifest } from "./manifest.ts";
import { ScopeSnapshot } from "./scope.ts";
import {
  codeStage,
  storedOutput,
  withRecords,
  type RunContext,
} from "./pipeline.ts";
import {
  clipText,
  type PublishCandidate,
  type PublishInputs,
} from "./publish.ts";
import { proximityUnits } from "./units.ts";
import {
  blobStructures,
  hunkBlobEntries,
  structuresByBlob,
} from "./blob-structure.ts";
import { captureOutlineSource } from "./graph-outline.ts";
import { asStructure, type BlobStructure, type Structure } from "./sections.ts";
import { step } from "./telemetry.ts";
import type { FinderResult } from "./pi/stages/finder-task.ts";
import type { RunSetup } from "./pi/stages/run.ts";

export const LINK_VERSION = 2;
export const DIGEST_CHARS = 2_000;
export const EXCLUDED_GROUP = "generated";
type Group = ReviewMap["groups"][number];
type Finding = FindStored["findings"][number];
type Disclosure = NonNullable<PublishInputs["disclosures"]>[number];

/** Excluded files still own their changed lines, in one code-only batch. */
export const fillGroups = (map: ReviewMap): Group[] => [
  ...map.groups,
  ...(map.excluded.length === 0
    ? []
    : [
        {
          id: EXCLUDED_GROUP,
          label: "Lockfiles and generated files",
          why: "Lockfiles and declared-generated files accompany the change.",
          tier: "mechanical" as const,
          doneWhen: [],
          files: map.excluded.map(({ path }) => ({
            path,
            placedBy: "code" as const,
          })),
          hunkIds: map.excluded.flatMap((file) => file.hunkIds),
          changedLines: 0,
        },
      ]),
];

/** Compatibility at the packet boundary; Frame and Map remain the input authorities. */
export const linkChangeMap = (frame: Frame, map: ReviewMap): ChangeMap => ({
  source: "mixed",
  summary: frame.goal,
  behaviours: fillGroups(map).map((group) => ({
    id: group.id,
    title: group.label,
    focus: group.why,
    hunkIds: [...group.hunkIds],
    scopeSectionIds: frame.doneWhen
      .filter((row) => group.doneWhen.includes(row.id))
      .flatMap((row) => (row.sectionId === null ? [] : [row.sectionId])),
    obligations: frame.doneWhen
      .filter((row) => group.doneWhen.includes(row.id))
      .map((row) => ({ ...row, hunkIds: [] })),
    from: [],
  })),
  hunkRoles: fillGroups(map).flatMap((group) =>
    group.hunkIds.map((hunkId) => ({
      hunkId,
      role: group.tier,
      note: "",
    })),
  ),
  understandPartitions: [],
  merges: [],
  gaps: [],
  questions: [],
  scopeGaps: [...frame.gaps, ...map.gaps],
  unlinked: map.unlinkedDoneWhen.length > 0,
  generated: [],
  keepTogether: [],
  candidates: [],
  reviewLines: { before: 0, after: 0, changes: [] },
});

const batchInputs = (
  frame: Frame,
  map: ReviewMap,
  manifest: RangeManifest,
  group: Group,
  keys: BatchInputs["keys"],
  snapshot: ScopeSnapshot | undefined,
  setup: RunSetup,
  structures?: ReadonlyMap<string, Structure>,
): BatchInputs => {
  const changeMap = linkChangeMap(frame, map);
  const behaviour = changeMap.behaviours.find((entry) => entry.id === group.id);
  if (behaviour === undefined)
    throw new Error(`Missing Link group ${group.id}`);
  return {
    behaviour,
    changeMap,
    manifest,
    hunks: new Map(manifest.hunks.map((hunk) => [hunk.hunkId, hunk])),
    snapshot,
    pins: setup.pins,
    keys,
    ...(structures === undefined ? {} : { structures }),
  };
};

/**
 * The structure of each text hunk's old and new blob, by blob object ID, for the units stage to cut
 * sections at (10.109). Read once per fill, from the structures Precompute stored; `blobStructures`
 * reads Graph only for a blob whose structure is not stored. A blob with no structure keeps its
 * file's hunks one section each. A failed read never fails the fill: it leaves every blob without a
 * structure, and the gap is counted on the span and in the run log.
 */
const fillStructures = (ctx: RunContext["Service"], manifest: RangeManifest) =>
  Effect.gen(function* () {
    const entries = hunkBlobEntries(manifest.hunks);
    // The run holds no outline source; it is captured here as `lookupContext` and the stack freeze
    // capture theirs. A structure's key holds the source key, so a changed engine never returns
    // another engine's structure: the lookup misses and the fallback recomputes under the new
    // source (once per changed blob), and `assertOutlineSource` refuses a change mid-read. With no
    // engine found the capture returns an unavailable key and the read succeeds: code blobs come back
    // `capability-unavailable`, counted on the span, and no gap is logged. A capture that throws is a
    // failed read like any other.
    const read = yield* Effect.result(
      Effect.flatMap(Effect.try(captureOutlineSource), (source) =>
        blobStructures(ctx.repository, [...entries.values()], source),
      ),
    );
    // One blob under two paths can be read two ways: it is given, with no cut and why.
    const joined =
      read._tag === "Success"
        ? structuresByBlob(entries.values(), read.success.structures)
        : { byBlob: new Map<string, BlobStructure>(), conflicting: 0 };
    const byOid = new Map<string, Structure>(
      [...joined.byBlob].map(([oid, stored]) => [oid, asStructure(stored)]),
    );
    if (read._tag === "Failure")
      ctx.log.write({
        type: "gap",
        stage: "link",
        agent: "link.fill",
        kind: "structures",
        // Plumbing a reader cannot act on: the units fall back to one section per hunk, so no
        // reader is told; the run log and the receipt keep it.
        published: false,
        detail:
          "The changed files' structures couldn't be read, so each hunk is its own section.",
        cause: `${String((read.failure as { _tag?: unknown })._tag ?? "error").slice(0, 100)}; ${entries.size} blobs without a structure`,
      });
    return {
      byOid,
      read,
      asked: entries.size,
      conflicting: joined.conflicting,
    };
  }).pipe((effect) =>
    step("harness.code-fill.structures", effect, (value) => ({
      "harness.structures.asked": value.asked,
      "harness.structures.status":
        value.read._tag === "Success" ? "read" : "failed",
      "harness.structures.unread":
        value.read._tag === "Success" ? 0 : value.asked,
      "harness.structures.conflicting": value.conflicting,
      "harness.structures.blobs": value.byOid.size,
      ...(value.read._tag === "Success"
        ? {
            "harness.structures.stored": value.read.success.counts.stored,
            "harness.structures.computed": value.read.success.counts.computed,
            "harness.structures.joined": value.read.success.counts.joined,
            ...Object.fromEntries(
              Object.entries(value.read.success.counts.none).map(
                ([reason, count]) => [
                  `harness.structures.none.${reason}`,
                  count,
                ],
              ),
            ),
          }
        : {}),
    })),
  );

/** Code's unit fill, with no model assessment, disposition, or context references. */
export const codeFilledBatch = (
  inputs: BatchInputs,
  proofs: UnitsPlan["proofs"] = [],
): AssembledBatch => {
  const applied = codeUnits(inputs);
  const groups = applied.batches.flatMap((batch) =>
    groupUnits(batch, applied.units),
  );
  const plan: UnitsPlan = {
    candidate: inputs.behaviour.id,
    ...applied,
    groups,
    references: [],
    proofs,
    ownership: ownershipCheck(inputs, applied.units),
    turns: {
      limit: 1,
      confirm: 0,
      groups: 0,
      groupTurns: 1,
      digests: 0,
      digestTurns: 1,
      overrun: false,
    },
  };
  const units = proximityUnits(
    inputs.behaviour.id,
    inputs.manifest.hunks.filter((hunk) =>
      inputs.behaviour.hunkIds.includes(hunk.hunkId),
    ),
  );
  const unitByHunk = new Map(
    units.flatMap((unit) => unit.hunkIds.map((id) => [id, unit.id])),
  );
  return composeBatch({
    inputs,
    plan,
    gaps: [],
    unitOf: (section) => {
      const id = section.hunkIds.flatMap(
        (hunk) => unitByHunk.get(hunk) ?? [],
      )[0];
      if (id === undefined)
        throw new Error(`Missing proximity unit for ${section.id}`);
      return id;
    },
  });
};

const put = (op: string, inputs: Record<string, string>, value: unknown) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const result = yield* store.run(
      {
        op,
        opVersion: LINK_VERSION,
        inputs: { ...inputs, output: sha256Hex(canonicalJson(value)) },
      },
      Effect.succeed({
        bytes: new TextEncoder().encode(JSON.stringify(value)),
        mediaType: "application/json",
      }),
    );
    return result.computation.key;
  });
const FillOutput = z.strictObject({
  groups: z.array(
    z.strictObject({ group: z.string(), assembledKey: z.string() }),
  ),
});
export type FillResult = {
  readonly record: import("./pipeline.ts").StageRecord;
} & z.infer<typeof FillOutput>;

export const fill = (
  ctx: RunContext["Service"],
  input: {
    readonly mapKey: string;
    readonly manifestKey: string;
    readonly setup: RunSetup;
  },
) =>
  Effect.gen(function* () {
    const map = yield* storedOutput(ctx, input.mapKey, ReviewMap);
    const frame = yield* storedOutput(ctx, map.frame, Frame);
    const manifest = yield* storedOutput(ctx, input.manifestKey, RangeManifest);
    const snapshot =
      input.setup.scopeKey === null
        ? undefined
        : yield* storedOutput(ctx, input.setup.scopeKey, ScopeSnapshot);
    const listed = yield* withRecords(
      ctx,
      Effect.result(
        Proofs.list({ repository: ctx.repository, range: ctx.range }),
      ),
    );
    const proofRecords =
      listed._tag === "Success" ? listed.success.records : [];
    const currency = Proofs.currencyChecker({
      repository: ctx.repository,
      headOid: ctx.range.headOid,
    });
    // Only with responsibility sections on: off, nothing is read and the inputs are as before.
    const structures =
      ctx.config.sections === undefined
        ? undefined
        : (yield* withRecords(ctx, fillStructures(ctx, manifest))).byOid;
    const outputs: AssembledBatch[] = [];
    for (const group of fillGroups(map)) {
      const inputs = batchInputs(
        frame,
        map,
        manifest,
        group,
        {
          manifest: input.manifestKey,
          changeMap: input.mapKey,
          scope: input.setup.scopeKey,
        },
        snapshot,
        input.setup,
        structures,
      );
      const applied = codeUnits(inputs);
      const currencies = new Map<string, Map<string, string>>();
      for (const proof of proofRecords) {
        const byUnit = new Map<string, string>();
        for (const unit of applied.units)
          byUnit.set(
            unit.id,
            Proofs.describeCurrency(
              yield* withRecords(
                ctx,
                currency(proof.revision, unit.ownedPaths),
              ),
            ),
          );
        currencies.set(proof.id, byUnit);
      }
      const output = codeFilledBatch(inputs, [
        ...proofIndex(proofRecords, currencies),
      ]);
      if (listed._tag === "Failure") {
        output.complete = false;
        output.gaps.push(
          "The range's proof records could not be read; verification has no proof credit.",
        );
      }
      outputs.push(output);
    }
    const record = yield* codeStage(
      ctx,
      "link",
      {
        op: "harness.code-fill",
        opVersion: LINK_VERSION,
        inputs: {
          map: input.mapKey,
          manifest: input.manifestKey,
          scope: input.setup.scopeKey,
          sources: sha256Hex(canonicalJson(input.setup.pins)),
          outputs: sha256Hex(canonicalJson(outputs)),
        },
      },
      Effect.gen(function* () {
        const groups = [];
        for (const output of outputs)
          groups.push({
            group: output.candidate,
            assembledKey: yield* put(
              "harness.code-filled-batch",
              { map: input.mapKey, manifest: input.manifestKey },
              output,
            ),
          });
        return { groups };
      }),
      {
        agent: "link.fill",
        afterCutoff: true,
        schema: FillOutput,
        fixedNote: "Code fill stored for every map group and excluded file.",
      },
    );
    if (record.key === undefined)
      throw new Error("Code fill did not store its output");
    return { record, ...(yield* storedOutput(ctx, record.key, FillOutput)) };
  });

export const placeFindings = (
  units: ReadonlyArray<AssembledUnit>,
  findings: ReadonlyArray<Finding>,
) => {
  const placed = new Map<string, Finding[]>();
  const disclosures: Disclosure[] = [];
  for (const finding of findings) {
    const primary = finding.anchors[0];
    const resolved =
      primary === undefined
        ? []
        : units.filter(
            (unit) =>
              unit.batchId === finding.group &&
              anchorResolves(primary, { unit, references: [] }),
          );
    const unit = resolved.length === 1 ? resolved[0] : undefined;
    if (unit === undefined)
      disclosures.push({
        kind: "finding-unanchored",
        detail:
          "One verified finding has no unique unit owning its primary anchor and is not published.",
      });
    else placed.set(unit.id, [...(placed.get(unit.id) ?? []), finding]);
  }
  return { placed, disclosures };
};

export const linkedReview = (
  inputs: BatchInputs,
  assembled: AssembledBatch,
  unit: AssembledUnit,
  findings: ReadonlyArray<Finding>,
): LinkedReview => {
  const batch = assembled.batches.find((batch) => batch.id === unit.batchId);
  if (batch === undefined || findings.length === 0)
    throw new Error("Link needs a touched unit in a batch");
  const guided = guidedBasis(inputs, batch, unit);
  const citations = citationIndex(inputs, {
    units: assembled.units,
    proofs: assembled.proofs.map((proof) => ({ ...proof, listing: "" })),
    references: [],
  }).index;
  const evidence = (finding: Finding) =>
    [...new Set([finding.hunkId, ...finding.evidence])]
      .filter((id) => citations.has(id))
      .slice(0, 8);
  const defects = findings.filter(
    (finding) => finding.kind === "defect" && evidence(finding).length > 0,
  );
  return LinkedReview.parse({
    unit: unit.id,
    source: "agent",
    uncited: false,
    withheld: defects.length === 0,
    notes: [],
    guided,
    citations: Object.fromEntries(citations),
    review: {
      verdict: defects.length > 0 ? "request-changes" : "approve",
      criteria: guided.rows.map((row) => {
        const defect = defects.find((finding) => finding.doneWhen === row.row);
        return {
          row: row.row,
          status: defect === undefined ? "no-evidence" : "not-met",
          does: clipText(
            defect?.claim ??
              "No verified defect establishes this condition's outcome.",
            200,
          ),
          evidence: defect === undefined ? [] : evidence(defect),
        };
      }),
      outside: [],
      findings: findings.map((finding) => ({
        id: finding.id,
        anchor: finding.anchors[0],
        kind: finding.kind,
        about: finding.about,
        signal: finding.signal,
        text: clipText(
          [
            finding.claim,
            ...finding.anchors
              .slice(1)
              .map(
                (anchor) =>
                  `${anchor.path} lines ${anchor.startLine}-${anchor.endLine} (${anchor.side === "new" ? "head" : "base"})`,
              ),
          ].join("; "),
          400,
        ),
        evidence: evidence(finding),
        row: null,
      })),
      message: clipText(
        defects.length > 0
          ? defects.map((finding) => finding.claim).join("\n")
          : "Verified comments are recorded. This unit has no agent disposition.",
        1200,
      ),
      gaps: findings.some(
        (finding) =>
          finding.kind === "defect" && evidence(finding).length === 0,
      )
        ? [
            "A verified defect has no resolvable evidence and cannot support a disposition.",
          ]
        : [],
    },
  });
};

/** Append complete links only; the digest cap can never sever a finding's unit link. */
const fitLines = (lines: ReadonlyArray<string>, cap: number) => {
  let result = "";
  for (const line of lines) {
    const next = result === "" ? line : `${result}\n${line}`;
    if (next.length > cap) break;
    result = next;
  }
  return result;
};
const linkLabel = (text: string) =>
  text.replace(/[\[\]\\]/g, " ").replace(/\s+/g, " ");
export const groupDigest = (
  frame: Frame,
  group: Group,
  units: ReadonlyArray<AssembledUnit>,
  placed: ReadonlyMap<string, ReadonlyArray<Finding>>,
  conditions: NonNullable<FindStored["conditions"]>,
  limitations: ReadonlyArray<string>,
): AssembledDigest => {
  const links = units.flatMap((unit) =>
    (placed.get(unit.id) ?? []).map(
      (finding) => `[${linkLabel(finding.claim)}](${unit.id})`,
    ),
  );
  const header = clipText(
    `${frame.goal}\n${group.why}\n${units.length} units.`,
    1_000,
  );
  const digest = fitLines([header, ...links], DIGEST_CHARS);
  const omitted =
    links.length -
    (digest === header
      ? 0
      : digest.split("\n").length - header.split("\n").length);
  return {
    batchId: group.id,
    source: "code",
    digest,
    verification: frame.doneWhen
      .filter((row) => group.doneWhen.includes(row.id))
      .map((row) => {
        const condition = conditions.find(
          (condition) => condition.doneWhen === row.id,
        );
        return `[${linkLabel(clipText(row.text, 240))}](${row.id}): ${condition?.verdict ?? "not checked"}${condition === undefined ? "" : `. ${condition.note}`}`;
      })
      .join("\n"),
    uncertainty: [],
    limitations: [
      ...limitations,
      ...(omitted > 0
        ? [
            `${omitted} findings are available in the units' comments beyond this digest's limit.`,
          ]
        : []),
      "Units without verified defects carry no agent disposition.",
    ],
    verdictWords: 0,
  };
};

const LinkOutput = z.strictObject({
  candidates: z.array(
    z.strictObject({
      candidate: z.string(),
      assembledKey: z.string(),
      disposed: z.array(
        z.strictObject({
          unit: z.string(),
          key: z.string(),
          status: z.literal("computed"),
        }),
      ),
    }),
  ),
  changeMapKey: z.string(),
  disclosures: z.array(
    z.strictObject({ kind: z.string(), detail: z.string() }),
  ),
});

export const link = (
  ctx: RunContext["Service"],
  input: {
    readonly frameKey: string;
    readonly mapKey: string;
    readonly manifestKey: string;
    readonly fill: FillResult;
    readonly finders: ReadonlyArray<FinderResult>;
    readonly setup: RunSetup;
  },
) =>
  Effect.gen(function* () {
    const frame = yield* storedOutput(ctx, input.frameKey, Frame);
    const map = yield* storedOutput(ctx, input.mapKey, ReviewMap);
    const manifest = yield* storedOutput(ctx, input.manifestKey, RangeManifest);
    const snapshot =
      input.setup.scopeKey === null
        ? undefined
        : yield* storedOutput(ctx, input.setup.scopeKey, ScopeSnapshot);
    const findings: Finding[] = [];
    const conditions: NonNullable<FindStored["conditions"]> = [];
    const disclosures: Disclosure[] = [];
    const limitations: string[] = [];
    for (const finder of input.finders) {
      const stored =
        finder.findKey === null
          ? undefined
          : yield* storedOutput(ctx, finder.findKey, FindStored);
      const unverified = finder.findings.filter(
        (finding) =>
          finding.status === "unverified" ||
          (finding.status === "kept" && finding.verifyKey === null),
      ).length;
      const dropped = finder.findings.filter(
        (finding) => finding.status === "dropped",
      ).length;
      limitations.push(
        `${finder.lens}: ${dropped} findings dropped by verification.`,
      );
      if (finder.reason !== undefined) {
        limitations.push(`${finder.lens}: ${finder.reason}`);
        disclosures.push({
          kind: "finder-unavailable",
          detail: `The ${finder.lens} finder has limited coverage. ${finder.reason}`,
        });
      }
      if (unverified > 0) {
        const detail = `${finder.lens}: ${unverified} findings were not verified and are not published.`;
        disclosures.push({ kind: "findings-unverified", detail });
        limitations.push(detail);
      }
      if (stored === undefined) continue;
      if (stored.reading.used >= stored.reading.limit)
        limitations.push(`${finder.lens} spent its reading budget.`);
      if (finder.lens === "scope-fit")
        conditions.push(...(stored.conditions ?? []));
      for (const result of finder.findings)
        if (result.status === "kept" && result.verifyKey !== null) {
          const finding = stored.findings.find(
            (finding) => finding.id === result.id,
          );
          if (finding !== undefined) findings.push(finding);
        }
    }
    const filled: AssembledBatch[] = [];
    for (const group of input.fill.groups)
      filled.push(yield* storedOutput(ctx, group.assembledKey, AssembledBatch));
    const placement = placeFindings(
      filled.flatMap((batch) => batch.units),
      findings,
    );
    disclosures.push(...placement.disclosures);
    const record = yield* codeStage(
      ctx,
      "link",
      {
        op: "harness.link",
        opVersion: LINK_VERSION,
        inputs: {
          frame: input.frameKey,
          map: input.mapKey,
          manifest: input.manifestKey,
          fill: input.fill.groups,
          finders: sha256Hex(
            canonicalJson(
              input.finders.map((finder) => ({
                lens: finder.lens,
                findKey: finder.findKey,
                findings: finder.findings,
                ...(finder.reason === undefined
                  ? {}
                  : { reason: finder.reason }),
              })),
            ),
          ),
          scope: input.setup.scopeKey,
          sources: sha256Hex(canonicalJson(input.setup.pins)),
        },
      },
      Effect.gen(function* () {
        const changeMapKey = yield* put(
          "harness.link-change-map",
          { frame: input.frameKey, map: input.mapKey },
          linkChangeMap(frame, map),
        );
        const candidates: PublishCandidate[] = [];
        for (const assembled of filled) {
          const group = fillGroups(map).find(
            (group) => group.id === assembled.candidate,
          );
          if (group === undefined)
            throw new Error(`Missing group ${assembled.candidate}`);
          const inputs = batchInputs(
            frame,
            map,
            manifest,
            group,
            {
              manifest: input.manifestKey,
              changeMap: changeMapKey,
              scope: input.setup.scopeKey,
            },
            snapshot,
            input.setup,
          );
          const disposed = [];
          for (const unit of assembled.units) {
            const own = placement.placed.get(unit.id);
            if (own === undefined) continue;
            const key = yield* put(
              "harness.link-review",
              { frame: input.frameKey, map: input.mapKey },
              linkedReview(inputs, assembled, unit, own),
            );
            disposed.push({ unit: unit.id, key, status: "computed" as const });
          }
          const digest = groupDigest(
            frame,
            group,
            assembled.units,
            placement.placed,
            conditions,
            limitations,
          );
          for (const row of frame.doneWhen)
            assembled.citations[row.id] = {
              kind: "obligation",
              ref: `computation:${changeMapKey}`,
              entry: row.id,
            };
          for (const unit of assembled.units)
            assembled.citations[unit.id] = {
              kind: "unit",
              ref: null,
              entry: unit.id,
            };
          const output = {
            ...assembled,
            batches: assembled.batches.map((batch) => ({ ...batch, digest })),
          };
          candidates.push({
            candidate: group.id,
            assembledKey: yield* put(
              "harness.linked-batch",
              { frame: input.frameKey, map: input.mapKey },
              output,
            ),
            disposed,
          });
        }
        return LinkOutput.parse({ candidates, changeMapKey, disclosures });
      }),
      {
        agent: "link",
        afterCutoff: true,
        schema: LinkOutput,
        fixedNote:
          "Verified findings linked to owned units; Link grants no approvals.",
      },
    );
    if (record.key === undefined)
      throw new Error("Link did not store its output");
    return { record, ...(yield* storedOutput(ctx, record.key, LinkOutput)) };
  });
