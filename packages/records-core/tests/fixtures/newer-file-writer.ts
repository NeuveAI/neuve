import { readFile, rename, writeFile } from "node:fs/promises";
import { withFileLock } from "../../src/file-lock.ts";

const [path, lock] = process.argv.slice(2);
if (!path || !lock) throw new Error("missing fixture paths");
process.stdout.write("waiting\n");
await withFileLock(lock, async () => {
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.future = { revision: 2 };
  const temporary = `${path}.newer`;
  await writeFile(temporary, JSON.stringify(stored));
  await rename(temporary, path);
});
