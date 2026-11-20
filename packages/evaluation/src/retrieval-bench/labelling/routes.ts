import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  advanceRoute,
  claudeCredential,
  currentRoute,
  isLimitFailure,
  routesExhausted,
  type Credential,
  type CredentialRoute,
} from "./credentials.ts";
import type { RunReceipt } from "./schema.ts";

/**
 * Model routes for labelling and grading (decision 9.37):
 *
 * - Codex (second family, 9.15): the Codex CLI named by `NEUVE_CODEX_BINARY` (`codex exec`) with
 *   GPT-6.1-Sol at high effort, its read-only sandbox (commands get no writes and no network), a
 *   structured-output schema and a clean Codex home holding only the owner's sign-in, so personal
 *   skills and hooks are not loaded. The `codex` on PATH through nvm is an unrelated npm package.
 * - Opus 5.5: headless Claude Code (`claude -p`) on the owner's plan, in restricted mode (no command
 *   tools; file tools confined to the run directory and the snapshot), safe mode (no CLAUDE.md,
 *   skills, hooks or MCP servers), read-only tools and structured output.
 *
 * Both run outside the agent sandbox, which hides their sign-ins. Every run works in its own
 * directory holding only what it may see (decision 2.16), gets only the allowlisted environment,
 * and its logged tool calls are audited for paths outside that directory and the snapshot.
 */

/**
 * The Codex program, only from `NEUVE_CODEX_BINARY` and read on every call: a path captured at import
 * would let a test that imports this module early reach a real program under a later test's fake.
 * These pinned runs never look a Codex up by themselves.
 */
export const codexBinary = () => {
  const binary = process.env["NEUVE_CODEX_BINARY"];
  if (binary === undefined || binary === "")
    throw new Error(
      "Set NEUVE_CODEX_BINARY to the absolute path of the Codex program to run: Neuve does not look one up",
    );
  return binary;
};
export const CODEX_MODEL = "gpt-6.1-sol";
export const CODEX_EFFORT = "high";
export const OPUS_MODEL = "claude-opus-5-5";
/** A clean Codex home the owner signs in to (`CODEX_HOME=<dir> codex login`); unset uses ~/.codex. */
export const LABEL_CODEX_HOME = process.env["NEUVE_LABEL_CODEX_HOME"];

/** The only variables a model process receives: no tokens, proxies, agent sockets or session state. */
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "CODEX_HOME",
  "TMPDIR",
  "LANG",
] as const;

/**
 * A minimal environment built from the allowlist, never by copying `process.env`, so variables such
 * as SSH_AUTH_SOCK, messaging tokens and proxy passwords cannot reach a model process.
 */
export const modelEnv = (options: {
  readonly home: string;
  readonly codexHome?: string;
  readonly source?: Readonly<Record<string, string | undefined>>;
  /** Exactly one Claude Code credential (decision on routes): only for Claude processes. */
  readonly credential?: Pick<Credential, "name" | "value">;
}): Record<string, string> => {
  const source = options.source ?? process.env;
  const env: Record<string, string> = {
    PATH: source["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: options.home,
    TMPDIR: source["TMPDIR"] ?? "/tmp",
    LANG: source["LANG"] ?? "en_US.UTF-8",
  };
  if (options.codexHome !== undefined) env["CODEX_HOME"] = options.codexHome;
  if (options.credential !== undefined)
    env[options.credential.name] = options.credential.value;
  return env;
};

export interface CodexRun {
  /** The run's own working directory: what the model may see, and where `output.json` lands. */
  readonly runDir: string;
  readonly prompt: string;
  /** The structured-output schema file inside the run directory. */
  readonly schemaFile: string;
  /**
   * A persisted session for multi-step runs: `resume: null` starts one (kept in the Codex home),
   * a thread id resumes it. Without it the run is ephemeral.
   */
  readonly session?: { readonly resume: string | null };
  /** Private log path (outside every run directory). */
  readonly log: string;
  readonly model?: string;
  readonly effort?: string;
  /** The step's bound (default `STEP_TIMEOUT_MS`). */
  readonly timeoutMs?: number;
  /** Another Codex binary (tests). */
  readonly binary?: string;
}

export const codexOutput = (runDir: string) => join(runDir, "output.json");

export const codexCommand = (run: CodexRun) => {
  const common = [
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--model",
    run.model ?? CODEX_MODEL,
    "-c",
    `model_reasoning_effort="${run.effort ?? CODEX_EFFORT}"`,
    "--output-schema",
    join(run.runDir, run.schemaFile),
    "--output-last-message",
    codexOutput(run.runDir),
    "--json",
  ];
  const resume = run.session?.resume ?? null;
  return {
    argv:
      resume !== null
        ? // `exec resume` takes no --sandbox or --cd: the sandbox is set by config, the folder by cwd.
          [
            run.binary ?? codexBinary(),
            "exec",
            "resume",
            resume,
            "-c",
            'sandbox_mode="read-only"',
            ...common,
            "-",
          ]
        : [
            run.binary ?? codexBinary(),
            "exec",
            ...(run.session === undefined ? ["--ephemeral"] : []),
            "--sandbox",
            "read-only",
            "--cd",
            run.runDir,
            ...common,
            "-",
          ],
    // The user's skills are found through HOME, so a clean Codex home doubles as HOME.
    env: modelEnv(
      LABEL_CODEX_HOME === undefined
        ? { home: homedir() }
        : { home: LABEL_CODEX_HOME, codexHome: LABEL_CODEX_HOME },
    ),
  };
};

/** The session (thread) id a Codex JSONL log started, for resuming it. */
export const codexThreadId = (jsonl: string) => {
  for (const line of jsonl.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: string };
      if (
        event.type === "thread.started" &&
        typeof event.thread_id === "string"
      )
        return event.thread_id;
    } catch {
      continue;
    }
  }
  return undefined;
};

/** Sums token usage over Codex's JSONL `turn.completed` events and counts commands. */
export const codexUsage = (jsonl: string) => {
  let input: number | null = null;
  let cached: number | null = null;
  let output: number | null = null;
  let reasoning: number | null = null;
  let toolCalls = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const item = event["item"] as Record<string, unknown> | undefined;
    if (
      event["type"] === "item.completed" &&
      item?.["type"] === "command_execution"
    )
      toolCalls++;
    const usage = event["usage"] as Record<string, number> | undefined;
    if (event["type"] === "turn.completed" && usage !== undefined) {
      input = (input ?? 0) + (usage["input_tokens"] ?? 0);
      cached = (cached ?? 0) + (usage["cached_input_tokens"] ?? 0);
      output = (output ?? 0) + (usage["output_tokens"] ?? 0);
      reasoning = (reasoning ?? 0) + (usage["reasoning_output_tokens"] ?? 0);
    }
  }
  return { input, cached, output, reasoning, toolCalls };
};

/** System locations a command may name without reading benchmark or user data. */
const SYSTEM = [
  "/bin/",
  "/sbin/",
  "/usr/",
  "/dev/",
  "/opt/homebrew/bin/",
  "/System/",
];

/**
 * Absolute paths in logged commands or tool inputs that fall outside the run directory and the
 * snapshot (both spellings of /tmp), plus any `..` step, which could leave the run directory.
 */
export const outsidePaths = (
  texts: ReadonlyArray<string>,
  allowed: ReadonlyArray<string>,
) => {
  const roots = allowed.flatMap((root) => [
    root,
    root.startsWith("/private/tmp/")
      ? root.slice("/private".length)
      : `/private${root}`,
  ]);
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(
      /(?:^|[\s'"=(:,])(\/[^\s'"`;|&<>()*,\\]+)/g,
    )) {
      const path = match[1]!;
      // A filesystem path has a named first segment and a second one; this skips sed and awk
      // patterns such as `/### /p` or `//` that the token pattern also matches.
      if (!/^\/[A-Za-z0-9._@-]+\//.test(path)) continue;
      if (SYSTEM.some((prefix) => path.startsWith(prefix))) continue;
      if (roots.some((root) => path === root || path.startsWith(`${root}/`)))
        continue;
      found.add(path);
    }
    if (/(^|[\s'"/=])\.\.\//.test(text)) found.add("(relative ../ path)");
  }
  return [...found].sort();
};

/** A model step's bound in wall-clock time (6.10): 20 minutes unless the environment sets another. */
export const STEP_TIMEOUT_MS = Number(
  process.env["NEUVE_LABEL_STEP_TIMEOUT_MS"] ?? 20 * 60_000,
);

/**
 * Runs one model process in its own process group, bounded in wall-clock time. On timeout the whole
 * group is killed, so no helper it started outlives it. Time is read from the wall clock, which keeps
 * running while the machine sleeps (the monotonic clock does not), so a killed or slept-through step
 * records its real duration.
 */
/**
 * The model process groups this process started and has not yet seen exit. They are detached (their
 * own groups), so a Ctrl-C would not reach them: on SIGINT, SIGTERM and exit they are killed, and an
 * orphan never outlives the CLI to write an answer unbounded.
 */
const liveGroups = new Set<number>();
export const liveProcessGroups = (): ReadonlySet<number> => liveGroups;
const killLiveGroups = () => {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  liveGroups.clear();
};
let guarded = false;
const guardLiveGroups = () => {
  if (guarded) return;
  guarded = true;
  process.on("exit", killLiveGroups);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    process.on(signal, () => {
      killLiveGroups();
      process.exit(code);
    });
};

export const runBounded = async (
  argv: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly stdin: string;
    readonly timeoutMs?: number;
  },
) => {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? STEP_TIMEOUT_MS);
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env,
    stdin: new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  guardLiveGroups();
  liveGroups.add(child.pid);
  let timedOut = false;
  // Checked against the wall clock: a timer alone pauses while the machine sleeps.
  const check = () => {
    if (timedOut || Date.now() < deadline) return;
    timedOut = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group already exited.
    }
  };
  const watch = setInterval(
    check,
    Math.min(15_000, options.timeoutMs ?? STEP_TIMEOUT_MS),
  );
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      stdout,
      stderr,
      code,
      timedOut,
      wallSeconds: (Date.now() - started) / 1000,
    };
  } finally {
    clearInterval(watch);
    // Helpers the step left behind in its group go with it.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is already empty.
    }
    liveGroups.delete(child.pid);
  }
};

/** The note of a step killed at its bound: a failed step, never an answer. */
export const timeoutNote = (wallSeconds: number) =>
  `timed out after ${Math.round(wallSeconds)}s; process group killed`;

/** Where a step's prompt is kept: a `prompts/` folder beside its log, which no receipt reader lists. */
export const promptFile = (log: string) =>
  join(dirname(log), "prompts", `${basename(log)}.prompt.txt`);

/** Keeps a step's prompt (a sha256 header line, then the text), so the wording survives the run folder. */
export const writePrompt = (log: string, prompt: string) => {
  const file = promptFile(log);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `sha256: ${createHash("sha256").update(prompt).digest("hex")}\n\n${prompt}`,
  );
};

export const runCodex = async (
  run: CodexRun & { readonly allowed: ReadonlyArray<string> },
  meta: Pick<RunReceipt, "caseId" | "hunkId" | "role">,
): Promise<RunReceipt> => {
  const { argv, env } = codexCommand(run);
  writePrompt(run.log, run.prompt);
  const { stdout, stderr, code, timedOut, wallSeconds } = await runBounded(
    argv,
    {
      cwd: run.runDir,
      env,
      stdin: run.prompt,
      ...(run.timeoutMs === undefined ? {} : { timeoutMs: run.timeoutMs }),
    },
  );
  // A killed step leaves no answer behind, even a partial one.
  if (timedOut) rmSync(codexOutput(run.runDir), { force: true });
  writeFileSync(run.log, stdout);
  writeFileSync(`${run.log}.stderr`, stderr);
  const usage = codexUsage(stdout);
  return {
    ...meta,
    route: "codex-exec",
    model: run.model ?? CODEX_MODEL,
    effort: run.effort ?? CODEX_EFFORT,
    wallSeconds,
    inputTokens: usage.input,
    cachedInputTokens: usage.cached,
    outputTokens: usage.output,
    reasoningTokens: usage.reasoning,
    totalTokens:
      usage.input === null ? null : usage.input + (usage.output ?? 0),
    toolCalls: usage.toolCalls,
    apiEquivalentUsd: null,
    credentialRoute: null,
    credentialVariable: null,
    outsideReads: auditCodexLog(stdout, [run.runDir, ...run.allowed]),
    note: timedOut
      ? timeoutNote(wallSeconds)
      : code === 0 && existsSync(codexOutput(run.runDir))
        ? null
        : `exit ${code}: ${stderr.slice(-400)}`,
  };
};

/** Paths outside the run directory and the snapshot named in a Codex log's commands. */
export const auditCodexLog = (
  stdout: string,
  allowed: ReadonlyArray<string>,
) => {
  const commands: Array<string> = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const item = (
        JSON.parse(line) as { item?: { type?: string; command?: string } }
      ).item;
      if (
        item?.type === "command_execution" &&
        typeof item.command === "string"
      )
        commands.push(item.command);
    } catch {
      continue;
    }
  }
  return outsidePaths(commands, allowed);
};

/**
 * The run prompt for either family. Each run works only in its own directory, and its final answer
 * is the JSON object (structured output); the runner writes it to the run's `output.json`.
 */
export const runPrompt = (
  runDir: string,
  role: "labeller" | "grader",
  task: string,
) =>
  [
    `You are ${role === "labeller" ? "a labeller" : "a grader of labeller additions"} for Neuve's M4 retrieval benchmark. Work only inside \`${runDir}\` and the read-only base snapshot its task names; do not read any other directory, repository or git history.`,
    "",
    role === "labeller"
      ? `Relative paths below are relative to \`${runDir}\`. Read \`brief.md\` and follow it exactly, then do the task below.`
      : `Relative paths below are relative to \`${runDir}\`. Do the task below.`,
    "Your final answer must be the JSON object only.",
    "",
    "---",
    "",
    task,
  ].join("\n");

export const OPUS_EFFORT = "high";

/**
 * Headless Claude Code on the owner's plan: restricted and safe mode, read-only tools confined to the
 * run directory (its working directory) and the snapshot, structured output, the minimal
 * environment (its sign-in lives under HOME), and a stream-json log for auditing tool calls.
 */
export const claudePrintCommand = (
  runDir: string,
  snapshot: string,
  schema: string,
  /** null leaves Claude Code's default effort. */
  effort: string | null = OPUS_EFFORT,
  /**
   * A persisted session for two-step runs: the first step starts it, the second resumes it, so
   * both steps share one context. Without it the session is not persisted.
   */
  session?: { readonly id: string; readonly resume: boolean },
  credential?: Pick<Credential, "name" | "value">,
) => ({
  argv: [
    "claude",
    "-p",
    "--model",
    OPUS_MODEL,
    ...(effort === null ? [] : ["--effort", effort]),
    "--restricted",
    "--safe-mode",
    "--strict-mcp-config",
    ...(session === undefined
      ? ["--no-session-persistence"]
      : session.resume
        ? ["--resume", session.id]
        : ["--session-id", session.id]),
    "--tools",
    "Read,Grep,Glob",
    "--add-dir",
    snapshot,
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    schema,
  ],
  env: modelEnv(
    credential === undefined
      ? { home: homedir() }
      : { home: homedir(), credential },
  ),
});

/** One short backoff before a limit failure counts as persistent (owner's route ruling). */
export const LIMIT_BACKOFF_MS = 60_000;

export const runClaude = async (
  run: {
    readonly runDir: string;
    readonly snapshot: string;
    readonly prompt: string;
    readonly schemaFile: string;
    readonly log: string;
    readonly effort?: string | null;
    readonly session?: { readonly id: string; readonly resume: boolean };
  },
  meta: Pick<RunReceipt, "caseId" | "hunkId" | "role">,
): Promise<RunReceipt> => {
  const effort = run.effort === undefined ? OPUS_EFFORT : run.effort;
  const schema = readFileSync(join(run.runDir, run.schemaFile), "utf8");
  writePrompt(run.log, run.prompt);
  const once = async (credential: Credential) => {
    const { argv, env } = claudePrintCommand(
      run.runDir,
      run.snapshot,
      schema,
      effort,
      run.session,
      credential,
    );
    const { stdout, stderr, code, timedOut, wallSeconds } = await runBounded(
      argv,
      { cwd: run.runDir, env, stdin: run.prompt },
    );
    const audited = auditClaudeLog(stdout, run.runDir, run.snapshot);
    const failure = timedOut
      ? timeoutNote(wallSeconds)
      : code === 0 && audited.result?.["is_error"] === false
        ? ""
        : `${String(audited.result?.["result"] ?? "")} ${stderr}`;
    return { stdout, stderr, code, audited, wallSeconds, failure, timedOut };
  };
  // Subscription token first; on a credit, quota or rate-limit failure that survives one backoff,
  // the API key; when both are exhausted the run stops and the caller reports it.
  let attempt: Awaited<ReturnType<typeof once>> | undefined;
  let route: CredentialRoute = currentRoute();
  for (;;) {
    if (routesExhausted())
      throw new Error(
        "Claude credential routes exhausted (subscription token and API key)",
      );
    route = currentRoute();
    const credential = claudeCredential();
    if (credential === undefined) {
      advanceRoute(route);
      continue;
    }
    attempt = await once(credential);
    if (isLimitFailure(attempt.failure)) {
      await new Promise((done) => setTimeout(done, LIMIT_BACKOFF_MS));
      attempt = await once(credential);
    }
    if (!isLimitFailure(attempt.failure)) break;
    advanceRoute(route);
  }
  const { stdout, stderr, code, audited, wallSeconds, timedOut } = attempt;
  writeFileSync(run.log, stdout);
  writeFileSync(`${run.log}.stderr`, stderr);
  const { toolCalls, result, outside } = audited;
  // A killed step gives no answer, even if a result had already been streamed.
  const structured = timedOut ? undefined : result?.["structured_output"];
  if (structured !== undefined && structured !== null)
    writeFileSync(codexOutput(run.runDir), `${JSON.stringify(structured)}\n`);
  const usage = (result?.["usage"] ?? {}) as Record<string, number>;
  const input =
    usage["input_tokens"] === undefined
      ? null
      : (usage["input_tokens"] ?? 0) +
        (usage["cache_read_input_tokens"] ?? 0) +
        (usage["cache_creation_input_tokens"] ?? 0);
  return {
    ...meta,
    route: "claude-print",
    model: OPUS_MODEL,
    effort: effort ?? "default",
    wallSeconds,
    inputTokens: input,
    cachedInputTokens: usage["cache_read_input_tokens"] ?? null,
    outputTokens: usage["output_tokens"] ?? null,
    reasoningTokens: null,
    totalTokens: input === null ? null : input + (usage["output_tokens"] ?? 0),
    toolCalls,
    apiEquivalentUsd:
      typeof result?.["total_cost_usd"] === "number"
        ? (result["total_cost_usd"] as number)
        : null,
    outsideReads: outside,
    credentialRoute: route,
    credentialVariable:
      route === "subscription-token"
        ? "CLAUDE_CODE_OAUTH_TOKEN"
        : "ANTHROPIC_API_KEY",
    note: timedOut
      ? timeoutNote(wallSeconds)
      : code === 0 &&
          result?.["is_error"] === false &&
          structured !== undefined &&
          structured !== null
        ? null
        : `exit ${code}: ${String(result?.["result"] ?? stderr).slice(-400)}`,
  };
};

/**
 * Tool-call paths in a Claude Code stream-json log outside the run directory and the snapshot, plus
 * any denied tool call. Claude Code's own spill files for large tool results (under
 * ~/.claude/projects/<the run directory's slug>/) hold output the run already read and are allowed.
 */
export const auditClaudeLog = (
  stdout: string,
  runDir: string,
  snapshot: string,
) => {
  const touched: Array<string> = [];
  let toolCalls = 0;
  let result: Record<string, unknown> | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event["type"] === "result") result = event;
    const content = (event["message"] as { content?: unknown } | undefined)
      ?.content;
    if (event["type"] === "assistant" && Array.isArray(content))
      for (const block of content as Array<Record<string, unknown>>)
        if (block["type"] === "tool_use") {
          toolCalls++;
          const input = (block["input"] ?? {}) as Record<string, unknown>;
          for (const key of ["file_path", "path"])
            if (typeof input[key] === "string")
              touched.push(` ${input[key] as string}`);
        }
  }
  const denials = (
    (result?.["permission_denials"] ?? []) as Array<{
      tool_input?: Record<string, unknown>;
    }>
  ).map((denial) => JSON.stringify(denial.tool_input ?? {}));
  const slug = (path: string) => path.replace(/[^A-Za-z0-9-]/g, "-");
  const spill = [
    runDir,
    runDir.startsWith("/tmp/")
      ? `/private${runDir}`
      : runDir.replace(/^\/private/, ""),
  ].map((path) => join(homedir(), ".claude", "projects", slug(path)));
  return {
    toolCalls,
    result,
    outside: [
      ...outsidePaths(touched, [runDir, snapshot, ...spill]),
      ...denials.map((denial) => `denied: ${denial}`),
    ],
  };
};

export const readJson = (path: string) =>
  JSON.parse(readFileSync(path, "utf8")) as unknown;
