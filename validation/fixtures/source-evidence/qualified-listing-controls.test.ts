export {};

const activation = process.env.NEUVE_QUALIFIED_LISTING_MODE;
const selector = process.env.NEUVE_QUALIFIED_LISTING_CASE;
const cases = [
  "native-control", "interception-control", "regular", "executable", "symlink", "gitlink", "tree", "missing",
  "missing-nul", "extra-record", "trailing-byte", "missing-tab", "wrong-path", "short-oid", "nonhex-oid",
  "wrong-format-oid", "unknown-mode", "link-commit", "gitlink-blob", "tree-blob", "invalid-utf8",
] as const;

async function selectedListing(caseId: (typeof cases)[number]) {
  const { test } = await import("bun:test");
  const { default: assert } = await import("node:assert/strict");
  const { spawnSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const { mkdtemp, realpath, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { dirname, isAbsolute, join } = await import("node:path");
  const { GitReadRefusal, GitReadNonBlobEntry, preflightLocalGitRead, qualifyLocalGitRead, readQualifiedGitBlob } =
    await import("../../../packages/graph-client/src/git-read-qualification.ts");
  type Observation = import("../../../packages/graph-client/src/git-read-qualification.ts").GitReadObservation;
  const required = {
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: "",
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1",
  };
  const errorAccount = (cause: unknown) => cause instanceof Error ? { name: cause.name, message: cause.message }
    : { kind: "unsupported-thrown-value" };
  const body = Buffer.from([0x6f, 0x6b, 0x0a]);
  const oid = createHash("sha1").update(Buffer.from("blob 3\0")).update(body).digest("hex");
  const line = (mode: string, type: string, object = oid, path = "good.txt") => Buffer.from(`${mode} ${type} ${object}\t${path}\0`);
  // These literal mutations select only the listing response, not an alternate Git command.
  const bytes = (() => {
    switch (caseId) {
      case "native-control": case "regular": return line("100644", "blob");
      case "interception-control": case "symlink": return line("120000", "blob");
      case "executable": return line("100755", "blob");
      case "gitlink": return line("160000", "commit");
      case "tree": return line("040000", "tree");
      case "missing": return Buffer.alloc(0);
      case "missing-nul": return line("100644", "blob").subarray(0, -1);
      case "extra-record": return Buffer.concat([line("100644", "blob"), line("100644", "blob")]);
      case "trailing-byte": return Buffer.concat([line("100644", "blob"), Buffer.from([0x78])]);
      case "missing-tab": return Buffer.from(`100644 blob ${oid} good.txt\0`);
      case "wrong-path": return line("100644", "blob", oid, "other.txt");
      case "short-oid": return line("100644", "blob", "1".repeat(39));
      case "nonhex-oid": return line("100644", "blob", "g".repeat(40));
      case "wrong-format-oid": return line("100644", "blob", "1".repeat(64));
      case "unknown-mode": return line("120001", "blob");
      case "link-commit": return line("120000", "commit");
      case "gitlink-blob": return line("160000", "blob");
      case "tree-blob": return line("040000", "blob");
      case "invalid-utf8": return Buffer.from([0xff, 0x00]);
    }
  })();
  const expected = (() => {
    switch (caseId) {
      case "native-control": case "regular": return { kind: "blob", mode: "100644" } as const;
      case "executable": return { kind: "blob", mode: "100755" } as const;
      case "interception-control": case "symlink": return { kind: "blob", mode: "120000" } as const;
      case "gitlink": return { kind: "non-blob", mode: "160000", type: "commit" } as const;
      case "tree": return { kind: "non-blob", mode: "040000", type: "tree" } as const;
      case "missing": return { kind: "refusal", reason: "command", detail: "source-entry-missing" } as const;
      case "missing-tab": case "wrong-path": return { kind: "refusal", reason: "command", detail: "source-entry-mismatch" } as const;
      case "short-oid": case "nonhex-oid": case "wrong-format-oid": return { kind: "refusal", reason: "command", detail: "source-entry-oid" } as const;
      case "invalid-utf8": return { kind: "refusal", reason: "unsupported-config", detail: "encoding" } as const;
      default: return { kind: "refusal", reason: "command", detail: "source-entry-shape" } as const;
    }
  })();

  test(`qualified listing ${caseId}`, async () => {
    for (const [key, value] of Object.entries(required)) assert.equal(process.env[key], value);
    for (const key of Object.keys(process.env))
      if (key.toUpperCase().startsWith("GIT_")) assert.ok(Object.hasOwn(required, key));
    assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.BUN_OPTIONS, undefined);
    const executable = Bun.which("git");
    assert.ok(executable && isAbsolute(executable)); assert.equal(process.env.PATH, dirname(executable));
    for (const key of ["HOME", "XDG_CONFIG_HOME", "TMPDIR"])
      assert.ok(process.env[key] && isAbsolute(process.env[key] ?? ""));
    const root = await realpath(await mkdtemp(join(tmpdir(), "neuve-listing-control-")));
    const git = (args: readonly string[], input?: Buffer) => {
      const result = spawnSync(executable, ["--no-lazy-fetch", "--no-replace-objects", "--no-optional-locks", "--no-pager", "-C", root, ...args], {
        input, encoding: "buffer", maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_AUTHOR_NAME: "Listing fixture", GIT_AUTHOR_EMAIL: "listing@example.invalid",
          GIT_COMMITTER_NAME: "Listing fixture", GIT_COMMITTER_EMAIL: "listing@example.invalid",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
      });
      assert.ifError(result.error); assert.equal(result.signal, null); assert.equal(result.status, 0, result.stderr.toString("utf8"));
      return result.stdout.toString("utf8").trim();
    };
    git(["init", "--quiet", "--template=", "--object-format=sha1"]);
    assert.equal(git(["hash-object", "-w", "--stdin"], body), oid);
    const tree = git(["mktree"], Buffer.from(`100644 blob ${oid}\tgood.txt\n`));
    const commit = git(["commit-tree", tree], Buffer.from("listing controls\n"));
    const qualified = await qualifyLocalGitRead(await preflightLocalGitRead({ repository: root }));
    const nativeSpawn = Bun.spawn, own = Object.getOwnPropertyDescriptor(Bun, "spawn");
    const prototype = Object.getPrototypeOf(Bun);
    if (own !== undefined && (!("value" in own) || !own.configurable && !own.writable)) throw new Error("Listing spawn interception unsupported");
    if (own === undefined && !Object.isExtensible(Bun)) throw new Error("Listing spawn shadow unsupported");
    const dispatches: string[][] = [], observations: Observation[] = [];
    let selected = 0, restored = false;
    // These observation allowances are experimental fixture inputs, not production deadlines.
    const originalDrainAllowanceMs = 5000, originalCleanupAllowanceMs = 5000;
    type OriginalCapture = {
      child: ReturnType<typeof nativeSpawn>; selectedAt: number; pid: number | null;
      stream: { kind: "registered" } | { kind: "acquired"; value: ReadableStream<Uint8Array> } | { kind: "unavailable" };
      reader: { kind: "unacquired" } | { kind: "acquired" | "released" | "release-failed"; value: ReadableStreamDefaultReader<Uint8Array> };
      acquiredBytes: number; retainedBytes: number; prefix: Uint8Array; eof: boolean;
      readerDone: { kind: "unobserved" } | { kind: "observed"; at: number;
        cancellationState: "unrequested" | "unavailable" | "pending" | "observed" | "failed" };
      drain: "unstarted" | "pending" | "complete" | "failed";
      interceptionFailure?: unknown; drainFailures: unknown[];
      exit: { kind: "unobserved" } | { kind: "pending" } | { kind: "observed"; code: number; at: number }
        | { kind: "failed"; cause: unknown; at: number };
      kill: { kind: "unrequested" } | { kind: "requested"; signal: "SIGKILL"; at: number }
        | { kind: "failed"; cause: unknown; at: number };
      cancel: { kind: "unrequested" } | { kind: "unavailable" }
        | { kind: "pending"; at: number } | { kind: "observed"; at: number }
        | { kind: "failed"; cause: unknown; at: number };
      exitObservation?: Promise<void>; cancelObservation?: Promise<void>;
    };
    const originalCaptures: OriginalCapture[] = [];
    let originalListing: Promise<{ kind: "complete"; hex: string } | { kind: "failed"; primary: ReturnType<typeof errorAccount>; ordered: ReturnType<typeof errorAccount>[] }> | undefined;
    const wrapper = new Proxy(nativeSpawn, { apply(target, receiver, argumentsList: unknown[]) {
      const argv = argumentsList[0];
      if (!Array.isArray(argv) || !argv.every(value => typeof value === "string")) throw new Error("Listing argv shape unsupported");
      dispatches.push([...argv]);
      const child: ReturnType<typeof nativeSpawn> = Reflect.apply(target, receiver, argumentsList);
      const tail = argv.slice(-7);
      if (tail.join("\0") !== ["--literal-pathspecs", "ls-tree", "-z", "--full-tree", commit, "--", "good.txt"].join("\0")) return child;
      selected += 1;
      // Retain ownership before any getter, reader acquisition or proxy construction can fail.
      const capture: OriginalCapture = { child, selectedAt: performance.now(), pid: null,
        stream: { kind: "registered" }, reader: { kind: "unacquired" }, acquiredBytes: 0, retainedBytes: 0,
        prefix: new Uint8Array(256), eof: false, readerDone: { kind: "unobserved" }, drain: "unstarted", drainFailures: [],
        exit: { kind: "unobserved" }, kill: { kind: "unrequested" }, cancel: { kind: "unrequested" } };
      originalCaptures.push(capture);
      try {
        const pid = child.pid;
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Original listing PID unavailable");
        capture.pid = pid;
        capture.exit = { kind: "pending" };
        let exited: Promise<number>;
        try { exited = child.exited; }
        catch (cause) { capture.exit = { kind: "failed", cause, at: performance.now() }; throw cause; }
        capture.exitObservation = Promise.resolve(exited).then(code => {
          capture.exit = { kind: "observed", code, at: performance.now() };
        }, cause => { capture.exit = { kind: "failed", cause, at: performance.now() }; });
        if (caseId === "native-control") return child;
        const stdout = child.stdout;
        if (!(stdout instanceof ReadableStream)) {
          capture.stream = { kind: "unavailable" };
          throw new Error("Original listing stream unavailable");
        }
        capture.stream = { kind: "acquired", value: stdout };
        capture.drain = "pending";
        originalListing = (async () => {
          let primary: unknown;
          try {
            const reader = stdout.getReader();
            capture.reader = { kind: "acquired", value: reader };
            while (true) {
              const part = await reader.read();
              if (part.done) {
                capture.readerDone = { kind: "observed", at: performance.now(), cancellationState: capture.cancel.kind };
                capture.eof = capture.cancel.kind === "unrequested";
                if (!capture.eof) throw new Error("Original listing drain ended after fixture cancellation; native EOF unestablished");
                break;
              }
              const next = capture.acquiredBytes + part.value.byteLength;
              if (!Number.isSafeInteger(next)) throw new Error("Original listing acquired count unrepresentable");
              capture.acquiredBytes = next;
              const retained = Math.min(part.value.byteLength, 256 - capture.retainedBytes);
              capture.prefix.set(part.value.subarray(0, retained), capture.retainedBytes);
              capture.retainedBytes += retained;
              if (capture.acquiredBytes > 256) throw new Error("Original listing capture exceeds fixture bound");
            }
          } catch (cause) { primary = cause; capture.drainFailures.push(cause); }
          finally {
            try {
              if (capture.reader.kind === "acquired" || capture.reader.kind === "release-failed") {
                capture.reader.value.releaseLock(); capture.reader = { kind: "released", value: capture.reader.value };
              }
            } catch (cause) {
              if (capture.reader.kind !== "unacquired") capture.reader = { kind: "release-failed", value: capture.reader.value };
              capture.drainFailures.push(cause);
              primary = primary === undefined ? cause : new AggregateError([primary, cause], "Original listing capture failures");
            }
          }
          capture.drain = primary === undefined ? "complete" : "failed";
          return primary === undefined ? { kind: "complete" as const, hex: Buffer.from(capture.prefix.subarray(0, capture.retainedBytes)).toString("hex") }
            : { kind: "failed" as const, primary: errorAccount(primary), ordered: primary instanceof AggregateError ? Array.from(primary.errors, errorAccount) : [] };
        })();
        const supplied = new ReadableStream<Uint8Array>({ start(controller) { if (bytes.byteLength > 0) controller.enqueue(bytes.slice()); controller.close(); } });
        return new Proxy(child, { get(actual, key) {
          if (key === "stdout") return supplied;
          if (key === "kill") return (signal: Parameters<typeof actual.kill>[0]) => actual.kill(signal);
          return Reflect.get(actual, key, actual);
        } });
      } catch (cause) { capture.interceptionFailure = cause; throw cause; }
    } });
    Object.defineProperty(Bun, "spawn", own === undefined
      ? { value: wrapper, configurable: true, writable: true, enumerable: false } : { ...own, value: wrapper });
    type Value = Awaited<ReturnType<typeof readQualifiedGitBlob>>;
    let outcome: { kind: "returned"; value: Value } | { kind: "threw"; cause: unknown };
    const cleanupFailures: unknown[] = [];
    try {
      try { outcome = { kind: "returned", value: await readQualifiedGitBlob(qualified, { commit, path: "good.txt" }, {
        onObservation: value => { observations.push({ ...value, argv: [...value.argv], termination: { ...value.termination },
          stdout: value.stdout === null ? null : { ...value.stdout }, stderr: value.stderr === null ? null : { ...value.stderr } }); },
      }, 3) }; } catch (cause) { outcome = { kind: "threw", cause }; }
    } finally {
      try {
        if (own === undefined) { if (!Reflect.deleteProperty(Bun, "spawn")) throw new Error("Listing spawn shadow removal failed"); }
        else Object.defineProperty(Bun, "spawn", own);
        restored = Object.getPrototypeOf(Bun) === prototype && Bun.spawn === nativeSpawn;
        if (!restored) throw new Error("Listing spawn restoration failed");
      } catch (cause) { cleanupFailures.push(cause); }
    }
    const captureSnapshot = (capture: OriginalCapture) => {
      let signal: { kind: "observed"; value: NonNullable<OriginalCapture["child"]["signalCode"]> }
        | { kind: "unreported"; value: "null" | "undefined" } | { kind: "failed"; cause: ReturnType<typeof errorAccount> };
      try {
        const value = capture.child.signalCode;
        signal = value === null || value === undefined ? { kind: "unreported", value: value === null ? "null" : "undefined" }
          : { kind: "observed", value };
      }
      catch (cause) { signal = { kind: "failed", cause: errorAccount(cause) }; }
      return { selectedAt: capture.selectedAt, observedAt: performance.now(), pid: capture.pid,
        streamState: capture.stream.kind, readerState: capture.reader.kind,
        acquiredBytes: capture.acquiredBytes, retainedBytes: capture.retainedBytes,
        prefixHex: Buffer.from(capture.prefix.subarray(0, capture.retainedBytes)).toString("hex"), eof: capture.eof,
        readerDone: { ...capture.readerDone },
        drain: capture.drain, drainFailures: capture.drainFailures.map(errorAccount),
        interceptionFailure: capture.interceptionFailure === undefined ? { kind: "absent" } : errorAccount(capture.interceptionFailure),
        exit: capture.exit.kind === "failed" ? { ...capture.exit, cause: errorAccount(capture.exit.cause) } : { ...capture.exit },
        signal, kill: capture.kill.kind === "failed" ? { ...capture.kill, cause: errorAccount(capture.kill.cause) } : { ...capture.kill },
        cancel: capture.cancel.kind === "failed" ? { ...capture.cancel, cause: errorAccount(capture.cancel.cause) } : { ...capture.cancel } };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drainObservationStartedAt = performance.now();
    let originalDrainCutoff: { deadline: number; observedAt: number; captures: ReturnType<typeof captureSnapshot>[] } | undefined;
    const nativeListing = originalListing === undefined ? { kind: "not-substituted" } : await Promise.race([
      originalListing.catch(cause => ({ kind: "observation-failed", cause: errorAccount(cause) })),
      new Promise<{ kind: "pending-at-fixture-cutoff"; observedAt: number; deadline: number }>(resolve => {
        timer = setTimeout(() => {
          originalDrainCutoff = { observedAt: performance.now(), deadline: drainObservationStartedAt + originalDrainAllowanceMs,
            captures: originalCaptures.map(captureSnapshot) };
          resolve({ kind: "pending-at-fixture-cutoff", observedAt: originalDrainCutoff.observedAt, deadline: originalDrainCutoff.deadline });
        }, originalDrainAllowanceMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    // Freeze the first drain-cutoff knowledge; subsequent cancellation/exit cannot revise it.
    const originalDrainFirstObservation = originalDrainCutoff?.captures ?? originalCaptures.map(captureSnapshot);
    const resourceCleanupFailures: { pid: number | null; stage: "kill" | "cancel" | "release"; cause: unknown }[] = [];
    const cleanupStartedAt = performance.now();
    const cleanupWaits: Promise<void>[] = [];
    let cleanupApplicable = false;
    for (const capture of originalCaptures) {
      if (caseId === "native-control" && capture.interceptionFailure === undefined) continue;
      if (capture.interceptionFailure === undefined && capture.drain === "complete") continue;
      cleanupApplicable = true;
      if (capture.exit.kind !== "observed") {
        try { capture.child.kill("SIGKILL"); capture.kill = { kind: "requested", signal: "SIGKILL", at: performance.now() }; }
        catch (cause) {
          capture.kill = { kind: "failed", cause, at: performance.now() };
          resourceCleanupFailures.push({ pid: capture.pid, stage: "kill", cause });
        }
      }
      try {
        const resource = capture.reader.kind === "acquired" || capture.reader.kind === "release-failed"
          ? capture.reader.value : capture.stream.kind === "acquired" ? capture.stream.value : undefined;
        if (resource === undefined) capture.cancel = { kind: "unavailable" };
        else {
          capture.cancel = { kind: "pending", at: performance.now() };
          const pending = resource.cancel();
          capture.cancelObservation = Promise.resolve(pending).then(() => {
            capture.cancel = { kind: "observed", at: performance.now() };
          }, cause => {
            capture.cancel = { kind: "failed", cause, at: performance.now() };
            resourceCleanupFailures.push({ pid: capture.pid, stage: "cancel", cause });
          });
          cleanupWaits.push(capture.cancelObservation);
        }
      } catch (cause) {
        capture.cancel = { kind: "failed", cause, at: performance.now() };
        resourceCleanupFailures.push({ pid: capture.pid, stage: "cancel", cause });
      }
      // A release attempt is independent of kill/cancel; neither establishes EOF or retirement.
      try {
        if (capture.reader.kind !== "unacquired" && capture.reader.kind !== "released") {
          capture.reader.value.releaseLock(); capture.reader = { kind: "released", value: capture.reader.value };
        }
      } catch (cause) {
        if (capture.reader.kind !== "unacquired") capture.reader = { kind: "release-failed", value: capture.reader.value };
        resourceCleanupFailures.push({ pid: capture.pid, stage: "release", cause });
      }
      if (capture.exitObservation !== undefined) cleanupWaits.push(capture.exitObservation);
    }
    if (originalListing !== undefined && cleanupApplicable)
      cleanupWaits.push(originalListing.then(() => {}, () => {}));
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let resourceCleanupCutoff: { deadline: number; observedAt: number; captures: ReturnType<typeof captureSnapshot>[];
      failures: { pid: number | null; stage: "kill" | "cancel" | "release"; cause: ReturnType<typeof errorAccount> }[] } | undefined;
    const resourceCleanupSettlement = !cleanupApplicable ? { kind: "not-applicable" }
      : await Promise.race([
        Promise.all(cleanupWaits).then(() => ({ kind: "observations-settled", observedAt: performance.now() })),
        new Promise<{ kind: "pending-at-fixture-cutoff"; observedAt: number; deadline: number }>(resolve => {
          cleanupTimer = setTimeout(() => {
            resourceCleanupCutoff = { observedAt: performance.now(), deadline: cleanupStartedAt + originalCleanupAllowanceMs,
              captures: originalCaptures.map(captureSnapshot),
              failures: resourceCleanupFailures.map(value => ({ pid: value.pid, stage: value.stage, cause: errorAccount(value.cause) })) };
            resolve({ kind: "pending-at-fixture-cutoff", observedAt: resourceCleanupCutoff.observedAt, deadline: resourceCleanupCutoff.deadline });
          }, originalCleanupAllowanceMs);
        }),
      ]);
    if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
    const originalAfterCleanupObservation = originalCaptures.map(captureSnapshot);
    const resourceCleanupFailureSnapshot = resourceCleanupFailures.map(value => ({ pid: value.pid, stage: value.stage, cause: errorAccount(value.cause) }));
    const originalCaptureFailures = originalCaptures.flatMap(capture => [
      ...(capture.interceptionFailure === undefined ? [] : [capture.interceptionFailure]), ...capture.drainFailures,
    ]);
    const error = outcome.kind === "threw" && outcome.cause instanceof GitReadRefusal ? outcome.cause : undefined;
    const evidence = {
      kind: "qualified-listing-control-v1", caseId, root, commit, tree, oid, selected,
      qualification: { scope: { ...qualified.scope }, objectFormat: qualified.objectFormat, executable: { ...qualified.executable },
        invocationPath: qualified.invocationPath, gitVersion: qualified.gitVersion, suppression: qualified.suppression,
        configurationSha256: qualified.configurationSha256, commandPrefix: [...qualified.commandPrefix] },
      injected: caseId !== "native-control", suppliedListingHex: bytes.toString("hex"), nativeListing, dispatches, observations, restored,
      originalDrainAllowanceMs, originalCleanupAllowanceMs, drainObservationStartedAt, cleanupStartedAt,
      originalDrainFirstObservation, originalDrainCutoff: originalDrainCutoff ?? { kind: "not-reached" },
      resourceCleanupSettlement, resourceCleanupCutoff: resourceCleanupCutoff ?? { kind: "not-reached" }, originalAfterCleanupObservation,
      resourceCleanupFailures: resourceCleanupFailureSnapshot,
      outcome: outcome.kind === "returned" ? { kind: "returned", ...outcome.value, bytes: Buffer.from(outcome.value.bytes).toString("hex") }
        : { kind: "threw", name: outcome.cause instanceof Error ? outcome.cause.name : "unsupported", message: outcome.cause instanceof Error ? outcome.cause.message : null,
          reason: error?.reason, detail: error?.detail, entry: error instanceof GitReadNonBlobEntry ? error.entry : null,
          cause: error?.cause instanceof AggregateError ? Array.from(error.cause.errors, errorAccount)
            : error?.cause === undefined ? { kind: "absent" } : errorAccount(error.cause),
          observerFailures: error?.observerFailures.map(errorAccount) ?? [], cleanupFailures: error?.cleanupFailures.map(errorAccount) ?? [] },
      cleanupFailures: cleanupFailures.map(errorAccount),
    };
    try {
      const text = JSON.stringify(evidence) + "\n";
      if (Buffer.byteLength(text) > 65536) throw new Error("Listing evidence exceeds fixed fixture publication bound");
      await new Promise<void>((resolve, reject) => { process.stdout.write(text, cause => cause ? reject(cause) : resolve()); });
    }
    catch (cause) { throw new AggregateError([...(outcome.kind === "threw" ? [outcome.cause] : []), ...originalCaptureFailures,
      ...cleanupFailures, ...resourceCleanupFailures.map(value => value.cause), cause], "Listing evidence publication failed"); }
    assert.equal(selected, 1); assert.equal(restored, true); assert.deepEqual(Object.getOwnPropertyDescriptor(Bun, "spawn"), own);
    assert.equal(cleanupFailures.length, 0);
    assert.equal(resourceCleanupFailures.length, 0);
    assert.equal(originalCaptureFailures.length, 0);
    assert.equal(cleanupApplicable, false);
    if (caseId !== "native-control") assert.deepEqual(nativeListing, { kind: "complete", hex: line("100644", "blob").toString("hex") });
    assert.deepEqual(observations.map(value => value.command), expected.kind === "blob" ? ["exact-commit", "source-entry", "blob-body"] : ["exact-commit", "source-entry"]);
    if (expected.kind === "blob") {
      assert.equal(outcome.kind, "returned");
      if (outcome.kind !== "returned") throw outcome.cause;
      assert.deepEqual(outcome.value, { commit, path: "good.txt", mode: expected.mode, oid, bytes: new Uint8Array(body) });
    } else {
      assert.equal(outcome.kind, "threw"); assert.ok(error);
      if (expected.kind === "non-blob") {
        assert.ok(error instanceof GitReadNonBlobEntry);
        assert.deepEqual(error.entry, { commit, path: "good.txt", oid, mode: expected.mode, type: expected.type });
      } else { assert.equal(error.reason, expected.reason); assert.equal(error.detail, expected.detail); }
    }
    // Failed assertions leave the owned synthetic root for enclosing custody, rather than hiding it.
    await rm(root, { recursive: true });
  });
}

if (activation !== undefined || selector !== undefined) {
  if (activation !== "listing-controls-v1" || selector === undefined) throw new Error("Qualified listing activation refused");
  const selected = cases.find(value => value === selector);
  if (selected === undefined) throw new Error("Qualified listing unknown case refused");
  await selectedListing(selected);
}
