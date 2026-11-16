// One old source's authority I/O never prevents later folders or a new review attempt from proceeding.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("the before-review sweep contains each authority failure while rapid sweeps preserve the source and four review attempts close", async () => {
  const root = mkdtempSync(join(tmpdir(), "authority-sweep-"));
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "fixtures/authority-sweep-boundary.ts"),
        root,
        "sweep",
        "EMFILE",
      ],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: root,
          TMPDIR: root,
          NEUVE_MODE: "check",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, error).toBe(0);
    const line = out.trim().split("\n").at(-1)!;
    expect(JSON.parse(line)).toEqual({
      results: [
        { sweep: true, source: true, review: true },
        { sweep: true, source: true, review: true },
        { sweep: true, source: true, review: true },
        { sweep: true, source: false, review: true },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
