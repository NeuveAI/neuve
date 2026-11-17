import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export class GitReadRefusal extends Error {
  constructor(
    readonly reason:
      | "unsupported-config"
      | "unsupported-store"
      | "executable-unavailable"
      | "source-moved"
      | "unsupported-suppression"
      | "command"
      | "cancelled"
      | "observer",
    readonly detail: string,
    readonly observerFailures: readonly unknown[] = [],
    readonly cleanupFailures: readonly unknown[] = [],
    cause?: unknown,
  ) {
    super(
      `Local Git read refused (${reason}: ${detail})`,
      cause === undefined ? undefined : { cause },
    );
    this.observerFailures = Object.freeze([...observerFailures]);
    this.cleanupFailures = Object.freeze([...cleanupFailures]);
    this.name = "GitReadRefusal";
  }
}
export type RecognizedNonBlobGitEntry = Readonly<{
  commit: string;
  path: string;
  oid: string;
}> &
  (
    | Readonly<{ mode: "160000"; type: "commit" }>
    | Readonly<{ mode: "040000"; type: "tree" }>
  );
export class GitReadNonBlobEntry extends GitReadRefusal {
  readonly entry: RecognizedNonBlobGitEntry;
  constructor(entry: RecognizedNonBlobGitEntry) {
    super("command", "source-entry-nonregular");
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.commit) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry.oid) ||
      entry.oid.length !== entry.commit.length ||
      entry.path.length === 0 ||
      isAbsolute(entry.path) ||
      entry.path.includes("\0") ||
      entry.path
        .split("/")
        .some((part) => part === "" || part === "." || part === "..") ||
      !(
        (entry.mode === "160000" && entry.type === "commit") ||
        (entry.mode === "040000" && entry.type === "tree")
      )
    )
      throw new GitReadRefusal("command", "source-entry-shape");
    this.name = "GitReadNonBlobEntry";
    this.entry = Object.freeze({ ...entry });
    Object.freeze(this);
  }
}
export type PhysicalGitScope = Readonly<{
  repository: string;
  workdir: string;
  gitDirectory: string;
  gitCommonDirectory: string;
}>;
type MetadataFile = Readonly<{ path: string; sha256: string | null }>;
export type GitReadPreflight = Readonly<{
  kind: "preflight";
  scope: PhysicalGitScope;
  objectFormat: "sha1" | "sha256";
  partialClone: boolean;
  executable: Readonly<{ path: string; sha256: string }>;
  invocationPath: string;
  inspection: Readonly<{
    entries: number;
    pathBytes: number;
    metadataBytes: number;
    executableBytes: number;
    elapsedMilliseconds: number;
  }>;
  configurationSha256: string;
  configurationFiles: readonly MetadataFile[];
  commandPrefix: readonly string[];
  environment: Readonly<Record<string, string>>;
}>;
export type QualifiedGitRead = Readonly<
  Omit<GitReadPreflight, "kind"> & {
    kind: "qualified";
    assessment: GitReadAssessment;
    gitVersion: string;
    suppression: GitReadPolicy["suppression"];
  }
>;
export type GitReadReceipt = Readonly<{
  command: GitReadCommand;
  argv: readonly string[];
  cwd: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}>;
export type GitReadObservation = Readonly<{
  argv: readonly string[];
  cwd: string;
  command: GitReadCommand["kind"];
  pid: number | null;
  termination:
    | Readonly<{ kind: "exit"; code: number }>
    | Readonly<{ kind: "signal"; signal: string }>
    | Readonly<{ kind: "unavailable" }>;
  stdout: Readonly<{
    complete: boolean;
    byteLength: number;
    sha256: string;
    retainedByteLength: number;
    retainedSha256: string;
  }> | null;
  stderr: Readonly<{
    complete: boolean;
    byteLength: number;
    sha256: string;
    retainedByteLength: number;
    retainedSha256: string;
  }> | null;
  refusal: string | null;
}>;
export type GitReadRun = Readonly<{
  signal?: AbortSignal;
  onCommand?: (receipt: GitReadReceipt) => void;
  onObservation?: (observation: GitReadObservation) => void;
}>;
export type GitReadCommand =
  | Readonly<{ kind: "version"; probeNoLazyFetch?: boolean }>
  | Readonly<{
      kind: "owner";
      field:
        | "--show-toplevel"
        | "--git-common-dir"
        | "--absolute-git-dir"
        | "--show-object-format=storage"
        | "--show-prefix";
    }>
  | Readonly<{ kind: "resolve-head" }>
  | Readonly<{ kind: "head-ref" }>
  | Readonly<{ kind: "resolve-local-ref"; ref: string }>
  | Readonly<{
      kind:
        | "object-type"
        | "object-size"
        | "commit-body"
        | "tree-body"
        | "blob-body";
      oid: string;
    }>
  | Readonly<{ kind: "source-entry"; oid: string; path: string }>
  | Readonly<{ kind: "exact-commit" | "exact-tree"; oid: string }>;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const checkAbort = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new GitReadRefusal("cancelled", "signal");
};
const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const optionalStat = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
};
const regularBytes = async (
  path: string,
  maximum: number,
): Promise<Uint8Array | null> => {
  const stat = await optionalStat(path);
  if (!stat) return null;
  if (!stat.isFile() || stat.size > maximum)
    throw new GitReadRefusal("unsupported-store", "metadata-shape");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let failure: { cause: unknown } | undefined;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size > maximum ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino
    )
      throw new GitReadRefusal("source-moved", "metadata-handle");
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const part = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (part.bytesRead === 0) break;
      offset += part.bytesRead;
    }
    const extra = Buffer.alloc(1);
    const tail = await handle.read(extra, 0, 1, offset);
    const after = await handle.stat();
    if (
      offset !== opened.size ||
      tail.bytesRead !== 0 ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new GitReadRefusal("source-moved", "metadata-read");
    return bytes;
  } catch (cause) {
    failure = { cause };
    throw cause;
  } finally {
    try {
      await handle.close();
    } catch (cause) {
      if (failure?.cause instanceof GitReadRefusal)
        throw new GitReadRefusal(
          failure.cause.reason,
          failure.cause.detail,
          failure.cause.observerFailures,
          [...failure.cause.cleanupFailures, cause],
          failure.cause.cause,
        );
      throw new GitReadRefusal(
        "command",
        failure === undefined ? "cleanup" : "filesystem-preflight",
        [],
        [cause],
        failure === undefined ? cause : failure.cause,
      );
    }
  }
};
const regularDigest = async (path: string): Promise<string> => {
  const before = await lstat(path);
  if (!before.isFile() || !Number.isSafeInteger(before.size))
    throw new GitReadRefusal("executable-unavailable", "executable-shape");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let failure: { cause: unknown } | undefined;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      throw new GitReadRefusal("source-moved", "executable-handle");
    const hash = createHash("sha256"),
      bytes = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const part = await handle.read(
        bytes,
        0,
        Math.min(bytes.byteLength, opened.size - offset),
        offset,
      );
      if (part.bytesRead === 0)
        throw new GitReadRefusal("source-moved", "executable-read");
      hash.update(bytes.subarray(0, part.bytesRead));
      offset += part.bytesRead;
    }
    const after = await handle.stat();
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new GitReadRefusal("source-moved", "executable-read");
    return hash.digest("hex");
  } catch (cause) {
    failure = { cause };
    throw cause;
  } finally {
    try {
      await handle.close();
    } catch (cause) {
      if (failure?.cause instanceof GitReadRefusal)
        throw new GitReadRefusal(
          failure.cause.reason,
          failure.cause.detail,
          failure.cause.observerFailures,
          [...failure.cause.cleanupFailures, cause],
          failure.cause.cause,
        );
      throw new GitReadRefusal(
        "command",
        failure === undefined ? "cleanup" : "filesystem-preflight",
        [],
        [cause],
        failure === undefined ? cause : failure.cause,
      );
    }
  }
};
const text = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new GitReadRefusal("unsupported-config", "encoding");
  }
};
const unquote = (raw: string): string => {
  raw = raw.trim();
  let value = "",
    whitespace = "",
    quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") {
      const next = raw[++i];
      value += whitespace;
      whitespace = "";
      if (next === "n") value += "\n";
      else if (next === "t") value += "\t";
      else if (next === "b") value += "\b";
      else if (next === "\\" || next === '"') value += next;
      else throw new GitReadRefusal("unsupported-config", "escape");
    } else if (c === '"') {
      value += whitespace;
      whitespace = "";
      quoted = !quoted;
    } else if (!quoted && (c === "#" || c === ";")) break;
    else if (!quoted && /[ \t]/.test(c ?? "")) whitespace += c;
    else {
      value += whitespace + c;
      whitespace = "";
    }
  }
  if (quoted) throw new GitReadRefusal("unsupported-config", "quote");
  return value;
};
const logicalConfigLines = (source: string): string[] => {
  const lines: string[] = [];
  let logical = "",
    quoted = false;
  const physicalLines = source.split("\n");
  for (let offset = 0; offset < physicalLines.length; offset++) {
    const physical = (physicalLines[offset] ?? "").replace(/\r$/, "");
    let end = physical.length,
      continued = false;
    for (let i = 0; i < physical.length; i++) {
      const c = physical[i];
      if (c === "\\") {
        if (i + 1 === physical.length) {
          end = i;
          continued = true;
          break;
        }
        i++;
      } else if (c === '"') quoted = !quoted;
      else if (!quoted && (c === "#" || c === ";")) {
        end = i;
        break;
      }
    }
    logical += physical.slice(0, end);
    if (continued) {
      if (offset + 1 === physicalLines.length)
        throw new GitReadRefusal("unsupported-config", "continuation");
    } else {
      if (quoted) throw new GitReadRefusal("unsupported-config", "quote");
      lines.push(logical);
      logical = "";
    }
  }
  if (logical || quoted)
    throw new GitReadRefusal("unsupported-config", "continuation");
  return lines;
};
const parseConfig = (
  bytes: Uint8Array | null,
): ReadonlyMap<string, readonly string[]> => {
  const values = new Map<string, string[]>();
  if (!bytes) return values;
  const source = text(bytes).replace(/^\uFEFF/, "");
  if (source.includes("\0"))
    throw new GitReadRefusal("unsupported-config", "nul");
  let section = "";
  for (const logical of logicalConfigLines(source)) {
    const line = logical.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith("[")) {
      const match =
        /^\[([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\["\\])*)")?\]\s*(?:[#;].*)?$/.exec(
          line,
        );
      if (!match?.[1])
        throw new GitReadRefusal("unsupported-config", "section");
      section =
        match[1].toLowerCase() +
        (match[2] === undefined ? "" : "." + unquote('"' + match[2] + '"'));
      if (
        section === "include" ||
        section.startsWith("include.") ||
        section === "includeif" ||
        section.startsWith("includeif.")
      )
        throw new GitReadRefusal("unsupported-config", "include");
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9-]*)(?:\s*=\s*(.*))?$/.exec(line);
    if (!section || !match?.[1])
      throw new GitReadRefusal("unsupported-config", "assignment");
    const key = `${section}.${match[1].toLowerCase()}`;
    const value = match[2] === undefined ? "true" : unquote(match[2]);
    const prior = values.get(key) ?? [];
    values.set(key, [...prior, value]);
  }
  return values;
};
const boolean = (value: string) => {
  if (["true", "yes", "on", "1"].includes(value.toLowerCase())) return true;
  if (["false", "no", "off", "0", ""].includes(value.toLowerCase()))
    return false;
  // Git's git_parse_maybe_bool uses a signed int, base 0, with k/m/g suffixes.
  const match =
    /^[\t\n\v\f\r ]*([+-]?)(0x[\da-f]+|0[0-7]*|[1-9]\d*)([kmg]?)$/i.exec(value);
  if (match?.[0] === value) {
    const digits = match[2] ?? "";
    const radix = /^0x/i.test(digits) ? 16 : digits.startsWith("0") ? 8 : 10;
    const suffix = (match[3] ?? "").toLowerCase();
    const factor = suffix === "" ? 1 : 1024 ** ("kmg".indexOf(suffix) + 1);
    const number =
      Number.parseInt(digits, radix) * factor * (match[1] === "-" ? -1 : 1);
    if (
      Number.isInteger(number) &&
      number >= -2147483648 &&
      number <= 2147483647
    )
      return number !== 0;
  }
  throw new GitReadRefusal("unsupported-config", "boolean");
};
const last = (config: ReadonlyMap<string, readonly string[]>, key: string) =>
  config.get(key)?.at(-1);
const qualifyConfig = (config: ReadonlyMap<string, readonly string[]>) => {
  for (const [key] of config) {
    if (
      key.startsWith("extensions.") &&
      ![
        "extensions.objectformat",
        "extensions.refstorage",
        "extensions.worktreeconfig",
        "extensions.partialclone",
      ].includes(key)
    )
      throw new GitReadRefusal("unsupported-config", "extension");
  }
  const version = last(config, "core.repositoryformatversion") ?? "0";
  if (!/^[01]$/.test(version))
    throw new GitReadRefusal("unsupported-config", "repository-format");
  const format = last(config, "extensions.objectformat") ?? "sha1";
  if (format !== "sha1" && format !== "sha256")
    throw new GitReadRefusal("unsupported-config", "object-format");
  const refs = last(config, "extensions.refstorage") ?? "files";
  if (refs !== "files" && refs !== "reftable")
    throw new GitReadRefusal("unsupported-config", "ref-storage");
  return format;
};
const orderedPointer = async (base: string, value: string) => {
  if (!value || /[\0\r\n]/.test(value))
    throw new GitReadRefusal("unsupported-store", "pointer");
  let current = isAbsolute(value) ? sep : base;
  for (const part of value.split(sep)) {
    if (!part || part === ".") continue;
    current =
      part === ".." ? dirname(current) : await realpath(join(current, part));
  }
  return realpath(current);
};
const structuralStore = async (
  roots: readonly string[],
  signal?: AbortSignal,
) => {
  const pending = [...roots];
  let entries = 0,
    pathBytes = 0,
    partialClone = false;
  while (pending.length) {
    checkAbort(signal);
    const directory = pending.pop();
    if (directory === undefined) break;
    const before = await lstat(directory);
    if (!before.isDirectory())
      throw new GitReadRefusal("unsupported-store", "directory-moved");
    const handle = await opendir(directory);
    for await (const entry of handle) {
      checkAbort(signal);
      const path = join(directory, entry.name);
      entries++;
      pathBytes += Buffer.byteLength(path);
      if (entries > 2_000_000 || pathBytes > 256 * 1024 * 1024)
        throw new GitReadRefusal("unsupported-store", "structural-bound");
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new GitReadRefusal(
          "unsupported-store",
          "redirect-or-special-file",
        );
      if (entry.name.endsWith(".promisor")) partialClone = true;
      if (stat.isDirectory()) pending.push(path);
    }
    const after = await lstat(directory);
    if (
      !after.isDirectory() ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    )
      throw new GitReadRefusal("source-moved", "directory-handle");
  }
  return { entries, pathBytes, partialClone };
};
const admittedQualifications = new WeakSet<object>();
const retainQualification = <T extends GitReadPreflight | QualifiedGitRead>(
  git: T,
): T => {
  Object.freeze(git.scope);
  Object.freeze(git.executable);
  Object.freeze(git.inspection);
  for (const file of git.configurationFiles) Object.freeze(file);
  Object.freeze(git.configurationFiles);
  Object.freeze(git.commandPrefix);
  Object.freeze(git.environment);
  admittedQualifications.add(git);
  return Object.freeze(git);
};
export const isolatedGitReadEnvironment = (
  executablePath: string,
  workdir: string,
  supplied?: NodeJS.ProcessEnv,
) => {
  const environment = Object.fromEntries(
    Object.entries(supplied ?? process.env).filter(
      (entry): entry is [string, string] =>
        !entry[0].toUpperCase().startsWith("GIT_") && entry[1] !== undefined,
    ),
  );
  // Explicit isolated object stores are used by the harness's attribute reader.
  for (const key of [
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    if (supplied?.[key] !== undefined) environment[key] = supplied[key];
  Object.assign(environment, {
    PATH: dirname(executablePath),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
    LANG: "C",
    PWD: workdir,
  });
  const pins = [
    ["core.fsmonitor", "false"],
    ["log.showSignature", "false"],
    ["core.excludesFile", ""],
    ["core.attributesFile", ""],
    ["submodule.recurse", "false"],
    ["log.mailmap", "false"],
    ["diff.orderFile", "/dev/null"],
  ];
  environment.GIT_CONFIG_COUNT = String(pins.length);
  pins.forEach(([key, value], i) => {
    if (key !== undefined && value !== undefined) {
      environment[`GIT_CONFIG_KEY_${i}`] = key;
      environment[`GIT_CONFIG_VALUE_${i}`] = value;
    }
  });
  return environment;
};

export const preflightLocalGitRead = async (
  input: Readonly<{
    repository: string;
    workdir?: string;
    expectedPhysicalScope?: PhysicalGitScope;
    signal?: AbortSignal;
  }>,
): Promise<GitReadPreflight> => {
  checkAbort(input.signal);
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new GitReadRefusal("unsupported-store", "platform");
  const started = performance.now();
  let metadataBytes = 0;
  try {
    const workdir = await realpath(input.workdir ?? input.repository);
    let repository = await realpath(input.repository);
    if (
      input.workdir === undefined &&
      input.expectedPhysicalScope === undefined
    ) {
      while (!(await optionalStat(join(repository, ".git")))) {
        const parent = dirname(repository);
        if (parent === repository)
          throw new GitReadRefusal("unsupported-store", "git-marker");
        repository = parent;
      }
    }
    const prefix = relative(repository, workdir);
    if (prefix === ".." || prefix.startsWith(`..${sep}`) || isAbsolute(prefix))
      throw new GitReadRefusal("source-moved", "workdir");
    const marker = join(repository, ".git"),
      markerStat = await optionalStat(marker);
    if (!markerStat || markerStat.isSymbolicLink())
      throw new GitReadRefusal("unsupported-store", "git-marker");
    const files: MetadataFile[] = [];
    const metadata = async (path: string) => {
      const bytes = await regularBytes(path, 16 * 1024 * 1024);
      metadataBytes += bytes?.byteLength ?? 0;
      files.push({ path, sha256: bytes === null ? null : digest(bytes) });
      return bytes;
    };
    let gitDirectory: string;
    if (markerStat.isDirectory()) gitDirectory = await realpath(marker);
    else {
      const bytes = await metadata(marker);
      const pointer = bytes === null ? "" : text(bytes);
      if (!/^gitdir: [^\0\r\n]+\r?\n?$/.test(pointer))
        throw new GitReadRefusal("unsupported-store", "gitfile");
      gitDirectory = await orderedPointer(
        repository,
        pointer.replace(/^gitdir: /, "").replace(/\r?\n$/, ""),
      );
    }
    const commonBytes = await metadata(join(gitDirectory, "commondir"));
    const gitCommonDirectory =
      commonBytes === null
        ? gitDirectory
        : await orderedPointer(
            gitDirectory,
            text(commonBytes).replace(/\r?\n$/, ""),
          );
    const scope = { repository, workdir, gitDirectory, gitCommonDirectory };
    if (
      input.expectedPhysicalScope &&
      JSON.stringify(scope) !==
        JSON.stringify({
          repository: input.expectedPhysicalScope.repository,
          workdir: input.expectedPhysicalScope.workdir,
          gitDirectory: input.expectedPhysicalScope.gitDirectory,
          gitCommonDirectory: input.expectedPhysicalScope.gitCommonDirectory,
        })
    )
      throw new GitReadRefusal("source-moved", "physical-scope");
    if (await optionalStat(join(gitCommonDirectory, "objects/info/alternates")))
      throw new GitReadRefusal("unsupported-store", "alternates");
    const config = parseConfig(
      await metadata(join(gitCommonDirectory, "config")),
    );
    const format = qualifyConfig(config);
    const perWorktreeConfiguration = boolean(
      last(config, "extensions.worktreeconfig") ?? "false",
    );
    const worktreeConfig = perWorktreeConfiguration
      ? parseConfig(await metadata(join(gitDirectory, "config.worktree")))
      : new Map<string, string[]>();
    qualifyConfig(worktreeConfig);
    const mainWorktreeOnly =
      gitDirectory !== gitCommonDirectory && !perWorktreeConfiguration;
    const bare =
      last(worktreeConfig, "core.bare") ??
      (mainWorktreeOnly ? undefined : last(config, "core.bare"));
    if (boolean(bare ?? "false"))
      throw new GitReadRefusal("unsupported-store", "bare");
    const configuredWorktree =
      last(worktreeConfig, "core.worktree") ??
      (mainWorktreeOnly ? undefined : last(config, "core.worktree"));
    if (
      configuredWorktree !== undefined &&
      (await orderedPointer(gitDirectory, configuredWorktree)) !== repository
    )
      throw new GitReadRefusal("source-moved", "configured-worktree");
    await metadata(join(gitCommonDirectory, "info/grafts"));
    await metadata(join(gitCommonDirectory, "shallow"));
    const structural = await structuralStore(
      gitDirectory === gitCommonDirectory
        ? [gitCommonDirectory]
        : [gitCommonDirectory, gitDirectory],
      input.signal,
    );
    const selected = Bun.which("git", { PATH: process.env.PATH ?? "" });
    if (!selected || !isAbsolute(selected) || basename(selected) !== "git")
      throw new GitReadRefusal("executable-unavailable", "git");
    const executablePath = await realpath(selected);
    if (basename(executablePath) !== "git")
      throw new GitReadRefusal("executable-unavailable", "canonical-git-name");
    await access(executablePath, constants.X_OK);
    const executableSha256 = await regularDigest(executablePath);
    if ((await realpath(join(dirname(selected), "git"))) !== executablePath)
      throw new GitReadRefusal("executable-unavailable", "git-image");
    const environment = isolatedGitReadEnvironment(executablePath, workdir);
    files.sort((a, b) => a.path.localeCompare(b.path));
    const configurationSha256 = digest(
      Buffer.from(
        JSON.stringify({
          scope,
          objectFormat: format,
          files,
          guards: "local-git-read-v1",
        }),
      ),
    );
    return retainQualification({
      kind: "preflight",
      scope,
      objectFormat: format,
      partialClone:
        isPartialClone(config) ||
        isPartialClone(worktreeConfig) ||
        structural.partialClone,
      executable: { path: executablePath, sha256: executableSha256 },
      invocationPath: selected,
      inspection: {
        ...structural,
        metadataBytes,
        executableBytes: (await lstat(executablePath)).size,
        elapsedMilliseconds: performance.now() - started,
      },
      configurationSha256,
      configurationFiles: files,
      commandPrefix: [
        "--no-replace-objects",
        "--no-optional-locks",
        "--no-pager",
      ],
      environment,
    });
  } catch (error) {
    if (error instanceof GitReadRefusal) throw error;
    throw new GitReadRefusal(
      input.signal?.aborted ? "cancelled" : "command",
      "filesystem-preflight",
      [],
      [],
      error,
    );
  }
};
const argsFor = (command: GitReadCommand): readonly string[] => {
  switch (command.kind) {
    case "version":
      return command.probeNoLazyFetch
        ? ["--no-lazy-fetch", "version"]
        : ["version"];
    case "owner":
      return ["rev-parse", "--path-format=absolute", command.field];
    case "resolve-head":
      return ["rev-parse", "--verify", "HEAD^{commit}"];
    case "head-ref":
      return ["symbolic-ref", "--quiet", "HEAD"];
    case "resolve-local-ref": {
      const ref = command.ref;
      if (
        !ref.startsWith("refs/heads/") ||
        ref.length > 4096 ||
        ref.endsWith(".") ||
        ref.includes("..") ||
        ref.includes("@{") ||
        /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) ||
        ref
          .split("/")
          .some(
            (part) =>
              part.length === 0 ||
              part.startsWith(".") ||
              part.endsWith(".lock"),
          )
      )
        throw new GitReadRefusal("command", "local-ref-shape");
      return ["show-ref", "--verify", "--hash", ref];
    }
    case "object-type":
      return ["cat-file", "-t", command.oid];
    case "object-size":
      return ["cat-file", "-s", command.oid];
    case "commit-body":
      return ["cat-file", "commit", command.oid];
    case "tree-body":
      return ["cat-file", "tree", command.oid];
    case "blob-body":
      return ["cat-file", "blob", command.oid];
    case "source-entry":
      return [
        "--literal-pathspecs",
        "ls-tree",
        "-z",
        "--full-tree",
        command.oid,
        "--",
        command.path,
      ];
    case "exact-commit":
      return ["rev-parse", "--verify", `${command.oid}^{commit}`];
    case "exact-tree":
      return ["rev-parse", "--verify", `${command.oid}^{tree}`];
  }
};
export const runQualifiedGit = async (
  git: GitReadPreflight | QualifiedGitRead,
  command: GitReadCommand,
  run: GitReadRun = {},
  maximumBytes = 16 * 1024 * 1024,
): Promise<{ bytes: Uint8Array; stderr: string; exitCode: number }> => {
  checkAbort(run.signal);
  if (!admittedQualifications.has(git))
    throw new GitReadRefusal(
      "unsupported-suppression",
      "unretained-qualification",
    );
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new GitReadRefusal("command", "output-bound-input");
  if (git.kind !== "qualified" && command.kind !== "version")
    throw new GitReadRefusal("unsupported-suppression", "unqualified-command");
  if (
    "oid" in command &&
    !(git.objectFormat === "sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(
      command.oid,
    )
  )
    throw new GitReadRefusal("command", "exact-oid");
  if (
    command.kind === "source-entry" &&
    (!command.path ||
      isAbsolute(command.path) ||
      command.path.includes("\0") ||
      command.path
        .split("/")
        .some((part) => !part || part === "." || part === ".."))
  )
    throw new GitReadRefusal("command", "root-relative-path");
  await recheckLocalGitRead(git, run);
  checkAbort(run.signal);
  const argv = [
    git.executable.path,
    ...git.commandPrefix,
    "-C",
    git.scope.workdir,
    ...argsFor(command),
  ];
  const observerFailures: unknown[] = [],
    cleanupFailures: unknown[] = [];
  const notify = (action: () => void) => {
    try {
      action();
    } catch (cause) {
      observerFailures.push(cause);
    }
  };
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(argv, {
      cwd: git.scope.workdir,
      env: { ...git.environment },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (cause) {
    notify(() =>
      run.onObservation?.({
        argv,
        cwd: git.scope.workdir,
        command: command.kind,
        pid: null,
        termination: { kind: "unavailable" },
        stdout: null,
        stderr: null,
        refusal: "launch-error",
      }),
    );
    throw new GitReadRefusal(
      "executable-unavailable",
      "launch",
      observerFailures,
      cleanupFailures,
      cause,
    );
  }
  let refusal: GitReadRefusal | undefined,
    retired = false,
    finished = false;
  const laterRefusals: GitReadRefusal[] = [];
  const failureCause = (
    primary: GitReadRefusal,
    additional: readonly GitReadRefusal[] = [],
    message = "Local Git read failures",
  ) => {
    const causes = [
      ...(refusal !== undefined && refusal !== primary ? [refusal] : []),
      ...laterRefusals,
      ...additional,
    ];
    return causes.length === 0
      ? primary.cause
      : new AggregateError(
          primary.cause === undefined ? causes : [primary.cause, ...causes],
          message,
        );
  };
  let retirementDeadline: ReturnType<typeof setTimeout> | undefined;
  let stopWaiting: (() => void) | undefined;
  const unavailable = new Promise<{ kind: "unavailable" }>((resolve) => {
    stopWaiting = () => resolve({ kind: "unavailable" });
  });
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const cancellations = new Map<
    ReadableStreamDefaultReader<Uint8Array>,
    Promise<void>
  >();
  const pendingCancellations = new Set<Promise<void>>();
  const cleanupFailure = (cause: unknown) => {
    if (!finished) cleanupFailures.push(cause);
  };
  const cancelReader = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const existing = cancellations.get(reader);
    if (existing) return existing;
    let cancellation: Promise<void>;
    try {
      cancellation = reader.cancel().then(
        () => {
          pendingCancellations.delete(cancellation);
        },
        (cause: unknown) => {
          cleanupFailure(cause);
          pendingCancellations.delete(cancellation);
        },
      );
      pendingCancellations.add(cancellation);
    } catch (cause) {
      cleanupFailure(cause);
      cancellation = Promise.resolve();
    }
    cancellations.set(reader, cancellation);
    return cancellation;
  };
  const retire = (reason: GitReadRefusal) => {
    if (finished) return;
    if (refusal === undefined) refusal = reason;
    else laterRefusals.push(reason);
    if (retired) return;
    retired = true;
    try {
      child.kill("SIGKILL");
    } catch (cause) {
      cleanupFailure(cause);
    }
    for (const reader of readers) cancelReader(reader);
    retirementDeadline = setTimeout(() => stopWaiting?.(), 10000);
  };
  const abort = () => retire(new GitReadRefusal("cancelled", "signal"));
  run.signal?.addEventListener("abort", abort, { once: true });
  if (run.signal?.aborted) abort();
  const deadline = setTimeout(
    () => retire(new GitReadRefusal("command", "read-deadline")),
    10000,
  );
  const bounded = async (
    stream: ReadableStream<Uint8Array>,
    maximum: number,
  ) => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const chunks: Uint8Array[] = [],
      observedHash = createHash("sha256");
    let length = 0,
      observedLength = 0,
      complete = false;
    try {
      reader = stream.getReader();
      readers.add(reader);
      if (retired) await cancelReader(reader);
      else
        while (true) {
          const item = await reader.read();
          if (item.done) {
            complete = refusal === undefined;
            break;
          }
          observedLength += item.value.byteLength;
          observedHash.update(item.value);
          if (
            !Number.isSafeInteger(observedLength) ||
            length + item.value.byteLength > maximum
          ) {
            retire(new GitReadRefusal("command", "output-bound"));
            break;
          }
          length += item.value.byteLength;
          chunks.push(item.value);
        }
    } catch (cause) {
      retire(new GitReadRefusal("command", "stream", [], [], cause));
    } finally {
      if (reader !== undefined) {
        const cancellation = cancellations.get(reader);
        if (cancellation !== undefined) await cancellation;
        readers.delete(reader);
        try {
          reader.releaseLock();
        } catch (cause) {
          cleanupFailure(cause);
          retire(new GitReadRefusal("command", "cleanup", [], [], cause));
        }
      }
    }
    if (reader === undefined) return null;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      bytes,
      complete,
      observedLength,
      observedSha256: observedHash.digest("hex"),
    };
  };
  try {
    const exit = Promise.race([
      Promise.resolve()
        .then(() => child.exited)
        .then(
          (code) => ({ kind: "observed" as const, code }),
          (cause: unknown) => {
            retire(
              new GitReadRefusal(
                "command",
                "termination-unavailable",
                [],
                [],
                cause,
              ),
            );
            return { kind: "unavailable" as const };
          },
        ),
      unavailable,
    ]);
    let stdoutStream: ReadableStream<Uint8Array> | null = null,
      stderrStream: ReadableStream<Uint8Array> | null = null;
    try {
      const stdout = child.stdout;
      if (stdout instanceof ReadableStream) stdoutStream = stdout;
    } catch (cause) {
      retire(new GitReadRefusal("command", "stream", [], [], cause));
    }
    try {
      const stderr = child.stderr;
      if (stderr instanceof ReadableStream) stderrStream = stderr;
    } catch (cause) {
      retire(new GitReadRefusal("command", "stream", [], [], cause));
    }
    if (stdoutStream === null || stderrStream === null)
      retire(new GitReadRefusal("command", "stream-unavailable"));
    const collect = (
      stream: ReadableStream<Uint8Array> | null,
      maximum: number,
    ) =>
      stream === null
        ? Promise.resolve(null)
        : bounded(stream, maximum).catch((cause: unknown) => {
            retire(new GitReadRefusal("command", "stream", [], [], cause));
            return null;
          });
    const settled = await Promise.race([
      Promise.all([
        collect(stdoutStream, maximumBytes),
        collect(stderrStream, 1024 * 1024),
        exit,
      ]).then(([stdout, stderr, exited]) => ({
        kind: "settled" as const,
        stdout,
        stderr,
        exited,
      })),
      unavailable.then(() => ({ kind: "unavailable" as const })),
    ]);
    if (settled.kind === "unavailable") {
      if (pendingCancellations.size > 0)
        cleanupFailures.push(
          new Error(
            "Reader cancellation settlement unavailable at retirement cutoff",
          ),
        );
      notify(() =>
        run.onObservation?.({
          argv,
          cwd: git.scope.workdir,
          command: command.kind,
          pid:
            Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null,
          termination: { kind: "unavailable" },
          stdout: null,
          stderr: null,
          refusal: refusal?.detail ?? "retirement-unavailable",
        }),
      );
      const primary =
        refusal ?? new GitReadRefusal("command", "retirement-unavailable");
      throw new GitReadRefusal(
        primary.reason,
        primary.detail,
        observerFailures,
        cleanupFailures,
        failureCause(primary),
      );
    }
    const { stdout, stderr, exited } = settled;
    const termination: GitReadObservation["termination"] = child.signalCode
      ? { kind: "signal", signal: String(child.signalCode) }
      : exited.kind === "observed" &&
          Number.isSafeInteger(exited.code) &&
          exited.code >= 0 &&
          Number.isSafeInteger(child.pid) &&
          child.pid > 0
        ? { kind: "exit", code: exited.code }
        : { kind: "unavailable" };
    const commandRefusal =
      termination.kind === "exit" &&
      termination.code !== 0 &&
      !(command.kind === "version" && command.probeNoLazyFetch) &&
      !(command.kind === "head-ref" && termination.code === 1)
        ? new GitReadRefusal(
            command.kind === "version" ? "unsupported-suppression" : "command",
            command.kind === "version" ? "flag-first-version" : "git-read",
          )
        : undefined;
    const primaryBeforeObservation = refusal ?? commandRefusal;
    notify(() =>
      run.onObservation?.({
        argv,
        cwd: git.scope.workdir,
        command: command.kind,
        pid:
          Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null,
        termination,
        stdout:
          stdout === null
            ? null
            : {
                complete: stdout.complete,
                byteLength: stdout.observedLength,
                sha256: stdout.observedSha256,
                retainedByteLength: stdout.bytes.byteLength,
                retainedSha256: digest(stdout.bytes),
              },
        stderr:
          stderr === null
            ? null
            : {
                complete: stderr.complete,
                byteLength: stderr.observedLength,
                sha256: stderr.observedSha256,
                retainedByteLength: stderr.bytes.byteLength,
                retainedSha256: digest(stderr.bytes),
              },
        refusal: refusal?.detail ?? commandRefusal?.detail ?? null,
      }),
    );
    if (refusal) {
      const primary = primaryBeforeObservation ?? refusal;
      throw new GitReadRefusal(
        primary.reason,
        primary.detail,
        observerFailures,
        cleanupFailures,
        failureCause(
          primary,
          commandRefusal !== undefined && commandRefusal !== primary
            ? [commandRefusal]
            : [],
        ),
      );
    }
    if (
      stdout === null ||
      stderr === null ||
      !stdout.complete ||
      !stderr.complete ||
      termination.kind !== "exit"
    )
      throw new GitReadRefusal(
        "command",
        "termination-unavailable",
        observerFailures,
        cleanupFailures,
      );
    const decodingFailures: GitReadRefusal[] = [];
    const decoded = (bytes: Uint8Array, stream: "stdout" | "stderr") => {
      try {
        return new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
      } catch (cause) {
        decodingFailures.push(
          new GitReadRefusal("command", `${stream}-encoding`, [], [], cause),
        );
        return null;
      }
    };
    const stderrText = decoded(stderr.bytes, "stderr");
    const stdoutText =
      run.onCommand === undefined
        ? null
        : command.kind === "commit-body" ||
            command.kind === "tree-body" ||
            command.kind === "blob-body" ||
            command.kind === "source-entry"
          ? `<raw ${command.kind}; ${stdout.bytes.byteLength} bytes>`
          : decoded(stdout.bytes, "stdout");
    if (
      run.onCommand !== undefined &&
      stdoutText !== null &&
      stderrText !== null
    )
      notify(() =>
        run.onCommand?.({
          command,
          argv,
          cwd: git.scope.workdir,
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: termination.code,
        }),
      );
    if (run.signal?.aborted && refusal === undefined) abort();
    const primary =
      commandRefusal ??
      refusal ??
      (observerFailures.length > 0
        ? new GitReadRefusal("observer", "evidence-callback")
        : cleanupFailures.length > 0
          ? new GitReadRefusal("command", "cleanup")
          : decodingFailures.at(0));
    if (primary)
      throw new GitReadRefusal(
        primary.reason,
        primary.detail,
        observerFailures,
        cleanupFailures,
        failureCause(
          primary,
          decodingFailures,
          decodingFailures.length > 0
            ? "Local Git command decoding failed"
            : "Local Git read failures",
        ),
      );
    if (stderrText === null)
      throw new GitReadRefusal(
        "command",
        "stderr-encoding",
        observerFailures,
        cleanupFailures,
      );
    return {
      bytes: stdout.bytes,
      stderr: stderrText,
      exitCode: termination.code,
    };
  } finally {
    finished = true;
    clearTimeout(deadline);
    if (retirementDeadline !== undefined) clearTimeout(retirementDeadline);
    run.signal?.removeEventListener("abort", abort);
  }
};
export const gitReadText = (result: {
  bytes: Uint8Array;
  exitCode: number;
}): string => {
  if (result.exitCode !== 0) throw new GitReadRefusal("command", "git-read");
  const value = text(result.bytes);
  if (
    !value.endsWith("\n") ||
    value.slice(0, -1).includes("\n") ||
    value.includes("\r")
  )
    throw new GitReadRefusal("command", "line-protocol");
  return value.slice(0, -1);
};
export const readQualifiedGitBlob = async (
  git: QualifiedGitRead,
  source: Readonly<{ commit: string; path: string }>,
  run: GitReadRun = {},
  maximumBytes = 1024 * 1024,
): Promise<
  Readonly<{
    commit: string;
    path: string;
    mode: "100644" | "100755" | "120000";
    oid: string;
    bytes: Uint8Array;
  }>
> => {
  checkAbort(run.signal);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    throw new GitReadRefusal("command", "output-bound-input");
  const resolved = gitReadText(
    await runQualifiedGit(
      git,
      { kind: "exact-commit", oid: source.commit },
      run,
    ),
  );
  checkAbort(run.signal);
  if (resolved !== source.commit)
    throw new GitReadRefusal("command", "commit-identity");
  const listing = await runQualifiedGit(
    git,
    { kind: "source-entry", oid: source.commit, path: source.path },
    run,
    Buffer.byteLength(source.path) + 128,
  );
  checkAbort(run.signal);
  if (listing.bytes.byteLength === 0)
    throw new GitReadRefusal("command", "source-entry-missing");
  const entries = text(listing.bytes).split("\0");
  if (entries.length !== 2 || entries[1] !== "")
    throw new GitReadRefusal("command", "source-entry-shape");
  const entry = entries[0] ?? "";
  const separator = entry.indexOf("\t");
  const fields = entry.slice(0, separator).split(" ");
  if (
    separator < 0 ||
    fields.length !== 3 ||
    entry.slice(separator + 1) !== source.path
  )
    throw new GitReadRefusal("command", "source-entry-mismatch");
  const [mode, type, oid] = fields;
  if (
    oid === undefined ||
    !(git.objectFormat === "sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/).test(
      oid,
    )
  )
    throw new GitReadRefusal("command", "source-entry-oid");
  if (mode === "160000" && type === "commit")
    throw new GitReadNonBlobEntry({ ...source, oid, mode, type });
  if (mode === "040000" && type === "tree")
    throw new GitReadNonBlobEntry({ ...source, oid, mode, type });
  if (
    (mode !== "100644" && mode !== "100755" && mode !== "120000") ||
    type !== "blob"
  )
    throw new GitReadRefusal("command", "source-entry-shape");
  const body = await runQualifiedGit(
    git,
    { kind: "blob-body", oid },
    run,
    maximumBytes,
  );
  checkAbort(run.signal);
  const observedOid = createHash(git.objectFormat)
    .update(Buffer.from(`blob ${body.bytes.byteLength}\0`))
    .update(body.bytes)
    .digest("hex");
  if (observedOid !== oid) throw new GitReadRefusal("command", "blob-identity");
  return {
    commit: source.commit,
    path: source.path,
    mode,
    oid,
    bytes: body.bytes,
  };
};
export const recheckLocalGitRead = async (
  git: GitReadPreflight | QualifiedGitRead,
  run: GitReadRun = {},
) => {
  const current = await preflightLocalGitRead({
    repository: git.scope.repository,
    workdir: git.scope.workdir,
    expectedPhysicalScope: git.scope,
    ...(run.signal === undefined ? {} : { signal: run.signal }),
  });
  if (
    current.configurationSha256 !== git.configurationSha256 ||
    current.executable.path !== git.executable.path ||
    current.invocationPath !== git.invocationPath ||
    current.executable.sha256 !== git.executable.sha256
  )
    throw new GitReadRefusal("source-moved", "qualification");
};
export const qualifyLocalGitRead = async (
  preflight: GitReadPreflight,
  run: GitReadRun = {},
): Promise<QualifiedGitRead> => {
  const assessment = await assessGitReadCapabilities(
    preflight.partialClone,
    (probeNoLazyFetch) =>
      runQualifiedGit(preflight, { kind: "version", probeNoLazyFetch }, run),
  );
  requireOfflineGitRead(assessment);
  const git: QualifiedGitRead = retainQualification({
    ...preflight,
    kind: "qualified",
    assessment,
    gitVersion: assessment.gitVersion,
    suppression: gitReadSuppression(assessment),
    commandPrefix: [
      ...gitReadSuppressionArgs(assessment),
      ...preflight.commandPrefix,
    ],
  });
  for (const [field, expected] of [
    ["--show-toplevel", git.scope.repository],
    ["--git-common-dir", git.scope.gitCommonDirectory],
    ["--absolute-git-dir", git.scope.gitDirectory],
    ["--show-object-format=storage", git.objectFormat],
  ] as const) {
    const observed = gitReadText(
      await runQualifiedGit(git, { kind: "owner", field }, run),
    );
    if (observed !== expected)
      throw new GitReadRefusal("source-moved", "git-owner");
  }
  await recheckLocalGitRead(git, run);
  return git;
};

export type GitReadAssessment = Readonly<{
  gitVersion: string;
  supportsNoLazyFetch: boolean;
  partialClone: boolean;
}>;

const isPartialClone = (config: ReadonlyMap<string, readonly string[]>) =>
  [...config].some(
    ([key, values]) =>
      key === "extensions.partialclone" ||
      (key.startsWith("remote.") &&
        (key.endsWith(".partialclonefilter") ||
          (key.endsWith(".promisor") && values.some(boolean)))),
  );

const assessGitReadCapabilities = async (
  partialClone: boolean,
  probe: (
    noLazyFetch: boolean,
  ) => Promise<{ bytes: Uint8Array; exitCode: number }>,
): Promise<GitReadAssessment> => {
  const gitVersion = gitReadText(await probe(false));
  if (!/^git version [0-9]+\.[0-9]+\.[0-9]+(?:[ .-].*)?$/.test(gitVersion))
    throw new GitReadRefusal("unsupported-suppression", "version-protocol");
  const supported = await probe(true);
  return Object.freeze({
    gitVersion,
    supportsNoLazyFetch:
      supported.exitCode === 0 && gitReadText(supported) === gitVersion,
    partialClone,
  });
};

export const OFFLINE_GIT_FIX =
  "Install Git 2.45 or later, for example with brew install git, or use a full clone.";

export const requireOfflineGitRead = (assessment: GitReadAssessment) => {
  if (assessment.partialClone && !assessment.supportsNoLazyFetch)
    throw new GitReadRefusal(
      "unsupported-suppression",
      `${assessment.gitVersion}; this repository is a partial clone, and this Git cannot disable lazy fetching. ${OFFLINE_GIT_FIX}`,
    );
};

export const describeGitReadAssessment = (assessment: GitReadAssessment) =>
  `${assessment.gitVersion}; --no-lazy-fetch ${assessment.supportsNoLazyFetch ? "supported" : "unsupported"}; ${assessment.partialClone ? "partial clone" : "full clone"}`;

export type GitReadPolicy = Readonly<{
  assessment: GitReadAssessment;
  executable: string;
  environment: Readonly<Record<string, string>>;
  suppression: "no-lazy-fetch-flag" | "none";
  commandPrefix: readonly string[];
}>;

const gitReadSuppression = (
  assessment: GitReadAssessment,
): GitReadPolicy["suppression"] =>
  assessment.partialClone && assessment.supportsNoLazyFetch
    ? "no-lazy-fetch-flag"
    : "none";
const gitReadSuppressionArgs = (assessment: GitReadAssessment) =>
  gitReadSuppression(assessment) === "no-lazy-fetch-flag"
    ? ["--no-lazy-fetch"]
    : [];

/** Metadata commands only, including in a partial clone on an older Git. */
const inspectLocalGitEnvironment = async (
  repository: string,
  supplied?: NodeJS.ProcessEnv,
): Promise<GitReadPolicy> => {
  const executable = Bun.which("git", {
    PATH: supplied?.PATH ?? process.env.PATH ?? "",
  });
  if (executable === null)
    throw new GitReadRefusal("executable-unavailable", "git");
  const environment = isolatedGitReadEnvironment(
    executable,
    repository,
    supplied,
  );
  const run = async (args: readonly string[]) => {
    const child = Bun.spawn([executable, "-C", repository, ...args], {
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    });
    const [bytes, , exitCode] = await Promise.all([
      new Response(child.stdout).bytes(),
      new Response(child.stderr).bytes(),
      child.exited,
    ]);
    return { bytes, exitCode };
  };
  const configuration = await run(["config", "--null", "--list", "--includes"]);
  if (configuration.exitCode !== 0)
    throw new GitReadRefusal("unsupported-config", "git-config");
  const config = new Map<string, string[]>();
  for (const entry of text(configuration.bytes).split("\0")) {
    if (!entry) continue;
    const at = entry.indexOf("\n");
    const key = at === -1 ? entry : entry.slice(0, at);
    const value = at === -1 ? "true" : entry.slice(at + 1);
    config.set(key, [...(config.get(key) ?? []), value]);
  }
  const assessment = await assessGitReadCapabilities(
    isPartialClone(config),
    (flag) => run(flag ? ["--no-lazy-fetch", "version"] : ["version"]),
  );
  return {
    assessment,
    executable,
    environment,
    suppression: gitReadSuppression(assessment),
    commandPrefix: [
      ...gitReadSuppressionArgs(assessment),
      "--no-replace-objects",
      "--no-optional-locks",
      "--no-pager",
    ],
  };
};

export const assessLocalGitEnvironment = async (
  repository: string,
): Promise<GitReadAssessment> =>
  (await inspectLocalGitEnvironment(repository)).assessment;

/** Keep every read on the executable, environment and suppression policy assessed together. */
export const prepareLocalGitRead = async (
  repository: string,
  environment?: NodeJS.ProcessEnv,
): Promise<GitReadPolicy> => {
  const policy = await inspectLocalGitEnvironment(repository, environment);
  requireOfflineGitRead(policy.assessment);
  return policy;
};
