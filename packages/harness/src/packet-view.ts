import { posix } from "node:path";
import {
  Checkpoints,
  type Dispositions,
  type PublishedPackets,
} from "@neuve/records-core";

/**
 * The terminal printer of a published packet, for `neuve review show`. The packet is read by
 * Records' read model (`PublishedPackets` in `@neuve/records-core`, M5 RD1), which the web app
 * reads too; this module only lays it out.
 */

type StandingPacket = PublishedPackets.StandingPacket;
type ReadPacket = PublishedPackets.ReadPacket;
type ReadPacketV2 = PublishedPackets.ReadPacketV2;
type ReadBatch = PublishedPackets.ReadBatch;
type ReadUnit = PublishedPackets.ReadUnit;
type ReadSection = PublishedPackets.ReadSection;

const short = (id: string) => id.slice(0, 12);

/**
 * Terminal escape sequences, control characters and bidirectional overrides. Every string a
 * packet stores, of either shape, was written by a model or read from a repository, so none may drive the
 * terminal or reorder what a person sees. It keeps tabs and line breaks, which each printer's
 * helpers handle: `one` and `clean` for the old shape, `line` and `block` for the new.
 *
 * An OSC's body (`ESC ]` to its BEL or `ESC \`) never runs past a line feed, so a sequence left
 * unterminated removes at most the rest of its own line, never the text after it. A CSI cannot
 * cross a line either. The other string-type openers (DCS `ESC P`, SOS `ESC X`, PM `ESC ^`, APC
 * `ESC _`) are removed as two-character escapes, their bodies kept as text; the C1 forms of every
 * opener are removed as single controls. Derived from `UNSAFE` in the CLI's `proof-cli.ts`, which
 * stops an OSC only at BEL or ESC.
 */
const UNSAFE =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]?|\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?|[@-Z\\-_])?|[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * Text with terminal escape sequences, control characters other than tab and line feed, and
 * bidirectional overrides removed, and every other character kept: the one definition of what may
 * reach a terminal, used by both printers here and by the CLI's guard on `review show`'s output.
 * Text without them is returned unchanged.
 */
export const terminalSafe = (text: string) => text.replace(UNSAFE, "");

/** The old printer's stored text with escape and control characters removed. */
const clean = terminalSafe;

/**
 * The old printer's rule for stored text of several lines: no line of it may start at an
 * indentation a line the printer writes itself uses. The deepest of those is eight spaces (a
 * Guided row's `does` and `SOURCES DISAGREE` lines), so every stored line that begins a line is
 * indented `DEEP`, ten spaces.
 */
const DEEP = "          ";
const storedLines = (text: string) => clean(text).split(/\n|\u2028|\u2029/);

/**
 * A field printed inline after its prefix (a comment body, a rationale, the facts, a gap's
 * detail, an ownership disclosure): its first line stays on its real line, so a one-line value
 * prints as it always has; every later line is indented `DEEP`. `first` and `rest` apart, so a
 * suffix can follow the first line.
 */
const inlineParts = (text: string) => {
  const [first = "", ...rest] = storedLines(text);
  return { first, rest: rest.map((row) => `\n${DEEP}${row}`).join("") };
};
const inline = (text: string) => {
  const { first, rest } = inlineParts(text);
  return `${first}${rest}`;
};

/** A block under its own heading (a digest, a review message): every line of it indented `DEEP`. */
const deepBlock = (text: string) =>
  storedLines(text).map((row) => `${DEEP}${row}`);

/**
 * The old printer's one-line field (a title, name, path, kind, verdict or lane word, requirement
 * text, ID or hash), cleaned, with each line break or tab made one space, so a stored string never
 * begins a line. Text without them prints byte for byte as before.
 */
const one = (text: string) => clean(text).replace(/[\t\n\u2028\u2029]/g, " ");
/** A one-line field in double quotes, its own quotes and backslashes escaped. */
const oneQuoted = (text: string) => `"${one(text).replace(/["\\]/g, "\\$&")}"`;
const oneId = (id: string) => one(shortId(id));
const oneHash = (hash: string) => one(short(hash));

/**
 * A ULID as `review show` prints it: its last 10 characters, the random part, which tells apart
 * the units and batches of one packet even when they share a time and sequence (their prefix).
 */
const shortId = (id: string) => `…${id.slice(-10)}`;

const citeText = (
  cites: ReadonlyArray<{ ref: string; entry?: string | undefined }>,
) =>
  cites
    .map((c) => {
      const [kind, id] = c.ref.split(":");
      return `${kind === "event" ? `event ${shortId(id ?? "")}` : `${kind} ${short(id ?? "")}`}${c.entry === undefined ? "" : `#${c.entry}`}`;
    })
    .join(", ");

const closureText = (judgement: Dispositions.UnitJudgement) =>
  judgement.closed
    ? `closed (${judgement.needs === "no-disposition" ? "static automation needs no disposition" : `by ${judgement.closing.length} disposition(s)`}${judgement.assessed ? "" : "; not assessed, so human-suggested and the agent's disposition applies (10.100)"}${judgement.standing !== null && judgement.closing.length > 1 ? `; ${judgement.standing.actorKind === "human" ? "a person's" : "the"} ${judgement.standing.verdict} stands` : ""})`
    : judgement.needs === "a-human-disposition"
      ? `open: needs a person's disposition${judgement.context.length > 0 ? `; ${judgement.context.length} agent disposition(s) reach them as context (4.14)` : ""}`
      : judgement.needs === "an-assessment"
        ? "open: Records holds no record of this unit"
        : `open: needs a disposition${judgement.assessed ? "" : " (not assessed, so human-suggested, 10.100)"}`;

/** Where a resolved local ID points, in a few words. */
const resolutionText = (cited: PublishedPackets.CitedId) => {
  const r = cited.resolution;
  if (r === undefined)
    return `UNRESOLVED (${cited.unresolved ?? "unknown"}${cited.detail === undefined ? "" : `: ${cited.detail}`})`;
  switch (r.kind) {
    case "reference": {
      const [anchor] = r.detail.anchors;
      return `context ${shortId(r.eventId)} (${r.detail.local}, ${r.detail.grade}${r.via === undefined ? "" : `, from ${r.via}`})${anchor === undefined ? "" : ` ${posix.basename(anchor.path)} ${anchor.side} ${anchor.startLine}-${anchor.endLine}`}`;
    }
    case "hunk":
      return `hunk ${posix.basename(r.path)} ${r.ranges.map((range) => `${range.side} ${range.startLine === undefined ? "whole" : `${range.startLine}-${range.endLine}`}`).join(", ")}`;
    case "unit":
      return `unit ${shortId(r.unitId)} (${r.local})`;
    case "proof":
      return `proof ${shortId(r.eventId)}`;
    default:
      return `${r.kind} ${r.ref.split(":")[0]} ${short(r.ref.split(":")[1] ?? "")}${r.entry === null ? "" : `#${r.entry}`}`;
  }
};

const citationLines = (
  citations: PublishedPackets.Citations,
  prefix: string,
) =>
  citations.cited.length === 0
    ? []
    : [
        `${prefix}citations (local IDs, resolved through the assembled batch): ${citations.resolved} resolved, ${citations.unresolved} unresolved`,
        ...citations.cited.map(
          (c) =>
            `${prefix}  ${one(c.id)} [${c.stops.map(one).join(", ")}] -> ${one(resolutionText(c))}`,
        ),
      ];

/**
 * A `packet.published@1` as `neuve review show` has always printed it, but for each unit's title in
 * quotes and each batch's focus under a label, so neither can pass for a line the printer writes.
 */
const describeV1 = (packet: StandingPacket) => {
  const c = packet.counts;
  const lines = [
    `packet (packet.published@1 ${one(packet.eventId)}, manifest blob ${oneHash(packet.manifest)}): ${packet.complete ? "complete" : "INCOMPLETE, gaps disclosed"}${packet.requestedPacket === packet.eventId ? "" : ` (the standing packet; this run's own ${one(packet.requestedPacket)} was superseded by a later packet)`}${packet.supersedes === null ? "" : `; supersedes ${one(packet.supersedes)}`}`,
    `  ${c.batches} batch(es), ${c.units} unit(s), ${c.contextReferences} context reference(s), ${c.assessments} assessment(s), ${c.deliveries} delivery stop(s), ${c.comments} comment(s), ${c.dispositions} disposition(s), ${c.gaps} publish gap(s)`,
  ];
  for (const batch of packet.batches) {
    const digest = batch.digest;
    lines.push(
      "",
      `batch ${oneId(batch.batchId)} (${one(batch.local)}) "${one(batch.recorded?.payload.title ?? "?")}"`,
      // The focus under a label of its own, so no focus can begin a line the printer writes.
      `  focus: ${oneQuoted(batch.recorded?.payload.focus ?? "")}`,
      ...(digest?.digest === undefined
        ? []
        : [
            `  digest (${one(digest.source ?? "?")}, advisory):`,
            ...deepBlock(digest.digest),
            `  verification: ${one(digest.verification ?? "-")}`,
          ]),
      // Each obligation's status across the batch's units (10.87).
      ...(digest?.obligations === undefined || digest.obligations.length === 0
        ? []
        : [
            "  obligations across units:",
            ...digest.obligations.map(
              (o) =>
                `    ${one(o.overall).toUpperCase()} ${one(o.row)} ${one(o.text)} (${o.units.map((u) => `${one(u.unit)} ${u.required ? one(u.status) : "not required"}`).join(", ")})`,
            ),
          ]),
      ...citationLines(batch.digestCitations, "  digest "),
    );
    for (const unit of batch.units) {
      const a = unit.assessment?.payload;
      const guided = unit.content.guided ?? {};
      const facts = unit.content.facts;
      lines.push(
        `  unit ${oneId(unit.unitId)} (${one(unit.local)}) [${one(a?.lane ?? "no assessment")}] ${oneQuoted(unit.recorded?.payload.title ?? "")}`,
        `    owned: ${(unit.recorded?.payload.ownedRanges ?? []).map((r) => (r.kind === "lines" ? `${one(posix.basename(r.path))} ${one(r.side)} ${r.startLine}-${r.endLine}` : `${one(posix.basename(r.path))} ${one(r.side)} whole`)).join(", ")}`,
        ...(a === undefined
          ? []
          : [
              `    ${one(a.quadrant)}: ${inline(a.rationale)}`,
              ...a.easeOfValidation.requirements.map(
                (r) =>
                  `    requirement ${one(r.coverage).toUpperCase()}: ${one(r.requirement)}${r.proof.length === 0 ? "" : ` [proof ${r.proof.map(oneId).join(", ")}]`}`,
              ),
            ]),
        ...(facts?.text === undefined
          ? []
          : [`    facts: ${inline(facts.text)}`]),
        `    guided (${one(guided.basis ?? "none")}${guided.unlinked ? ", unlinked" : ""}; scope ${one(String(guided.stratum ?? "?"))}):`,
        ...(guided.rows ?? []).flatMap((row) => [
          row.required === false
            ? `      NOT REQUIRED BY THIS UNIT ${one(row.row)} [${one(row.basis)}] ${one(row.text)} (static automation closed it on other rows)`
            : `      ${one(row.status).toUpperCase()} for this unit${row.closedOn === true ? " (static automation closed it on this row)" : ""} ${one(row.row)} [${one(row.basis)}] ${one(row.text)}`,
          `        ${one(row.does)}${row.evidence.length === 0 ? "" : ` [${row.evidence.map(one).join(", ")}]`}`,
          ...(row.disagreement === undefined
            ? []
            : [`        SOURCES DISAGREE (11.1): ${one(row.disagreement)}`]),
        ]),
        ...(guided.omitted ?? []).map(
          (o) =>
            `      NOT JUDGED ${one(o.row)} (past the 20-row bound, disclosed) ${one(o.text)}`,
        ),
        ...(guided.outside ?? []).map(
          (o) =>
            `      OUTSIDE ${one(o.item)}: ${one(o.does)}${o.evidence.length === 0 ? "" : ` [${o.evidence.map(one).join(", ")}]`}`,
        ),
        ...(guided.review === null || guided.review === undefined
          ? [
              "    review: none (the unit's review did not finish; nothing invented)",
            ]
          : [
              `    review (${one(guided.review.source)}, lane-blind): ${guided.review.withheld === true ? "no disposition" : one(guided.review.verdict)}${guided.review.uncited ? " UNCITED" : ""}`,
              ...deepBlock(guided.review.message),
            ]),
        ...(guided.suggestion === null || guided.suggestion === undefined
          ? []
          : [
              `    suggested review (human-required; not a disposition until a person sends it): ${one(guided.suggestion.verdict)}`,
            ]),
        ...(unit.disposition === undefined
          ? ["    disposition: none recorded by the agent"]
          : [
              `    disposition ${one(unit.disposition.payload.verdict)} (${oneId(unit.disposition.id)}) at ${oneHash(unit.disposition.payload.reviewedHeadOid)}; rests on ${unit.disposition.payload.restsOn.length} comment(s); cites ${unit.disposition.payload.proof.length} proof record(s)`,
            ]),
        ...(guided.proof === undefined ? [] : [`    ${one(guided.proof)}`]),
        ...unit.comments.map((comment) => {
          const f = comment.payload.finding;
          const anchor = comment.payload.anchor;
          // The evidence follows the body's first line, where a one-line body has always had it.
          const body = inlineParts(comment.payload.body);
          return `    comment ${oneId(comment.id)} ${f === undefined ? "" : `[${one(f.kind)}/${one(f.about)}${f.signal === undefined ? "" : `/${one(f.signal)}`}] `}${anchor === undefined ? "" : `${one(posix.basename(anchor.path))}:${one(anchor.side)}${anchor.startLine}-${anchor.endLine} `}${body.first}${f === undefined || f.evidence.length === 0 ? "" : ` (${one(citeText(f.evidence))})`}${body.rest}`;
        }),
        ...unit.references.flatMap((r) => {
          const detail = unit.referenceDetails[r.id];
          return [
            `    context ${oneId(r.id)} ${one(r.payload.markerKind)}/${one(r.payload.stance)} ${one(r.payload.source.locator)}`,
            // The reference whole, from the assembled batch the event names (M5 §2.1).
            ...(detail === undefined
              ? []
              : [
                  `      ${one(detail.local)} ${one(detail.grade)}; ${detail.anchors.length} anchor(s); from ${detail.entries.map(one).join(", ") || "no ledger entry"}`,
                  `      why: ${one(detail.why)}`,
                  `      before you decide: ${one(detail.beforeYouDecide)}`,
                ]),
          ];
        }),
        ...(guided.notes ?? []).map((note) => `    code: ${one(note)}`),
        `    closure: ${closureText(unit.judgement)}`,
        ...citationLines(unit.citations, "    "),
      );
    }
  }
  if (packet.gaps.length > 0) {
    lines.push("", "gaps disclosed by the run (gap.disclosed@1)");
    // A gap's stage begins its line at a unit line's depth, so a stage name shaped like a unit line
    // would read as one. Safe today because only code names a gap's stage (the pipeline's own
    // stage names); a writer that lets a model or a repository name it must move it off that depth.
    for (const gap of packet.gaps)
      lines.push(
        `  ${one(gap.attribution.stage ?? "run")}: ${one(gap.payload.kind)}${gap.attribution.unitIds === undefined ? "" : ` (unit ${gap.attribution.unitIds.map(oneId).join(", ")})`}: ${inline(gap.payload.detail)}`,
      );
    const ownership = packet.gaps.filter(
      (gap) =>
        gap.payload.kind === "unit-owns-nothing" ||
        /owns no changed lines|no owner|refused the units' ownership/.test(
          gap.payload.detail,
        ),
    );
    lines.push(
      "",
      `ownership disclosures (10.21): ${ownership.length === 0 ? "none" : ownership.length}`,
      // An ownership disclosure's detail begins its line at a unit line's depth, so a detail shaped
      // like a unit line would read as one. Every gap whose detail holds an ownership phrase is
      // listed here, Publish's ownership gaps and stage gaps from the run log among them. Safe
      // today because every writer of such a detail is a code template that begins with code
      // text; a writer that lets a model or a repository begin one must move it off that depth.
      // Its later lines are indented `DEEP` like every inline field's.
      ...ownership.map((gap) => `  ${inline(gap.payload.detail)}`),
    );
  }
  // Stored content today's schemas could not read, disclosed rather than thrown (M5 S1).
  if (packet.undecoded.length > 0)
    lines.push(
      "",
      "stored content not decoded (disclosed; the rest of the packet reads as stored)",
      ...packet.undecoded.map(
        (u) =>
          `  ${one(u.what)} (${one(u.ref.split(":")[0] ?? "")} ${oneHash(u.ref.split(":")[1] ?? u.ref)}): ${one(u.issue)}`,
      ),
    );
  return lines;
};

// ---------------------------------------------------------------------------------------------
// A `packet.published@2`: one publication of a review's chain, its units by section
// ---------------------------------------------------------------------------------------------

/**
 * Invisible format characters `UNSAFE` lets through, which make two names look alike: zero-width
 * space, non-joiner and joiner, the left-to-right and right-to-left marks, the word joiner and the
 * invisible operators, the Arabic letter mark, the byte-order mark and the soft hyphen. The new
 * printer's alone, so the old one stays as it printed.
 */
const INVISIBLE = /[\u200b-\u200f\u2060-\u2064\u061c\ufeff\u00ad]/g;

/**
 * A stored string printed inside one line (a title, name, ID, path, rule, cause, reading,
 * requirement, effect or lane word): cleaned, and every run of whitespace, line breaks and tabs
 * included, made one space, so it can never begin a line of its own nor pad the true end of its
 * line out of sight.
 */
const line = (text: string) =>
  text.replace(UNSAFE, "").replace(INVISIBLE, "").replace(/\s+/g, " ");

/** A stored one-line string in double quotes, its own quotes and backslashes escaped. */
const quoted = (text: string) => `"${line(text).replace(/["\\]/g, "\\$&")}"`;

/** An ID or hash as the new printer shows it, short, through the cleaner: the manifest's are any string. */
const idText = (id: string) => line(shortId(id));
const hashText = (hash: string) => line(short(hash));

/**
 * Stored text that is legitimately several lines (a comment body, a rationale, the facts, a
 * digest, a review message, a gap's detail) is printed under its own heading line, every line of it
 * indented by `BLOCK`. That is deeper than any line the printer itself writes (eight spaces at
 * most), so no stored line can pass for a unit, section, disposition, requirement, closure or
 * disclosure line.
 */
const BLOCK = "          ";
const block = (text: string) =>
  text
    .replace(UNSAFE, "")
    .replace(INVISIBLE, "")
    .replace(/\t/g, " ")
    .split(/\n|\u2028|\u2029/)
    .map((row) => `${BLOCK}${row}`);

type Range = NonNullable<
  ReadUnit["recorded"]
>["payload"]["ownedRanges"][number];

const rangeText = (r: Range) =>
  r.kind === "lines"
    ? `${line(posix.basename(r.path))} ${line(r.side)} ${r.startLine}-${r.endLine}`
    : `${line(posix.basename(r.path))} ${line(r.side)} whole`;

/** Counts by cause, such as `1 failed, 2 unsure`; empty when there are none. */
const causeText = (counts: Readonly<Record<string, number>>) =>
  Object.entries(counts)
    .map(([cause, n]) => `${n} ${line(cause)}`)
    .join(", ");

const causeTotal = (counts: Readonly<Record<string, number>>) =>
  Object.values(counts).reduce((sum, n) => sum + n, 0);

/** How the printer names units: by title, cleaned and quoted, by Records ID or by local handle. */
interface Names {
  readonly byId: (unitId: string) => string | undefined;
  /** A unit's local handle, such as `b1.u1`, by its title; the handle itself when it has none. */
  readonly byLocal: (local: string) => string;
  /** A unit with no title to show: its handle, cleaned, or its short ID when it has none. */
  readonly fallback: (unit: ReadUnit) => string;
  /** A change of this packet by its key: its title, quoted; undefined when the packet holds none. */
  readonly bySection: (key: string) => string | undefined;
}

/** Where a resolved local ID points, naming a unit of this packet by its title. */
const citationLinesV2 = (
  citations: PublishedPackets.Citations,
  prefix: string,
  names: Names,
) =>
  citations.cited.length === 0
    ? []
    : [
        `${prefix}citations (local IDs, resolved through the assembled batch): ${citations.resolved} resolved, ${citations.unresolved} unresolved`,
        ...citations.cited.map((c) => {
          const title =
            c.resolution?.kind === "unit"
              ? names.byId(c.resolution.unitId)
              : undefined;
          return `${prefix}  ${line(c.id)} [${c.stops.map(line).join(", ")}] -> ${title === undefined ? line(resolutionText(c)) : `unit ${title}`}`;
        }),
      ];

/** Whether a section's lane moved from the judged one: the public-surface raise or a floor. */
const raised = (lane: NonNullable<ReadSection["lane"]>) =>
  lane.floors.length > 0 ||
  lane.surfaced !== lane.judged ||
  lane.applied !== lane.judged;

/** The trail from the judged lane to the applied one, in words. */
const trailText = (lane: NonNullable<ReadSection["lane"]>) =>
  [
    `judged ${lane.judged === null ? "by no agent" : line(lane.judged)}`,
    ...(lane.surfaced !== lane.judged && lane.surfaced !== null
      ? [`raised to ${line(lane.surfaced)} for the public surface`]
      : []),
    ...lane.floors.map(
      (floor) =>
        `raised to ${line(floor.to)} by a code rule (${line(floor.rule)})`,
    ),
    `applied ${line(lane.applied)}`,
  ].join("; ");

/**
 * A unit's closure as today's shape says it. When the decision that stands is a person's carried
 * from an earlier review, it says so: a person's decision, as their own would read, never the
 * review's.
 */
const closureTextV2 = (unit: ReadUnit) => {
  const text = closureText(unit.judgement);
  const standing = unit.judgement.standing;
  if (
    !unit.judgement.closed ||
    standing === null ||
    !unit.carriedDecisions.some((carried) => carried.id === standing.eventId)
  )
    return text;
  // A closed unit's text ends in its closing parenthesis.
  return unit.judgement.closing.length > 1
    ? `${text.slice(0, -1)}, carried from an earlier review)`
    : `${text.slice(0, -1)}; a person's ${standing.verdict}, carried from an earlier review)`;
};

/** Why no agent judged a file the map excluded, in words. */
const EXCLUDED_WORDS: Readonly<Record<string, string>> = {
  lockfile: "a lockfile",
  "declared-generated": "a file declared generated",
  "linguist-generated": "a file Linguist's generated list marks",
  "linguist-vendored": "a file Linguist's vendored list marks",
};

/** An excluded file's reason in words; a reason without words of its own, cleaned. */
const excludedText = (reason: string) =>
  Object.hasOwn(EXCLUDED_WORDS, reason)
    ? EXCLUDED_WORDS[reason]!
    : line(reason);

/**
 * Whether a person's carried decision still stands: Records counts it among the unit's current
 * decisions (those that close it, or reach its person as context). One the person retracted or
 * replaced after publication is still listed, since the packet is frozen. On a lane that needs no
 * decision Records lists none, so there it cannot be told and is not marked.
 */
const stillStands = (unit: ReadUnit, eventId: string) =>
  unit.judgement.needs === "no-disposition" ||
  unit.judgement.closing.some((d) => d.eventId === eventId) ||
  unit.judgement.context.some((d) => d.eventId === eventId);

/** The words a context change is shown with when its rule gives no statement of its own. */
const CONTEXT_WORDS = "imports only";

/**
 * How a change's judgement was produced, when not by an agent's two readings: the code rules that
 * judged it (and that an agent reviewed it, when one reading was made; its verdict is on the
 * change's own line), the
 * change whose pattern it shares and whose judgement it carries, and that it is context of its
 * file's unit. Nothing for a change judged before these were recorded.
 */
const treatmentLines = (section: ReadSection, names: Names) => {
  const rules = section.rules ?? [];
  const representative = section.family?.representative;
  const statement = rules
    .map((rule) =>
      rule.statement === undefined ? "" : line(rule.statement).trim(),
    )
    .find((text) => text !== "");
  return [
    ...(section.origin?.assess === "rule" && rules.length > 0
      ? [
          `      judged by ${rules.length === 1 ? "a code rule" : "code rules"} (${rules.map((rule) => `${line(rule.rule)}, version ${rule.version}`).join("; ")})${section.origin.review === "model" ? " and reviewed by an agent" : ""}`,
        ]
      : []),
    ...(representative === undefined || representative === section.key
      ? []
      : [
          `      same pattern as ${names.bySection(representative) ?? "another change of this review"}`,
        ]),
    ...(section.context === true
      ? [`      context of this file's unit: ${statement ?? CONTEXT_WORDS}`]
      : []),
  ];
};

const sectionLines = (unit: ReadUnit, section: ReadSection, names: Names) => {
  const lane = section.lane;
  const requirements = section.assess?.easeOfValidation.requirements ?? [];
  const checkpoints = unit.checkpoints.filter(
    (checkpoint): checkpoint is Checkpoints.SectionCheckpoint =>
      "section" in checkpoint && checkpoint.section === section.key,
  );
  return [
    `    change ${quoted(section.title)} [${lane === undefined ? "no judgement" : line(lane.applied)}]${section.renamedFrom === null ? "" : ` (renamed from ${line(section.renamedFrom)})`}: ${section.ownedRanges.length} owned range(s)${section.review === null || section.review === undefined ? "" : `; review ${line(section.review.verdict)}`}`,
    ...treatmentLines(section, names),
    ...(section.undecided === undefined
      ? section.excluded !== undefined
        ? [
            `      not judged by an agent: ${excludedText(section.excluded.reason)}, which the review does not read; lane ${lane === undefined ? "not recorded" : trailText(lane)}`,
          ]
        : lane !== undefined && raised(lane)
          ? [`      lane: ${trailText(lane)}`]
          : []
      : [
          `      not decided by an agent: ${line(section.undecided.cause)} (at the ${line(section.undecided.reading)} stage); lane ${lane === undefined ? "not recorded" : trailText(lane)}`,
        ]),
    // Each requirement with the proof state code set at this read (11.16).
    // A checkpoint is one distinct requirement of the unit, listed under the section that places
    // it; its coverage is that section's word for the same requirement.
    ...checkpoints.map((checkpoint) => {
      const identity = Checkpoints.requirementIdentity({
        requirement: checkpoint.requirement,
        cites: checkpoint.cites,
        kinds: checkpoint.kinds ?? [],
        proof: checkpoint.records.map((record) => record.eventId),
      });
      const coverage = requirements.find(
        (requirement) =>
          Checkpoints.requirementIdentity(requirement) === identity,
      )?.coverage;
      return `      requirement ${checkpoint.proof.toUpperCase()}${coverage === undefined ? "" : ` (coverage ${line(coverage)})`}: ${line(checkpoint.requirement)}${checkpoint.records.length === 0 ? "" : ` [proof ${checkpoint.records.map((record) => idText(record.eventId)).join(", ")}]`}`;
    }),
    ...(section.impact ?? []).map(
      (impact) => `      impact, ${line(impact.effect)}: ${line(impact.text)}`,
    ),
  ];
};

const guidedLines = (guided: NonNullable<ReadUnit["content"]["guided"]>) => [
  `    guided (${line(guided.basis ?? "none")}${guided.unlinked ? ", unlinked" : ""}; scope ${line(String(guided.stratum ?? "?"))}):`,
  ...(guided.rows ?? []).flatMap((row) => [
    row.required === false
      ? `      NOT REQUIRED BY THIS UNIT ${line(row.row)} [${line(row.basis)}] ${line(row.text)} (static automation closed it on other rows)`
      : `      ${line(row.status).toUpperCase()} for this unit${row.closedOn === true ? " (static automation closed it on this row)" : ""} ${line(row.row)} [${line(row.basis)}] ${line(row.text)}`,
    `        ${line(row.does)}${row.evidence.length === 0 ? "" : ` [${row.evidence.map(line).join(", ")}]`}`,
    ...(row.disagreement === undefined
      ? []
      : [`        SOURCES DISAGREE (11.1): ${line(row.disagreement)}`]),
  ]),
  ...(guided.omitted ?? []).map(
    (o) =>
      `      NOT JUDGED ${line(o.row)} (past the 20-row bound, disclosed) ${line(o.text)}`,
  ),
  ...(guided.outside ?? []).map(
    (o) =>
      `      OUTSIDE ${line(o.item)}: ${line(o.does)}${o.evidence.length === 0 ? "" : ` [${o.evidence.map(line).join(", ")}]`}`,
  ),
  ...(guided.review === null || guided.review === undefined
    ? []
    : [
        `    review (${line(guided.review.source)}, lane-blind): ${guided.review.withheld === true ? "no disposition" : line(guided.review.verdict)}${guided.review.uncited ? " UNCITED" : ""}`,
        ...block(guided.review.message),
      ]),
  ...(guided.suggestion === null || guided.suggestion === undefined
    ? []
    : [
        `    suggested review (human-required; not a disposition until a person sends it): ${line(guided.suggestion.verdict)}`,
      ]),
  ...(guided.proof === undefined ? [] : [`    ${line(guided.proof)}`]),
];

const unitLines = (unit: ReadUnit, names: Names) => {
  const title = line(unit.recorded?.payload.title ?? "").trim();
  const a = unit.assessment;
  const lane = a?.payload.lane;
  const recorded = unit.recorded;
  const ranges = recorded?.payload.ownedRanges ?? [];
  const guided = unit.content.guided;
  return [
    // The title quoted, as a change's and a batch's are, so no text in it can pass for the mark after it.
    `  unit ${idText(unit.unitId)} [${lane === undefined ? "no assessment" : line(lane)}${a?.kind === "assessment.recorded@4" ? `, lane rule ${a.payload.laneRule}` : ""}] ${title === "" ? names.fallback(unit) : quoted(recorded!.payload.title)}${recorded?.kind === "unit.recorded@3" && recorded.payload.titleBy === "code" ? " (title written by code)" : ""}`,
    `    owned (${ranges.length} range(s)${unit.sections.length === 0 ? "" : ` in ${unit.sections.length} change(s)`}): ${ranges.map(rangeText).join(", ")}`,
    ...(a === undefined
      ? []
      : a.kind === "assessment.recorded@4"
        ? [
            `    changes judged: ${a.payload.sections.count}, ${a.payload.sections.raised} placed in a higher lane than the agent's judgement gave${causeTotal(a.payload.sections.undecided) === 0 ? "" : `, ${causeTotal(a.payload.sections.undecided)} not decided by an agent (${causeText(a.payload.sections.undecided)})`}`,
            ...(a.payload.rationale === undefined
              ? []
              : ["    rationale:", ...block(a.payload.rationale)]),
          ]
        : [
            `    ${line(a.payload.quadrant)}:`,
            ...block(a.payload.rationale),
            ...a.payload.easeOfValidation.requirements.map(
              (r) =>
                `    requirement ${line(r.coverage).toUpperCase()}: ${line(r.requirement)}${r.proof.length === 0 ? "" : ` [proof ${r.proof.map(idText).join(", ")}]`}`,
            ),
          ]),
    ...unit.sections.flatMap((section) => sectionLines(unit, section, names)),
    ...(unit.content.facts?.text === undefined
      ? []
      : ["    facts:", ...block(unit.content.facts.text)]),
    ...(guided === undefined ? [] : guidedLines(guided)),
    ...(unit.disposition === undefined
      ? ["    disposition: none recorded by the agent"]
      : [
          `    disposition ${line(unit.disposition.payload.verdict)} (${idText(unit.disposition.id)}) at ${hashText(unit.disposition.payload.reviewedHeadOid)}; rests on ${unit.disposition.payload.restsOn.length} comment(s); cites ${unit.disposition.payload.proof.length} proof record(s)`,
        ]),
    // A person's decision on an earlier unit this one is unchanged from, carried onto it: the
    // person's, never the review's own.
    ...unit.carriedDecisions.map(
      (carried) =>
        `    disposition ${line(carried.payload.verdict)} by a person (${idText(carried.id)}) at ${hashText(carried.payload.reviewedHeadOid)}, carried from an earlier review; rests on ${carried.payload.restsOn.length} comment(s); cites ${carried.payload.proof.length} proof record(s)${stillStands(unit, carried.id) ? "" : "; no longer stands"}`,
    ),
    // A comment's heading line, then its body as a block under it.
    ...unit.comments.flatMap((comment) => {
      const f = comment.payload.finding;
      const anchor = comment.payload.anchor;
      const effect =
        f !== undefined && "effect" in f && f.effect !== undefined
          ? `, effect ${line(f.effect)}`
          : "";
      return [
        `    comment ${idText(comment.id)}${f === undefined ? "" : ` [${line(f.kind)}/${line(f.about)}${f.signal === undefined ? "" : `/${line(f.signal)}`}${effect}]`}${anchor === undefined ? "" : ` ${line(posix.basename(anchor.path))}:${line(anchor.side)}${anchor.startLine}-${anchor.endLine}`}${f === undefined || f.evidence.length === 0 ? "" : ` (${line(citeText(f.evidence))})`}:`,
        ...block(comment.payload.body),
      ];
    }),
    ...unit.references.flatMap((r) => {
      const detail = unit.referenceDetails[r.id];
      return [
        `    context ${idText(r.id)} ${line(r.payload.markerKind)}/${line(r.payload.stance)} ${line(r.payload.source.locator)}`,
        ...(detail === undefined
          ? []
          : [
              `      ${line(detail.local)} ${line(detail.grade)}; ${detail.anchors.length} anchor(s); from ${detail.entries.map(line).join(", ") || "no ledger entry"}`,
              `      why: ${line(detail.why)}`,
              `      before you decide: ${line(detail.beforeYouDecide)}`,
            ]),
      ];
    }),
    // How the unit relates to earlier units, each with the lane its own packet recorded.
    ...(unit.lineage?.payload.from ?? []).map(
      (from) =>
        `    lineage: earlier unit ${idText(from.unitId)} ${from.relation === "unchanged" ? `unchanged (${from.unchanged} change(s) the same)` : `changed (${from.unchanged} unchanged, ${from.changed} changed)`}; its lane was ${from.lane === null ? "not assessed" : line(from.lane)}${from.lane !== null && lane !== undefined && from.lane !== lane ? `, now ${line(lane)}` : ""}`,
    ),
    ...(guided?.notes ?? []).map((note) => `    code: ${line(note)}`),
    `    closure: ${line(closureTextV2(unit))}`,
    ...citationLinesV2(unit.citations, "    ", names),
  ];
};

const batchLines = (batch: ReadBatch, names: Names) => {
  const digest = batch.digest;
  return [
    "",
    `batch ${idText(batch.batchId)} ${line(batch.recorded?.payload.title ?? "").trim() === "" ? `(${line(batch.local).trim() || "no title"})` : quoted(batch.recorded!.payload.title)}${batch.publishedBy === undefined ? "" : ` (published in publication ${batch.publishedBy.ordinal})`}`,
    // The focus under a label of its own, so no focus can begin a line the printer writes.
    `  focus: ${quoted(batch.recorded?.payload.focus ?? "")}`,
    ...(batch.gaps.length === 0
      ? []
      : [`  ${batch.gaps.length} gap(s) frozen with the batch`]),
    ...(digest?.digest === undefined
      ? []
      : [
          `  digest (${line(digest.source ?? "?")}, advisory):`,
          ...block(digest.digest),
          `  verification: ${line(digest.verification ?? "-")}`,
        ]),
    ...(digest?.obligations === undefined || digest.obligations.length === 0
      ? []
      : [
          "  obligations across units:",
          ...digest.obligations.map(
            (o) =>
              `    ${line(o.overall).toUpperCase()} ${line(o.row)} ${line(o.text)} (${o.units.map((u) => `${names.byLocal(u.unit)} ${u.required ? line(u.status) : "not required"}`).join(", ")})`,
          ),
        ]),
    ...citationLinesV2(batch.digestCitations, "  digest ", names),
    ...batch.units.flatMap((unit) => unitLines(unit, names)),
  ];
};

/** A `packet.published@2` as `neuve review show` prints it. */
const describeV2 = (packet: ReadPacketV2) => {
  const c = packet.counts;
  const added = packet.added;
  const units = packet.batches.flatMap((batch) => batch.units);
  // Each change's quoted title by its key, the first a key is found under, for "same pattern as".
  const sectionTitles = new Map<string, string>();
  for (const unit of units)
    for (const section of unit.sections)
      if (!sectionTitles.has(section.key))
        sectionTitles.set(section.key, quoted(section.title));
  const fallback = (unit: ReadUnit) =>
    line(unit.local).trim() || idText(unit.unitId);
  // A unit's quoted title, or, when it has none or it cleans to nothing, its handle or short ID.
  const title = (unit: ReadUnit | undefined) =>
    unit === undefined
      ? undefined
      : line(unit.recorded?.payload.title ?? "").trim() === ""
        ? fallback(unit)
        : quoted(unit.recorded!.payload.title);
  const names: Names = {
    byId: (unitId) => title(units.find((unit) => unit.unitId === unitId)),
    byLocal: (local) =>
      title(units.find((unit) => unit.local === local)) ??
      (line(local).trim() || "a unit with no handle"),
    fallback,
    bySection: (key) => sectionTitles.get(key),
  };
  const batchTitles = new Map(
    packet.batches.flatMap((batch) =>
      batch.recorded === undefined ||
      line(batch.recorded.payload.title).trim() === ""
        ? []
        : [[batch.local, quoted(batch.recorded.payload.title)] as const],
    ),
  );
  /** The read model's `what`, its unit or batch named by title where one exists. */
  const what = (u: ReadPacketV2["undecoded"][number]) => {
    const text = line(u.what);
    if (u.unit !== undefined) {
      const found = units.find((unit) => unit.local === u.unit);
      const name = title(found);
      return name === undefined ? text : text.split(line(u.unit)).join(name);
    }
    const batch = u.batch === undefined ? undefined : batchTitles.get(u.batch);
    return batch === undefined || u.batch === undefined
      ? text
      : text.split(line(u.batch)).join(batch);
  };
  const lines = [
    `packet (packet.published@2 ${line(packet.eventId)}, manifest blob ${hashText(packet.manifest)}): publication ${packet.ordinal} of this review, ${packet.complete ? "complete" : "INCOMPLETE"}${packet.requestedPacket === packet.eventId ? "" : ` (the standing packet; this run's own newest packet ${line(packet.requestedPacket)} was superseded by a later packet)`}${packet.supersedes === null ? "" : `; supersedes ${line(packet.supersedes)}`}`,
    `  ${c.batches} batch(es), ${c.units} unit(s), ${c.sections} change(s), ${c.contextReferences} context reference(s), ${c.assessments} assessment(s), ${c.deliveries} delivery stop(s), ${c.comments} comment(s), ${c.dispositions} disposition(s), ${c.gaps} publish gap(s)`,
    ...(c.pending.batches === 0 && c.pending.sections === 0
      ? []
      : [
          `  still being judged: ${c.pending.batches} batch(es), ${c.pending.sections} change(s)`,
        ]),
    ...(causeTotal(c.undecided) === 0
      ? []
      : [
          `  not decided by an agent: ${causeTotal(c.undecided)} change(s) (${causeText(c.undecided)})`,
        ]),
    `  this publication added ${added.batches} batch(es), ${added.units} unit(s), ${added.sections} change(s)${causeTotal(added.undecided) === 0 ? "" : `, ${causeTotal(added.undecided)} not decided by an agent (${causeText(added.undecided)})`}`,
    ...(packet.unmatched.length === 0
      ? []
      : [
          `  ${packet.unmatched.length} earlier unit(s) no unit of this review holds a change of`,
        ]),
    ...packet.batches.flatMap((batch) => batchLines(batch, names)),
  ];
  if (packet.gaps.length > 0) {
    lines.push("", "gaps this packet names (gap.disclosed@1)");
    // A gap's heading line, then its detail as a block under it.
    for (const gap of packet.gaps)
      lines.push(
        `  ${line(gap.attribution.stage ?? "run")}: ${line(gap.payload.kind)}${gap.attribution.unitIds === undefined ? "" : ` (unit ${gap.attribution.unitIds.map((id) => names.byId(id) ?? idText(id)).join(", ")})`}:`,
        ...block(gap.payload.detail),
      );
    const ownership = packet.gaps.filter(
      (gap) =>
        gap.payload.kind === "unit-owns-nothing" ||
        /owns no changed lines|no owner|refused the units' ownership/.test(
          gap.payload.detail,
        ),
    );
    lines.push(
      "",
      `ownership disclosures (10.21): ${ownership.length === 0 ? "none" : ownership.length}`,
      ...ownership.flatMap((gap) => block(gap.payload.detail)),
    );
  }
  // Stored content today's schemas could not read, the new parts' included, as version 1 says it.
  if (packet.undecoded.length > 0)
    lines.push(
      "",
      "stored content not decoded (disclosed; the rest of the packet reads as stored)",
      ...packet.undecoded.map(
        (u) =>
          `  ${what(u)} (${line(u.ref.split(":")[0] ?? "")} ${hashText(u.ref.split(":")[1] ?? u.ref)}): ${line(u.issue)}`,
      ),
    );
  return lines;
};

const isV2 = (packet: StandingPacket | ReadPacket): packet is ReadPacketV2 =>
  (packet as { readonly kind?: string }).kind === "packet.published@2";

/**
 * The packet as `neuve review show` prints it, of either shape: a `packet.published@1` (read by
 * `readRun` or the version 1 readers) as it always has been but for its quoted unit titles and
 * labelled focus, a `packet.published@2` by
 * its units' sections, every stored string in it cleaned (`line`, `block`).
 */
export const describePacket = (packet: StandingPacket | ReadPacket) =>
  isV2(packet) ? describeV2(packet) : describeV1(packet);
