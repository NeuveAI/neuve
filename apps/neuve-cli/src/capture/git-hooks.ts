import { Effect } from "effect";
import { z } from "zod";
import type { CommitLink, RecordEvent } from "@neuve/records-schema";
import {
  Ancestry,
  Caller,
  Identity,
  canonicalJson,
  sha256Hex,
  type StoreLocation,
} from "@neuve/records-core/capture";
import { captureEvent, defined, registration } from "./events.ts";

export const GIT_HOOKS = ["post-commit", "post-rewrite"] as const;
export const TRAILER_HOOK = "prepare-commit-msg";

/** Git hooks cannot take flags, so the `--session` override (D23) reaches them through this variable. */
export const SESSION_OVERRIDE_ENV = "NEUVE_SESSION";

const git = (repository: string, args: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const child = Bun.spawn(["git", "-C", repository, ...args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`git ${args.join(" ")} exited ${code}`);
    return stdout;
  });

/** A git identity as git recorded it, cut to the schema's bounds so an odd value never loses the event. */
const gitIdentity = (name: string | undefined, email: string | undefined) => ({
  name: (name ?? "").slice(0, 256),
  email: (email ?? "").slice(0, 320),
});

/**
 * Who made the change (D21, D23). A linked agent session (ancestry, override, or a session the harness
 * declared when the process table could not be read, 8.13) is the actor, and is registered again,
 * which is idempotent, so an override naming a session no hook has seen still yields a listed actor.
 * A declared link keeps its source, the variable it was read from. Only when the process table was
 * read and no recorded session owns the hook's ancestry (`none`) is the committer, a human by git
 * email, the actor. When the table could not be read and nothing was declared, several sessions claim
 * the process, or the override is invalid, the actor is left unresolved rather than guessed; the
 * committer stays on the record as a git fact either way.
 */
const attributeTo = (
  location: StoreLocation,
  committer: { readonly name: string; readonly email: string },
  processes: ProcessTable,
  environment: Environment,
) =>
  Effect.gen(function* () {
    const resolution = yield* Caller.resolveCaller(location, {
      override: environment[SESSION_OVERRIDE_ENV] || undefined,
      processes,
      environment,
    }).pipe(
      Effect.catchTag("UnknownSession", () =>
        Effect.succeed({ _tag: "InvalidOverride" } as const),
      ),
    );
    switch (resolution._tag) {
      case "Linked": {
        const parent =
          resolution.subagentId === undefined
            ? undefined
            : Identity.agentFingerprint({
                harness: resolution.harness,
                sessionId: resolution.sessionId,
              });
        return {
          actorId: resolution.actorId,
          sessionId: resolution.sessionId as string | undefined,
          link: resolution.method as CommitLink,
          linkSource:
            resolution.method === "declared" ? resolution.source : undefined,
          registrations: [
            registration(resolution.actorId, {
              actorKind: "agent",
              harness: resolution.harness,
              sessionId: resolution.sessionId,
              subagentId: resolution.subagentId,
              parentActor: parent,
            }),
          ],
        };
      }
      case "None": {
        const email = Identity.normalizeEmail(committer.email);
        const actorId = Identity.humanFingerprint(email);
        return {
          actorId,
          sessionId: undefined,
          link: "none" as CommitLink,
          linkSource: undefined,
          registrations: [
            registration(actorId, {
              actorKind: "human",
              harness: "git",
              // A malformed git email still identifies the committer, but is not recorded as an email.
              email: z.email().safeParse(email).success ? email : undefined,
              displayName: committer.name.slice(0, 256) || undefined,
            }),
          ],
        };
      }
      default:
        return {
          actorId: Identity.UNRESOLVED_ACTOR,
          sessionId: undefined,
          link: (resolution._tag === "Ambiguous"
            ? "ambiguous"
            : resolution._tag === "Unavailable"
              ? "unavailable"
              : "invalid-override") as CommitLink,
          linkSource: undefined,
          registrations: [] as Array<RecordEvent>,
        };
    }
  });

const FIELD = "%x00";

/** How the hook reads the process table; tests pass a fixed table or one that cannot be read. */
export type ProcessTable = () => Ancestry.Snapshot | undefined;

/** The hook's environment, where `NEUVE_SESSION` and declared session IDs (8.13) are read. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** `post-commit`: records HEAD and links it to its session. This is the commit link in this repository (8.1). */
export const capturePostCommit = (
  repository: string,
  location: StoreLocation,
  processes: ProcessTable = Ancestry.snapshotProcesses,
  environment: Environment = process.env,
) =>
  Effect.gen(function* () {
    const [oid, tree, parents, authorName, authorEmail, name, email] =
      (yield* git(repository, [
        "log",
        "-1",
        `--format=%H${FIELD}%T${FIELD}%P${FIELD}%an${FIELD}%ae${FIELD}%cn${FIELD}%ce`,
        "HEAD",
      ]))
        .replace(/\n$/, "")
        .split("\u0000");
    const committer = gitIdentity(name, email);
    const by = yield* attributeTo(location, committer, processes, environment);
    const events: Array<RecordEvent> = [
      ...by.registrations,
      captureEvent({
        kind: "commit.recorded@1",
        idempotencyKey: () => `git:commit:${oid}`,
        actor: by.actorId,
        attribution:
          by.sessionId === undefined ? undefined : { sessionId: by.sessionId },
        payload: defined({
          oid,
          tree,
          parents: (parents ?? "").split(" ").filter((p) => p.length > 0),
          author: gitIdentity(authorName, authorEmail),
          committer,
          link: by.link,
          linkSource: by.linkSource,
        }),
      }),
    ];
    return events;
  });

/**
 * `post-rewrite amend|rebase`: the old-to-new mapping git passes on standard input. The rewritten
 * commits are discovered by the worker, including rewrite paths that do not run `post-commit`.
 */
export const capturePostRewrite = (
  repository: string,
  location: StoreLocation,
  rewrite: string | undefined,
  input: string,
  processes: ProcessTable = Ancestry.snapshotProcesses,
  environment: Environment = process.env,
) =>
  Effect.gen(function* () {
    if (rewrite !== "amend" && rewrite !== "rebase") return [];
    const mappings = input
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields.length >= 2 && fields[0] !== "")
      .map(([from, to]) => ({ from: from!, to: to! }));
    if (mappings.length === 0) return [];
    const [name, email] = (yield* git(repository, [
      "var",
      "GIT_COMMITTER_IDENT",
    ]))
      .replace(/\s+\d+\s+[+-]\d{4}\s*$/, "")
      .split(/\s+<|>$/);
    const committer = gitIdentity(name?.trim(), email);
    const by = yield* attributeTo(location, committer, processes, environment);
    const events: Array<RecordEvent> = [...by.registrations];
    for (let start = 0; start < mappings.length; start += 1_024) {
      const chunk = mappings.slice(start, start + 1_024);
      events.push(
        captureEvent({
          kind: "commit.rewritten@1",
          idempotencyKey: () =>
            `git:rewrite:${sha256Hex(canonicalJson({ rewrite, chunk })).slice(0, 32)}`,
          actor: by.actorId,
          attribution:
            by.sessionId === undefined
              ? undefined
              : { sessionId: by.sessionId },
          payload: defined({
            rewrite,
            mappings: chunk,
            committer,
            link: by.link,
            linkSource: by.linkSource,
          }),
        }),
      );
    }
    return events;
  });

/**
 * `prepare-commit-msg`, installed only when a user opts into the `Neuve-Session` trailer for their
 * repository (8.1). It adds the session's fingerprint when the commit is linked to an agent session.
 * It writes nothing to the spool.
 */
export const addSessionTrailer = (
  repository: string,
  location: StoreLocation,
  messageFile: string | undefined,
) =>
  Effect.gen(function* () {
    if (messageFile === undefined) return;
    const resolution = yield* Caller.resolveCaller(location, {
      override: process.env[SESSION_OVERRIDE_ENV] || undefined,
      includeAceChats: false,
    });
    if (resolution._tag !== "Linked") return;
    yield* git(repository, [
      "interpret-trailers",
      "--in-place",
      "--if-exists",
      "addIfDifferent",
      "--trailer",
      `Neuve-Session: ${resolution.actorId}`,
      messageFile,
    ]);
  });
