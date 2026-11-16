import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CouncilItemIncomplete,
  memberStep,
  modelStepRunner,
  settleAll,
  type CouncilReceipt,
  type MemberState,
  type StepRunner,
} from "../council-run.ts";
import {
  auditShared,
  MAX_ROUNDS,
  memberLabels,
  namesIn,
  scrub,
  type Member,
} from "../council.ts";
import { jsonSchemaOf } from "../schema.ts";

/**
 * A review panel confirms whether each later commit fixes a defect that was present in the reviewed
 * range. Round 0 is blind and independent; `needed` votes on one answer decide. Otherwise the panel
 * deliberates, each reviewer seeing every position under shuffled labels (and, for the one item the
 * owner answered, the owner's opinion as one more peer), for at most `maxRounds` rounds; a split that
 * survives is unsure. The owner's opinion never counts as a vote. A failed step is never a vote: the
 * item stops and is rerun (the council's `memberStep` and `runItems`).
 *
 * 9.65's panel was three reviewers (two of three, one round); 9.66's is four adversarial reviewers,
 * two per family (three of four, the council's round limit).
 */

export const ANSWERS = ["fix", "not-a-fix", "unsure"] as const;
export type Answer = (typeof ANSWERS)[number];

export interface Panel {
  readonly id: "9.65" | "9.66";
  readonly reviewers: ReadonlyArray<Member>;
  /** Votes on one answer that decide. */
  readonly needed: number;
  /** Deliberation rounds at most after round 0. */
  readonly maxRounds: number;
  /** Each reviewer tries to disprove the fix (9.66). */
  readonly adversarial: boolean;
  /** As many reviewers per family (9.66). */
  readonly equalRepresentation: boolean;
}

/** Each family's reviewer count. */
export const familyCounts = (reviewers: ReadonlyArray<Member>) => {
  const counts: Record<string, number> = {};
  for (const r of reviewers) counts[r.family] = (counts[r.family] ?? 0) + 1;
  return counts;
};

/** Refuses a panel without a strict majority rule, or unequal when it must be equal. */
export const checkPanel = (panel: Panel) => {
  const n = panel.reviewers.length;
  if (new Set(panel.reviewers.map((r) => r.id)).size !== n)
    throw new Error(`panel ${panel.id} repeats a reviewer`);
  if (panel.needed * 2 <= n || panel.needed > n)
    throw new Error(
      `panel ${panel.id}: ${panel.needed} of ${n} is not a majority`,
    );
  const counts = Object.values(familyCounts(panel.reviewers));
  if (
    panel.equalRepresentation &&
    (counts.length !== 2 || counts[0] !== counts[1])
  )
    throw new Error(
      `panel ${panel.id} does not give both families equal seats`,
    );
  return panel;
};

/** 9.65: Opus at its default effort (9.55's subscription token) and Sol at medium and high (9.60). */
const PANEL_965: Panel = {
  id: "9.65",
  reviewers: [
    { id: "opus", family: "opus", effort: null },
    { id: "sol-medium", family: "codex", effort: "medium" },
    { id: "sol-high", family: "codex", effort: "high" },
  ],
  needed: 2,
  maxRounds: 1,
  adversarial: false,
  equalRepresentation: false,
};
/** 9.66: two per family, adversarial; three of four decide, up to the council's round limit. */
const PANEL_966: Panel = {
  id: "9.66",
  reviewers: [
    { id: "opus-default", family: "opus", effort: null },
    { id: "opus-high", family: "opus", effort: "high" },
    { id: "sol-medium", family: "codex", effort: "medium" },
    { id: "sol-high", family: "codex", effort: "high" },
  ],
  needed: 3,
  maxRounds: MAX_ROUNDS,
  adversarial: true,
  equalRepresentation: true,
};
export const PANELS: Readonly<Record<Panel["id"], Panel>> = {
  "9.65": checkPanel(PANEL_965),
  "9.66": checkPanel(PANEL_966),
};
export const panelOf = (id: string | undefined) => {
  const panel = PANELS[(id ?? "9.66") as Panel["id"]];
  if (panel === undefined || !Object.hasOwn(PANELS, id ?? "9.66"))
    throw new Error(`--panel must be ${Object.keys(PANELS).join(" or ")}`);
  return panel;
};

export const Verdict = z.strictObject({
  answer: z.enum(ANSWERS),
  reason: z.string().min(1),
});
export const Deliberation = z.strictObject({
  critique: z.string().min(1),
  answer: z.enum(ANSWERS),
  reason: z.string().min(1),
});
export const SCHEMA_FILES = {
  "verdict.schema.json": Verdict,
  "deliberation.schema.json": Deliberation,
} as const;

/** `needed` votes on one answer decide, unsure included; anything else is a split (null). */
export const decide = (
  answers: ReadonlyArray<Answer>,
  needed: number,
): Answer | null => {
  const counts = new Map<Answer, number>();
  for (const answer of answers)
    counts.set(answer, (counts.get(answer) ?? 0) + 1);
  for (const [answer, count] of counts) if (count >= needed) return answer;
  return null;
};

/**
 * Whether the result has cross-family agreement: at least one Opus and one Sol vote, in the final
 * round, on the winning answer.
 */
export const crossFamilyAgreement = (
  votes: Readonly<Record<string, string>>,
  answer: string,
  reviewers: ReadonlyArray<Member>,
) => {
  const on = reviewers.filter((r) => votes[r.id] === answer);
  return (
    on.some((r) => r.family === "opus") && on.some((r) => r.family === "codex")
  );
};

/** One item as the reviewers see it: an id for files, and its packet text. */
export interface ReviewItem {
  readonly id: string;
  readonly key: string;
  readonly caseId: string;
  readonly hunkId: string;
  readonly packet: string;
  /** The owner's one sheet answer for this item, shown only in a deliberation. */
  readonly owner: { readonly answer: Answer; readonly note: string } | null;
}

export interface ReviewContext {
  readonly panel: Panel;
  /** Private folder for this item's step logs. */
  readonly logs: string;
  /** A fresh, empty, private run folder for one reviewer. */
  readonly reviewerDir: (reviewerId: string) => string;
  readonly runStep?: StepRunner;
}

/** 9.66's adversarial stance, added to the same packet and question. */
export const ADVERSARIAL = [
  "Review adversarially. Try to disprove that the later commit fixes a defect that was present in the reviewed change: look for the reading under which it is a feature change, a refactor, a cleanup, hardening of code that was not wrong, or an adaptation to something that changed after the review.",
  "Answer **fix** only if that attempt fails: the reviewed lines, as shown, were wrong or lacked something they needed (an omission is a defect), and the later commit corrects that. If you cannot tell either way, answer **unsure**.",
].join("\n");

export const round0Prompt = (panel: Panel) =>
  [
    "Read `item.md` in this folder and follow it. It holds everything you need; do not read any other file, repository or history.",
    ...(panel.adversarial ? [ADVERSARIAL] : []),
    "You are one of several independent reviewers; work alone.",
    "Your final answer must be the JSON object only.",
  ].join("\n");

export const OWNER_LABEL = "owner";

/** The deliberation file: every position under shuffled labels, the viewer's marked as its own. */
export const deliberationFile = (
  itemId: string,
  viewer: string,
  round: number,
  positions: ReadonlyArray<{ id: string; answer: string; reason: string }>,
  allowed: ReadonlySet<string> = new Set(),
) => {
  const labels = memberLabels(itemId, viewer, round, positions);
  let scrubbed = 0;
  const blocks = labels.map((id, index) => {
    const position = positions.find((p) => p.id === id)!;
    const reason = scrub(position.reason, allowed);
    scrubbed += reason.count;
    return [
      `## Reviewer ${index + 1}${id === viewer ? " (you)" : ""}`,
      "",
      `Answer: **${position.answer}**`,
      "",
      `Reason: ${reason.text}`,
      "",
    ].join("\n");
  });
  return {
    text: `# Deliberation${round > 1 ? `, round ${round}` : ""}\n\nThe reviewers of this item answered independently and do not agree. Each position is shown under a shuffled label.\n\n${blocks.join("\n")}`,
    scrubbed,
  };
};

const WORDS = ["zero", "one", "two", "three", "four", "five", "six"];
const count = (n: number) => WORDS[n] ?? String(n);
export const deliberatePrompt = (panel: Panel, file: string) =>
  [
    `Read \`${file}\`: every reviewer's answer and reason for this item, including yours.`,
    `Write a short critique of the other positions (where they are right or wrong, and why), then keep or change your answer with a reason. ${count(panel.needed).replace(/^./, (c) => c.toUpperCase())} of ${count(panel.reviewers.length)} reviewers agreeing decides.`,
    ...(panel.adversarial
      ? [
          "Keep reviewing adversarially: answer fix only if the case against it fails, that is, the reviewed lines were wrong or lacked something they needed (an omission is a defect) and the later commit corrects that.",
        ]
      : []),
    `Use only \`item.md\` and \`${file}\`. Your final answer must be the JSON object only.`,
  ].join("\n");

/** One item's review: round 0, then deliberation rounds while the panel is split. */
export const reviewItem = async (item: ReviewItem, context: ReviewContext) => {
  const { panel } = context;
  const runStep = context.runStep ?? modelStepRunner;
  const allowed = namesIn(item.packet);
  mkdirSync(context.logs, { recursive: true });
  const meta = {
    caseId: item.caseId,
    hunkId: item.hunkId,
    role: "later-fix-reviewer" as const,
  };
  const receipts: Array<CouncilReceipt> = [];
  const state = new Map<string, MemberState>(
    panel.reviewers.map((member) => {
      const dir = context.reviewerDir(member.id);
      writeFileSync(join(dir, "item.md"), item.packet);
      for (const [file, schema] of Object.entries(SCHEMA_FILES))
        writeFileSync(
          join(dir, file),
          `${JSON.stringify(jsonSchemaOf(schema), null, 2)}\n`,
        );
      return [
        member.id,
        {
          member,
          dir,
          session: randomUUID(),
          thread: null,
          steps: 0,
          trail: [],
        },
      ];
    }),
  );
  const step = memberStep({
    state,
    receipts,
    logs: context.logs,
    meta,
    runStep,
    snapshot: null,
  });
  const ids = panel.reviewers.map((member) => member.id);
  try {
    const round0 = new Map<string, z.infer<typeof Verdict>>();
    await settleAll(
      ids.map(async (id) =>
        round0.set(
          id,
          await step(
            id,
            "round-0",
            round0Prompt(panel),
            "verdict.schema.json",
            (v) => Verdict.parse(v),
            false,
          ),
        ),
      ),
    );
    const current = new Map<string, { answer: Answer; reason: string }>(
      ids.map((id) => [id, round0.get(id)!]),
    );
    const votes: Array<{ round: number; votes: Record<string, Answer> }> = [
      {
        round: 0,
        votes: Object.fromEntries(
          ids.map((id) => [id, current.get(id)!.answer]),
        ),
      },
    ];
    const answers = () => ids.map((id) => current.get(id)!.answer);
    let answer = decide(answers(), panel.needed);
    const deliberations: Array<Record<string, z.infer<typeof Deliberation>>> =
      [];
    const files: Array<string> = [];
    let scrubbed = 0;
    let round = 0;
    while (answer === null && round < panel.maxRounds) {
      round++;
      const file = round === 1 ? "deliberation.md" : `deliberation-${round}.md`;
      files.push(file);
      const positions = [
        ...ids.map((id) => ({ id, ...current.get(id)! })),
        ...(item.owner === null
          ? []
          : [
              {
                id: OWNER_LABEL,
                answer: item.owner.answer,
                reason: item.owner.note,
              },
            ]),
      ];
      const updates = await settleAll(
        ids.map(async (id) => {
          const shown = deliberationFile(
            item.id,
            id,
            round,
            positions,
            allowed,
          );
          scrubbed += shown.scrubbed;
          writeFileSync(join(state.get(id)!.dir, file), shown.text);
          const value = await step(
            id,
            round === 1 ? "deliberation" : `deliberation-${round}`,
            deliberatePrompt(panel, file),
            "deliberation.schema.json",
            (v) => Deliberation.parse(v),
            false,
          );
          return [id, value] as const;
        }),
      );
      const update = Object.fromEntries(updates);
      deliberations.push(update);
      for (const id of ids) current.set(id, update[id]!);
      votes.push({
        round,
        votes: Object.fromEntries(
          ids.map((id) => [id, current.get(id)!.answer]),
        ),
      });
      answer = decide(answers(), panel.needed);
    }
    const namesInShared = ids.reduce(
      (total, id) => total + auditShared(state.get(id)!.dir, files, allowed),
      0,
    );
    return {
      itemId: item.id,
      key: item.key,
      panel: panel.id,
      answer: answer ?? ("unsure" as const),
      decidedIn:
        round === 0
          ? ("round-0" as const)
          : answer === null
            ? ("still-split" as const)
            : ("deliberation" as const),
      votes,
      reasons: {
        round0: Object.fromEntries(
          ids.map((id) => [id, round0.get(id)!.reason]),
        ),
        deliberations,
      },
      owner:
        item.owner === null
          ? null
          : { ...item.owner, counted: false, shownInDeliberation: round > 0 },
      members: Object.fromEntries(
        ids.map((id) => [id, { trail: state.get(id)!.trail }]),
      ),
      anonymity: { scrubbedNames: scrubbed, namesInSharedFiles: namesInShared },
      outsideReads: receipts.flatMap((r) =>
        r.outsideReads.map((path) => `${r.member}/${r.step}: ${path}`),
      ),
      receipts,
    };
  } catch (error) {
    throw new CouncilItemIncomplete(
      error,
      receipts,
      Object.fromEntries(ids.map((id) => [id, state.get(id)!.trail])),
    );
  }
};
