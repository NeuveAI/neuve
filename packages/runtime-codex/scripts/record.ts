/**
 * Records a conversation with a real Codex, for re-recording the fixtures after a Codex update.
 * The program is an explicit argument, never looked up here:
 *
 *   bun scripts/record.ts --program <absolute path> --step <step> --out <new file outside any Git work tree>
 *
 * Each run gets a new empty working folder under the temp directory, the person's own Codex home,
 * and the person's environment without OpenAI's key and address variables. The recording is
 * redacted and saved whether the run succeeds or fails; it still describes the person's setup,
 * so it is only ever turned into a fixture by `scripts/trim.ts`. Nothing is printed but the
 * outcome, and nothing in the Codex home is read.
 */
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Effect, Exit } from "effect";
import { connect } from "../src/client.ts";
import { processLayer } from "../src/production.ts";
import { saveRecording, type Recorded } from "../src/recorder.ts";
import { steps, type Step } from "./steps.ts";

/**
 * The program as given, refused unless it is an absolute path: a bare name would be looked up
 * through `PATH`, which can lead to a program other than the one the probe found.
 */
export const programPath = (program: string) => {
  if (!isAbsolute(program))
    throw new Error(
      "--program must be an absolute path: a bare or relative name is looked up through PATH or the current folder, and may start another program",
    );
  return program;
};

/** The Git work tree a folder is inside, if any: a `.git` folder or file in it or above it. */
const workTree = (folder: string): string | undefined => {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) return at;
    if (dirname(at) === at) return undefined;
  }
};

/**
 * Where the output goes, refused inside any Git work tree: every step's output describes the
 * person's setup until `trim.ts` has made a fixture of it, so it must never be one `git add` away
 * from a commit.
 */
export const outputPath = (out: string) => {
  const path = resolve(out);
  const tree = workTree(realpathSync(dirname(path)));
  if (tree !== undefined)
    throw new Error(
      "--out must be outside every Git work tree: the output names the person's own settings",
    );
  return path;
};

/** OpenAI's key and address variables: Codex must use its own login, not a key that is set. */
export const REMOVED_ENVIRONMENT = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "OPENAI_PROJECT_ID",
  "CODEX_API_KEY",
  "CODEX_HOME",
];

const record = async () => {
  const { values } = parseArgs({
    options: {
      program: { type: "string" },
      step: { type: "string" },
      out: { type: "string" },
    },
  });
  const step = steps[values.step as keyof typeof steps] as Step | undefined;
  if (
    values.program === undefined ||
    step === undefined ||
    values.out === undefined
  )
    throw new Error(
      `usage: --program <absolute path> --step <${Object.keys(steps).join("|")}> --out <file>`,
    );
  const program = programPath(values.program);
  const out = outputPath(values.out);
  const codexHome = join(homedir(), ".codex");
  const workdir = mkdtempSync(join(tmpdir(), "codex-proof-"));
  const env: Record<string, string | undefined> = { ...process.env };
  for (const name of [...REMOVED_ENVIRONMENT, "NEUVE_CODEX_OWN_SETTINGS"])
    delete env[name];
  env.CODEX_HOME = codexHome;

  const entries: Array<Recorded> = [];
  const known: Array<readonly [string, string]> = [
    [workdir, "<cwd>"],
    [codexHome, "<codex-home>"],
    [homedir(), "<home>"],
    [program, "<program>"],
    [hostname(), "<host>"],
  ];

  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* connect({
          program,
          args: step.args(),
          env,
          cwd: workdir,
          clientInfo: { name: "neuve", title: "Neuve", version: "0.1.0" },
          answer: (request) => Effect.sync(() => step.answer(request)),
          onLine: (line) => entries.push(line),
          handshakeTimeout: "20 seconds",
        });
        const note = yield* step.run(connection, workdir);
        yield* connection.close;
        return { note, userAgent: connection.initialize.userAgent };
      }),
    ).pipe(Effect.provide(processLayer)),
  );
  const value = Exit.isSuccess(exit) ? exit.value : undefined;
  if (value !== undefined && !step.recorded)
    writeFileSync(out, value.note, { flag: "wx", mode: 0o600 });
  else
    saveRecording(
      out,
      {
        version: 1,
        codex:
          /\/(\d+\.\d+\.\d+[^\s;()]*)/.exec(value?.userAgent ?? "")?.[1] ??
          "unknown",
        note:
          value?.note ??
          `failed: ${Exit.isFailure(exit) ? String(exit.cause).slice(0, 200) : ""}`,
        entries,
      },
      known,
    );
  console.log(Exit.isSuccess(exit) ? "ok" : "failed; recording saved");
};

if (import.meta.main) await record();
