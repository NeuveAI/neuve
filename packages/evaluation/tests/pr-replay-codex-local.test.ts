// Why: the Mac fallback must keep the treatment write boundary, isolate each call's home,
// freeze the judged install and serialize one rotating sign-in across real processes.
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  CANARY_PROMPTS,
  DISABLED_FEATURES,
  MAC_DISABLED_FEATURES,
  PINNED_CODEX_VERSION,
  PINNED_MAC_CODEX_VERSION,
  PINNED_MAC_INSTALL_HASH,
  SAFE_ENABLED_FEATURES,
  installHash,
} from "../src/pr-replay/codex.ts";

const environment = { ...process.env };
let temporary: string | undefined;
afterEach(() => {
  process.env = { ...environment };
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

const entry = {
  slug: "gpt-6.1-sol",
  tool_mode: "code_mode_only",
  experimental_supported_tools: [],
  upgrade: null,
  shell_type: "unified_exec",
  apply_patch_tool_type: "freeform",
  supports_search_tool: true,
  node_repl_disabled: false,
  multi_agent_version: "v2",
  web_search_tool_type: "text_and_image",
};
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

const setup = async ({ legacy = false } = {}) => {
  temporary = mkdtempSync(join(tmpdir(), "replay-local-"));
  const base = temporary;
  const research = join(base, "research"),
    dataset = join(base, "dataset"),
    treatment = join(base, "treatment");
  const home = join(legacy ? research : dataset, "codex-home");
  const install = join(dataset, "tools", "codex-0.166.0-alpha.6");
  for (const path of [
    research,
    home,
    install,
    treatment,
    join(legacy ? research : dataset, "codex-catalog"),
  ])
    mkdirSync(path, { recursive: true });
  const binary = join(install, "codex");
  const features = [
    ...(legacy ? DISABLED_FEATURES : MAC_DISABLED_FEATURES).map(
      (f) => `${f} stable false`,
    ),
    ...[...SAFE_ENABLED_FEATURES].map((f) => `${f} stable true`),
  ].join("\n");
  writeFileSync(
    join(dataset, "version"),
    legacy ? PINNED_CODEX_VERSION : PINNED_MAC_CODEX_VERSION,
  );
  writeFileSync(join(dataset, "features"), features);
  // The fixture uses only synthetic files and the old gate tests' external-binary boundary.
  writeFileSync(
    binary,
    `#!/bin/sh
out=''; prev=''
for a in "$@"; do
  [ "$a" = '--version' ] && exec cat ${quote(join(dataset, "version"))}
  [ "$a" = 'features' ] && { mkdir -p "$CODEX_HOME/probe-cache"; exec cat ${quote(join(dataset, "features"))}; }
  [ "$prev" = '--output-last-message' ] && out="$a"
  prev="$a"
done
[ "$HOME" = "$CODEX_HOME" ] || exit 8
${legacy ? "" : '[ -e "$CODEX_HOME/stale" ] && exit 9'}
printf '%s\\n' "$@" > ${quote(join(dataset, "exec-args"))}
cat >/dev/null
if [ -f ${quote(join(dataset, "pause"))} ]; then
  echo $$ > ${quote(join(dataset, "exec-pid"))}
  sleep 60
fi
mkdir -p "$CODEX_HOME/sessions"
ln -s ${quote(research)} "$CODEX_HOME/sessions/outside"
echo scratch > "$CODEX_HOME/config.toml"
if [ -f ${quote(join(dataset, "download"))} ]; then cp ${quote(join(dataset, "download"))} "$CODEX_HOME/models_cache.json"; fi
echo '{"ok":true}' > "$out"
echo '{"type":"thread.started"}'
echo '{"type":"turn.completed"}'
`,
  );
  chmodSync(binary, 0o755);
  process.env["NEUVE_RESEARCH_ROOT"] = research;
  process.env["NEUVE_DATASET_ROOT"] = dataset;
  process.env["NEUVE_TREATMENT_ROOT"] = treatment;
  process.env["NEUVE_CODEX_INSTALL_ROOT"] = install;
  process.env["NEUVE_CODEX_BINARY"] = binary;
  process.env["NEUVE_LABEL_RUNNER"] = "local";
  if (legacy) {
    delete process.env["NEUVE_DATASET_ROOT"];
    delete process.env["NEUVE_TREATMENT_ROOT"];
    process.env["NEUVE_LABEL_CODEX_HOME"] = home;
  } else delete process.env["NEUVE_LABEL_CODEX_HOME"];
  const catalog = JSON.stringify({ models: [entry] });
  writeFileSync(
    join(legacy ? research : dataset, "codex-catalog", "gpt-6.1-sol.json"),
    catalog,
  );
  writeFileSync(join(home, "models_cache.json"), catalog);
  writeFileSync(join(research, "sentinel"), "unchanged");
  // Production has no pin override. A private source copy pins this test's fake install instead.
  // All imports still point to the real implementations, including treatment writes and syscalls.
  const source = resolve(import.meta.dir, "../src/pr-replay/codex.ts");
  const fixture = join(base, "codex-fixture.ts");
  writeFileSync(
    fixture,
    readFileSync(source, "utf8")
      .replace(PINNED_MAC_INSTALL_HASH, installHash())
      .replaceAll(
        /from "(\.[^"]+)"/g,
        (_, relative: string) =>
          `from ${JSON.stringify(resolve(dirname(source), relative))}`,
      )
      .replaceAll("import.meta.dir", JSON.stringify(dirname(source)))
      .replace(
        'from "zod"',
        `from ${JSON.stringify(resolve(import.meta.dir, "../../../node_modules/zod/index.js"))}`,
      ),
  );
  const runner: typeof import("../src/pr-replay/codex.ts") = await import(
    fixture
  );
  const runDir = join(legacy ? research : treatment, "canary");
  mkdirSync(runDir);
  const run = {
    runDir,
    log: join(legacy ? research : treatment, "canary.jsonl"),
    prompt: "fixture",
    schema: { type: "object" },
    effort: "low" as const,
  };
  return {
    base,
    dataset,
    research,
    treatment,
    home,
    install,
    binary,
    fixture,
    runner,
    run,
  };
};

// Why: legacy labelling shares persistent sessions and must never reset that home.
test("the legacy local path preserves every existing home file and its receipt contract", async () => {
  const f = await setup({ legacy: true });
  const kept: ReadonlyArray<readonly [string, string]> = [
    ["auth.json", '{"fixture":"synthetic sign-in"}'],
    ["history.jsonl", "synthetic history"],
    ["memories/notes.md", "synthetic memory"],
    ["logs/codex.log", "synthetic log"],
    ["sessions/resume.jsonl", "synthetic session"],
    ["skills/example/SKILL.md", "synthetic skill"],
    ["plugins/example/plugin.json", "synthetic plugin"],
    ["stale/keep", "synthetic existing file"],
    [
      "models_cache.json",
      readFileSync(join(f.home, "models_cache.json"), "utf8"),
    ],
  ];
  for (const [name, content] of kept) {
    const path = join(f.home, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  symlinkSync(f.research, join(f.home, "existing-link"));
  const result = await f.runner.runToolless(f.run, []);
  expect(result.failure).toBeNull();
  expect(result.output).toEqual({ ok: true });
  for (const [name, content] of kept)
    expect(readFileSync(join(f.home, name), "utf8")).toBe(content);
  expect(readlinkSync(join(f.home, "existing-link"))).toBe(f.research);
  expect(result.receipt.codex).toBe(PINNED_CODEX_VERSION);
  expect(result.receipt.codexCreated).toEqual([]);
  expect(result.receipt.codexHomeBefore).toBeNull();
  expect(result.receipt.codexInstall).toBeUndefined();
  expect(existsSync(join(f.research, "local-labeller.lock"))).toBe(false);
});

// Why: a dataset reset must preserve a plain sign-in byte for byte.
test("a plain synthetic auth.json survives dataset labelling unchanged", async () => {
  const f = await setup();
  const auth = Buffer.from('{"fixture":"synthetic sign-in"}\n');
  writeFileSync(join(f.home, "auth.json"), auth);
  mkdirSync(join(f.home, "stale"));
  const result = await f.runner.runToolless(f.run, []);
  expect(result.failure).toBeNull();
  expect(result.output).toEqual({ ok: true });
  expect(readFileSync(join(f.home, "auth.json"))).toEqual(auth);
  expect(readdirSync(f.home).sort()).toEqual([
    "auth.json",
    "models_cache.json",
  ]);
});

// Why: a fake feature list cannot prove that exec receives the tool-disabling flags.
test("the dataset exec receives every Mac disabled-feature flag", async () => {
  const f = await setup();
  const result = await f.runner.runToolless(f.run, []);
  expect(result.failure).toBeNull();
  const args = readFileSync(join(f.dataset, "exec-args"), "utf8")
    .trimEnd()
    .split("\n");
  expect(args[0]).toBe("exec");
  for (const feature of MAC_DISABLED_FEATURES) {
    const flag = `features.${feature}=false`;
    expect(args.filter((arg) => arg === flag)).toHaveLength(1);
    expect(args[args.indexOf(flag) - 1]).toBe("-c");
    expect(args).not.toContain(`features.${feature}=true`);
  }
});

// Why: incomplete holder metadata must not strand an unlocked sign-in after a crash.
test("an unlocked malformed holder record is replaced and cleared", async () => {
  const f = await setup();
  const lock = join(f.dataset, "local-labeller.lock");
  for (const record of ['{"pid":', '{"pid":"invalid"}', "null"]) {
    writeFileSync(lock, record);
    expect(
      await f.runner.withLocalLabellerLock(async () => {
        const holder = JSON.parse(readFileSync(lock, "utf8"));
        expect(holder.pid).toBe(process.pid);
        expect(holder.started).toMatch(/^[0-9.]+$/);
        return "taken over";
      }),
    ).toBe("taken over");
    expect(readFileSync(lock, "utf8")).toBe("");
  }
});

test("local treatment canaries write only in the treatment and dataset and reset before and after", async () => {
  const f = await setup();
  mkdirSync(join(f.home, "stale"));
  symlinkSync(f.research, join(f.home, "stale", "outside"));
  for (const prompt of Object.values(CANARY_PROMPTS)) {
    const result = await f.runner.runToolless({ ...f.run, prompt }, []);
    expect(result.failure).toBeNull();
    expect(result.output).toEqual({ ok: true });
    expect(result.receipt.where).toBe("local");
    expect(result.receipt.codex).toBe(PINNED_MAC_CODEX_VERSION);
    expect(result.receipt.codexInstall).toEqual({
      root: f.install,
      sha256: installHash(),
    });
    expect(result.receipt.codexCreated).toContain("sessions");
    expect(result.receipt.codexCreated).toContain("config.toml");
    expect(readdirSync(f.home)).toEqual(["models_cache.json"]);
  }
  expect(readFileSync(join(f.research, "sentinel"), "utf8")).toBe("unchanged");
  expect(readdirSync(f.research)).toEqual(["sentinel"]);
  expect(readdirSync(f.treatment).sort()).toEqual(["canary", "canary.jsonl"]);
  expect(existsSync(join(f.run.runDir, "output.json"))).toBe(true);
  const before = readdirSync(f.dataset).sort();
  await expect(
    f.runner.runToolless({ ...f.run, log: join(f.research, "escape") }, []),
  ).rejects.toThrow("treatment only");
  expect(readdirSync(f.dataset).sort()).toEqual(before);
});

test("a home, sign-in, downloaded or pinned catalog reached through a link or folder refuses", async () => {
  const f = await setup();
  renameSync(f.home, `${f.home}-kept`);
  symlinkSync(`${f.home}-kept`, f.home);
  await expect(f.runner.runToolless(f.run, [])).rejects.toThrow("never a link");
  rmSync(f.home);
  renameSync(`${f.home}-kept`, f.home);
  for (const name of ["auth.json", "models_cache.json"]) {
    const path = join(f.home, name);
    const saved =
      name === "models_cache.json" ? readFileSync(path, "utf8") : null;
    rmSync(path, { force: true });
    for (const link of [true, false]) {
      if (link) symlinkSync(join(f.research, "sentinel"), path);
      else mkdirSync(path);
      await expect(f.runner.runToolless(f.run, [])).rejects.toThrow(
        "link or a folder",
      );
      rmSync(path, { recursive: true });
    }
    if (saved !== null) writeFileSync(path, saved);
  }
  const pinned = join(f.dataset, "codex-catalog", "gpt-6.1-sol.json");
  rmSync(pinned);
  symlinkSync(join(f.research, "sentinel"), pinned);
  await expect(f.runner.runToolless(f.run, [])).rejects.toThrow(
    "not a plain file",
  );
  expect(readFileSync(join(f.research, "sentinel"), "utf8")).toBe("unchanged");
  process.env["NEUVE_DATASET_ROOT"] = process.env["HOME"];
  expect(() => f.runner.labelCodexHome()).toThrow("owner's HOME");
  symlinkSync(f.dataset, join(f.base, "dataset-link"));
  process.env["NEUVE_DATASET_ROOT"] = join(f.base, "dataset-link");
  expect(() => f.runner.labelCodexHome()).toThrow("never a link");
  process.env["NEUVE_DATASET_ROOT"] = f.dataset;
});

test("the Mac pin refuses another version, a changed install and newly enabled features", async () => {
  const f = await setup();
  writeFileSync(join(f.dataset, "version"), "codex-cli 9.9.9");
  await expect(f.runner.runToolless(f.run, [])).rejects.toThrow(
    "not codex-cli 0.166.0-alpha.6",
  );
  writeFileSync(join(f.dataset, "version"), PINNED_MAC_CODEX_VERSION);
  const features = readFileSync(join(f.dataset, "features"), "utf8");
  writeFileSync(
    join(f.dataset, "features"),
    `${features}\nunknown_tool stable true`,
  );
  await expect(f.runner.runToolless(f.run, [])).rejects.toThrow(
    "not known to be safe",
  );
  writeFileSync(
    join(f.dataset, "features"),
    features.replace(
      "plugin_discovery_prefetch stable false",
      "plugin_discovery_prefetch stable true",
    ),
  );
  await expect(f.runner.runToolless(f.run, [])).rejects.toThrow(
    "not list these features as off",
  );
  writeFileSync(join(f.dataset, "features"), features);
  writeFileSync(join(f.install, "changed"), "changed");
  await expect(f.runner.runToolless(f.run, [])).rejects.toThrow(
    "not the pinned Mac build",
  );
  expect(existsSync(join(f.run.runDir, "output.json"))).toBe(false);
  expect(DISABLED_FEATURES).not.toContain("plugin_discovery_prefetch");
});

test("a second process refuses a held lock, death permits takeover, and a live recorded holder refuses", async () => {
  const f = await setup();
  const script = `import {withLocalLabellerLock} from ${JSON.stringify(f.fixture)}; await withLocalLabellerLock(async()=>{console.log("held");await Bun.sleep(60000)});`;
  const holder = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = holder.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain("held");
    reader.releaseLock();
    const record = JSON.parse(
      readFileSync(join(f.dataset, "local-labeller.lock"), "utf8"),
    );
    expect(record.pid).toBe(holder.pid);
    expect(record.started).toMatch(/^[0-9.]+$/);
    await expect(
      f.runner.withLocalLabellerLock(async () => true),
    ).rejects.toThrow("the local labeller is busy");
    holder.kill("SIGKILL");
    await holder.exited;
    expect(await f.runner.withLocalLabellerLock(async () => "taken over")).toBe(
      "taken over",
    );
    let live = "";
    await f.runner.withLocalLabellerLock(async () => {
      live = readFileSync(join(f.dataset, "local-labeller.lock"), "utf8");
    });
    writeFileSync(join(f.dataset, "local-labeller.lock"), live);
    await expect(
      f.runner.withLocalLabellerLock(async () => true),
    ).rejects.toThrow("still holds this sign-in");
    // Same PID with a different birth time names a process that is gone, even if its PID was reused.
    writeFileSync(
      join(f.dataset, "local-labeller.lock"),
      JSON.stringify({ pid: process.pid, started: "0" }),
    );
    expect(await f.runner.withLocalLabellerLock(async () => "reused PID")).toBe(
      "reused PID",
    );
  } finally {
    holder.kill();
    await holder.exited;
  }
});

// Why: a parent killed during exec must not release a sign-in while its Codex child is alive.
test("a Codex child retains the lock after its orchestrator is killed", async () => {
  const f = await setup();
  writeFileSync(join(f.dataset, "pause"), "");
  const script = `import {runToolless} from ${JSON.stringify(f.fixture)}; await runToolless(${JSON.stringify(f.run)},[]);`;
  const parent = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  let child: number | undefined;
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(join(f.dataset, "exec-pid")) && Date.now() < deadline)
      await Bun.sleep(20);
    expect(existsSync(join(f.dataset, "exec-pid"))).toBe(true);
    child = Number(readFileSync(join(f.dataset, "exec-pid"), "utf8"));
    parent.kill("SIGKILL");
    await parent.exited;
    await expect(
      f.runner.withLocalLabellerLock(async () => true),
    ).rejects.toThrow("the local labeller is busy");
    process.kill(-child, "SIGKILL");
    child = undefined;
    let taken = false;
    for (let i = 0; i < 100 && !taken; i++) {
      try {
        taken = await f.runner.withLocalLabellerLock(async () => true);
      } catch (error) {
        if (!(
          error instanceof Error &&
          error.message.includes("the local labeller is busy")
        ))
          throw error;
        await Bun.sleep(10);
      }
    }
    expect(taken).toBe(true);
  } finally {
    parent.kill();
    await parent.exited;
    if (child !== undefined) {
      try {
        process.kill(-child, "SIGKILL");
      } catch {
        /* Already exited. */
      }
    }
  }
});

// Why: fresh login need not download a catalog; any first download must still pass the tool gate.
test("pinning stays in the dataset and a first download is checked before accepting an answer", async () => {
  const f = await setup();
  f.runner.pinCatalog(f.home);
  expect(f.runner.pinnedCatalogPath()).toBe(
    join(f.dataset, "codex-catalog", "gpt-6.1-sol.json"),
  );
  expect(readdirSync(f.research)).toEqual(["sentinel"]);
  rmSync(join(f.home, "models_cache.json"));
  writeFileSync(
    join(f.dataset, "download"),
    JSON.stringify({ models: [entry] }),
  );
  const first = await f.runner.runToolless(f.run, []);
  expect(first.failure).toBeNull();
  expect(first.output).toEqual({ ok: true });
  writeFileSync(
    join(f.dataset, "download"),
    JSON.stringify({ models: [{ ...entry, tool_mode: "direct" }] }),
  );
  const unsafe = await f.runner.runToolless(f.run, []);
  expect(unsafe.output).toBeNull();
  expect(unsafe.failure).toContain("model catalog failed after the run");
  expect(existsSync(join(f.run.runDir, "output.json"))).toBe(false);
  // A successful previous log is retained by the old contract; this call never replaces it.
  expect(unsafe.receipt.eventProblems).toBeGreaterThan(0);
});
