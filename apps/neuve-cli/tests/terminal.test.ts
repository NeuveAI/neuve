// Why: setup's screen is what a person (or an agent) reads at the end of every setup and upgrade.
// Two promises are checked at the screen's own interface: a step a question settled is not left for
// the person in the closing summary, and an answer typed without a newline before the end of input
// still ends its prompt's line.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { plainScreen } from "../src/terminal.ts";

test("a question settles the step before it, and its command is not left for the person", async () => {
  let said = "";
  const screen = plainScreen(
    async (text) => {
      said += text;
    },
    { canAsk: true, ask: async () => "y" },
  );
  await screen.step(
    "needs",
    "Claude Code",
    "not found. To install it",
    "brew install claude",
  );
  expect(await screen.confirm("Install Claude Code now?")).toBe(true);
  await screen.step("done", "Claude Code", "installed");
  await screen.closing({ next: "neuve review" });
  expect(said).not.toContain("Left for you");
  expect(said).toContain("Neuve is ready.\n  Next: neuve review\n");
});

test("an answer typed before the end of input, with no newline, still ends the prompt's line", async () => {
  const script = `import { plainScreen } from ${JSON.stringify(join(import.meta.dir, "../src/terminal.ts"))};
const screen = plainScreen(async (text) => { await Bun.write(Bun.stdout, text); }, { canAsk: true });
const answer = await screen.confirm("Go on?");
await Bun.write(Bun.stdout, "answer " + String(answer) + "\\n");`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    stdin: new TextEncoder().encode("y"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, stderr).toBe(0);
  expect(stdout).toBe("Go on? [y/N] \nanswer true\n");
});
