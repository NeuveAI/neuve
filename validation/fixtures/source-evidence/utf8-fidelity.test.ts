export {};

const activation = process.env.NEUVE_SOURCE_EVIDENCE_MODE;

async function selectedFidelity() {
  const { afterAll, beforeAll, expect, test } = await import("bun:test");
  const { default: assert } = await import("node:assert/strict");
  const { spawnSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { dirname, isAbsolute, join } = await import("node:path");
  const { collectSourceEvidence } = await import("../../../apps/neuve-cli/src/source-evidence.ts");
  type PublicQueryResult = import("../../../apps/neuve-cli/src/domain.ts").PublicQueryResult;

  const blobs = {
    "bom.txt": Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0xce, 0xb2, 0x0a, 0x7a]),
    "plain.txt": Buffer.from([0x61, 0x0d, 0x0a, 0xce, 0xb2, 0x0a, 0x7a]),
    "invalid.txt": Buffer.from([0x61, 0xff, 0x0a]),
  };
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
  let repository: string | undefined;
  let revision: string | undefined;

  beforeAll(async () => {
    for (const [key, value] of Object.entries(requiredGitEnvironment))
      assert.equal(process.env[key], value, `Isolated reader operation requires ${key}`);
    for (const key of Object.keys(process.env))
      if (key.toUpperCase().startsWith("GIT_"))
        assert.ok(Object.hasOwn(requiredGitEnvironment, key), `Unexpected Git environment: ${key}`);
    const executable = Bun.which("git");
    assert.ok(executable && isAbsolute(executable));
    assert.equal(process.env.PATH, dirname(executable), "Use one qualified Git executable directory");
    const root = await realpath(await mkdtemp(join(tmpdir(), "neuve-source-evidence-")));
    repository = root;
    const git = (args: readonly string[], input?: Buffer) => {
      const result = spawnSync(executable, [
        "--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks", "--no-pager",
        "-C", root, ...args,
      ], {
        input,
        encoding: "buffer",
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Reader fixture",
          GIT_AUTHOR_EMAIL: "reader@example.invalid",
          GIT_COMMITTER_NAME: "Reader fixture",
          GIT_COMMITTER_EMAIL: "reader@example.invalid",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        },
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr.toString("utf8"));
      return result.stdout.toString("utf8").trim();
    };
    git(["init", "--quiet", "--template=", "--object-format=sha1"]);
    const entries = Object.entries(blobs).map(([path, bytes]) => {
      const expected = createHash("sha1")
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest("hex");
      assert.equal(git(["hash-object", "-w", "--stdin"], bytes), expected);
      return `100644 blob ${expected}\t${path}\n`;
    });
    const tree = git(["mktree"], Buffer.from(entries.join("")));
    revision = git(["commit-tree", tree], Buffer.from("reader fidelity\n"));
    assert.match(revision, /^[a-f0-9]{40}$/);
  });

  afterAll(async () => {
    if (repository !== undefined) await rm(repository, { recursive: true, force: true });
  });

  const query = (path: string, start: number, end: number, selectedRevision = revision): PublicQueryResult => {
    assert.ok(repository && selectedRevision);
    return {
      schema_version: 2,
      provider: {
        name: "entire-graph",
        version: "reader-fixture",
        identity_revision: "reader-fixture",
        capabilities: {
          schema_version: "reader-fixture",
          file_extensions: [],
          languages: { supported: [], semantic: [], inventory_only: [], unsupported_detected_hints: [] },
          relations: { selection_modes: [], families: {}, supported: [], by_language: {}, by_profile: {}, heuristic: [] },
          parser_versions: {},
          optional_local_features: {},
          features_requiring_network: {},
        },
      },
      query: "reader fixture only",
      source: { repository, revision: selectedRevision },
      retrieval: {
        status: "ok",
        coverage: "reader fixture only",
        contained_callable_coverage: "unavailable",
        candidates: [{
          kind: "region",
          language: null,
          source: { kind: "range", path, start_line: start, end_line: end },
          contained_callables: { status: "unavailable" },
        }],
        warnings: [],
        partial_failures: [],
        limitations: [],
        budget: {
          requested_top_k: 1,
          requested_max_context_bytes: 0,
          returned_results: 1,
          provider_context_budget_bytes: 0,
          provider_result_bytes: 0,
          query_constraints_truncated: false,
          results_dropped_by_budget: 0,
          snippets_truncated_by_budget: 0,
        },
      },
      structural_observations: [],
    };
  };
  const read = (path: string, start: number, end: number, budget: number) =>
    collectSourceEvidence(query(path, start, end), budget, new AbortController().signal);
  const expectedBlob = (path: keyof typeof blobs) => createHash("sha1")
    .update(Buffer.from(`blob ${blobs[path].length}\0`))
    .update(blobs[path])
    .digest("hex");

  test("initial BOM and CRLF survive inclusive line selection", async () => {
    const result = await read("bom.txt", 1, 3, 10);
    expect(result).toEqual({
      source_evidence: [{ path: "bom.txt", start_line: 1, end_line: 3, text: "\uFEFFa\r\nβ\nz", blob_oid: expectedBlob("bom.txt"), revision }],
      source_evidence_limitations: [],
      source_evidence_budget: { requested_bytes: 10, returned_bytes: 10 },
    });
    expect(Buffer.from(result.source_evidence[0]?.text ?? "")).toEqual(blobs["bom.txt"]);
  });

  test("a source without BOM retains its seven bytes", async () => {
    const result = await read("plain.txt", 1, 3, 7);
    expect(result.source_evidence).toEqual([{ path: "plain.txt", start_line: 1, end_line: 3, text: "a\r\nβ\nz", blob_oid: expectedBlob("plain.txt"), revision }]);
    expect(result.source_evidence_limitations).toEqual([]);
    expect(result.source_evidence_budget).toEqual({ requested_bytes: 7, returned_bytes: 7 });
  });

  test("later line selection excludes the initial BOM and preserves UTF-8 and CRLF boundaries", async () => {
    const result = await read("bom.txt", 2, 2, 3);
    expect(result.source_evidence).toEqual([{ path: "bom.txt", start_line: 2, end_line: 2, text: "β\n", blob_oid: expectedBlob("bom.txt"), revision }]);
    expect(result.source_evidence_limitations).toEqual([]);
    expect(result.source_evidence_budget).toEqual({ requested_bytes: 3, returned_bytes: 3 });
  });

  test("exact first-line budget counts the three BOM bytes", async () => {
    const result = await read("bom.txt", 1, 1, 6);
    expect(result.source_evidence).toEqual([{ path: "bom.txt", start_line: 1, end_line: 1, text: "\uFEFFa\r\n", blob_oid: expectedBlob("bom.txt"), revision }]);
    expect(result.source_evidence_limitations).toEqual([]);
    expect(result.source_evidence_budget).toEqual({ requested_bytes: 6, returned_bytes: 6 });
  });

  test("one byte below the first-line budget omits the complete range", async () => {
    expect(await read("bom.txt", 1, 1, 5)).toEqual({
      source_evidence: [],
      source_evidence_limitations: [{ path: "bom.txt", start_line: 1, end_line: 1, reason: "source-budget-exhausted" }],
      source_evidence_budget: { requested_bytes: 5, returned_bytes: 0 },
    });
  });

  test("invalid UTF-8 remains an explicit omission", async () => {
    expect(await read("invalid.txt", 1, 1, 3)).toEqual({
      source_evidence: [],
      source_evidence_limitations: [{ path: "invalid.txt", start_line: 1, end_line: 1, reason: "non-utf8-source" }],
      source_evidence_budget: { requested_bytes: 3, returned_bytes: 0 },
    });
  });

  test("a missing object in the wholly local fixture remains unavailable", async () => {
    const result = await collectSourceEvidence(query("bom.txt", 1, 1, "0".repeat(40)), 6, new AbortController().signal);
    expect(result).toEqual({
      source_evidence: [],
      source_evidence_limitations: [{ path: "bom.txt", start_line: 1, end_line: 1, reason: "blob-unavailable" }],
      source_evidence_budget: { requested_bytes: 6, returned_bytes: 0 },
    });
  });

  test("a pre-aborted reader preserves its cancellation reason", async () => {
    const controller = new AbortController();
    const reason = new Error("reader cancelled before body read");
    controller.abort(reason);
    await assert.rejects(collectSourceEvidence(query("bom.txt", 1, 1), 6, controller.signal), (cause) => cause === reason);
  });
}

if (activation !== undefined) {
  if (activation !== "utf8-fidelity-v1")
    throw new Error("Source evidence fidelity unknown mode refused");
  await selectedFidelity();
}
