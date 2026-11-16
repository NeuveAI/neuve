// Why: capture writes into files the user owns (agent settings, git hooks) and into Records through
// events other processes ingest. These tests pin the two contracts that cannot be seen from a single
// run: setup keeps everything it did not write and is safe to rerun, and the events hooks produce are
// accepted by Records and project to the actors `neuve agents` lists, without ever carrying a prompt.
import { afterEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  symlink,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
  chmod,
} from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect } from "effect";
import {
  Actors,
  Ancestry,
  Identity,
  Log,
  Sessions,
  Store,
  resolveStoreLocation,
} from "@neuve/records-core";
import { captureAgentHook, HookPayload } from "../src/capture/agent-hooks.ts";
import {
  capturePostCommit,
  SESSION_OVERRIDE_ENV,
} from "../src/capture/git-hooks.ts";
import { runSetupHooks } from "../src/capture/setup-hooks.ts";

const directories: Array<string> = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const git = (cwd: string, ...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

const repository = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuve-capture-")));
  directories.push(root);
  const repo = join(root, "repo");
  Bun.spawnSync(["git", "init", "-q", repo]);
  git(repo, "config", "user.email", "Dev@Example.com");
  git(repo, "config", "user.name", "Dev Person");
  await writeFile(join(repo, "a"), "a\n");
  git(repo, "add", "a");
  // Hooks are not installed yet, so this commit runs none.
  git(repo, "commit", "-qm", "init");
  return { root, repo };
};

test("setup hooks keeps foreign hooks and settings, backs files up, and is idempotent", async () => {
  const { root, repo } = await repository();
  // A dotfile manager's layout: the settings path is a link into another directory.
  const dotfiles = join(root, "dotfiles");
  await mkdir(dotfiles);
  const claude = join(root, "claude-settings.json");
  await symlink(join(dotfiles, "claude-settings.json"), claude);
  const codex = join(root, "codex-hooks.json");
  // Ends like one of Neuve's hook verbs, but is another tool's.
  const foreign = {
    type: "command",
    command: "/usr/local/bin/notify codex stop",
  };
  await writeFile(
    join(dotfiles, "claude-settings.json"),
    JSON.stringify({
      model: "opus",
      hooks: { Stop: [{ matcher: "", hooks: [foreign] }] },
    }),
  );
  const previousHook = join(repo, ".git", "hooks", "post-commit");
  await writeFile(previousHook, "#!/bin/sh\necho previous\n");
  await chmod(previousHook, 0o755);
  const setup = () =>
    runSetupHooks([
      "--repo",
      repo,
      "--claude-settings",
      claude,
      "--codex-hooks",
      codex,
      "--command",
      "/opt/neuve/bin/neuve",
    ]);

  await setup();
  const first = await readFile(claude, "utf8");
  await setup();

  const settings = JSON.parse(await readFile(claude, "utf8"));
  expect(await readFile(claude, "utf8")).toBe(first);
  expect(settings.model).toBe("opus");
  expect(
    settings.hooks.Stop.flatMap((g: { hooks: Array<{ command: string }> }) =>
      g.hooks.map((h) => h.command),
    ),
  ).toEqual([
    foreign.command,
    "sh -c '/opt/neuve/bin/neuve hook claude-code stop >/dev/null 2>&1; exit 0 # neuve-capture-hook'",
  ]);
  expect(Object.keys(settings.hooks).sort()).toEqual([
    "SessionEnd",
    "SessionStart",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "UserPromptSubmit",
  ]);
  expect(
    (await readdir(dotfiles)).filter((name) => name.includes(".neuve-backup-")),
  ).toHaveLength(1);
  expect(
    JSON.parse(await readFile(codex, "utf8")).hooks.SessionStart[0],
  ).toEqual({
    matcher: null,
    hooks: [
      {
        type: "command",
        command:
          "sh -c '/opt/neuve/bin/neuve hook codex session-start >/dev/null 2>&1; exit 0 # neuve-capture-hook'",
        timeout: 10,
      },
    ],
  });
  const hook = await readFile(previousHook, "utf8");
  expect(hook).toContain(
    'if [ -x "$(dirname "$0")/post-commit.pre-neuve" ]; then "$(dirname "$0")/post-commit.pre-neuve" "$@"; status=$?; fi',
  );
  expect((await lstat(claude)).isSymbolicLink()).toBe(true);
  expect(hook).toContain("/opt/neuve/bin/neuve hook git post-commit");
  expect(await readFile(`${previousHook}.pre-neuve`, "utf8")).toBe(
    "#!/bin/sh\necho previous\n",
  );
});

test("hook events are accepted by Records and list the session, its subagent and the linked commit", async () => {
  const { repo } = await repository();
  const location = await Effect.runPromise(resolveStoreLocation(repo));
  const transcript = join(repo, "..", "transcript.jsonl");
  await writeFile(
    transcript,
    `${JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } })}\n`,
  );
  const hook = (
    event: Parameters<typeof captureAgentHook>[0],
    payload: Record<string, unknown>,
  ) =>
    captureAgentHook(event, {
      location,
      harness: "claude-code",
      payload: HookPayload.parse({ session_id: "s-1", cwd: repo, ...payload }),
    });

  const events = await Effect.runPromise(
    Effect.gen(function* () {
      const captured = [
        ...(yield* hook("session-start", {
          source: "startup",
          transcript_path: transcript,
        })),
        ...(yield* hook("user-prompt-submit", {
          prompt: "DO-NOT-STORE",
          transcript_path: transcript,
        })),
        ...(yield* hook("subagent-start", {
          agent_id: "a-1",
          agent_type: "reviewer",
        })),
        ...(yield* hook("subagent-stop", {
          agent_id: "a-1",
          agent_type: "reviewer",
          agent_transcript_path: transcript,
        })),
        ...(yield* hook("stop", { transcript_path: transcript })),
      ];
      writeFileSync(join(repo, "b"), "b\n");
      git(repo, "add", "b");
      git(repo, "commit", "-qm", "work");
      process.env[SESSION_OVERRIDE_ENV] = "claude-code:s-1";
      try {
        captured.push(...(yield* capturePostCommit(repo, location)));
      } finally {
        delete process.env[SESSION_OVERRIDE_ENV];
      }
      return captured;
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );
  const actors = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      yield* Log.append(events);
      return yield* Actors.list;
    }).pipe(
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );

  expect(JSON.stringify(events)).not.toContain("DO-NOT-STORE");
  expect(
    actors.map((a) => ({
      kind: a.subagentId === null ? "session" : "subagent",
      parent: a.parentAlias,
      words: a.alias.split("-").length,
      model: a.activity.model,
      turns: a.activity.turns,
      commits: a.activity.commits,
    })),
  ).toEqual([
    {
      kind: "session",
      parent: null,
      words: 3,
      model: "claude-opus-5-5",
      turns: 1,
      commits: 1,
    },
    {
      kind: "subagent",
      parent: actors[0]!.alias,
      words: 3,
      model: "claude-opus-5-5",
      turns: 1,
      commits: 0,
    },
  ]);
});

// Why (S3 review B1, B2): a commit's actor is a fact in an append-only log. A hook that cannot read the
// process table, or receives an override naming no supported harness, must leave the actor unknown
// rather than record the committer as its author, and no override can mint a human's fingerprint.
test("commits are attributed to the committer only when ancestry was checked; otherwise left unresolved", async () => {
  const { repo } = await repository();
  const location = await Effect.runPromise(resolveStoreLocation(repo));
  const unreadable = () => undefined;
  const noAgent = () =>
    Ancestry.parseProcessTable(
      `${process.pid} 1 Sat Oct 17 13:30:35 2026 bun\n`,
    );
  const commit = (file: string) => {
    writeFileSync(join(repo, file), `${file}\n`);
    git(repo, "add", file);
    git(repo, "commit", "-qm", file);
  };

  const events = await Effect.runPromise(
    Effect.gen(function* () {
      const captured = [];
      commit("sandboxed");
      captured.push(
        ...(yield* capturePostCommit(repo, location, unreadable, {})),
      );
      commit("spoofed");
      process.env[SESSION_OVERRIDE_ENV] = "human:dev@example.com";
      try {
        captured.push(...(yield* capturePostCommit(repo, location, noAgent)));
      } finally {
        delete process.env[SESSION_OVERRIDE_ENV];
      }
      commit("by-hand");
      captured.push(...(yield* capturePostCommit(repo, location, noAgent)));
      return captured;
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );
  const { actors, unresolved } = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      yield* Log.append(events);
      return {
        actors: yield* Actors.list,
        unresolved: yield* Actors.unresolvedCommits,
      };
    }).pipe(
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  const commits = events.filter((e) => e.kind === "commit.recorded@1");

  expect(
    commits.map((e) => [e.payload.link, e.actor === Identity.UNRESOLVED_ACTOR]),
  ).toEqual([
    ["unavailable", true],
    ["invalid-override", true],
    ["none", false],
  ]);
  expect(
    commits.every((e) => e.payload.committer.email === "Dev@Example.com"),
  ).toBe(true);
  expect(
    actors.map((a) => [a.actorKind, a.harness, a.email, a.activity.commits]),
  ).toEqual([["human", "git", "dev@example.com", 1]]);
  expect(unresolved).toEqual([
    { link: "invalid-override", commits: 1 },
    { link: "unavailable", commits: 1 },
  ]);
  expect(
    Identity.agentFingerprint({
      harness: "human",
      sessionId: "dev@example.com",
    }),
  ).not.toBe(Identity.humanFingerprint("dev@example.com"));
});

// Why (8.13): when the process table cannot be read, the session ID a harness sets in its shells may
// name the commit's session. It must count only for a live session recorded here, map to the same
// actor the hooks registered, keep its source, and stay distinguishable from ancestry, or commits are
// silently misattributed. A live variable inherited from an enclosing harness must not win over the
// calling harness's unrecorded one.
test("a declared session ID links a sandboxed commit to its live session and keeps its source", async () => {
  const { repo } = await repository();
  const location = await Effect.runPromise(resolveStoreLocation(repo));
  const unreadable = () => undefined;
  const live = (harness: "claude-code" | "codex", sessionId: string) =>
    Sessions.writeSession(location, {
      version: 1,
      harness,
      sessionId,
      actorId: Identity.agentFingerprint({ harness, sessionId }),
    });
  const commit = (file: string) => {
    writeFileSync(join(repo, file), `${file}\n`);
    git(repo, "add", file);
    git(repo, "commit", "-qm", file);
  };
  const events = await Effect.runPromise(
    Effect.gen(function* () {
      yield* live("claude-code", "cc-live");
      yield* live("codex", "codex-live");
      const captured = [];
      commit("declared");
      captured.push(
        ...(yield* capturePostCommit(repo, location, unreadable, {
          CLAUDE_CODE_SESSION_ID: "cc-live",
        })),
      );
      commit("codex-declared");
      captured.push(
        ...(yield* capturePostCommit(repo, location, unreadable, {
          CODEX_THREAD_ID: "codex-live",
        })),
      );
      commit("not-live");
      captured.push(
        ...(yield* capturePostCommit(repo, location, unreadable, {
          CLAUDE_CODE_SESSION_ID: "cc-gone",
        })),
      );
      commit("both");
      captured.push(
        ...(yield* capturePostCommit(repo, location, unreadable, {
          CLAUDE_CODE_SESSION_ID: "cc-live",
          CODEX_THREAD_ID: "codex-live",
        })),
      );
      // Codex inside Claude Code: its own thread is not recorded, the inherited variable is live.
      commit("inherited");
      captured.push(
        ...(yield* capturePostCommit(repo, location, unreadable, {
          CLAUDE_CODE_SESSION_ID: "cc-live",
          CODEX_THREAD_ID: "codex-unrecorded",
        })),
      );
      return captured;
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );
  const actors = await Effect.runPromise(
    Effect.gen(function* () {
      yield* Store.prepareForWrite;
      yield* Log.append(events);
      return yield* Actors.list;
    }).pipe(
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  const commits = events.filter((e) => e.kind === "commit.recorded@1");
  expect(
    commits.map((e) => [
      e.payload.link,
      e.payload.linkSource ?? null,
      e.attribution?.sessionId ?? null,
    ]),
  ).toEqual([
    ["declared", "CLAUDE_CODE_SESSION_ID", "cc-live"],
    ["declared", "CODEX_THREAD_ID", "codex-live"],
    ["unavailable", null, null],
    ["ambiguous", null, null],
    ["unavailable", null, null],
  ]);
  expect(commits[0]!.actor).toBe(
    Identity.agentFingerprint({ harness: "claude-code", sessionId: "cc-live" }),
  );
  expect(
    actors.map((a) => [
      a.harness,
      a.sessionId,
      a.activity.commits,
      a.activity.commitsDeclared,
    ]),
  ).toEqual([
    ["claude-code", "cc-live", 1, 1],
    ["codex", "codex-live", 1, 1],
  ]);
});
