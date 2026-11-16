import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The review desk's content hash: every file's name, size and bytes, in a fixed order, so any
 * changed, added or removed asset changes it. `desk.json` at the top records the hash and is left
 * out. A link or any other non-regular entry is refused, so the hash never follows one.
 */
export const hashDesk = async (directory: string): Promise<string> => {
  if (!(await lstat(directory)).isDirectory())
    throw new Error(`${directory} is not a folder.`);
  const hash = createHash("sha256");
  const visit = async (at: string, relative: string) => {
    for (const name of (await readdir(at)).sort()) {
      const path = join(at, name);
      const key = relative + name;
      const info = await lstat(path);
      if (relative === "" && name === "desk.json" && info.isFile()) continue;
      if (info.isDirectory()) await visit(path, `${key}/`);
      else if (info.isFile())
        hash
          .update(key)
          .update("\0")
          .update(String(info.size))
          .update("\0")
          .update(await readFile(path));
      else throw new Error(`${path} is not a regular file.`);
    }
  };
  await visit(directory, "");
  return hash.digest("hex");
};
