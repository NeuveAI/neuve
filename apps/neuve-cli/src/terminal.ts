/**
 * How setup and the commands that share its printing speak: one decision about the terminal
 * (`styled`), one look for a step (a mark, a label, what came of it), one way to ask, and one
 * closing summary. A person at a colour terminal sees marks in colour and a line that is replaced
 * once slow work ends; everywhere else (a pipe, an agent's shell, `NO_COLOR`, `TERM=dumb`, CI) the
 * same facts print as plain lines whose mark is a word, which is also the output an agent reads.
 * Without a terminal nothing is asked: a question becomes a step that needs the person, with the
 * exact command that does it.
 *
 * No prompts library: answers are read a byte at a time from standard input, because the install
 * script points it at /dev/tty, where Bun's own stdin stream fails on macOS (see `readLine`).
 */
import { readSync } from "node:fs";
import { homedir } from "node:os";

/** What came of a step: done, left out, waiting for the person, or failed. */
export type Mark = "done" | "skipped" | "needs" | "failed";

const CI_VARIABLES = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "BUILDKITE",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
];

/**
 * The one decision: colour, marks and line replacement only for a terminal that is not dumb, with
 * `NO_COLOR` unset (https://no-color.org) and outside CI. Everything else gets plain lines.
 */
export const isStyled = (
  stream: { readonly isTTY?: boolean },
  environment: Readonly<Record<string, string | undefined>> = process.env,
) =>
  stream.isTTY === true &&
  !environment["NO_COLOR"] &&
  environment["TERM"] !== "dumb" &&
  !CI_VARIABLES.some((name) => environment[name]);

const sgr = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const COLOUR = {
  bold: sgr("1"),
  dim: sgr("2"),
  green: sgr("32"),
  yellow: sgr("33"),
  red: sgr("31"),
  cyan: sgr("36"),
};

const GLYPH: Record<Mark, string> = {
  done: COLOUR.green("✓"),
  skipped: COLOUR.dim("–"),
  needs: COLOUR.yellow("◆"),
  failed: COLOUR.red("✗"),
};
/** Plain marks are words, the same width, so a line reads the same in a log or to an agent. */
const WORD: Record<Mark, string> = {
  done: "ok",
  skipped: "skipped",
  needs: "to do",
  failed: "failed",
};
const LABEL_WIDTH = 13;

/** A path as a person reads it: the home folder as `~`. Commands keep the real path. */
export const shown = (path: string, home = homedir()) =>
  home !== "/" && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;

/**
 * One line from standard input, read with blocking reads of fd 0. Bun's own stdin stream watches
 * the descriptor with kqueue, which macOS refuses for /dev/tty (EINVAL), and the installer points
 * the offer's input at /dev/tty so it can ask even when it was piped in from curl. Reading one byte
 * at a time also leaves the next line for the next question. Null at the end of input.
 */
export const readLine = async (question: string) => {
  await Bun.write(Bun.stdout, question);
  const bytes: Array<number> = [];
  const byte = new Uint8Array(1);
  let ended = false;
  for (;;) {
    let read: number;
    try {
      read = readSync(0, byte, 0, 1, null);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EAGAIN"
      ) {
        Bun.sleepSync(20);
        continue;
      }
      throw error;
    }
    if (read === 0) {
      ended = true;
      break;
    }
    if (byte[0] === 0x0a) break;
    bytes.push(byte[0] ?? 0);
  }
  if (ended && bytes.length === 0) return null;
  // Input ended after a partial answer: keep the answer, end the prompt's line.
  if (ended) await Bun.write(Bun.stdout, "\n");
  return new TextDecoder().decode(new Uint8Array(bytes)).replace(/\r$/, "");
};

export interface Screen {
  /** Colour and line replacement are on. */
  readonly styled: boolean;
  /** A person can answer: standard input and output are a terminal, and no record was asked for. */
  readonly canAsk: boolean;
  print: (text: string) => Promise<void>;
  /** The command and version, once, at the top. */
  header: (title: string) => Promise<void>;
  /**
   * One step's line. `command` is the exact command that finishes it: shown after the text, and,
   * on a step that needs the person or failed, kept for the closing summary.
   */
  step: (
    mark: Mark,
    label: string,
    text: string,
    command?: string,
  ) => Promise<void>;
  /** Lines under a step, indented; dim when styled. */
  detail: (lines: ReadonlyArray<string>) => Promise<void>;
  /** Shows that slow work is under way, when styled; the next step line replaces it. */
  working: (label: string, text: string) => Promise<void>;
  /**
   * Asks until the answer is one of `choices` (their number or key) or empty, which picks
   * `fallback`. Undefined at the end of input. Only call it when `canAsk`.
   */
  choose: <T extends string>(
    question: string,
    choices: ReadonlyArray<{ readonly value: T; readonly label: string }>,
    fallback: { readonly label: string },
  ) => Promise<T | undefined>;
  /**
   * A yes or no question whose default is no; asked again until the answer is one of them.
   * Undefined at the end of input, which is no answer at all.
   */
  confirm: (question: string) => Promise<boolean | undefined>;
  /**
   * The closing summary: ready, or what is left for the person as exact commands, then the next
   * one. Never ready once a step failed.
   */
  closing: (input: { readonly next?: string }) => Promise<void>;
}

const YES = /^\s*y(es)?\s*$/i;
const NO = /^\s*n(o)?\s*$/i;

export const makeScreen = (input: {
  readonly out: (text: string) => Promise<void>;
  readonly styled: boolean;
  readonly canAsk: boolean;
  /** Prints the question and reads one line; null at the end of input. */
  readonly ask?: (question: string) => Promise<string | null>;
}): Screen => {
  const { out, styled } = input;
  const ask = input.ask ?? readLine;
  const paint = (colour: keyof typeof COLOUR, text: string) =>
    styled ? COLOUR[colour](text) : text;
  // A styled `working` line waits for the next line to replace it.
  let pending = false;
  const left: string[] = [];
  let failed = false;
  // Steps that need the person, with or without a command for it. A question settles the step
  // shown just before it: its answer's own line says what came of it, so its command is not left.
  let needed = 0;
  let unsettled = false;
  let unsettledCommand: string | undefined;
  const settle = () => {
    if (unsettled) needed -= 1;
    if (unsettledCommand !== undefined)
      left.splice(left.indexOf(unsettledCommand), 1);
    unsettled = false;
    unsettledCommand = undefined;
  };
  const write = async (text: string) => {
    if (pending) {
      pending = false;
      await out("\r\x1b[K");
    }
    await out(text);
  };
  const line = (mark: Mark, label: string, text: string) =>
    styled
      ? `${GLYPH[mark]} ${COLOUR.bold(label.padEnd(LABEL_WIDTH - 1))} ${text}`
      : `${WORD[mark].padEnd(8)}${label.padEnd(LABEL_WIDTH - 1)} ${text}`;
  // The hint stays one plain run of text after the question, so a person (or expect(1)) sees
  // exactly `[y/N] ` before the cursor.
  const question = (text: string, hint: string) =>
    styled
      ? `${COLOUR.cyan("?")} ${COLOUR.bold(text)} ${hint} `
      : `${text} ${hint} `;
  const asked = async (text: string) => {
    await write("");
    const answer = await ask(text);
    // The end of input typed no newline; end the prompt's line here.
    if (answer === null) await out("\n");
    return answer;
  };
  return {
    styled,
    canAsk: input.canAsk,
    print: write,
    header: (title) => write(`${paint("bold", title)}\n\n`),
    step: async (mark, label, text, command) => {
      if (mark === "failed") failed = true;
      unsettled = mark === "needs";
      unsettledCommand = undefined;
      if (unsettled) needed += 1;
      if (
        (mark === "needs" || mark === "failed") &&
        command !== undefined &&
        !left.includes(command)
      ) {
        left.push(command);
        if (unsettled) unsettledCommand = command;
      }
      await write(
        `${line(mark, label, command === undefined ? text : `${text}: ${paint("cyan", command)}`)}\n`,
      );
    },
    detail: async (lines) => {
      if (lines.length > 0)
        await write(
          `${lines.map((entry) => `${" ".repeat(styled ? 2 : 8)}${paint("dim", entry)}`).join("\n")}\n`,
        );
    },
    working: async (label, text) => {
      if (!styled) return;
      await write(
        `${COLOUR.dim("…")} ${COLOUR.bold(label.padEnd(LABEL_WIDTH))}${COLOUR.dim(text)}`,
      );
      pending = true;
    },
    choose: async (text, choices, fallback) => {
      settle();
      const listed = choices
        .map((choice, index) => `  ${index + 1}. ${choice.label}`)
        .join("\n");
      await write(
        `${styled ? `${COLOUR.cyan("?")} ${COLOUR.bold(text)}` : text}\n${listed}\n`,
      );
      const hint = `[1-${choices.length}, Enter to ${fallback.label}]`;
      for (;;) {
        const answer = await asked(question("Choose", hint));
        if (answer === null) return undefined;
        const typed = answer.trim();
        if (typed === "") return undefined;
        const picked =
          choices[Number(typed) - 1] ??
          choices.find((choice) => choice.value === typed);
        if (picked !== undefined) return picked.value;
        await write(
          `${paint("yellow", `Type a number from 1 to ${choices.length}, or press Enter to ${fallback.label}.`)}\n`,
        );
      }
    },
    confirm: async (text) => {
      settle();
      for (;;) {
        const answer = await asked(question(text, "[y/N]"));
        if (answer === null) return undefined;
        if (answer.trim() === "" || NO.test(answer)) return false;
        if (YES.test(answer)) return true;
        await write(`${paint("yellow", "Type y or n.")}\n`);
      }
    },
    closing: async ({ next }) => {
      const command = (text: string) => `  ${paint("cyan", text)}`;
      const lines =
        left.length === 0 && (failed || needed > 0)
          ? [paint("bold", "Not finished: see the lines above.")]
          : left.length === 0
            ? [
                paint("bold", "Neuve is ready."),
                ...(next === undefined
                  ? []
                  : [`  Next: ${paint("cyan", next)}`]),
              ]
            : [
                paint(
                  "bold",
                  failed ? "Not finished. Left for you:" : "Left for you:",
                ),
                ...left.map(command),
                ...(next === undefined ? [] : [`Then: ${paint("cyan", next)}`]),
              ];
      await write(`\n${lines.join("\n")}\n`);
    },
  };
};

/**
 * The screen for a command run by a person or an agent: human lines on standard output, or, with
 * `--json`, on standard error so standard output holds only the record. Asks only at a terminal.
 */
export const commandScreen = (options: { readonly json?: boolean }) => {
  const stream = options.json === true ? process.stderr : process.stdout;
  const target = options.json === true ? Bun.stderr : Bun.stdout;
  return makeScreen({
    out: async (text) => {
      await Bun.write(target, text);
    },
    styled: isStyled(stream),
    canAsk:
      options.json !== true &&
      process.stdin.isTTY === true &&
      process.stdout.isTTY === true,
  });
};

/** Plain lines into `out`, never asking: for tests and for callers that only report. */
export const plainScreen = (
  out: (text: string) => Promise<void>,
  options: {
    readonly canAsk?: boolean;
    readonly ask?: (question: string) => Promise<string | null>;
  } = {},
) =>
  makeScreen({
    out,
    styled: false,
    canAsk: options.canAsk === true,
    ...(options.ask === undefined ? {} : { ask: options.ask }),
  });
