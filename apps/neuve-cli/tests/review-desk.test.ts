// Why: a person who installed Neuve opens reviews through `neuve review desk`, served by the
// compiled CLI from the desk folder built once beside it, with no Bun on PATH and no build at run
// time. This builds the real desk and the real CLI, installs both into a scratch prefix, and runs
// the commands a newcomer runs: the setup-first refusals, the desk with its one-per-repository
// claim, the review's link onto it, and the refusals of a damaged desk. It needs no Graph engine:
// setup is recorded as setup records it.
import { expect, test } from "bun:test";
import { builtinModules } from "node:module";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { resolveStoreLocation } from "@neuve/records-core";
import { buildDesk, cliVersion } from "../scripts/build-desk.ts";
import { installLocalCli } from "../scripts/install-local.ts";
import { claimDesk, deskSocket, liveDesk } from "../src/review-desk-claim.ts";
import {
  deskManifestSchema,
  SOURCE_DESK_FIX,
} from "../src/review-desk-config.ts";
import { hashDesk } from "../src/review-desk-files.ts";
import { quote } from "../src/shell-quote.ts";
import { markSetUp } from "./fixtures/set-up.ts";

const CHECKOUT = resolve(import.meta.dir, "../../..");

type Check = { check: string; status: string; detail: string; fix?: string };
type Report = { checks: Check[]; exitCode: number };

test("an installed desk serves any set-up repository without Bun, one desk per repository", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desk-prefix-")));
  const repository = join(root, "project's folder");
  const home = join(root, "home");
  const prefix = join(root, "prefix");
  const pathBin = join(root, "path");
  const children = new Set<Bun.Subprocess>();
  const environment: Record<string, string> = {
    HOME: home,
    PATH: pathBin,
    TMPDIR: root,
    NEUVE_TEST_PROCESS: "1",
    NEUVE_BUDGET_DIRECTORY: join(root, "budget"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const run = async (
    command: string[],
    env: Record<string, string> = environment,
    cwd = repository,
  ) => {
    const child = Bun.spawn(command, {
      cwd,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
    });
    children.add(child);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    children.delete(child);
    return { stdout, stderr, code };
  };
  const cli = join(prefix, "bin/neuve");
  /** Starts a desk and waits for the address it prints. */
  const open = async (
    command: string[] = [cli, "review", "desk", "--port", "0"],
    cwd = repository,
  ) => {
    const child = Bun.spawn(command, {
      cwd,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.add(child);
    const errors = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    let output = "";
    const announced = (async () => {
      while (!output.includes("\n")) {
        const next = await reader.read();
        if (next.done) throw new Error(`The desk exited: ${await errors}`);
        output += new TextDecoder().decode(next.value);
      }
      const address = /^Review desk: (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(
        output,
      )?.[1];
      if (address === undefined) throw new Error(output);
      return address;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const address = await Promise.race([
        announced,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("The desk printed no address")),
            20_000,
          );
        }),
      ]);
      const stop = async (signal: NodeJS.Signals) => {
        child.kill(signal);
        const code = await child.exited;
        children.delete(child);
        reader.releaseLock();
        return { code, stderr: await errors };
      };
      return { address, stop };
    } finally {
      clearTimeout(timer);
    }
  };
  const answers = (address: string) =>
    fetch(address).then(
      () => true,
      () => false,
    );
  try {
    await mkdir(repository, { recursive: true });
    await mkdir(home);
    await mkdir(pathBin);
    for (const tool of ["git", "id", "dscl", "getent", "xcode-select"]) {
      const found = Bun.which(tool);
      if (found !== null) await symlink(found, join(pathBin, tool));
    }
    expect(Bun.which("bun", { PATH: pathBin })).toBeNull();
    const git = join(pathBin, "git");
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Test"],
      ["config", "user.email", "test@example.invalid"],
      ["commit", "--allow-empty", "-qm", "first"],
    ])
      expect((await run([git, ...args])).code).toBe(0);
    await writeFile(join(repository, "file.ts"), "export const a = 1;\n");
    expect((await run([git, "add", "file.ts"])).code).toBe(0);
    expect((await run([git, "commit", "-qm", "second"])).code).toBe(0);

    // The desk is built once, for no repository in particular.
    const built = join(root, "built/desk");
    await buildDesk({ out: built, scratch: root });
    const version = await cliVersion(CHECKOUT);
    expect(
      deskManifestSchema.parse(
        JSON.parse(await readFile(join(built, "desk.json"), "utf8")),
      ),
    ).toEqual({
      schemaVersion: 1,
      base: "/",
      version,
      sha256: await hashDesk(built),
    });
    // Its server carries every package inside it: it imports only the runtime's own modules.
    const imports = new Bun.Transpiler({ loader: "js" })
      .scanImports(await readFile(join(built, "server/server.js"), "utf8"))
      .map(({ path }) => path)
      .filter(
        (path) =>
          !path.startsWith("node:") &&
          !path.startsWith("bun:") &&
          !builtinModules.includes(path),
      );
    expect(imports).toEqual([]);

    const binary = join(root, "neuve");
    const compiled = await run(
      [
        process.execPath,
        join(CHECKOUT, "apps/neuve-cli/scripts/build.ts"),
        "--outfile",
        binary,
      ],
      { ...environment, PATH: process.env["PATH"] ?? "" },
      CHECKOUT,
    );
    expect(compiled.code, compiled.stderr).toBe(0);
    // The desk needs no Graph engine; the install only needs a file to put beside the CLI.
    const graph = join(root, "graph");
    await writeFile(graph, "#!/bin/sh\necho fixture\n");
    await chmod(graph, 0o755);
    await installLocalCli({
      cli: binary,
      graph,
      desk: built,
      prefix,
      graphVersion: "fixture",
      graphWorkspaceRevision: null,
    });
    await symlink(cli, join(pathBin, "neuve"));
    expect((await run([cli, "--version"])).stdout).toBe(`neuve ${version}\n`);

    // Setup first: both commands refuse before any store or job exists.
    for (const args of [
      ["review", "HEAD~1..HEAD", "--detach"],
      ["review", "desk", "--port", "0"],
    ]) {
      const refused = await run([cli, ...args]);
      expect({ code: refused.code, stderr: refused.stderr }).toEqual({
        code: 1,
        stderr: `Neuve isn't set up in ${repository}.\nRun neuve setup there first.\n`,
      });
      expect(
        await lstat(join(repository, ".git/neuve")).catch(() => undefined),
      ).toBeUndefined();
    }
    // Outside Git the review keeps its own refusal.
    const outside = await run([
      cli,
      "review",
      "HEAD~1..HEAD",
      "--detach",
      "--repo",
      home,
    ]);
    expect(outside.code).toBe(2);
    expect(outside.stderr).toContain("is not inside a git repository");
    await markSetUp(repository, {
      cliBinary: cli,
      graphBinary: join(prefix, "lib/neuve/entire-graph"),
    });

    // From source there is no prefix, so the desk must be named.
    const source = await run(
      [
        process.execPath,
        join(CHECKOUT, "apps/neuve-cli/src/cli.ts"),
        "review",
        "desk",
      ],
      { ...environment, PATH: process.env["PATH"] ?? "" },
    );
    expect({ code: source.code, stderr: source.stderr }).toEqual({
      code: 1,
      stderr: `NEUVE_DESK_DIR is unset, and neuve needs it when it runs from source.\n${SOURCE_DESK_FIX}\n`,
    });

    // A desk.json that doesn't hold is refused, with the reinstall command for this prefix.
    const installed = join(prefix, "lib/neuve/desk");
    const metadata = join(installed, "desk.json");
    const valid = await readFile(metadata, "utf8");
    const reinstall = `From your Neuve checkout, run bun run build:graph && bun run install:cli --prefix ${quote(prefix)}`;
    for (const invalid of [
      "{",
      JSON.stringify({ ...JSON.parse(valid), version: "0.0.0-other" }),
      JSON.stringify({ ...JSON.parse(valid), sha256: "0".repeat(64) }),
    ]) {
      await writeFile(metadata, invalid);
      const refused = await run([cli, "review", "desk", "--port", "0"]);
      expect({ code: refused.code, stderr: refused.stderr }).toEqual({
        code: 1,
        stderr: `The review desk at ${installed} is incomplete, changed or from another version.\n${reinstall}\n`,
      });
    }
    await writeFile(metadata, valid);

    const first = await open();
    const overview = await fetch(first.address);
    expect(overview.status).toBe(200);
    const page = await overview.text();
    expect(page).toContain("Neuve");
    // Every script, style, font and icon the page names loads from the installed desk.
    const assets = [
      ...new Set(
        [...page.matchAll(/(?:src|href)="(\/[^"]+)"/g)]
          .map((match) => match[1]!)
          .filter((path) => /\.[a-z0-9]+$/i.test(path)),
      ),
    ];
    expect(assets.length).toBeGreaterThan(2);
    expect(assets.some((path) => path.endsWith(".js"))).toBe(true);
    for (const path of assets)
      expect({
        path,
        status: (await fetch(new URL(path, first.address))).status,
      }).toEqual({ path, status: 200 });
    expect(overview.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(
      (await fetch(first.address, { headers: { Host: "foreign.invalid" } }))
        .status,
    ).toBe(403);
    // One desk per repository: a second call, from a subfolder, names the open one.
    await mkdir(join(repository, "nested"));
    const second = await run(
      [cli, "review", "desk", "--port", "0"],
      environment,
      join(repository, "nested"),
    );
    expect({ code: second.code, stdout: second.stdout }).toEqual({
      code: 0,
      stdout: `Review desk: ${first.address}\nIt is already open for this repository.\n`,
    });
    // A review prints its cycle on the open desk, and the link opens.
    const requested = await run([cli, "review", "HEAD~1..HEAD", "--detach"]);
    expect(requested.code, requested.stderr).toBe(0);
    const link = new RegExp(
      `^Review desk: (${first.address.replaceAll(".", "\\.")}cycles/[0-9A-Z]{26})$`,
      "m",
    ).exec(requested.stdout)?.[1];
    expect(link, requested.stdout).toBeDefined();
    expect((await fetch(link!)).status).toBe(200);
    expect(await first.stop("SIGINT")).toEqual({ code: 0, stderr: "" });
    expect(await answers(first.address)).toBe(false);

    // With no desk open, the review says how to open one, with --repo when it was given.
    const closed = await run([cli, "review", "HEAD~1..HEAD", "--detach"]);
    expect(closed.stdout).toEndWith("To open it, run neuve review desk.\n");
    const named = await run(
      [cli, "review", "HEAD~1..HEAD", "--detach", "--repo", repository],
      environment,
      home,
    );
    const command = named.stdout.trimEnd().split("\n").at(-1)!;
    expect(named.stdout).toContain("To open it, run:\n");
    expect(command).toBe(`neuve review desk --repo ${quote(repository)}`);
    // The printed command runs as printed, from anywhere.
    const followed = await open(
      ["/bin/sh", "-c", `exec ${command} --port 0`],
      home,
    );
    expect((await fetch(followed.address)).status).toBe(200);
    expect((await followed.stop("SIGTERM")).code).toBe(0);

    // A claim another process holds, before it serves, is waited for, not taken.
    const socket = await deskSocket(
      await Effect.runPromise(resolveStoreLocation(repository)),
    );
    const held = await claimDesk(socket);
    expect(held).toBeDefined();
    try {
      held!.publish("unreadable");
      const refused = await run([cli, "review", "desk", "--port", "0"]);
      expect({ code: refused.code, stderr: refused.stderr }).toEqual({
        code: 1,
        stderr:
          "A review desk for this repository is starting or stopping.\nWait a moment, then run:\nneuve review desk\n",
      });
    } finally {
      await held!.close();
    }
    // A desk killed outright leaves nothing to clean up: the next one claims at once.
    const killed = await open();
    await killed.stop("SIGKILL");
    const takeover = await open();
    expect((await fetch(takeover.address)).status).toBe(200);
    expect((await takeover.stop("SIGHUP")).code).toBe(0);

    // The default port gives way when it is taken, and says so.
    let blocker: Bun.Server<undefined> | undefined;
    try {
      try {
        blocker = Bun.serve({
          hostname: "127.0.0.1",
          port: 4141,
          fetch: () => new Response("taken"),
        });
      } catch {
        // Something else already holds it, which serves the case as well.
      }
      const moved = await open([cli, "review", "desk"]);
      expect(new URL(moved.address).port).not.toBe("4141");
      const stopped = await moved.stop("SIGINT");
      expect(stopped.stderr).toMatch(
        /^Port 4141 is in use\. The desk uses port \d+ instead\.\n$/,
      );
    } finally {
      await blocker?.stop(true);
    }

    // Doctor names this copy and any other one PATH could run.
    const doctor = await run([cli, "doctor", "--json"]);
    const { checks } = JSON.parse(doctor.stdout) as Report;
    expect(checks.find((check) => check.check === "review desk")).toEqual({
      check: "review desk",
      status: "ok",
      detail: installed,
    });
    expect(checks.find((check) => check.check === "setup")?.status).toBe("ok");
    expect(checks.find((check) => check.check === "PATH")?.status).toBe("ok");
    const other = join(home, ".local/bin/neuve");
    await mkdir(join(home, ".local/bin"), { recursive: true });
    await writeFile(other, "#!/bin/sh\necho other\n");
    await chmod(other, 0o755);
    const both = JSON.parse(
      (await run([cli, "doctor", "--json"])).stdout,
    ) as Report;
    expect(both.checks.find((check) => check.check === "PATH")).toMatchObject({
      status: "warning",
      detail: expect.stringContaining(`${other} (the install from source)`),
    });
    const shadowed = JSON.parse(
      (
        await run([cli, "doctor", "--json"], {
          ...environment,
          PATH: `${join(home, ".local/bin")}:${pathBin}`,
        })
      ).stdout,
    ) as Report;
    expect(shadowed.checks.find((check) => check.check === "PATH")).toEqual({
      check: "PATH",
      status: "missing",
      detail: `neuve on PATH runs ${other} (the install from source), not this copy`,
      fix: `export PATH=${quote(join(prefix, "bin"))}:"$PATH", or remove the other copy`,
    });
    expect(shadowed.exitCode).toBe(1);

    // A desk changed after the install is refused before anything of it runs.
    await writeFile(
      join(installed, "server/server.js"),
      'throw new Error("a damaged desk must not be loaded");',
    );
    const damaged = await run([cli, "review", "desk", "--port", "0"]);
    const detail = `The review desk at ${installed} is incomplete, changed or from another version.`;
    expect(damaged).toEqual({
      code: 1,
      stdout: "",
      stderr: `${detail}\n${reinstall}\n`,
    });
    expect(await liveDesk(socket)).toBeUndefined();
    const after = JSON.parse(
      (await run([cli, "doctor", "--json"])).stdout,
    ) as Report;
    expect(after.checks.find((check) => check.check === "review desk")).toEqual(
      {
        check: "review desk",
        status: "missing",
        detail,
        fix: reinstall,
      },
    );
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all([...children].map((child) => child.exited));
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
