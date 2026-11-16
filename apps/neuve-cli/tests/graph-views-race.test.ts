// Why: two uses of Graph's temporary views share the `neuve-<uid>/graph-views/` levels, and one use
// ending removes them once empty, so another use's next `mkdtemp` can find a level gone (ENOENT) or
// going (EINVAL on macOS). The view must then make the levels again and stay in the temporary
// folder, not fall back to another place. This forces both forms at the exact call, every run,
// instead of hoping a timing race shows them. From the front-door slice's fifth review.
import { afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const real = { ...fs };
/** What the next `mkdtemp` into a `graph-views/run-` folder does first, once. */
let next: "remove the levels" | "fail with EINVAL" | undefined;
mock.module("node:fs/promises", () => ({
  ...real,
  mkdtemp: async (prefix: string, ...rest: Array<unknown>) => {
    if (next !== undefined && prefix.includes("graph-views/run-")) {
      const step = next;
      next = undefined;
      const level = prefix.slice(0, prefix.lastIndexOf("/"));
      // Another use's release removes both empty levels as this one starts.
      await real.rmdir(level);
      await real.rmdir(level.slice(0, level.lastIndexOf("/")));
      if (step === "fail with EINVAL")
        throw Object.assign(new Error(`EINVAL: mkdtemp '${prefix}'`), {
          code: "EINVAL",
        });
    }
    return (real.mkdtemp as (...args: Array<unknown>) => Promise<string>)(
      prefix,
      ...rest,
    );
  },
}));
const { viewFolder } = await import("../src/graph-views.ts");

const roots: Array<string> = [];
const savedTmp = process.env["TMPDIR"];
afterEach(async () => {
  next = undefined;
  if (savedTmp === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = savedTmp;
  for (const root of roots.splice(0))
    await real.rm(root, { recursive: true, force: true });
});

for (const form of ["remove the levels", "fail with EINVAL"] as const)
  test(`a level that vanishes as mkdtemp runs (${form}) is made again, and the view stays in the temporary folder`, async () => {
    const root = await real.realpath(
      await real.mkdtemp(join(tmpdir(), "neuve-views-race-")),
    );
    roots.push(root);
    const temporary = join(root, "tmp");
    await real.mkdir(temporary, { mode: 0o700 });
    process.env["TMPDIR"] = temporary;
    const repository = join(root, "repo");
    await real.mkdir(repository);
    Bun.spawnSync(["git", "init", "-q", repository]);
    next = form;
    const views = await viewFolder(repository);
    expect(next).toBeUndefined();
    expect(views?.parent.startsWith(`${temporary}/neuve-`)).toBe(true);
    await views?.release();
  });
