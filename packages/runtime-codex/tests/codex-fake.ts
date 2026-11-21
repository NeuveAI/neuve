/**
 * A stand-in app server for the runtime's tests: each process the session starts is a fresh fake
 * program (tests/replay.ts) that answers the requests a session makes. A test overrides any answer
 * and sends notifications to the process that is running.
 */
import { Effect, Layer } from "effect";
import { CodexProcess } from "../src/services.ts";
import { fake, type Fake } from "./replay.ts";

export interface Process {
  readonly io: Fake;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether the process was started with the person's own settings off. */
  readonly clean: boolean;
}
type Reply = (
  message: Record<string, unknown>,
  process: Process,
) => unknown | undefined;

/** A reply that sends nothing: the test answers, or the request stays unanswered. */
export const SILENT = Symbol("silent");
export const RELEASE_AGENT = "neuve/0.171.0-alpha.13 (test)";
const excludeOf = (args: ReadonlyArray<string>) => {
  const flag = args.find((arg) =>
    arg.startsWith("shell_environment_policy.exclude="),
  );
  return flag === undefined
    ? undefined
    : (JSON.parse(
        flag.slice("shell_environment_policy.exclude=".length),
      ) as string[]);
};
/** The person's own exclude list, which a session must keep. */
export const OWN_EXCLUDE = ["OWN_SECRET_*"];
export const OWN = {
  mcp_servers: { "own-server": { enabled: true } },
  plugins: { "own-plugin": {} },
  apps: { "own-app": {}, _default: {} },
};

/** The default answers: a signed-in Codex with one thread, whose turns start and run until told. */
const answers: Record<string, (params: any, process: Process) => unknown> = {
  initialize: () => ({
    userAgent: RELEASE_AGENT,
    codexHome: "/codex-home",
    platformFamily: "unix",
    platformOs: "macos",
  }),
  // Each answer reflects the process's own arguments, as Codex's read-backs do, so a switch left
  // out of the launch shows as that addition still on.
  "config/read": (_params, process) => ({
    config: {
      mcp_servers: Object.fromEntries(
        Object.keys(OWN.mcp_servers).map((name) => [
          name,
          {
            enabled: !process.args.includes(
              `mcp_servers.${name}.enabled=false`,
            ),
          },
        ]),
      ),
      plugins: OWN.plugins,
      apps: OWN.apps,
      features: Object.fromEntries(
        ["hooks", "apps", "plugins"].map((name) => [
          name,
          !process.args.includes(`features.${name}=false`),
        ]),
      ),
      web_search: process.args.includes('web_search="disabled"')
        ? "disabled"
        : "live",
      // Seen live: a `-c` list replaces the person's, so the read-back is the flag's when given.
      shell_environment_policy: {
        exclude: excludeOf(process.args) ?? OWN_EXCLUDE,
      },
    },
    origins: {},
    layers: null,
  }),
  "hooks/list": (_params, process) => ({
    data: [
      {
        cwd: "/work",
        hooks: process.args.includes("features.hooks=false")
          ? []
          : [{ event: "SessionStart" }],
        warnings: [],
        errors: [],
      },
    ],
  }),
  "mcpServerStatus/list": (_params, process) => ({
    data: Object.keys(OWN.mcp_servers).map((name) => ({
      name,
      runtimeStatus: null,
      tools: process.args.includes(`mcp_servers.${name}.enabled=false`)
        ? {}
        : { lookup: {} },
    })),
    nextCursor: null,
  }),
  "skills/list": (_params, process) => ({
    data: [
      {
        cwd: "/work",
        skills: [
          {
            name: "own-skill",
            scope: "user",
            enabled: !process.args
              .join(" ")
              .includes('{name="own-skill",enabled=false}'),
          },
          {
            name: "bundled-skill",
            scope: "system",
            enabled: !process.args.includes("skills.bundled.enabled=false"),
          },
          { name: "repo-skill", scope: "repo", enabled: true },
        ],
        errors: [],
      },
    ],
  }),
  "account/read": () => ({
    account: { type: "chatgpt", email: null, workspaceName: null },
    userId: null,
    requiresOpenaiAuth: true,
  }),
  "thread/start": () => ({ thread: { id: "thread-1" }, model: "gpt-test" }),
  "thread/resume": (params) => ({
    thread: {
      id: params.threadId,
      turns: [{ id: "turn-a", status: "completed" }],
    },
  }),
  "thread/fork": () => ({ thread: { id: "thread-fork" } }),
  "turn/start": () => ({ turn: { id: "codex-turn" } }),
  "turn/steer": () => ({ turnId: "codex-turn" }),
  "turn/interrupt": () => ({}),
};

export const codex = (reply: Reply = () => undefined) => {
  const processes: Array<Process> = [];
  const layer = Layer.succeed(CodexProcess, {
    start: (command, options) =>
      Effect.suspend(() => {
        const args = command.slice(2);
        let process!: Process;
        const one = fake((message, io) => {
          if (typeof message.method !== "string" || message.id === undefined)
            return;
          const answer =
            reply(message, process) ??
            answers[message.method]?.(message.params, process);
          if (answer === undefined || answer === SILENT) return;
          queueMicrotask(() =>
            io.send(
              answer instanceof Error
                ? {
                    id: message.id,
                    error: { code: -32000, message: answer.message },
                  }
                : { id: message.id, result: answer },
            ),
          );
        });
        process = {
          io: one.io,
          args,
          env: options.env,
          clean: args.includes("features.hooks=false"),
        };
        processes.push(process);
        return Effect.gen(function* () {
          const service = yield* CodexProcess;
          return yield* service.start(command, options);
        }).pipe(Effect.provide(one.layer));
      }),
  });
  return {
    layer,
    processes,
    /** The process the session is using now: the last one started. */
    current: () => processes.at(-1)!,
    send: (method: string, params: unknown) =>
      processes.at(-1)!.io.send({ method, params }),
  };
};

export const completed = (
  status: "completed" | "interrupted" | "failed",
  error: unknown = null,
  id = "codex-turn",
) => ({
  threadId: "thread-1",
  turn: { id, status, error, items: [] },
});
