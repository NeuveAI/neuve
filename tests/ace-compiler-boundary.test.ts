import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PI_TRANSITION_STORAGE_PROFILE } from "../scripts/pi-storage.ts";

test("the generated protocol preserves SDK and native types without leaking provider declarations", async () => {
  const source = resolve(import.meta.dirname, "..");
  const directory = await mkdtemp(
    join(PI_TRANSITION_STORAGE_PROFILE.paths.tmp, "ace-types-"),
  );
  const original = JSON.stringify(
    join(source, "packages/channel/src/protocol.ts"),
  );
  const rolled = JSON.stringify(
    join(source, "packages/channel/.types/src/protocol.d.ts"),
  );
  const options = {
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: false,
    noEmit: true,
    allowImportingTsExtensions: true,
    module: "Preserve",
    moduleResolution: "Bundler",
    target: "ESNext",
    lib: ["ESNext", "DOM"],
    types: [],
  };
  async function compile(name: string, input: string) {
    await Bun.write(join(directory, `${name}.ts`), input);
    const config = join(directory, `${name}.json`);
    await Bun.write(
      config,
      JSON.stringify({ compilerOptions: options, files: [`${name}.ts`] }),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        join(source, "node_modules/typescript/bin/tsc"),
        "--project",
        config,
        "--listFiles",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(`${name} compiler failed: ${stdout}\n${stderr}`);
    return stdout;
  }
  try {
    const consumer = await compile(
      "consumer",
      `import type { Effort } from ${rolled};\n// @ts-expect-error The native SDK does not define this effort.\nconst invalid: Effort = "invented-effort";\n`,
    );
    expect(consumer).toContain("packages/channel/.types/src/protocol.d.ts");
    expect(consumer).not.toMatch(/pi-ai|google-auth-library|gaxios/);
    const parity = await compile(
      "parity",
      `import type * as Original from ${original};\nimport type * as Rolled from ${rolled};\ntype Equal<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;\nconst effort: Equal<Original.Effort, Rolled.Effort> = true;\nconst model: Equal<Original.ModelRef, Rolled.ModelRef> = true;\nconst request: Equal<Original.Request, Rolled.Request> = true;\nconst channel: Equal<Original.ChannelInfo, Rolled.ChannelInfo> = true;\n`,
    );
    expect(parity).toContain("pi-ai/dist/types.d.ts");
    expect(parity).toContain("packages/channel/src/protocol.ts");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
