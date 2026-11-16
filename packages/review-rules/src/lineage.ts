import { z } from "zod";

const Identity = z.string().min(1).max(4096);
const Revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
export const LineageUnitReference = z.object({
  unitId: Identity,
  hunkIds: z.array(Identity).min(1).max(4096),
});
/** How a later revision's units relate to earlier units' work. */
export const RecordUnitLineage = z.object({
  commandId: Identity,
  fromRevisionId: Revision,
  toRevisionId: Revision,
  relation: z.enum(["renewed", "corrected", "regrouped", "carried"]),
  before: z.array(LineageUnitReference).min(1).max(100),
  after: z.array(LineageUnitReference).min(1).max(100),
  rationale: z.string().min(1).regex(/\S/).max(16384),
  comments: z
    .array(
      z.object({ commandId: Identity, unitId: Identity, revisionId: Revision }),
    )
    .max(100),
  evidence: z
    .array(
      z.object({
        unitId: Identity,
        revisionId: Revision,
        evidenceId: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(100),
});
export type RecordUnitLineage = z.infer<typeof RecordUnitLineage>;
export const UnitLineageRecord = RecordUnitLineage.extend({
  author: z.object({ kind: z.enum(["human", "agent"]), id: Identity }),
});
export type UnitLineageRecord = z.infer<typeof UnitLineageRecord>;
