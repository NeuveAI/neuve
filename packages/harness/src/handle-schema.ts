import { z } from "zod";

export const Revision = z.enum(["head", "base"]);
export type Revision = z.infer<typeof Revision>;

export const Handle = z.strictObject({
  id: z.string(),
  /** `stack`: a region of a stack source (stack/tools.ts), read only with `stack_read`. */
  rev: z.union([Revision, z.literal("lead-tree"), z.literal("stack")]),
  path: z.string(),
  blob: z.string(),
  /** The commit the region was read at. */
  commit: z.string(),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  lookup: z.string(),
  args: z.json(),
  parent: z.string().nullable(),
  retrieval: z
    .strictObject({
      retriever: z.string(),
      querySha256: z.string(),
      rank: z.int().min(1),
      score: z.number(),
    })
    .nullable(),
  /** Every lookup that returned this region, earliest first (the first is its lineage). */
  foundBy: z.array(z.string()),
});
export type Handle = z.infer<typeof Handle>;

/** One lookup's sighting of a region or an ID, with the turn it happened in. */
export const Sighting = z.strictObject({
  turn: z.int().min(0),
  lookup: z.string(),
  args: z.json(),
  parent: z.string().nullable(),
  retrieval: Handle.shape.retrieval,
});
export type Sighting = z.infer<typeof Sighting>;

/**
 * A registry as its conversation's durable state keeps it (pi/stages/docs.ts): every region with
 * all its sightings, and every scope section and hunk ID shown, so a resumed context reads the same
 * lineage without replaying its lookups.
 */
export const HandleRegistryState = z.strictObject({
  handles: z.array(
    z.tuple([
      z.string(),
      z.strictObject({
        base: Handle.pick({
          rev: true,
          path: true,
          blob: true,
          commit: true,
          startLine: true,
          endLine: true,
        }),
        sightings: z.array(Sighting),
      }),
    ]),
  ),
  seen: z.array(z.tuple([z.string(), z.array(Sighting)])),
});
export type HandleRegistryState = z.infer<typeof HandleRegistryState>;
