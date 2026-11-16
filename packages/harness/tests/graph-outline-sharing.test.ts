// Exercise the reviewer's process boundary, including the authority's disclosed failure floor.
import { afterAll, expect, test } from "bun:test";
import { deserialize, serialize } from "node:v8";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PUBLICATION_MAGIC } from "../src/shared-publication.ts";
import { hostBudget } from "../src/budget/local.ts";
const root = mkdtempSync(join(tmpdir(), "outline-sharing-"));
let host: Awaited<ReturnType<typeof hostBudget>>;
try {
  host = await hostBudget({
    directory: join(root, "host"),
    threads: 2,
    efficiency: 1,
    fixed: 2,
  });
} catch (error) {
  console.info(`Outline sharing host unavailable: ${String(error)}`);
}
afterAll(async () => {
  await host?.close();
  rmSync(root, { recursive: true, force: true });
});
const run = async (directory: string) => {
  const children = [0, 1].map(() =>
    Bun.spawn(
      [process.execPath, join(import.meta.dir, "fixtures/outline/child.ts")],
      {
        env: {
          ...process.env,
          TMPDIR: root,
          BUN_TMPDIR: root,
          NEUVE_BUDGET_DIRECTORY: directory,
          OUTLINE_CASE: directory,
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    ),
  );
  const streams = children.map((child) => child.stdout.getReader());
  let maximumEngines = 0;
  const observer = setInterval(() => {
    maximumEngines = Math.max(
      maximumEngines,
      readdirSync(root).filter((name) =>
        name.startsWith("neuve-graph-symbols-engine-"),
      ).length,
    );
  }, 1);
  try {
    const ready = await Promise.all(streams.map((stream) => stream.read()));
    expect(
      ready.every((value) =>
        new TextDecoder().decode(value.value).includes('"stage":"ready"'),
      ),
    ).toBe(true);
    for (const child of children) {
      child.stdin.write("go\n");
      await child.stdin.end();
    }
    const outputs = await Promise.all(
      streams.map(async (stream) => {
        let text = "";
        for (;;) {
          const value = await stream.read();
          if (value.done) return text;
          text += new TextDecoder().decode(value.value);
        }
      }),
    );
    expect(await Promise.all(children.map((child) => child.exited))).toEqual([
      0, 0,
    ]);
    expect(
      outputs.every((output) => output.includes('"kind":"available"')),
    ).toBe(true);
    return {
      maximumEngines,
      errors: await Promise.all(
        children.map((child) => new Response(child.stderr).text()),
      ),
    };
  } finally {
    clearInterval(observer);
    for (const child of children) child.kill();
  }
};
test.skipIf(!host || !process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE)(
  "different processes subscribe to one outline run",
  async () => {
    const result = await run(join(root, "host"));
    expect(result.maximumEngines).toBe(1);
    expect(
      result.errors.every(
        (error) => !error.includes('"type":"shared-work.floor"'),
      ),
    ).toBe(true);
    const outcomes = join(root, "host", "shared-outlines-v4");
    const [key] = readdirSync(outcomes);
    if (!key) throw new Error("shared outline was not published");
    const slot = readdirSync(join(outcomes, key)).find((name) =>
      name.startsWith("slot-"),
    );
    if (!slot) throw new Error("No outline key slot");
    const keyFolder = readdirSync(join(outcomes, key, slot)).find((name) =>
      name.startsWith("key-"),
    );
    if (!keyFolder) throw new Error("No outline key");
    const storedRun = readdirSync(join(outcomes, key, slot, keyFolder)).find(
      (name) => name.startsWith("run-"),
    );
    if (!storedRun) throw new Error("No outline run");
    const latest = join(
      outcomes,
      key,
      slot,
      keyFolder,
      storedRun,
      "value",
      storedRun.slice(4),
    );
    const stored = deserialize(
      readFileSync(latest).subarray(PUBLICATION_MAGIC.length),
    );
    stored.value.outcome.value.future = true;
    const newer = Buffer.concat([PUBLICATION_MAGIC, serialize(stored)]);
    writeFileSync(latest, newer);
    expect((await run(join(root, "host"))).maximumEngines).toBe(0);
    expect(readFileSync(latest)).toEqual(newer);
  },
);
test.skipIf(!process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE)(
  "an unreachable outline host discloses the duplicate-work floor",
  async () => {
    const result = await run(join(root, "unreachable-host"));
    expect(
      result.errors.every(
        (error) =>
          error.includes('"type":"shared-work.floor"') &&
          error.includes('"floor":"unreachable"'),
      ),
    ).toBe(true);
  },
);
