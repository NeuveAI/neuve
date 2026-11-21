/**
 * The agent programs Neuve works with, in one list: Claude Code and Codex. Each entry knows how
 * it is found and the public registry's package that installs it. Setup looks for each and
 * reports what it found; capture hooks and the Neuve skill are written only for those found; a
 * missing one is offered from npm, and only from npm (decisions 14.66 and 14.75); doctor reports
 * the same findings in the same words ([the Codex runtime design](../../../process/proposals/codex-runtime.md#setup-install-and-upgrade)).
 *
 * Looking runs programs, and says which: Claude Code is the `claude` the PATH resolves to, asked
 * `claude --version`. Codex is asked its version as its app server: in `find` (setup) every
 * candidate discovery knows, the first that answers stored as the codex account's program; in
 * `check` (doctor, `setup hooks`, `skills install`) only what run time would start, the stored
 * path or else the PATH's one `codex`, and nothing stored.
 */
import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomically } from "./skill-bundle.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Settings } from "@neuve/harness";
import { findProgram } from "@neuve/runtime";
import { CODEX_PROGRAM } from "@neuve/harness/runtimes";
import type { AgentHarness } from "./capture/agent-hooks.ts";

export type Look = "find" | "check";

/** Where to look: the PATH and the home whose Neuve settings hold a stored program path. */
export interface Surroundings {
  readonly path: string;
  readonly home?: string | undefined;
  /** For tests: Codex's discovery, in place of the one that starts programs. */
  readonly findCodex?:
    typeof import("@neuve/harness/runtimes").findCodexProgram | undefined;
}

export interface Finding {
  readonly program: AgentProgram;
  readonly found?: {
    readonly path: string;
    readonly version?: string;
    readonly how: string;
  };
  /** What was asked and answered, in the order it happened. */
  readonly lines: ReadonlyArray<string>;
  /** Other programs on the PATH with this program's name, which did not answer as it. */
  readonly strangers: ReadonlyArray<string>;
  /** A program path stored on this machine that no longer answers. */
  readonly stale?: string;
  /** Why looking failed, when it could not finish (a settings file that can't be read, say). */
  readonly problem?: string;
}

export interface AgentProgram {
  readonly id: AgentHarness;
  readonly name: string;
  /** The npm package's own install, as its vendor documents it. */
  readonly install: ReadonlyArray<string>;
  readonly page: string;
  readonly look: (
    look: Look,
    surroundings: Surroundings,
  ) => Promise<Omit<Finding, "program">>;
}

/** The first line a program prints for `--version`, or undefined when it prints none. */
const versionOf = async (path: string) => {
  try {
    const child = Bun.spawn([path, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    });
    const [stdout, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    const line = stdout.trim().split("\n")[0]?.trim();
    return code === 0 && line ? line.slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
};

export const AGENT_PROGRAMS: ReadonlyArray<AgentProgram> = [
  {
    id: "claude-code",
    name: "Claude Code",
    install: ["npm", "install", "-g", "@anthropic-ai/claude-code@latest"],
    page: "https://code.claude.com/docs/en/setup",
    // As the Claude runtime finds it: the PATH's `claude`.
    look: async (_look, { path }) => {
      const found = findProgram("claude", undefined, path);
      if (found === undefined) return { lines: [], strangers: [] };
      const version = await versionOf(found);
      return {
        found: {
          path: found,
          ...(version === undefined ? {} : { version }),
          how: "found on the PATH",
        },
        lines: [],
        strangers: [],
      };
    },
  },
  {
    id: "codex",
    name: CODEX_PROGRAM.displayName,
    install: CODEX_PROGRAM.install.split(" "),
    page: CODEX_PROGRAM.page,
    // The one discovery `neuve auth program codex --find` runs.
    look: async (look, { path, home, findCodex }) =>
      (await import("./auth-cli.ts")).lookForCodex(look, {
        ...(home === undefined ? {} : { home }),
        ...(findCodex === undefined ? {} : { findCodex }),
        environment: { ...process.env, PATH: path },
      }),
  },
];

/** The ids the list knows, in its order, for `--agents`. */
export const AGENT_IDS = AGENT_PROGRAMS.map((program) => program.id);

export const programNamed = (id: AgentHarness) =>
  AGENT_PROGRAMS.find((program) => program.id === id)!;

/**
 * Parses `--agents a,b` against the list, and `none` as no program where `none` is allowed.
 * Undefined when not given.
 */
export const agentsFlag = (
  value: string | undefined,
  none = true,
): ReadonlyArray<AgentHarness> | undefined => {
  if (value === undefined) return undefined;
  if (none && value === "none") return [];
  const names = [
    ...new Set(
      value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== ""),
    ),
  ];
  const expected = `${AGENT_IDS.join(", ")} or ${none ? "none" : "both"}`;
  if (names.length === 0) throw new Error(`--agents takes ${expected}.`);
  for (const name of names)
    if (!(AGENT_IDS as ReadonlyArray<string>).includes(name))
      throw new Error(
        `--agents takes ${expected}, not ${JSON.stringify(name)}.`,
      );
  return names as ReadonlyArray<AgentHarness>;
};

/** Looks for each program in `ids` (every one by default), in the list's order. */
export const findAgentPrograms = async (
  look: Look,
  surroundings: Surroundings = { path: process.env["PATH"] ?? "" },
  ids: ReadonlyArray<AgentHarness> = AGENT_IDS,
): Promise<ReadonlyArray<Finding>> => {
  const findings: Finding[] = [];
  for (const program of AGENT_PROGRAMS)
    if (ids.includes(program.id))
      findings.push({
        program,
        // A look that fails is that program's finding; it never stops setup or doctor.
        ...(await program.look(look, surroundings).catch((error: unknown) => ({
          lines: [],
          strangers: [],
          problem: error instanceof Error ? error.message : String(error),
        }))),
      });
  return findings;
};

/** The ids of the programs found. */
export const foundIds = (findings: ReadonlyArray<Finding>) =>
  findings.flatMap((finding) =>
    finding.found === undefined ? [] : [finding.program.id],
  );

/** One finding's headline, the same words in setup and doctor. */
export const headline = ({ program, found, problem }: Finding) =>
  found === undefined
    ? `${program.name} was not found${problem === undefined ? "" : `: looking for it failed (${problem})`}`
    : `${program.name}${found.version === undefined ? "" : ` ${found.version}`} at ${found.path}, ${found.how}`;

/** The finding as setup prints it: the headline, then what was asked. */
export const describeFinding = (finding: Finding) =>
  [`${headline(finding)}.`, ...finding.lines].join("\n");

/** How a missing program is installed, and the vendor's page; for a look that failed, its fix. */
export const installAdvice = ({ program, problem }: Finding) =>
  problem === undefined
    ? `install it with ${program.install.join(" ")} (${program.page})`
    : "fix what stopped the look, then run this again";

/** What the install offer reads from its surroundings; setup passes the skill offer's. */
export interface OfferContext {
  readonly isTerminal: boolean;
  readonly ask: (question: string) => Promise<string | null>;
  readonly out: (text: string) => Promise<void>;
  readonly path: string;
  /** Runs npm with the person's terminal; the exit code. */
  readonly run?: (argv: ReadonlyArray<string>) => Promise<number>;
  /** The programs this machine was already asked about; each is asked once. None remembered when absent. */
  readonly offers?: OfferMemory;
  /** `neuve setup --ask-install-again`: asked again whatever was answered before. */
  readonly askAgain?: boolean;
}

export interface OfferMemory {
  readonly asked: (id: AgentHarness) => Promise<boolean>;
  /** Remembers an answer; what went wrong, the first time only, when it couldn't. */
  readonly record: (id: AgentHarness) => Promise<string | undefined>;
}

/**
 * The install offers answered on this machine, in `install-offers.json` beside the person's Neuve
 * settings: a program is asked about once per machine, as the skill offer is once per repository.
 * A no is remembered, and a yes only once npm installed it. Without a terminal nothing is asked, so
 * nothing is recorded. A file that can't be read counts as nothing asked; one that can't be
 * written is said once and never fails setup.
 */
export const machineOffers = (home = homedir()): OfferMemory => {
  const file = join(
    dirname(Settings.settingsPath(home)),
    "install-offers.json",
  );
  const read = async (): Promise<Record<string, string>> => {
    try {
      const value: unknown = JSON.parse(await readFile(file, "utf8"));
      return typeof value === "object" && value !== null
        ? (value as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  };
  let reported = false;
  return {
    asked: async (id) => (await read())[id] !== undefined,
    record: async (id) => {
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFileAtomically(
          file,
          `${JSON.stringify({ ...(await read()), [id]: new Date().toISOString() })}\n`,
          0o600,
        );
        return undefined;
      } catch (error) {
        if (reported) return undefined;
        reported = true;
        return `Setup couldn't remember this answer in ${file} (${error instanceof Error ? error.message : String(error)}), so it may ask again.`;
      }
    },
  };
};

/** The skill offer's answer: yes only when typed. */
export const YES = /^\s*y(es)?\s*$/i;

const inherit = async (argv: ReadonlyArray<string>) => {
  try {
    return await Bun.spawn([...argv], {
      stdio: ["inherit", "inherit", "inherit"],
    }).exited;
  } catch {
    return 127;
  }
};

/**
 * The offer for one missing program, default no, as the skill offer asks. Without a terminal it
 * prints the command and installs nothing. On yes it runs the npm package's own install and nothing
 * else; without npm, or when npm refuses, it says so and nothing else is changed. True only when
 * npm installed it.
 */
export const offerInstall = async (
  finding: Finding,
  context: OfferContext,
): Promise<boolean> => {
  const { program } = finding;
  const command = program.install.join(" ");
  const another =
    finding.strangers.length === 0
      ? []
      : [
          `Another program with its name is on the PATH (${finding.strangers.join(", ")}), and it did not answer as ${program.name}. What npm does about it is npm's: it may refuse, or replace it.`,
        ];
  if (!context.isTerminal) {
    await context.out(
      `${[`To install ${program.name}: ${command} (${program.page}). Nothing was installed: there is no terminal to ask.`, ...another].join("\n")}\n`,
    );
    return false;
  }
  if (context.askAgain !== true && (await context.offers?.asked(program.id))) {
    await context.out(
      `${[`To install ${program.name}: ${command} (${program.page}). Setup asked about it on this machine before, so it doesn't ask again; neuve setup --ask-install-again asks again.`, ...another].join("\n")}\n`,
    );
    return false;
  }
  const remember = async () => {
    const problem = await context.offers?.record(program.id);
    if (problem !== undefined) await context.out(`${problem}\n`);
  };
  if (another.length > 0) await context.out(`${another.join("\n")}\n`);
  const answer = await context.ask(
    `Install ${program.name} with ${command}? Its own page is ${program.page}. [y/N] `,
  );
  // A no is remembered; the end of input is no answer, and a yes waits for npm's result.
  if (!YES.test(answer ?? "")) {
    if (answer !== null) await remember();
    await context.out(`Not installed. To install it later: ${command}\n`);
    return false;
  }
  const npm = findProgram("npm", undefined, context.path);
  if (npm === undefined) {
    await context.out(
      `npm isn't on the PATH, so ${program.name} wasn't installed and nothing was changed. Install npm, then run ${command}, or see ${program.page}.\n`,
    );
    return false;
  }
  const code = await (context.run ?? inherit)([
    npm,
    ...program.install.slice(1),
  ]);
  if (code !== 0) {
    await context.out(
      `npm did not install ${program.name} (it exited ${code}); setup changed nothing else.\n`,
    );
    return false;
  }
  await remember();
  return true;
};
