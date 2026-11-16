// A defect before the audit has any results still passes through the CLI's public-wording boundary.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the capture CLI top-level catch suppresses private defects and preserves public reasons", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-public-error-"));
  try {
    for (const [message, publicText] of [
      [
        "synthetic-private-defect-body",
        "capture close failed (private details suppressed)",
      ],
      [
        "capture scan mark has an idempotency conflict",
        "capture scan mark has an idempotency conflict",
      ],
    ]) {
      const preload = join(root, "preload.ts");
      writeFileSync(
        preload,
        `Bun.argv.slice=()=>{throw new Error(${JSON.stringify(message)});};`,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--preload",
          preload,
          join(import.meta.dir, "../src/cli.ts"),
          "review",
          "audit",
          "--all",
        ],
        {
          env: {
            PATH: process.env["PATH"] ?? "/usr/bin:/bin",
            HOME: root,
            TMPDIR: root,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(2);
      expect(out).toBe("");
      expect(err).toBe(`neuve: ${publicText}\n`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  // Alone 0.73-0.89 s; 10x slowest, at least 30 s; child processes and disk I/O under load.
}, 30_000);

test("audit --capture suppresses a defect in the initial alias lookup", async () => {
  const { Effect } = await import("effect");
  const { storeLocationIn } = await import("@neuve/records-core");
  const { runIn, value } =
    await import("../../../packages/harness/tests/pi/capture/fixture.ts");
  const root = mkdtempSync(join(tmpdir(), "capture-alias-defect-"));
  try {
    const location = storeLocationIn(join(root, "store"));
    value(await runIn(location)(Effect.void));
    const preload = join(root, "preload.ts");
    writeFileSync(
      preload,
      `import {plugin} from "bun";
      plugin({name:"alias-defect",setup(build){build.onLoad({filter:/records-core\\/src\\/capture-marks\\.ts$/},async args=>{
        const source=await Bun.file(args.path).text();
        const needle="export const captureRawIdentity = (identity: string) =>\\n  Effect.gen(function* () {";
        if(!source.includes(needle)) throw new Error("test patch missing");
        return {loader:"ts",contents:source.replace(needle,needle+'\\n    throw new Error("synthetic-private-alias-body");')};
      });}});`,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        preload,
        join(import.meta.dir, "../src/cli.ts"),
        "review",
        "audit",
        "--capture",
        "a".repeat(64),
        "--store",
        location.directory,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toBe(
      "neuve: capture close failed (private details suppressed)\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
