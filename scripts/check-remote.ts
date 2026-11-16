import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { receiptDirectory } from "../apps/neuve-cli/src/install-source.ts";
import { PI_TRANSITION_STORAGE_PROFILE } from "./pi-storage.ts";
import {
  GRAPH_DEPENDENT_TESTS,
  escapeTestName,
} from "./graph-dependent-tests.ts";

const source = resolve(import.meta.dirname, "..");
const digest = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");

const gitEnvironment = () => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
});

const git = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-C",
      cwd,
      ...args,
    ],
    {
      env: gitEnvironment(),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `git exited ${code}`);
  return stdout;
};

export const resolveCommit = async (cwd: string, revision: string) => {
  const commit = (
    await git(
      cwd,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${revision}^{commit}`,
    )
  ).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Unknown commit");
  return commit;
};

export const checkedCommit = async (cwd: string, revision: string) => {
  const commit = await resolveCommit(cwd, revision);
  const head = (await git(cwd, "rev-parse", "HEAD")).trim();
  if (head !== commit)
    throw new Error(
      "Check out the requested commit first; local parts must use the same source",
    );
  if (
    (await git(cwd, "status", "--porcelain=v1", "--untracked-files=all")).trim()
  )
    throw new Error("Refusing a dirty checkout, including untracked files");
  return commit;
};

/** Only this existing checkout moves; initialized submodules keep their own files and HEAD. */
export const pinLocalCheckout = async (
  cwd: string,
  commit: string,
  originalHead: string,
) => {
  await checkedCommit(cwd, originalHead);
  const branch = await git(
    cwd,
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ).then(
    (text) => text.trim(),
    () => null,
  );
  const submodules: { path: string; head: string }[] = [];
  for (const entry of (await git(cwd, "ls-files", "--stage", "-z")).split(
    "\0",
  )) {
    if (!entry.startsWith("160000 ")) continue;
    const path = entry.slice(entry.indexOf("\t") + 1);
    if (!(await lstat(join(cwd, path, ".git")).catch(() => null))) continue;
    submodules.push({
      path,
      head: await git(join(cwd, path), "rev-parse", "HEAD"),
    });
  }
  const check = async () => {
    if ((await resolveCommit(cwd, "HEAD")) !== commit)
      throw new Error("Checkout changed during local checks");
    if (
      (
        await git(
          cwd,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
          "--ignore-submodules=all",
        )
      ).trim()
    )
      throw new Error("Refusing a dirty checkout, including untracked files");
    // Ignoring worktree gitlink mismatches must never hide staged pointer edits.
    await git(
      cwd,
      "diff-index",
      "--cached",
      "--quiet",
      "--ignore-submodules=none",
      commit,
      "--",
    );
    for (const { path, head } of submodules) {
      const sub = join(cwd, path);
      if (
        (await git(sub, "rev-parse", "HEAD")) !== head ||
        (
          await git(sub, "status", "--porcelain=v1", "--untracked-files=all")
        ).trim()
      )
        throw new Error(`Submodule changed during local checks: ${path}`);
    }
  };
  const moved = commit !== originalHead;
  if (moved)
    await git(
      cwd,
      "switch",
      "--no-recurse-submodules",
      "--no-overwrite-ignore",
      "--detach",
      commit,
    );
  return {
    check,
    async restore() {
      await check();
      if (moved)
        await git(
          cwd,
          "switch",
          "--no-recurse-submodules",
          "--no-overwrite-ignore",
          ...(branch === null ? ["--detach", originalHead] : [branch]),
        );
    },
  };
};

type LocalCheckout = {
  check: () => Promise<void>;
  signal: AbortSignal;
  track: (child: Bun.Subprocess) => () => void;
};

/** Signals stop the process group before the single restoration attempt. */
export const withPinnedLocalCheckout = async <T>(
  cwd: string,
  commit: string,
  originalHead: string,
  use: (checkout: LocalCheckout) => Promise<T>,
) => {
  const controller = new AbortController();
  const children = new Set<Bun.Subprocess>();
  let stopping: Promise<void> | undefined;
  let restoring: Promise<string | null> | undefined;
  let interrupted = false;
  const pin = pinLocalCheckout(cwd, commit, originalHead);
  const restore = () =>
    (restoring ??= (async () => {
      try {
        await stopping;
        await (await pin).restore();
        return null;
      } catch (error) {
        return String(error);
      }
    })());
  const handlers = (
    [
      ["SIGINT", 130],
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const
  ).map(([signal, code]) => {
    const handler = () => {
      if (interrupted) return;
      interrupted = true;
      controller.abort();
      stopping = Promise.all(
        [...children].map(async (child) => {
          const kill = (signal: NodeJS.Signals) => {
            try {
              process.kill(-child.pid, signal);
            } catch (error) {
              if (!(
                error instanceof Error &&
                "code" in error &&
                error.code === "ESRCH"
              ))
                throw error;
            }
          };
          kill("SIGTERM");
          const timer = setTimeout(() => kill("SIGKILL"), 2000);
          try {
            await child.exited;
          } finally {
            clearTimeout(timer);
            kill("SIGKILL");
          }
        }),
      ).then(() => {});
      void restore().then((error) => {
        if (error !== null)
          console.error(`Checkout restoration failed: ${error}`);
        process.exit(code);
      });
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  try {
    const checkout = await pin;
    controller.signal.throwIfAborted();
    const value = await use({
      check: checkout.check,
      signal: controller.signal,
      track(child) {
        children.add(child);
        return () => children.delete(child);
      },
    });
    return { value, restorationError: await restore() };
  } finally {
    const error = await restore();
    if (error !== null) console.error(`Checkout restoration failed: ${error}`);
    if (!interrupted)
      for (const { signal, handler } of handlers) process.off(signal, handler);
  }
};

const deniedPath = (path: string) =>
  path
    .split("/")
    .some(
      (part) =>
        /^(?:\.git|\.neuve|\.ssh|\.aws|\.azure|\.config|\.codex|\.claude|\.local|\.cache|\.npm|\.bun|node_modules|homes?)$/i.test(
          part,
        ) ||
        /^(?:\.env(?:rc|\..*)?|\.dev\.vars(?:\..*)?)$/i.test(part) ||
        /^(?:\.npmrc|\.netrc|\.pypirc|\.git-credentials|(?:auth|credentials|secrets?)(?:\.(?:json|ya?ml|toml|ini|txt))?|id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?|.*\.(?:pem|key|keychain(?:-db)?|p12|pfx))$/i.test(
          part,
        ),
    );

export const checkUploadPath = (path: string, link?: string) => {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path
      .split("/")
      .some((part) => part === ".." || part === "." || part === "") ||
    deniedPath(path)
  )
    throw new Error(`Refusing upload path: ${path}`);
  if (link !== undefined) {
    const target = posix.normalize(posix.join(posix.dirname(path), link));
    if (
      link.startsWith("/") ||
      link.includes("\\") ||
      link.includes("\0") ||
      target === ".." ||
      target.startsWith("../") ||
      deniedPath(target)
    )
      throw new Error(`Refusing upload link: ${path}`);
  }
};

const Part = z.object({
  id: z.string().regex(/^[a-zA-Z0-9-]+$/),
  cwd: z.string(),
  command: z.array(z.string()).min(1),
});
type Part = z.infer<typeof Part>;
export const graphLocalPart: Part = {
  id: "local-graph",
  cwd: ".",
  command: [
    process.execPath,
    "--no-env-file",
    "scripts/check-graph.ts",
    "--test",
  ],
};
const Result = Part.extend({
  location: z.enum(["modal", "local"]),
  exitCode: z.number().int(),
  pass: z.number().int().nonnegative(),
  fail: z.number().int().nonnegative(),
  skip: z.number().int().nonnegative().default(0),
  seconds: z.number().optional(),
  sandbox: z.string().optional(),
  error: z.string().optional(),
});
type Result = z.infer<typeof Result>;

// These adapters omit only the Mac storage preflight. Refuse source changes until their
// compiler/build invocations have been reconciled with the new scripts.
const adapters = {
  "scripts/build-ace-types.ts":
    "ccab17686f5a9e75a2848c4412f189ae2b69f94591a6230d0f25a96a707f0780",
  "scripts/check-ace.ts":
    "23d9ff5ca12cefeeabb72f5d7faa9d182093503173df96a32ced771b0a61ac00",
};

const Package = z.object({
  name: z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
  scripts: z.record(z.string(), z.string()).default({}),
});
export const remotePlan = async (
  cwd: string,
  commit: string,
): Promise<Part[]> => {
  const plan: Part[] = [
    {
      id: "test-root",
      cwd: ".",
      command: [
        "bun",
        "--no-env-file",
        "run",
        "test:root",
        "--test-name-pattern",
        "^(?!the generated protocol preserves SDK and native types).*$",
      ],
    },
    {
      id: "typecheck-root",
      cwd: ".",
      command: ["bun", "--no-env-file", "run", "typecheck:root"],
    },
  ];
  const paths = (await git(cwd, "ls-tree", "-r", "--name-only", commit))
    .trim()
    .split("\n");
  for (const path of paths.filter((path) =>
    /^(?:(?:apps|packages|services)\/[^/]+|apps\/neuve-web\/(?:apps|packages)\/[^/]+)\/package\.json$/.test(
      path,
    ),
  )) {
    const pkg = Package.parse(
      JSON.parse(await git(cwd, "show", `${commit}:${path}`)),
    );
    if (
      !(
        pkg.name.startsWith("@neuve/") ||
        pkg.name.startsWith("@ace/") ||
        pkg.name.startsWith("@workspace/") ||
        pkg.name === "web"
      ) ||
      pkg.name === "@neuve/graph"
    )
      continue;
    for (const kind of ["test", "typecheck"]) {
      if (!pkg.scripts[kind] || (kind === "test" && pkg.name === "@ace/host"))
        continue;
      const excluded =
        kind !== "test"
          ? undefined
          : pkg.name === "@neuve/records-core"
            ? "a process that can only read an older store"
            : pkg.name === "web"
              ? "the web app and the CLI freeze the same run key"
              : pkg.name === "@neuve/evaluation"
                ? "the committed harness holds every snapshot marker the seam path needs"
                : pkg.name === "@neuve/cli"
                  ? "the worker this build starts loads neither the project's"
                  : undefined;
      const excludedNames =
        kind === "test"
          ? GRAPH_DEPENDENT_TESTS.filter(
              (test) => test.cwd === posix.dirname(path),
            ).flatMap(({ names }) => names.map(escapeTestName))
          : [];
      if (excluded !== undefined) excludedNames.push(`${excluded}.*`);
      plan.push({
        id: `${kind}-${pkg.name.replace("@", "").replace("/", "-")}`,
        cwd: posix.dirname(path),
        command: [
          "bun",
          "--no-env-file",
          "run",
          kind,
          ...(kind === "test" &&
          ["@neuve/cli", "@neuve/harness", "@neuve/records-core"].includes(
            pkg.name,
          )
            ? ["--timeout", "15000"]
            : []),
          ...(excludedNames.length === 0
            ? []
            : [
                "--test-name-pattern",
                `^(?!(?:${excludedNames.join("|")})$).*$`,
              ]),
        ],
      });
    }
  }
  plan.push({
    id: "check-ace",
    cwd: ".",
    command: ["bun", "--no-env-file", "./.remote-check-ace.ts"],
  });
  return plan;
};

/** Apply public-cut exclusions before uploading from a private checkout. */
const publicCutExclusions = async (patterns: string, files: string[]) => {
  const matcher = await mkdtemp(join(tmpdir(), "neuve-public-cut-"));
  try {
    await git(matcher, "init", "--quiet");
    await writeFile(join(matcher, ".gitignore"), patterns);
    const child = Bun.spawn(
      [
        "git",
        "-c",
        "core.excludesFile=/dev/null",
        "check-ignore",
        "--no-index",
        "--stdin",
        "-z",
      ],
      {
        cwd: matcher,
        env: gitEnvironment(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    child.stdin.write(files.join("\0") + "\0");
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0 && code !== 1)
      throw new Error(stderr.trim() || `git check-ignore exited ${code}`);
    return new Set(stdout.split("\0").filter(Boolean));
  } finally {
    await rm(matcher, { recursive: true, force: true });
  }
};

export const sourceArchive = async (
  cwd: string,
  commit: string,
  path: string,
) => {
  const entries = (await git(cwd, "ls-tree", "-r", "-z", commit))
    .split("\0")
    .filter(Boolean);
  const files: string[] = [];
  for (const entry of entries) {
    const match = /^(\d+) (blob|commit) ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (!match) throw new Error("Malformed Git tree entry");
    const [, mode, , , name] = match;
    if (name === undefined) throw new Error("Missing tree path");
    if (
      name.startsWith(".claude/") ||
      name.startsWith(".codex/") ||
      posix.basename(name) === ".npmrc"
    )
      continue;
    if (
      name.includes("/") &&
      !/^(?:\.agents|apps|packages|services|scripts|tests|architecture|process|foundations)\//.test(
        name,
      ) &&
      !name.startsWith("research/pr-bench/replay/modal/") &&
      !name.startsWith("validation/review-quality/") &&
      !name.startsWith("validation/external/neuve-effect/") &&
      !name.startsWith("validation/benchmarks/m4/labelling/dev/") &&
      name !== "design/neuve-web/design-export/tokens.css" &&
      name !==
        "validation/benchmarks/m4/results/harness-compare/sticky-leads/sol/spend.json" &&
      name !== "validation/benchmarks/m4/results/dev/score.dev.json"
    )
      continue;
    checkUploadPath(name);
    if (mode === "160000") {
      if (name !== "apps/neuve-graph")
        throw new Error(`Unrecognized submodule: ${name}`);
      continue;
    }
    if (mode !== "100644" && mode !== "100755" && mode !== "120000")
      throw new Error(`Unsupported file mode: ${name}`);
    if (mode === "120000") throw new Error(`Refusing upload link: ${name}`);
    if (
      posix.basename(name) === ".gitattributes" &&
      /export-(?:ignore|subst)/.test(
        await git(cwd, "show", `${commit}:${name}`),
      )
    )
      throw new Error(
        "Archive export attributes could change the submitted source",
      );
    files.push(name);
  }
  const hasExclusions = entries.some((entry) =>
    entry.endsWith("\tscripts/release/public-cut.exclude"),
  );
  const excluded = hasExclusions
    ? await publicCutExclusions(
        await git(cwd, "show", `${commit}:scripts/release/public-cut.exclude`),
        files,
      )
    : new Set<string>();
  const publicFiles = files.filter((name) => !excluded.has(name));
  if (publicFiles.length === 0) throw new Error("No tracked source to upload");
  await git(
    cwd,
    "archive",
    "--format=tar.gz",
    `--output=${path}`,
    commit,
    "--",
    ...publicFiles.map((name) => `:(literal)${name}`),
  );
  return publicFiles;
};

const counts = (text: string, name: string) =>
  [...text.matchAll(new RegExp(`^\\s*(\\d+) ${name}\\s*$`, "gm"))].reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );

const localPart = async (
  part: Part,
  directory: string,
  checkout: LocalCheckout,
): Promise<Result> => {
  const started = performance.now();
  checkout.signal.throwIfAborted();
  const child = Bun.spawn(part.command, {
    detached: true,
    cwd: resolve(source, part.cwd),
    env: {
      ...gitEnvironment(),
      HOME: process.env.HOME ?? "",
      TMPDIR: PI_TRANSITION_STORAGE_PROFILE.paths.tmp,
      NEUVE_MODE: "check",
      CI: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30 * 60 * 1000,
  });
  const release = checkout.track(child);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  release();
  checkout.signal.throwIfAborted();
  const log = stdout + stderr;
  await writeFile(join(directory, `${part.id}.log`), log, { mode: 0o600 });
  const result = {
    ...part,
    location: "local",
    exitCode,
    pass: counts(log, "pass"),
    fail: counts(log, "fail"),
    skip: counts(log, "skip"),
    seconds: (performance.now() - started) / 1000,
  } satisfies Result;
  if (result.pass === 0 && result.fail === 0) {
    result.pass = Number(exitCode === 0);
    result.fail = Number(exitCode !== 0);
  }
  console.log(
    `${part.id}: ${exitCode === 0 ? "PASS" : "FAIL"} (${result.pass} pass, ${result.fail} fail, ${result.skip} skip)`,
  );
  return result;
};

export const remoteReceiptPath = (directory: string, commit: string) =>
  join(directory, `${commit}.remote.json`);

/**
 * Reading a closed native source. SQLite on Linux opens a WAL file whose WAL is gone, and SQLite on
 * macOS refuses, so only these local runs show a read that depends on the WAL staying. The second
 * run collects early and often, because on Bun up to 1.4.3 collection is what removes the WAL.
 */
const CLOSED_SOURCE_TESTS = [
  "packages/harness/tests/pi/capture/own-connection.test.ts",
  "packages/harness/tests/run-folder-close.test.ts",
  "packages/harness/tests/pi/capture/closed-source.test.ts",
  "packages/harness/tests/pi/capture/archive-store-policy.test.ts",
  "packages/harness/tests/pi/capture/lifecycle.test.ts",
  "packages/harness/tests/pi/capture/recorded-inventory.test.ts",
  "packages/harness/tests/pi/providers/native-worker-capture.test.ts",
  "packages/channel/tests/paused-administration.test.ts",
  "apps/neuve-host/tests/native-source-lifecycle.test.ts",
  "apps/neuve-cli/tests/sidecarless-wal-readers.test.ts",
  "apps/neuve-cli/tests/sidecarless-wal-readers-archive.test.ts",
  "apps/neuve-cli/tests/capture-close-diagnostic-archive.test.ts",
  "packages/evaluation/tests/retrieval-bench-heldout-archive.test.ts",
  "packages/evaluation/tests/review-quality-archive.test.ts",
  "packages/evaluation/tests/external-validation-case-archive.test.ts",
  "packages/evaluation/tests/retrieval-bench-stage-archive.test.ts",
  "packages/evaluation/tests/retrieval-bench-cancel-archive.test.ts",
  "packages/evaluation/tests/harness-compare-run-folder-archive.test.ts",
];

const main = async () => {
  const [revision, ...extra] = Bun.argv.slice(2);
  if (!revision || extra.length)
    throw new Error("Usage: bun run check:remote <commit>");
  if (process.platform !== "darwin")
    throw new Error("Run the coordinator on macOS for its local parts");
  const runnerCommit = await checkedCommit(source, "HEAD");
  const commit = await resolveCommit(source, revision);
  const lockSha256 = digest(await git(source, "show", `${commit}:bun.lock`));
  if (lockSha256 !== digest(await readFile(join(source, "bun.lock"))))
    throw new Error(
      "The target lockfile differs; install its dependencies in a checkout of that commit before checking it",
    );
  for (const [path, hash] of Object.entries(adapters))
    if (digest(await git(source, "show", `${commit}:${path}`)) !== hash)
      throw new Error(
        `Reconcile the remote adapter with ${path} before running`,
      );
  if (Bun.version !== "1.4.4")
    throw new Error("The check requires Bun 1.4.4 locally and remotely");
  const common = (
    await git(source, "rev-parse", "--path-format=absolute", "--git-common-dir")
  ).trim();
  const receipts = receiptDirectory(common);
  const startedAt = new Date().toISOString();
  const directory = join(
    receipts,
    "remote-runs",
    commit,
    startedAt.replaceAll(":", "-"),
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(PI_TRANSITION_STORAGE_PROFILE.paths.tmp, { recursive: true });
  const scratch = await mkdtemp(
    join(PI_TRANSITION_STORAGE_PROFILE.paths.tmp, "remote-check-"),
  );
  const archive = join(scratch, "source.tar.gz");
  try {
    const sourceFiles = await sourceArchive(source, commit, archive);
    await writeFile(
      join(directory, "source-files.json"),
      JSON.stringify(sourceFiles, null, 2),
    );
    const sourceSha256 = digest(await readFile(archive));
    const plan = await remotePlan(source, commit);
    await writeFile(
      join(directory, "plan.json"),
      JSON.stringify(plan, null, 2),
    );
    console.log(`Checking ${commit}; logs: ${directory}`);
    const python = Bun.spawn(
      [
        "uv",
        "run",
        "--project",
        join(source, "scripts/remote-check"),
        "python",
        join(source, "scripts/remote-check/run_modal.py"),
        archive,
        join(directory, "plan.json"),
        directory,
        join(source, "scripts/remote-check/build-types.ts"),
        join(source, "scripts/remote-check/check-ace.ts"),
      ],
      { cwd: source, stdout: "inherit", stderr: "inherit" },
    );
    const transportCode = await python.exited;
    const remote = await readFile(join(directory, "remote.json"), "utf8")
      .then((text) => z.array(Result).parse(JSON.parse(text)))
      .catch((error: unknown) =>
        plan.map((part) =>
          Result.parse({
            ...part,
            location: "modal",
            exitCode: 1,
            pass: 0,
            fail: 1,
            error: String(error),
          }),
        ),
      );
    if (
      remote.length !== plan.length ||
      remote.some((result, index) => result.id !== plan[index]?.id)
    )
      throw new Error("Remote results do not match the complete plan");
    const local: Result[] = [];
    const targetFiles = new Set(
      (await git(source, "ls-tree", "-r", "--name-only", "-z", commit)).split(
        "\0",
      ),
    );
    const closedSourceTests = CLOSED_SOURCE_TESTS.filter((path) =>
      targetFiles.has(path),
    );
    const localPlan: Part[] = [
      graphLocalPart,
      {
        id: "local-build-types",
        cwd: ".",
        command: [process.execPath, "--no-env-file", "run", "build:ace-types"],
      },
      {
        id: "test-ace-host",
        cwd: "apps/neuve-host",
        command: [process.execPath, "--no-env-file", "run", "test"],
      },
      {
        id: "local-storage",
        cwd: ".",
        command: [
          process.execPath,
          "--no-env-file",
          join(source, "scripts/test-budget.ts"),
          "tests/pi-storage.test.ts",
          "tests/preparation-macos.test.ts",
          "tests/ace-compiler-boundary.test.ts",
        ],
      },
      {
        id: "local-records-permissions",
        cwd: "packages/records-core",
        command: [
          process.execPath,
          "--no-env-file",
          join(source, "scripts/test-budget.ts"),
          "tests/gate.test.ts",
          "tests/retention.test.ts",
        ],
      },
      {
        id: "local-closed-source",
        cwd: ".",
        command: [
          process.execPath,
          "--no-env-file",
          join(source, "scripts/test-budget.ts"),
          ...closedSourceTests,
        ],
      },
      {
        id: "local-closed-source-collected",
        cwd: ".",
        command: [
          process.execPath,
          "--no-env-file",
          join(source, "scripts/test-budget.ts"),
          "--preload",
          "./scripts/force-gc-preload.ts",
          ...closedSourceTests,
        ],
      },
      {
        id: "local-web-settings",
        cwd: "apps/neuve-web/apps/web",
        command: [
          process.execPath,
          "--no-env-file",
          join(source, "scripts/test-budget.ts"),
          "src/server/review-request.test.ts",
        ],
      },
      {
        id: "local-historical-source",
        cwd: "packages/evaluation",
        command: [
          process.execPath,
          "--no-env-file",
          join(source, "scripts/test-budget.ts"),
          targetFiles.has(
            "packages/evaluation/tests/harness-compare-full-test-archive.test.ts",
          )
            ? "tests/harness-compare-full-test-archive.test.ts"
            : "tests/harness-compare-full-test.test.ts",
          "--test-name-pattern",
          "^the committed harness holds every snapshot marker the seam path needs$",
        ],
      },
      {
        id: "local-cli-process-env",
        cwd: "apps/neuve-cli",
        command: [
          process.execPath,
          "--no-env-file",
          join(source, "scripts/test-budget.ts"),
          "tests/review-worker.test.ts",
          "--test-name-pattern",
          "^the worker this build starts loads neither",
        ],
      },
      {
        id: "check-installed",
        cwd: ".",
        command: [process.execPath, "--no-env-file", "run", "check:installed"],
      },
    ];
    const outcome = await withPinnedLocalCheckout(
      source,
      commit,
      runnerCommit,
      async (checkout) => {
        for (const part of localPlan)
          local.push(await localPart(part, directory, checkout));
        return checkout.check().then(
          () => true,
          () => false,
        );
      },
    ).catch((error: unknown) => {
      for (const part of localPlan.slice(local.length))
        local.push(
          Result.parse({
            ...part,
            location: "local",
            exitCode: 1,
            pass: 0,
            fail: 1,
            error: String(error),
          }),
        );
      return { value: false, restorationError: String(error) };
    });
    const unchanged = outcome.value;
    const restorationError = outcome.restorationError;
    const parts = [...remote, ...local];
    const checksPassed =
      unchanged &&
      transportCode === 0 &&
      parts.every((part) => part.exitCode === 0);
    const passed = checksPassed && restorationError === null;
    const receipt = {
      version: 1,
      kind: "remote",
      installEligible: false,
      commit,
      runnerCommit,
      restorationError,
      checksPassed,
      startedAt,
      finishedAt: new Date().toISOString(),
      passed,
      unchanged,
      bunVersion: Bun.version,
      lockSha256,
      sourceSha256,
      uploadedFiles: sourceFiles.length,
      excludedPaths: [
        ".claude/**",
        ".codex/**",
        "**/.npmrc",
        "apps/neuve-graph (submodule)",
        "design, research data and validation evidence; only the test fixtures listed in source-files.json are sent",
      ],
      adapters,
      image: await readFile(join(directory, "image.json"), "utf8").then(
        (text) => JSON.parse(text),
        () => ({ error: "Image did not build" }),
      ),
      parts,
      logs: directory,
    };
    const destination = remoteReceiptPath(receipts, commit);
    await writeFile(
      `${destination}.tmp-${process.pid}`,
      JSON.stringify(receipt, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(`${destination}.tmp-${process.pid}`, destination);
    console.log(
      `Overall: ${passed ? "PASS" : "FAIL"} (${parts.filter((part) => part.exitCode === 0).length} parts passed, ${parts.filter((part) => part.exitCode !== 0).length} failed); remote receipt: ${destination}`,
    );
    return passed ? 0 : 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
