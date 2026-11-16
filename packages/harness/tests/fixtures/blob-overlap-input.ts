import { createHash } from "node:crypto";
import { join } from "node:path";

export const overlapInput = (root: string) => {
  const executable = join(root, "absent-engine"),
    source = { executable, key: { unavailable: executable } },
    contents = new Map<string, Uint8Array>(),
    entries = Array.from({ length: 33 }, (_, i) => {
      const bytes = new TextEncoder().encode(`# heading${i}\n\nText.\n`),
        oid = createHash("sha1").update(bytes).digest("hex");
      contents.set(oid, bytes);
      return {
        mode: "100644",
        type: "blob",
        oid,
        size: bytes.length,
        path: `file${i}.md`,
      };
    });
  const target = entries[32];
  if (!target) throw new Error("Missing overlap target");
  return { entries, contents, source, target };
};
