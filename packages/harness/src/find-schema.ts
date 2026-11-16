import {
  FindingAbout,
  FindingKind,
  FindingSignal,
} from "@neuve/records-schema";
import { z } from "zod";

export const Anchor = z.strictObject({
  path: z.string().min(1).max(4096),
  side: z.enum(["old", "new"]),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
});
export type Anchor = z.infer<typeof Anchor>;
export const Finding = z.strictObject({
  claim: z.string().min(1).max(300),
  kind: FindingKind,
  about: FindingAbout,
  signal: FindingSignal.nullable(),
  critical: z.boolean(),
  anchors: z.array(Anchor).min(1).max(4),
  doneWhen: z.string().max(8).nullable(),
  evidence: z.array(z.string().max(160)).max(8),
});
export type Finding = z.infer<typeof Finding>;
export const FinderSubmission = z.strictObject({
  findings: z.array(Finding).max(5),
  notes: z.array(z.string().min(1).max(300)).max(3),
});
export type FinderSubmission = z.infer<typeof FinderSubmission>;
export const ScopeFitSubmission = FinderSubmission.extend({
  conditions: z
    .array(
      z.strictObject({
        doneWhen: z.string().max(8),
        verdict: z.enum(["met", "not-met", "needs-human"]),
        anchors: z.array(Anchor).max(4),
        note: z.string().min(1).max(300),
      }),
    )
    .max(5),
});
export type ScopeFitSubmission = z.infer<typeof ScopeFitSubmission>;
export const FindSubmission = ScopeFitSubmission.partial({ conditions: true });
export type FindSubmission = z.infer<typeof FindSubmission>;
export const HeadRead = z.strictObject({
  path: z.string(),
  startLine: z.int(),
  endLine: z.int(),
});
export type HeadRead = z.infer<typeof HeadRead>;
