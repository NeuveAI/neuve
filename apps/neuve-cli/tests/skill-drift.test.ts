// Why: the `neuve` skill teaches agents commands and flags by name, and an agent runs what it reads.
// A command or flag the CLI renamed or dropped would send every agent with the skill into usage
// errors, so every `neuve ...` invocation the skill's text shows is checked against the built CLI's
// own help. Only `--help` runs: nothing that writes, starts a worker or calls a model.
//
// How it finds them, so none is skipped silently: the text of every fenced code block (except
// `text` and `json` blocks, which quote the CLI's own output) and every inline code span in SKILL.md
// and references/*.md is scanned, and every standalone word `neuve` there (not part of a path or a
// longer name such as `neuve/bin` or `neuve-graph`) starts an invocation. Its leading lowercase words
// are the command (`review show`), and every `--flag` after them, up to a shell separator, is a flag.
// The command must have a usage entry in the help of `neuve --help`, `neuve <command> --help` or, for
// the two commands whose help is their own, `neuve setup hooks|stack --help`, and each flag must
// appear in that entry. A command named alone, with no flags, may instead be a family whose entries
// are its subcommands (`neuve hybrid` for `neuve hybrid prepare`). `--help` needs only the help to
// exist. A flag shown alone in inline code (`--stdin`) belongs to the command shown in the same
// paragraph, list item or table row: the last one before it, else the first after it, and every
// flag in that span is checked there; a lone flag with no command in its paragraph fails the test.
// Fences may be ``` or ~~~ and indented (under a list item); a line ending in `\` continues on the
// next. A short (`-z`) or uppercase (`--Detach`) flag is checked as written, so it fails, since the
// CLI's flags are lowercase long ones. Each file must show at least one invocation, and the test
// prints how many it checked.
//
// Known limits, which the skill's text doesn't use and a reviewer should keep out of it: a command
// in prose without backticks, an inline code span broken across lines, and `text` or `json` blocks,
// which are skipped by design.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  frontmatterVersion,
  VERSION_PLACEHOLDER,
} from "../src/skill-bundle.ts";

const TEMPLATE = resolve(import.meta.dir, "../skills/neuve");

/** Commands whose `--help` is their own and runs nothing: `neuve <first> <second> --help`. */
const OWN_HELP = new Set(["setup hooks", "setup stack"]);

export type Invocation = Readonly<{
  file: string;
  text: string;
  command: ReadonlyArray<string>;
  flags: ReadonlyArray<string>;
  /** A flag shown alone with no command in its paragraph, list item or table row. */
  orphan?: true;
}>;

/** A fenced block: ``` or ~~~, indented or not, with its language and its lines. */
const FENCE = /^[ \t]*(```|~~~)([^\n]*)\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;

/** The code in a Markdown file: each fenced block's lines, and each inline span outside them. */
export const codeOf = (markdown: string): ReadonlyArray<string> => {
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  const code: Array<string> = [];
  const prose = body.replace(
    FENCE,
    (_, _fence: string, language: string, block: string) => {
      // `text` and `json` blocks quote what the CLI printed; they are output, not commands.
      if (!["text", "json"].includes(language.trim()))
        code.push(...block.replace(/\\\n[ \t]*/g, " ").split("\n"));
      return "";
    },
  );
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) code.push(match[1]!);
  return code;
};

const STANDALONE = /(?<![\w./@-])neuve(?![\w./-])/g;

/** The flags among some tokens, as written: `--json`, and `-z` or `--Detach`, which then fail. */
const flagsIn = (tokens: ReadonlyArray<string>) =>
  tokens
    .map((token) => /^-{1,2}[A-Za-z][\w-]*/.exec(token)?.[0])
    .filter((flag): flag is string => flag !== undefined);
const SEPARATOR = /\s*(?:&&|\|\||[;|)]|$)/;

/** Every `neuve` invocation in one piece of code. */
export const invocationsIn = (
  code: string,
  file = "",
): ReadonlyArray<Invocation> =>
  [...code.matchAll(STANDALONE)].map((match) => {
    const rest = code.slice(match.index + "neuve".length);
    const end = rest.search(SEPARATOR);
    const tokens = rest
      .slice(0, end === -1 ? undefined : end)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const command: Array<string> = [];
    for (const token of tokens) {
      if (!/^[a-z][a-z-]*$/.test(token)) break;
      command.push(token);
    }
    const flags = flagsIn(tokens);
    return {
      file,
      text: `neuve ${tokens.join(" ")}`.trim(),
      command,
      flags: [...new Set(flags)],
    };
  });

/**
 * The usage entries for `command` in a help text: a line that names the command (with or without
 * `neuve `) followed by something other than another subcommand word, and the lines indented under
 * it. `review` matches `neuve review <base>..<head> ...`, not `neuve review show ...`.
 */
export const usageEntries = (
  help: string,
  command: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const lines = help.split("\n");
  const entries: Array<string> = [];
  const name = command.join(" ");
  lines.forEach((line, index) => {
    const match = /^(\s+)(?:neuve )?(.*)$/.exec(line);
    if (match === null || !match[2]!.startsWith(name)) return;
    const after = match[2]!.slice(name.length);
    if (after !== "" && !after.startsWith(" ")) return;
    const next = after.trim().split(/\s+/)[0] ?? "";
    if (/^[a-z][a-z-]*$/.test(next)) return;
    const indent = match[1]!.length;
    const entry = [line];
    for (const following of lines.slice(index + 1)) {
      if (following.trim() === "") break;
      if ((/^\s*/.exec(following)![0].length ?? 0) <= indent) break;
      entry.push(following);
    }
    entries.push(entry.join("\n"));
  });
  return entries;
};

const FLAG = /^-{1,2}[A-Za-z]/;

/**
 * Every invocation in a Markdown file: those in its code (`codeOf`), and each flag shown alone in an
 * inline span, attached to the command shown in the same paragraph, list item or table row (the last
 * one before it, else the first after it), or marked an orphan when there is none.
 */
export const invocationsOf = (
  markdown: string,
  file = "",
): ReadonlyArray<Invocation> => {
  const found = codeOf(markdown).flatMap((code) => invocationsIn(code, file));
  const prose = markdown
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(FENCE, "\n");
  const blocks: Array<string> = [];
  for (const chunk of prose.split(/\n[ \t]*\n/)) {
    let current: Array<string> = [];
    for (const line of chunk.split("\n")) {
      if (/^\s*(?:[-*]|\d+\.)\s|^\s*\||^#/.test(line) && current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      current.push(line);
    }
    blocks.push(current.join("\n"));
  }
  for (const block of blocks) {
    const spans = [...block.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
    const commands = spans.map((span) => invocationsIn(span, file).at(-1));
    spans.forEach((span, index) => {
      if (!FLAG.test(span)) return;
      const flags = [...new Set(flagsIn(span.split(/\s+/)))];
      const host =
        commands.slice(0, index).findLast((command) => command !== undefined) ??
        commands.slice(index + 1).find((command) => command !== undefined);
      found.push(
        host === undefined
          ? {
              file,
              text: `\`${span}\``,
              command: [],
              flags,
              orphan: true,
            }
          : {
              file,
              text: `${host.text} (with \`${span}\`)`,
              command: host.command,
              flags,
            },
      );
    });
  }
  return found;
};

const hasFlag = (text: string, flag: string) =>
  new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(text);

const skillFiles = async () => {
  const files = ["SKILL.md"];
  for (const name of (await readdir(join(TEMPLATE, "references"))).sort())
    files.push(`references/${name}`);
  return Promise.all(
    files.map(async (file) => ({
      file,
      text: await readFile(join(TEMPLATE, file), "utf8"),
    })),
  );
};

describe("the extractor", () => {
  test("finds invocations in blocks, spans and chains, and skips paths, names and quoted output", () => {
    const markdown = [
      "---",
      "description: when neuve setup has run",
      "---",
      "Run `neuve review show <base>..<head> --json`, then `neuve jobs`.",
      "The store is `<repo>/neuve/`, linked as `neuve/bin/neuve-graph`.",
      "```sh",
      "neuve setup hooks --agents claude-code,codex --dry-run && neuve worker status",
      'echo done | neuve vent "too slow" --session=claude:1',
      "```",
      "```text",
      "the job waits (neuve worker start from such a shell).",
      "```",
    ].join("\n");
    expect(
      codeOf(markdown).flatMap((code) =>
        invocationsIn(code).map((i) => [i.command.join(" "), ...i.flags]),
      ),
    ).toEqual([
      ["setup hooks", "--agents", "--dry-run"],
      ["worker status"],
      ["vent", "--session"],
      ["review show", "--json"],
      ["jobs"],
    ]);
  });

  test("matches a command's own usage entry, not its subcommands'", () => {
    const help = [
      "Usage:",
      "  neuve review <base>..<head> [--detach] [--repo <path>]",
      "              Request a review.",
      "  neuve review show [<base>..<head> | --run <run-id>] [--json]",
      "              Print a receipt.",
    ].join("\n");
    expect(usageEntries(help, ["review"])).toEqual([
      "  neuve review <base>..<head> [--detach] [--repo <path>]\n              Request a review.",
    ]);
    expect(usageEntries(help, ["review", "show"])).toHaveLength(1);
    expect(usageEntries(help, ["review", "desk"])).toEqual([]);
  });

  test("reads ~~~ and indented fences, continued lines, every flag of a lone span, and odd flags", () => {
    const markdown = [
      "~~~sh",
      "neuve ventz",
      "~~~",
      "",
      "- A step:",
      "  ```sh",
      "  neuve jobss --all",
      "  ```",
      "",
      "```sh",
      "neuve proof record <range> \\",
      "  --kindd test-run",
      "```",
      "",
      "With `neuve proof record`, give `--text <text> --stdinz`, not `--Detach` or `-z`.",
    ].join("\n");
    expect(
      invocationsOf(markdown).map((i) => [i.command.join(" "), ...i.flags]),
    ).toEqual([
      ["ventz"],
      ["jobss", "--all"],
      ["proof record", "--kindd"],
      ["proof record"],
      ["proof record", "--text", "--stdinz"],
      ["proof record", "--Detach"],
      ["proof record", "-z"],
    ]);
  });

  test("attaches a flag shown alone to its paragraph's command, and marks one with none", () => {
    const markdown = [
      "Run `neuve proof record <range>` with `--stdin`, or `--file <path>`.",
      "",
      "- Unless given `--no-stack`, `neuve setup hooks` runs `neuve setup stack`.",
      "- `--kind` is one of `test-run` or `log`.",
      "| `neuve review show` | `--json` |",
    ].join("\n");
    expect(
      invocationsOf(markdown)
        .filter((i) => !i.text.startsWith("neuve ") || i.text.includes("(with"))
        .map((i) => [i.orphan ? "orphan" : i.command.join(" "), ...i.flags]),
    ).toEqual([
      ["proof record", "--stdin"],
      ["proof record", "--file"],
      ["setup hooks", "--no-stack"],
      ["orphan", "--kind"],
      ["review show", "--json"],
    ]);
  });
});

describe("the skill text", () => {
  test("has its frontmatter, the version placeholder, and the six references it names", async () => {
    const files = await skillFiles();
    const entry = files.find((file) => file.file === "SKILL.md")!.text;
    expect(entry).toMatch(/^---\nname: neuve\ndescription: >\n/);
    expect(frontmatterVersion(entry)).toBe(VERSION_PLACEHOLDER);
    const references = files
      .map((file) => file.file)
      .filter((file) => file.startsWith("references/"));
    expect(references).toEqual([
      "references/desk.md",
      "references/lanes-and-dispositions.md",
      "references/proof.md",
      "references/request-review.md",
      "references/setup.md",
      "references/stack.md",
    ]);
    for (const reference of references) {
      expect(entry).toContain(`](${reference})`);
      expect(files.find((file) => file.file === reference)!.text).toContain(
        "\n## Worked example\n",
      );
    }
  });

  test("uses none of the design's working words", async () => {
    for (const { file, text } of await skillFiles())
      expect({
        file,
        found: text.match(
          /\bsections?\b|reading group|code risk floor|backstop/gi,
        ),
      }).toEqual({ file, found: null });
  });
});

describe("every command the skill shows exists in the CLI's help", () => {
  const root = { path: "" };
  const helps = new Map<string, string>();
  let invocations: ReadonlyArray<Invocation> = [];

  const neuve = (binary: string, args: ReadonlyArray<string>) => {
    const child = Bun.spawnSync([binary, ...args], {
      cwd: root.path,
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        HOME: root.path,
        TMPDIR: root.path,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: child.exitCode, stdout: child.stdout.toString() };
  };

  beforeAll(async () => {
    root.path = await mkdtemp(join(tmpdir(), "neuve-skill-drift-"));
    const binary = join(root.path, "neuve");
    const build = Bun.spawnSync(
      ["bun", "./scripts/build.ts", "--outfile", binary],
      { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    invocations = (await skillFiles()).flatMap(({ file, text }) =>
      invocationsOf(text, file),
    );
    const top = neuve(binary, ["--help"]);
    expect(top.code).toBe(0);
    helps.set("", top.stdout);
    for (const invocation of invocations) {
      const [first, second] = invocation.command;
      if (first !== undefined && !helps.has(first)) {
        const help = neuve(binary, [first, "--help"]);
        helps.set(first, help.code === 0 ? help.stdout : "");
      }
      const pair = `${first} ${second}`;
      if (OWN_HELP.has(pair) && !helps.has(pair)) {
        const help = neuve(binary, [first!, second!, "--help"]);
        expect(help.code).toBe(0);
        helps.set(pair, help.stdout);
      }
    }
  }, 300_000);

  afterAll(async () => {
    await rm(root.path, { recursive: true, force: true });
  });

  test("the sign-in commands are among those checked", () => {
    const shown = invocations.map((invocation) => [
      invocation.command.join(" "),
      ...invocation.flags,
    ]);
    expect(shown).toContainEqual(["auth login openai"]);
    expect(shown).toContainEqual(["review", "--route"]);
    expect(shown).toContainEqual(["setup", "--route"]);
    expect(shown).toContainEqual(["doctor"]);
    expect(shown).toContainEqual(["review desk"]);
    expect(shown).toContainEqual(["skills install"]);
  });

  test("each file shows commands, and every one is accounted for", () => {
    for (const file of [
      "SKILL.md",
      "references/desk.md",
      "references/lanes-and-dispositions.md",
      "references/proof.md",
      "references/request-review.md",
      "references/setup.md",
      "references/stack.md",
    ])
      expect({
        file,
        some: invocations.some((invocation) => invocation.file === file),
      }).toEqual({ file, some: true });
  });

  test("each command has a usage entry, and each flag is in it", () => {
    const problems: Array<string> = [];
    for (const invocation of invocations) {
      if (invocation.orphan === true) {
        problems.push(
          `${invocation.file}: ${invocation.text}: a flag shown with no command in its paragraph; name the command beside it`,
        );
        continue;
      }
      const name = invocation.command.join(" ");
      const texts = [
        helps.get(""),
        helps.get(invocation.command[0] ?? ""),
        helps.get(invocation.command.slice(0, 2).join(" ")),
      ].filter((text): text is string => text !== undefined && text !== "");
      const entries =
        invocation.command.length === 0
          ? [helps.get("")!]
          : texts.flatMap((text) => usageEntries(text, invocation.command));
      const family =
        invocation.flags.length === 0 &&
        texts.some((text) =>
          text
            .split("\n")
            .some((line) =>
              new RegExp(`^\\s+(?:neuve )?${name} [a-z][a-z-]*(?:\\s|$)`).test(
                line,
              ),
            ),
        );
      if (entries.length === 0 && !family) {
        problems.push(
          `${invocation.file}: \`${invocation.text}\`: no usage entry for "neuve ${name}" in the CLI's help`,
        );
        continue;
      }
      for (const flag of invocation.flags)
        if (
          !(flag === "--help" && texts.length > 0) &&
          !entries.some((entry) => hasFlag(entry, flag))
        )
          problems.push(
            `${invocation.file}: \`${invocation.text}\`: "neuve ${name}" has no ${flag}`,
          );
    }
    expect(problems).toEqual([]);
    // Shown so a reader of the test's output sees how many were checked.
    console.info(`checked ${invocations.length} invocations`);
  });
});
