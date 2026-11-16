import { z } from "zod";

/**
 * `<prefix>/lib/neuve/install.json`, the one schema for what `bun run install:cli` installed: the
 * install script writes it and decides from it which files it may replace, and the CLI reads it to
 * compare its store versions (installed-copy.ts). Strict, so an unrecognized manifest is refused
 * rather than guessed at.
 */
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const installManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  installedAt: z.string(),
  cli: z.strictObject({ path: z.string(), sha256 }),
  graph: z.strictObject({
    path: z.string(),
    sha256,
    version: z.string(),
    workspaceRevision: z.string().nullable(),
  }),
  /**
   * The Records versions the installed CLI reads and writes (packages/records-core/src/schema.ts),
   * which `bun run check`, `records migrate` and the worker compare against. Absent in installs from
   * before 20 October 2026.
   */
  records: z
    .strictObject({
      schemaVersion: z.number().int(),
      writerVersion: z.number().int(),
      projectorVersion: z.number().int(),
    })
    .optional(),
  /** The workspace commit the CLI was built from, and whether the tree had local changes. */
  source: z
    .strictObject({ commit: z.string().nullable(), dirty: z.boolean() })
    .optional(),
  /**
   * The semantic client's Python workers (E0's encoder and hybrid leads' reranker, 10.117), which
   * a compiled CLI cannot carry inside itself. Absent in installs from before they were shipped.
   */
  semantic: z
    .strictObject({
      encoder: z.strictObject({ path: z.string(), sha256 }),
      reranker: z.strictObject({ path: z.string(), sha256 }),
    })
    .optional(),
  /**
   * The `neuve` agent skill under `<prefix>/share/neuve/skills/` (skill-bundle.ts): its version and
   * each file, relative to that folder, `manifest.json` included. `neuve skills install` copies it
   * into agents' skill folders. Absent in installs from before the skill was shipped.
   */
  skills: z
    .strictObject({
      path: z.string(),
      version: z.string(),
      files: z.array(z.strictObject({ path: z.string(), sha256 })),
    })
    .optional(),
  /** Absent in installs from before the parser was shipped. */
  parser: z
    .strictObject({
      path: z.string(),
      version: z.string(),
      binding: z.string(),
      sha256,
    })
    .optional(),
});
export type InstallManifest = z.infer<typeof installManifestSchema>;

export type InstalledRecords = NonNullable<InstallManifest["records"]>;
