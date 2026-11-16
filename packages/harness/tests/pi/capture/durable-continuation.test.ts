import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { readSessionDump } from "../../../src/session-dump.ts";
import {
  readDump,
  encodeManifest,
  SOURCE_VALIDATION_FILE,
} from "../../../src/pi/capture/archive.ts";
import { sha256Of } from "../../../src/pi/capture/journal.ts";
const portableTamper = async (source: string, target: string, kind: string) => {
  const bundle = await readDump(source),
    files = new Map(bundle.files);
  const proof = JSON.parse(
    new TextDecoder().decode(files.get(SOURCE_VALIDATION_FILE)),
  );
  const manifest = { ...bundle.manifest };
  if (kind === "policy") proof.version = 9;
  if (kind === "remove") delete proof.retainedPrefixCalls;
  if (kind === "extra") {
    proof.retainedPrefixCalls.push("invented-call");
    manifest.retainedPrefixCalls = [...proof.retainedPrefixCalls];
  }
  if (kind === "uncovered") proof.retainedPrefixCalls = [];
  if (kind === "source") proof.source = "records:" + "0".repeat(64);
  if (kind === "session") {
    const name = [...files.keys()].find((name) => name.startsWith("sessions/"));
    if (!name) throw new Error("session missing");
    const value = JSON.parse(new TextDecoder().decode(files.get(name)));
    value.conversationId += 100000;
    files.set(name, new TextEncoder().encode(JSON.stringify(value)));
  }
  if (kind === "complete") {
    const run = JSON.parse(new TextDecoder().decode(files.get("run.json")));
    run.complete = true;
    run.gaps = [];
    files.set("run.json", new TextEncoder().encode(JSON.stringify(run)));
  }
  if (kind === "projection") proof.projections = [];
  else if (kind === "session" || kind === "complete")
    proof.projections = proof.projections.map((file: { name: string }) => ({
      ...file,
      sha256: sha256Of(files.get(file.name)!),
      size: files.get(file.name)!.byteLength,
    }));
  files.set(
    SOURCE_VALIDATION_FILE,
    new TextEncoder().encode(JSON.stringify(proof)),
  );
  manifest.files = manifest.files.map((file) => ({
    ...file,
    sha256: sha256Of(files.get(file.name)!),
    size: files.get(file.name)!.byteLength,
  }));
  const bytes = encodeManifest(manifest);
  mkdirSync(join(target, "objects"), { recursive: true });
  for (const file of manifest.files)
    writeFileSync(join(target, "objects", file.sha256), files.get(file.name)!);
  writeFileSync(join(target, "manifest.json"), bytes);
  writeFileSync(
    join(target, "export.json"),
    JSON.stringify({ ...bundle.record, manifest: sha256Of(bytes) }),
  );
  return Effect.runPromise(readSessionDump(target));
};
const directory = mkdtempSync(join(tmpdir(), "durable-continuation-"));
afterAll(() => {
  if (process.env["NEUVE_CAPTURE_INTEGRITY_KEEP"] === "1")
    console.log(`Durable continuation evidence: ${directory}`);
  else rmSync(directory, { recursive: true, force: true });
});
const child = fileURLToPath(
  new URL("./durable-continuation-child.ts", import.meta.url),
);
for (const variant of [
  "safe",
  "old",
  "current",
  "native-only",
  "duplicate",
] as const)
  test(`genuine SIGKILL and rotated ${variant} continuation retains truthful history`, async () => {
    const root = join(directory, variant);
    mkdirSync(root);
    const first = Bun.spawn([process.execPath, child, "first", root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const errors = new Response(first.stderr).text();
    const until = Date.now() + 10000;
    while (!existsSync(join(root, "ready.json")) && Date.now() < until) {
      if (first.exitCode !== null) throw new Error(await errors);
      await Bun.sleep(10);
    }
    expect(existsSync(join(root, "ready.json"))).toBe(true);
    first.kill("SIGKILL");
    await first.exited;
    const restarted = Bun.spawn(
      [
        process.execPath,
        child,
        variant === "native-only" ? "native-only" : "second",
        root,
        variant,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [output, stderr, code] = await Promise.all([
      new Response(restarted.stdout).text(),
      new Response(restarted.stderr).text(),
      restarted.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(output);
    expect(result.requests).toBe(
      variant === "native-only" ? 0 : variant === "safe" ? 2 : 1,
    );
    expect(result.exported).toBe(
      variant === "safe" || variant === "native-only",
    );
    if (variant === "safe") {
      expect(result.complete).toBe(false);
      expect(
        result.gaps.some(
          (gap: { code: string }) => gap.code === "journal-interrupted",
        ),
      ).toBe(true);
      expect(result.children).toBe(1);
      expect(result.hasHistoricalInput).toBe(true);
      expect(result.hasNewToolResult).toBe(true);
      expect(result.artifacts).toContain("safe-after-restart.txt");
    }
    if (variant === "old")
      expect(
        readFileSync(join(root, "source/capture/events.jsonl"), "utf8"),
      ).not.toContain("new output old synthetic-lease-first");
  }, 20000);

test("a clean historical close and fresh safe continuation retains complete public history", async () => {
  const root = join(directory, "clean");
  mkdirSync(root);
  for (const mode of ["first-clean", "second"]) {
    const process = Bun.spawn(
      [Bun.which("bun") ?? "bun", child, mode, root, "safe"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.exported).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.hasHistoricalInput).toBe(true);
    if (mode === "second") {
      expect(result.children).toBe(1);
      expect(result.hasNewToolResult).toBe(true);
      expect(result.artifacts).toContain("safe-after-restart.txt");
    }
  }
}, 20_000);

for (const crash of ["crash-before-registration", "crash-after-registration"])
  test(`actual SIGKILL ${crash} sends no HTTP and resumes with the durable authority`, async () => {
    const root = join(directory, crash);
    mkdirSync(root);
    const first = Bun.spawn([process.execPath, child, crash, root], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await first.exited).toBe(137);
    expect(await new Response(first.stderr).text()).toBe("");
    expect(readFileSync(join(root, crash + "-requests.json"), "utf8")).toBe(
      "0",
    );
    const restarted = Bun.spawn(
      [process.execPath, child, "second", root, "safe"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(restarted.stdout).text(),
      new Response(restarted.stderr).text(),
      restarted.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.exported).toBe(true);
    expect(result.complete).toBe(false);
    expect(result.hasHistoricalInput).toBe(true);
    expect(result.requests).toBe(3);
  }, 20000);

test("managed artifact admission privately owns bytes before asynchronous inspection and export", async () => {
  const root = join(directory, "buffer");
  mkdirSync(root);
  for (const mode of ["first-clean", "second"]) {
    const process = Bun.spawn(
      [
        Bun.which("bun") ?? "bun",
        child,
        mode,
        root,
        mode === "second" ? "buffer" : "safe",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.exported).toBe(true);
    expect(result.complete).toBe(true);
    if (mode === "second") {
      expect(result.mutatedDuringExport).toBe(true);
      expect(result.callerBuffer).toBe("synthetic-lease-first");
      expect(result.admittedArtifact).toBe("safe admitted artifact");
      expect(result.requests).toBe(1);
    }
  }
}, 20_000);

for (const mode of [
  "first-partial",
  "first-partial-split",
  "first-partial-arguments",
  "first-partial-arguments-split",
  "first-partial-arguments-invalid",
])
  test(`killed ${mode} preserves safe prefixes and refuses split historical credentials`, async () => {
    const root = join(directory, mode);
    mkdirSync(root);
    const first = Bun.spawn([process.execPath, child, mode, root, "safe"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const errors = new Response(first.stderr).text();
    const deadline = Date.now() + 10000;
    while (
      !existsSync(join(root, "ready.json")) &&
      first.exitCode === null &&
      Date.now() < deadline
    )
      await Bun.sleep(5);
    if (!existsSync(join(root, "ready.json"))) throw new Error(await errors);
    first.kill("SIGKILL");
    await first.exited;
    const before = readFileSync(
      join(root, "source/capture/events.jsonl"),
      "utf8",
    )
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line).event);
    const request = before
      .filter((event) => event.type === "model.request")
      .at(-1);
    const callId = request.callId;
    expect(
      before.filter(
        (event) =>
          event.type === "model.event" &&
          event.callId === callId &&
          event.name === "credential_guard" &&
          event.data.status === "observed",
      ),
    ).toHaveLength(0);
    expect(
      before.filter(
        (event) => event.type === "model.end" && event.callId === callId,
      ),
    ).toHaveLength(0);
    const second = Bun.spawn(
      [process.execPath, child, "second", root, "continuation"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(second.stdout).text(),
      new Response(second.stderr).text(),
      second.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.exported).toBe(
      !mode.includes("split") && !mode.includes("invalid"),
    );
    if (!mode.includes("split") && !mode.includes("invalid")) {
      expect(result.complete).toBe(false);
      expect(result.portableRead).toBe(true);
      expect(result.portableComplete).toBe(false);
      if (mode === "first-partial")
        for (const kind of [
          "remove",
          "extra",
          "uncovered",
          "source",
          "session",
          "complete",
          "projection",
          "policy",
        ])
          await expect(
            portableTamper(
              result.portableDirectory,
              join(root, "tamper-" + kind),
              kind,
            ),
          ).rejects.toBeDefined();
      expect(result.retainedPrefixCertificates).toBeGreaterThan(0);
      expect(
        result.gaps.some(
          (gap: { code: string }) => gap.code === "journal-interrupted",
        ),
      ).toBe(true);
    } else if (mode.includes("invalid"))
      expect(result.reason).toContain("retained-argument-escape");
    else expect(result.reason).toContain("credential exposure");
    const after = readFileSync(
      join(root, "source/capture/events.jsonl"),
      "utf8",
    )
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line).event);
    expect(
      after.filter(
        (event) =>
          event.type === "model.event" &&
          event.callId === callId &&
          event.name === "credential_guard" &&
          event.data.status === "observed",
      ),
    ).toHaveLength(0);
    expect(
      after.filter(
        (event) => event.type === "model.end" && event.callId === callId,
      ),
    ).toHaveLength(0);
  }, 20000);
