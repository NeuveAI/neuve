export {};

const activation = process.env.NEUVE_QUALIFIED_GIT_BLOB_MODE;

async function selectedBlobControls() {
  const { afterEach, beforeAll, expect, test } = await import("bun:test");
  const { default: assert } = await import("node:assert/strict");
  const { spawnSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { appendFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } = await import("node:fs/promises");
  const { deflateSync } = await import("node:zlib");
  const { tmpdir } = await import("node:os");
  const { dirname, isAbsolute, join } = await import("node:path");
  const { GitReadRefusal, GitReadNonBlobEntry, preflightLocalGitRead, qualifyLocalGitRead, readQualifiedGitBlob } =
    await import("../../../packages/graph-client/src/git-read-qualification.ts");
  type GitReadReceipt = import("../../../packages/graph-client/src/git-read-qualification.ts").GitReadReceipt;
  type GitReadObservation = import("../../../packages/graph-client/src/git-read-qualification.ts").GitReadObservation;

  const binary = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x41]);
  const decoy = Buffer.from([0x42]);
  const link = Buffer.from("regular.bin");
  const requiredGitEnvironment = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ALLOW_PROTOCOL: "",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
  };
  beforeAll(() => {
    for (const [key, value] of Object.entries(requiredGitEnvironment))
      assert.equal(process.env[key], value, `Selected blob operation requires ${key}`);
    for (const key of Object.keys(process.env))
      if (key.toUpperCase().startsWith("GIT_"))
        assert.ok(Object.hasOwn(requiredGitEnvironment, key), `Unexpected Git environment: ${key}`);
    const executable = Bun.which("git");
    assert.ok(executable && isAbsolute(executable));
    assert.equal(process.env.PATH, dirname(executable));
    for (const key of ["HOME", "XDG_CONFIG_HOME", "TMPDIR"]) {
      const value = process.env[key];
      assert.ok(value && isAbsolute(value), `Require owned absolute ${key}`);
    }
    assert.equal(process.env.NODE_OPTIONS, undefined);
    assert.equal(process.env.BUN_OPTIONS, undefined);
  });
  const roots: string[] = [];
  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
  });
  const objectOid = (format: "sha1" | "sha256", type: string, bytes: Buffer) =>
    createHash(format).update(Buffer.from(`${type} ${bytes.length}\0`)).update(bytes).digest("hex");
  async function fixture(format: "sha1" | "sha256" = "sha1") {
    const root = await realpath(await mkdtemp(join(tmpdir(), "neuve-qualified-blob-")));
    roots.push(root);
    await mkdir(join(root, "nested"));
    const executable = Bun.which("git");
    assert.ok(executable && isAbsolute(executable));
    const git = (args: readonly string[], input?: Buffer) => {
      const result = spawnSync(executable, [
        "--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks", "--no-pager", "-C", root, ...args,
      ], {
        input, encoding: "buffer", maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Blob fixture", GIT_AUTHOR_EMAIL: "blob@example.invalid",
          GIT_COMMITTER_NAME: "Blob fixture", GIT_COMMITTER_EMAIL: "blob@example.invalid",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr.toString("utf8"));
      return result.stdout.toString("utf8").trim();
    };
    git(["init", "--quiet", "--template=", `--object-format=${format}`]);
    const blob = (bytes: Buffer) => {
      const expected = objectOid(format, "blob", bytes);
      assert.equal(git(["hash-object", "-w", "--stdin"], bytes), expected);
      return expected;
    };
    const oid = blob(binary), decoyOid = blob(decoy), linkOid = blob(link);
    const emptyTree = git(["mktree"], Buffer.alloc(0));
    const childCommit = git(["commit-tree", emptyTree], Buffer.from("gitlink target\n"));
    const entries = [
      `100755 blob ${oid}\texecutable.bin\n`,
      `120000 blob ${linkOid}\tlink\n`,
      `100644 blob ${oid}\tliteral[?]*.bin\n`,
      `100644 blob ${decoyOid}\tliteral?.bin\n`,
      `100644 blob ${oid}\tregular.bin\n`,
      `160000 commit ${childCommit}\tsubmodule\n`,
      `040000 tree ${emptyTree}\tdirectory\n`,
    ];
    const tree = git(["mktree"], Buffer.from(entries.join("")));
    const commit = git(["commit-tree", tree], Buffer.from("qualified blob controls\n"));
    const tagBytes = Buffer.from(`object ${commit}\ntype commit\ntag fixture-tag\ntagger Blob fixture <blob@example.invalid> 946684800 +0000\n\nfixture tag\n`);
    const tag = git(["hash-object", "-t", "tag", "-w", "--stdin"], tagBytes);
    assert.equal(tag, objectOid(format, "tag", tagBytes));
    const qualify = async (nested = false) => qualifyLocalGitRead(await preflightLocalGitRead({
      repository: root, workdir: nested ? join(root, "nested") : root,
    }));
    return { root, commit, oid, tag, qualify, git, emptyTree, childCommit, linkOid };
  }
  const refusal = (reason: string, detail: string) => (cause: unknown) =>
    cause instanceof GitReadRefusal && cause.reason === reason && cause.detail === detail;

  test("root selection binds regular blob bytes to exact commit and Git identity", async () => {
    const f = await fixture();
    const result = await readQualifiedGitBlob(await f.qualify(), { commit: f.commit, path: "regular.bin" }, {}, 5);
    expect(result).toEqual({ commit: f.commit, path: "regular.bin", mode: "100644", oid: objectOid("sha1", "blob", binary), bytes: new Uint8Array(binary) });
  });
  test("nested workdir keeps root-relative selection unchanged", async () => {
    const f = await fixture();
    const result = await readQualifiedGitBlob(await f.qualify(true), { commit: f.commit, path: "regular.bin" }, {}, 5);
    expect(result).toEqual({ commit: f.commit, path: "regular.bin", mode: "100644", oid: objectOid("sha1", "blob", binary), bytes: new Uint8Array(binary) });
  });
  test("executable regular mode is retained", async () => {
    const f = await fixture();
    const result = await readQualifiedGitBlob(await f.qualify(), { commit: f.commit, path: "executable.bin" }, {}, 5);
    expect(result.mode).toBe("100755");
    expect(result.oid).toBe(f.oid);
    expect(result.bytes).toEqual(new Uint8Array(binary));
  });
  test("metacharacters select one literal path rather than its decoy", async () => {
    const f = await fixture();
    const result = await readQualifiedGitBlob(await f.qualify(), { commit: f.commit, path: "literal[?]*.bin" }, {}, 5);
    expect(result.path).toBe("literal[?]*.bin");
    expect(result.oid).toBe(f.oid);
    expect(result.bytes).toEqual(new Uint8Array(binary));
  });
  test("SHA-256 repository uses the exact 64-character blob identity", async () => {
    const f = await fixture("sha256");
    const result = await readQualifiedGitBlob(await f.qualify(), { commit: f.commit, path: "regular.bin" }, {}, 5);
    expect(result.oid).toBe(objectOid("sha256", "blob", binary));
    expect(result.oid.length).toBe(64);
    expect(result.bytes).toEqual(new Uint8Array(binary));
  });
  test("committed symlink text is verified without requiring its target", async () => {
    const f = await fixture();
    const observations: GitReadObservation[] = [];
    const result = await readQualifiedGitBlob(await f.qualify(), { commit: f.commit, path: "link" }, {
      onObservation: value => { observations.push(value); },
    }, link.byteLength);
    expect(result).toEqual({ commit: f.commit, path: "link", mode: "120000", oid: objectOid("sha1", "blob", link), bytes: new Uint8Array(link) });
    expect(observations.map(value => value.command)).toEqual(["exact-commit", "source-entry", "blob-body"]);
  });
  test("changed worktree target and advanced HEAD cannot replace selected symlink bytes", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "regular.bin"), Buffer.from("one\n"), { flag: "wx" });
    const qualified = await f.qualify();
    await writeFile(join(f.root, "regular.bin"), Buffer.from("two\n"));
    const next = f.git(["commit-tree", f.emptyTree, "-p", f.commit], Buffer.from("HEAD advanced\n"));
    f.git(["update-ref", "HEAD", next]);
    const result = await readQualifiedGitBlob(qualified, { commit: f.commit, path: "link" }, {}, link.byteLength);
    expect(result).toEqual({ commit: f.commit, path: "link", mode: "120000", oid: f.linkOid, bytes: new Uint8Array(link) });
  });
  test("SHA-256 symlink bytes use the same independently framed identity", async () => {
    const f = await fixture("sha256");
    const result = await readQualifiedGitBlob(await f.qualify(), { commit: f.commit, path: "link" }, {}, link.byteLength);
    expect(result.oid).toBe(objectOid("sha256", "blob", link));
    expect(result.mode).toBe("120000");
    expect(result.bytes).toEqual(new Uint8Array(link));
  });
  for (const path of ["submodule", "directory"])
    test(`nonregular ${path} refuses before blob acquisition`, async () => {
      const f = await fixture();
      const observations: GitReadObservation[] = [];
      await assert.rejects(readQualifiedGitBlob(await f.qualify(), { commit: f.commit, path }, {
        onObservation: value => observations.push(value),
      }, 5), cause => {
        if (!(cause instanceof GitReadNonBlobEntry)) return false;
        expect(cause.entry).toEqual(path === "submodule"
          ? { commit: f.commit, path, mode: "160000", type: "commit", oid: f.childCommit }
          : { commit: f.commit, path, mode: "040000", type: "tree", oid: f.emptyTree });
        expect(Object.isFrozen(cause.entry)).toBe(true);
        expect(Object.isFrozen(cause)).toBe(true);
        return cause.reason === "command" && cause.detail === "source-entry-nonregular";
      });
      expect(observations.map(value => value.command)).toEqual(["exact-commit", "source-entry"]);
    });
  test("non-blob construction validates the exact OID before an immutable account exists", () => {
    assert.throws(() => new GitReadNonBlobEntry({
      commit: "1".repeat(40), path: "submodule", mode: "160000", type: "commit", oid: "1".repeat(39),
    }), refusal("command", "source-entry-shape"));
    assert.throws(() => new GitReadNonBlobEntry({
      commit: "1".repeat(40), path: "../submodule", mode: "160000", type: "commit", oid: "1".repeat(40),
    }), refusal("command", "source-entry-shape"));
  });
  test("a body-bound observer failure remains separate from the original bound", async () => {
    const f = await fixture();
    const marker = new Error("CP-observer");
    await assert.rejects(readQualifiedGitBlob(await f.qualify(), { commit: f.commit, path: "regular.bin" }, {
      onObservation: value => { if (value.command === "blob-body") throw marker; },
    }, 4), cause => cause instanceof GitReadRefusal && cause.reason === "command" &&
      cause.detail === "output-bound" && cause.observerFailures.length === 1 && cause.observerFailures[0] === marker);
  });
  test("missing path is not a HEAD fallback", async () => {
    const f = await fixture();
    await assert.rejects(readQualifiedGitBlob(await f.qualify(), { commit: f.commit, path: "absent.bin" }, {}, 5), refusal("command", "source-entry-missing"));
  });
  test("missing full commit retains the existing Git-command refusal", async () => {
    const f = await fixture();
    await assert.rejects(readQualifiedGitBlob(await f.qualify(), { commit: "0".repeat(40), path: "regular.bin" }, {}, 5), refusal("command", "git-read"));
  });
  test("abbreviated commit refuses without command observations", async () => {
    const f = await fixture();
    const observations: GitReadObservation[] = [];
    await assert.rejects(readQualifiedGitBlob(await f.qualify(), { commit: f.commit.slice(0, 7), path: "regular.bin" }, {
      onObservation: value => observations.push(value),
    }, 5), refusal("command", "exact-oid"));
    expect(observations).toEqual([]);
  });
  test("tag-to-commit peeling cannot replace the supplied commit identity", async () => {
    const f = await fixture();
    const observations: GitReadObservation[] = [];
    await assert.rejects(readQualifiedGitBlob(await f.qualify(), { commit: f.tag, path: "regular.bin" }, {
      onObservation: value => observations.push(value),
    }, 5), refusal("command", "commit-identity"));
    expect(observations.map(value => value.command)).toEqual(["exact-commit"]);
  });
  test("non-UTF8 raw body retains byte observations and raw command receipts", async () => {
    const f = await fixture();
    const observations: GitReadObservation[] = [], receipts: GitReadReceipt[] = [];
    const result = await readQualifiedGitBlob(await f.qualify(), { commit: f.commit, path: "regular.bin" }, {
      onObservation: value => observations.push(value), onCommand: value => receipts.push(value),
    }, 5);
    expect(result.bytes).toEqual(new Uint8Array(binary));
    expect(receipts.map(value => value.command.kind)).toEqual(["exact-commit", "source-entry", "blob-body"]);
    expect(receipts[1]?.stdout).toBe("<raw source-entry; 65 bytes>");
    expect(receipts[2]?.stdout).toBe("<raw blob-body; 5 bytes>");
    const body = observations.find(value => value.command === "blob-body");
    assert.ok(body);
    expect(body.refusal).toBeNull();
    expect(body.stdout).toEqual({ complete: true, byteLength: 5, sha256: createHash("sha256").update(binary).digest("hex"), retainedByteLength: 5, retainedSha256: createHash("sha256").update(binary).digest("hex") });
  });
  test("one-byte-too-small bound refuses rather than returning partial body", async () => {
    const f = await fixture();
    const observations: GitReadObservation[] = [];
    await assert.rejects(readQualifiedGitBlob(await f.qualify(), { commit: f.commit, path: "regular.bin" }, {
      onObservation: value => observations.push(value),
    }, 4), refusal("command", "output-bound"));
    const body = observations.find(value => value.command === "blob-body");
    assert.ok(body?.stdout);
    expect(body.refusal).toBe("output-bound");
    expect(body.stdout.complete).toBe(false);
    expect(body.stdout.byteLength).toBe(5);
    expect(body.stdout.retainedByteLength).toBeLessThanOrEqual(4);
  });
  test("wrong loose-object bytes cannot be admitted under the selected blob identity", async () => {
    const f = await fixture();
    const qualified = await f.qualify();
    const wrong = Buffer.from([0x00, 0xfe, 0x0d, 0x0a, 0x41]);
    const object = join(f.root, ".git", "objects", f.oid.slice(0, 2), f.oid.slice(2));
    const replacement = `${object}.control14-replacement`;
    await writeFile(replacement, deflateSync(Buffer.concat([Buffer.from("blob 5\0"), wrong])),
      { flag: "wx", mode: 0o600 });
    await rename(replacement, object);
    const observations: GitReadObservation[] = [];
    const outcome = await readQualifiedGitBlob(qualified, { commit: f.commit, path: "regular.bin" }, {
      onObservation: value => observations.push(value),
    }, 5).then(value => ({ kind: "returned" as const, value }), (cause: unknown) => ({ kind: "threw" as const, cause }));
    const rejected = outcome.kind === "threw" && outcome.cause instanceof GitReadRefusal ? outcome.cause : undefined;
    const errorAccount = (cause: unknown) => cause instanceof Error ? { name: cause.name, message: cause.message } : { kind: "unsupported-thrown-value" };
    try {
      const evidence = JSON.stringify({
        kind: "qualified-git-blob-control14-evidence-v1",
        control: "wrong loose-object bytes cannot be admitted under the selected blob identity",
        outcome: outcome.kind === "returned" ? { kind: "returned", ...outcome.value, bytes: Buffer.from(outcome.value.bytes).toString("hex") }
          : { kind: "threw", error: errorAccount(outcome.cause) },
        refusal: rejected === undefined ? null : { reason: rejected.reason, detail: rejected.detail,
          cause: rejected.cause instanceof AggregateError ? Array.from(rejected.cause.errors, errorAccount)
            : rejected.cause === undefined ? { kind: "absent" } : errorAccount(rejected.cause),
          observerFailures: rejected.observerFailures.map(errorAccount), cleanupFailures: rejected.cleanupFailures.map(errorAccount) },
        observations,
      }) + "\n";
      if (Buffer.byteLength(evidence) > 65536)
        throw new Error("Qualified Git blob control14 evidence exceeds 65536 bytes");
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(evidence, error => error ? reject(error) : resolve());
      });
    } catch (cause) {
      throw new AggregateError([...(outcome.kind === "threw" ? [outcome.cause] : []), cause], "Qualified Git blob control14 publication failed");
    }
    assert.equal(outcome.kind, "threw"); assert.ok(rejected);
    assert.equal(rejected.reason, "command");
    assert.ok(rejected.detail === "blob-identity" || rejected.detail === "git-read");
    const body = observations.find(value => value.command === "blob-body");
    assert.ok(body);
    if (rejected.detail === "blob-identity") {
      expect(body.refusal).toBeNull();
      expect(body.stdout?.complete).toBe(true);
      expect(body.stdout?.byteLength).toBe(5);
      expect(body.stdout?.sha256).toBe(createHash("sha256").update(wrong).digest("hex"));
    } else {
      expect(body.refusal).toBe("git-read");
    }
  });
  test("configuration movement refuses before a source command", async () => {
    const f = await fixture();
    const qualified = await f.qualify();
    await appendFile(join(f.root, ".git", "config"), "\n# qualified blob fixture changed\n");
    const observations: GitReadObservation[] = [];
    await assert.rejects(readQualifiedGitBlob(qualified, { commit: f.commit, path: "regular.bin" }, {
      onObservation: value => observations.push(value),
    }, 5), refusal("source-moved", "qualification"));
    expect(observations).toEqual([]);
  });
  test("missing physical Git marker retains its exact preflight refusal", async () => {
    const f = await fixture();
    const qualified = await f.qualify();
    await rename(join(f.root, ".git"), join(f.root, ".git-moved"));
    const observations: GitReadObservation[] = [];
    await assert.rejects(readQualifiedGitBlob(qualified, { commit: f.commit, path: "regular.bin" }, {
      onObservation: value => observations.push(value),
    }, 5), refusal("unsupported-store", "git-marker"));
    expect(observations).toEqual([]);
  });
  test("pre-aborted qualified acquisition makes no source command", async () => {
    const f = await fixture();
    const qualified = await f.qualify();
    const controller = new AbortController();
    controller.abort();
    const observations: GitReadObservation[] = [];
    await assert.rejects(readQualifiedGitBlob(qualified, { commit: f.commit, path: "regular.bin" }, {
      signal: controller.signal, onObservation: value => observations.push(value),
    }, 5), refusal("cancelled", "signal"));
    expect(observations).toEqual([]);
  });
  test("cancellation at selected-entry observation prevents blob launch", async () => {
    const f = await fixture();
    const qualified = await f.qualify();
    const controller = new AbortController();
    const observations: GitReadObservation[] = [];
    await assert.rejects(readQualifiedGitBlob(qualified, { commit: f.commit, path: "regular.bin" }, {
      signal: controller.signal,
      onObservation: value => {
        observations.push(value);
        if (value.command === "source-entry") controller.abort();
      },
    }, 5), refusal("cancelled", "signal"));
    expect(observations.map(value => value.command)).toEqual(["exact-commit", "source-entry"]);
  });
  test("parent traversal refuses before entry or blob launch", async () => {
    const f = await fixture();
    const observations: GitReadObservation[] = [];
    await assert.rejects(readQualifiedGitBlob(await f.qualify(), { commit: f.commit, path: "../regular.bin" }, {
      onObservation: value => observations.push(value),
    }, 5), refusal("command", "root-relative-path"));
    expect(observations.map(value => value.command)).toEqual(["exact-commit"]);
  });
}

if (activation !== undefined) {
  if (activation !== "qualified-git-blob-v1")
    throw new Error("Qualified Git blob unknown mode refused");
  await selectedBlobControls();
}
