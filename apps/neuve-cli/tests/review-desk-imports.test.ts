// Why: the desk, doctor and setup-first run on a friend's install without the coding workspace, so
// nothing they load may reach the Ace-backed `workspace-*` files or an `@ace/` package. This walks
// every module they import, statically or dynamically, through Neuve's own sources.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const ENTRIES = [
  "apps/neuve-cli/src/review-desk.ts",
  "apps/neuve-cli/src/doctor.ts",
  "apps/neuve-cli/src/setup-status.ts",
  "apps/neuve-cli/scripts/build-desk.ts",
].map((path) => resolve(ROOT, path));

test("the desk, doctor and setup-first load no workspace or Ace module", () => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const refused: string[] = [];
  const visit = (file: string, from: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (/\/workspace-[^/]*\.ts$/.test(file) || file.includes("/@ace/"))
      refused.push(`${file} (from ${from})`);
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (path.startsWith("@ace/")) {
        refused.push(`${path} (from ${file})`);
        continue;
      }
      if (path.startsWith("node:") || path.startsWith("bun:")) continue;
      let next: string;
      try {
        next = Bun.resolveSync(path, dirname(file));
      } catch {
        continue;
      }
      // Neuve's own sources only; third-party packages can't reach the workspace files.
      if (
        next.startsWith(ROOT) &&
        !next.includes("/node_modules/") &&
        /\.tsx?$/.test(next)
      )
        visit(next, file);
    }
  };
  for (const entry of ENTRIES) visit(entry, "entry");
  expect(refused).toEqual([]);
  expect(seen.size).toBeGreaterThan(20);
});
