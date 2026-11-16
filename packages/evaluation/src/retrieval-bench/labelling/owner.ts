import { createHash } from "node:crypto";
import { z } from "zod";
import { draw, type OwnerDecision } from "./adjudication.ts";
import { GRADES } from "./schema.ts";

/**
 * The owner's adjudication (9.36): queue items exported blind for a page, and the owner's verdicts
 * imported back into the gold. The two labellers appear as A and B, assigned per item by a seeded
 * coin flip, so the owner cannot learn which family is which; the real mapping is kept privately.
 */

export const BLIND_SEED = "neuve-m4-b3-blind-v1";

/** A stable, opaque item id from the queue key. */
export const itemId = (queueKey: string) =>
  `q-${createHash("sha256").update(queueKey).digest("hex").slice(0, 12)}`;

/** Which family is shown as A for this item: a seeded coin flip per item. */
export const blindSides = (id: string, seed = BLIND_SEED) =>
  draw(seed, id) < 0.5
    ? ({ A: "opus", B: "codex" } as const)
    : ({ A: "codex", B: "opus" } as const);

export const Verdicts = z.strictObject({
  decidedBy: z.string().min(1),
  /** ISO time of the decision; defaults to the import time. */
  /** ISO time, or a date when the page records only the day. */
  decidedAt: z
    .union([z.iso.datetime({ offset: true }), z.iso.date()])
    .optional(),
  verdicts: z
    .array(
      z.strictObject({
        id: z.string().regex(/^q-[0-9a-f]{12}$/),
        grade: z.enum(GRADES),
        note: z.string().nullable().optional(),
        /** Decide-then-reveal (9.38): the blind grade before the reveal, and when it was given. */
        firstGrade: z.enum(GRADES).optional(),
        firstAt: z.iso.datetime({ offset: true }).optional(),
        decidedAt: z.iso.datetime({ offset: true }).optional(),
        batch: z.string().optional(),
      }),
    )
    .min(1),
});
export type Verdicts = z.infer<typeof Verdicts>;

/**
 * Maps verdicts to queue keys. Refuses unknown or repeated ids, so a verdict can never land on an
 * item the owner was not shown.
 */
export const decisionsFor = (
  input: unknown,
  queueKeys: ReadonlyArray<string>,
  now: () => string = () => new Date().toISOString(),
) => {
  const parsed = Verdicts.parse(input);
  const byId = new Map(queueKeys.map((key) => [itemId(key), key]));
  const decidedAt = parsed.decidedAt ?? now();
  const out = new Map<string, OwnerDecision>();
  for (const verdict of parsed.verdicts) {
    const key = byId.get(verdict.id);
    if (key === undefined) throw new Error(`unknown item id ${verdict.id}`);
    if (out.has(key)) throw new Error(`item ${verdict.id} has two verdicts`);
    out.set(key, {
      grade: verdict.grade,
      note:
        verdict.note === undefined || verdict.note === "" ? null : verdict.note,
      decidedBy: parsed.decidedBy,
      decidedAt: verdict.decidedAt ?? decidedAt,
      ...(verdict.firstGrade === undefined
        ? {}
        : { firstGrade: verdict.firstGrade }),
      ...(verdict.firstAt === undefined ? {} : { firstAt: verdict.firstAt }),
      ...(verdict.batch === undefined ? {} : { batch: verdict.batch }),
    });
  }
  return out;
};

/** One verdict file as the owner's page saves it (one file per item). */
export const RecordedVerdict = z.strictObject({
  batch: z.string(),
  decidedAt: z.iso.datetime({ offset: true }),
  grade: z.enum(GRADES),
  item: z.string().regex(/^q-[0-9a-f]{12}$/),
  note: z.string(),
});

/** One blind-pass decision file (9.38): the grade before the reveal and the final grade after it. */
export const BlindDecision = z.strictObject({
  batch: z.string(),
  item: z.string().regex(/^q-[0-9a-f]{12}$/),
  firstGrade: z.enum(GRADES),
  finalGrade: z.enum(GRADES),
  note: z.string(),
  firstAt: z.iso.datetime({ offset: true }),
  decidedAt: z.iso.datetime({ offset: true }),
});

/** Blind-pass decision files as verdicts: the gold takes the final grade; the first is recorded. */
export const blindVerdicts = (
  files: ReadonlyArray<unknown>,
  decidedBy: string,
) => ({
  decidedBy,
  verdicts: files.map((file) => {
    const decision = BlindDecision.parse(file);
    return {
      id: decision.item,
      grade: decision.finalGrade,
      firstGrade: decision.firstGrade,
      firstAt: decision.firstAt,
      decidedAt: decision.decidedAt,
      batch: decision.batch,
      ...(decision.note === "" ? {} : { note: decision.note }),
    };
  }),
});
