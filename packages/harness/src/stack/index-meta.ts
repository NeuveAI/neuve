import { safeRead } from "@neuve/records-schema";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const StackIndexSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("available"), sha256: z.string() }),
  z.strictObject({ kind: z.literal("unavailable"), path: z.string() }),
]);

export const StackIndexMeta = z.strictObject({
  recipe: z.string(),
  source: StackIndexSource.optional(),
  // Absent in indexes written before Graph chunks; a retryable index holds transient fallbacks.
  retryable: z.boolean().optional(),
  tree: z.string(),
  docs: z.int().min(0),
  totalLength: z.int().min(0),
  files: z.int().min(0),
  excluded: z.record(z.string(), z.int().min(0)),
  builtAt: z.string(),
});

// Actual historical writer identities. See tests/fixtures/stack/legacy-index/provenance.json.
const previousRecipes = new Set([
  // The source-aware Graph recipe before builds verified the producing engine.
  "f48ea78fea37c65eea4b83cbdaff1184",
  "51cc36c5599cf79b3448830206c19358",
  "a9d09dccaf9188a1c524c73e04c31f1b",
  // Round 18's source-bound v2 index, captured by the same fixture generator.
  "5dd388c2a679812f64d0b677be1f49a4",
]);

/** Replacement and eviction must inspect the metadata before deleting the directory. */
export const knownStackIndex = async (folder: string, recipe?: string) => {
  try {
    const read = safeRead(
      StackIndexMeta,
      JSON.parse(await readFile(join(folder, "meta.json"), "utf8")),
      { source: join(folder, "meta.json") },
    );
    return (
      read.success &&
      read.droppedKeys.length === 0 &&
      (recipe === undefined ||
        read.data.recipe === recipe ||
        previousRecipes.has(read.data.recipe))
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // A missing metadata file does not make an existing newer directory disposable.
      try {
        await stat(folder);
      } catch (missing) {
        if (
          missing instanceof Error &&
          "code" in missing &&
          missing.code === "ENOENT"
        )
          return true;
        throw missing;
      }
    }
    return false;
  }
};
