// Why: the installer is the only path a release reaches a friend's Mac. These cases pin what it must
// never get wrong, on tiny releases whose CLI is a shell script so each case takes milliseconds:
// the checksum and archive checks before anything is written, the refusals that protect a source
// copy and the shared .local, the one marked PATH line, rollback after a failure or a signal, the
// downgrade refusal, the same-version no-op, the dry run writing nothing, the quarantine notice,
// which neuve a terminal runs, and the skills offer. Each runs under sh and, where present, dash.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  ASSET,
  readLaunchdProgram,
  scratchDirectory,
  TARGET,
  install,
  installer,
  removeAllScratch,
  run,
  scratch,
  snapshot,
  stubs,
  tinyRelease,
} from "./release-fixture.ts";
import { stampInstaller } from "../../scripts/release/release.ts";

afterEach(removeAllScratch, 60_000);

const shells = ["sh", ...(Bun.which("dash") ? ["dash"] : [])];

const ok = (result: Awaited<ReturnType<typeof run>>) =>
  expect(result, result.output).toMatchObject({ code: 0 });
const refused = (result: Awaited<ReturnType<typeof run>>, message: string) => {
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain(message);
};
const read = (path: string) => readFile(path, "utf8");
// Renames bin/neuve to a member that climbs out of the release folder. bsdtar (macOS) renames with
// -s; GNU tar (Linux) reads -s as --same-order, renames with --transform, and keeps the `..` only
// with -P.
const escapeMember = Bun.spawnSync(["tar", "--version"])
  .stdout.toString()
  .includes("GNU tar")
  ? [
      "-P",
      `--transform=s,^neuve-${TARGET}/bin/neuve$,neuve-${TARGET}/../escape,`,
    ]
  : ["-s", `,^neuve-${TARGET}/bin/neuve$,neuve-${TARGET}/../escape,`];
const MARKER = "# Added by the Neuve installer";

describe.each(shells)("installer under %s", (shell) => {
  test("installs a release, writes one PATH block, and says what comes next", async () => {
    const context = await scratch();
    const release = await tinyRelease("0.1.0-preview.1");
    await writeFile(join(context.home, ".zshrc"), "export EDITOR=vi");
    const first = await install(context, release, [], shell);
    ok(first);
    expect(first.output).toContain(
      `Installed neuve 0.1.0-preview.1 at ${await realpath(context.home)}/.neuve/bin/neuve.`,
    );
    expect(first.output).toContain(
      "Next, in a repository, run neuve setup, then neuve doctor.",
    );
    expect(first.output).toContain(
      "Agent skills can be added later, once a release includes them.",
    );
    const prefix = await realpath(context.prefix);
    expect(
      (await run([join(prefix, "bin/neuve"), "--version"], context.env)).stdout,
    ).toBe("neuve 0.1.0-preview.1\n");
    const manifest = JSON.parse(
      await read(join(prefix, "lib/neuve/install.json")),
    );
    expect(manifest.cli.path).toBe(join(prefix, "bin/neuve"));
    for (const path of [
      "lib/neuve/entire-graph",
      "lib/neuve/release.json",
      "lib/neuve/semantic/worker.py",
      "share/neuve/notices/THIRD_PARTY_NOTICES.md",
      "share/neuve/skills/manifest.json",
    ])
      expect(await Bun.file(join(prefix, path)).exists()).toBe(true);
    expect(
      await Bun.file(join(prefix, "lib/neuve/install.json.in")).exists(),
    ).toBe(false);
    // The existing last line had no newline; the block starts on its own line, once.
    const line = `export PATH="${prefix}/bin:$PATH"`;
    expect(await read(join(context.home, ".zshrc"))).toBe(
      `export EDITOR=vi\n${MARKER}\n${line}\n`,
    );
    ok(await install(context, release, ["--force"], shell));
    expect(await read(join(context.home, ".zshrc"))).toBe(
      `export EDITOR=vi\n${MARKER}\n${line}\n`,
    );
    // A new shell reading that file runs this install.
    const fresh = await run(
      ["/bin/zsh", "-c", `source "${context.home}/.zshrc"; command -v neuve`],
      context.env,
    );
    expect(fresh.stdout.trim()).toBe(join(prefix, "bin/neuve"));
  });

  // Seven installer runs and four tiny releases. Measured on 14 November, one tiny install took 1.4 to 2.1 s at a load of 35, so
  // 7 runs come to about 13 s there, within 30 s but with little room above it; at a load of 11 to 13
  // the whole case took under 4 s. 90 s keeps a margin for a heavier machine and still catches a hang.
  test("the same version is a no-op unless --force, and an older one is refused", async () => {
    const context = await scratch();
    const older = await tinyRelease("0.1.0-preview.2");
    const newer = await tinyRelease("0.1.0-preview.10");
    ok(await install(context, older, [], shell));
    const again = await install(context, older, [], shell);
    ok(again);
    expect(again.output).toContain(
      "neuve 0.1.0-preview.2 is already installed",
    );
    expect(again.output).toContain("nothing changed");
    // preview.10 is newer than preview.2: numeric identifiers compare as numbers.
    const upgraded = await install(context, newer, [], shell);
    ok(upgraded);
    expect(upgraded.output).toContain("Installed neuve 0.1.0-preview.10");
    const before = await snapshot(context.home);
    refused(
      await install(context, older, [], shell),
      "neuve 0.1.0-preview.10 is installed in",
    );
    refused(
      await install(context, older, ["--force"], shell),
      "never replaces a release with an older one",
    );
    expect(await snapshot(context.home)).toEqual(before);
    const forced = await install(context, newer, ["--force"], shell);
    ok(forced);
    expect(forced.output).toContain("Installed neuve 0.1.0-preview.10");
    // A release without a pre-release part is newer than its previews.
    ok(await install(context, await tinyRelease("0.1.0"), [], shell));
    refused(
      await install(context, await tinyRelease("0.1.0-rc.1"), [], shell),
      "newer than 0.1.0-rc.1",
    );
  }, 90_000);

  test("refuses a tampered archive, unsafe members and links before creating the prefix", async () => {
    const context = await scratch();
    const release = await tinyRelease("0.1.0");
    const tampered = await tinyRelease("0.1.0");
    await writeFile(
      tampered.archive,
      Buffer.concat([await readFile(tampered.archive), Buffer.from("x")]),
    );
    refused(
      await install(context, tampered, [], shell),
      `${ASSET} doesn't match SHA256SUMS, so nothing was installed.`,
    );
    const linked = await tinyRelease("0.1.0", {
      plant: (stage) => symlink("/etc/passwd", join(stage, "lib/neuve/link")),
    });
    refused(
      await install(context, linked, [], shell),
      "The archive contains a link or special file.",
    );
    const traversal = await tinyRelease("0.1.0", {
      tarArgs: escapeMember,
    });
    refused(
      await install(context, traversal, [], shell),
      "The archive contains an unsafe path.",
    );
    const sums = join(release.directory, "assets/SHA256SUMS");
    await writeFile(sums, (await read(sums)).replace(ASSET, "other.tar.gz"));
    refused(
      await install(context, release, [], shell),
      `SHA256SUMS doesn't list ${ASSET} exactly once`,
    );
    expect(await Bun.file(context.prefix).exists()).toBe(false);
    expect(await snapshot(context.home)).toEqual({});
  });

  test("refuses .local, a copy built from source, a held lock and linked folders", async () => {
    const context = await scratch();
    const release = await tinyRelease("0.1.0");
    refused(
      await install(
        context,
        release,
        ["--prefix", join(context.home, ".local")],
        shell,
      ),
      "This folder is kept for the copy that bun run install:cli builds from source.",
    );
    await mkdir(join(context.prefix, "lib/neuve"), { recursive: true });
    await writeFile(join(context.prefix, "lib/neuve/install.json"), "{}\n");
    refused(
      await install(context, release, [], shell),
      "This folder holds a copy built from source.",
    );
    ok(await install(context, release, ["--force"], shell));
    await mkdir(join(context.prefix, ".install.lock"));
    refused(
      await install(context, release, ["--force"], shell),
      `If none is running, delete that empty folder. Then run the same command again with --force.`,
    );
    await rm(join(context.prefix, ".install.lock"), { recursive: true });
    const other = join(context.directory, "other");
    await mkdir(join(other, "elsewhere"), { recursive: true });
    await symlink(join(other, "elsewhere"), join(other, "share"));
    refused(
      await install(context, release, ["--prefix", other], shell),
      "share is a symbolic link, which the installer won't follow.",
    );
  });

  test("rolls back to the previous release when a replacement fails", async () => {
    const context = await scratch();
    ok(await install(context, await tinyRelease("0.1.0"), [], shell));
    const before = await snapshot(context.home);
    await chmod(join(context.prefix, "bin"), 0o555);
    const failed = await install(
      context,
      await tinyRelease("0.2.0"),
      [],
      shell,
    );
    await chmod(join(context.prefix, "bin"), 0o755);
    expect(failed.code, failed.output).not.toBe(0);
    expect(failed.output).toContain("Can't replace");
    expect(await snapshot(context.home)).toEqual(before);
    expect((await run([context.cli, "--version"], context.env)).stdout).toBe(
      "neuve 0.1.0\n",
    );
  });

  test("a TERM after the CLI is replaced puts the previous release back, and a plain retry works", async () => {
    const context = await scratch();
    ok(await install(context, await tinyRelease("0.1.0"), [], shell));
    const before = await snapshot(context.home);
    const pidFile = join(context.directory, "installer.pid");
    // mv runs the real move, then signals the installer: the signal lands mid-transaction.
    const shim = await stubs({
      mv: `#!/bin/sh\n/bin/mv "$@"; status=$?\ncase "$*" in *bin/neuve) kill -TERM "$(cat "${pidFile}")" ;; esac\nexit $status\n`,
    });
    const next = await tinyRelease("0.2.0");
    const interrupted = await run(
      [
        shell,
        "-c",
        `echo $$ > "${pidFile}"; exec ${shell} "${installer}" --archive "${next.archive}" --checksums "${next.sums}"`,
      ],
      { ...context.env, PATH: `${shim}:${context.env.PATH}` },
    );
    expect(interrupted.code, interrupted.output).toBe(143);
    expect(await snapshot(context.home)).toEqual(before);
    ok(await install(context, next, [], shell));
    expect((await run([context.cli, "--version"], context.env)).stdout).toBe(
      "neuve 0.2.0\n",
    );
  });

  test("uninstall removes the release and its PATH block and keeps everything else", async () => {
    const context = await scratch();
    await writeFile(join(context.home, ".zshrc"), "export EDITOR=vi\n");
    ok(await install(context, await tinyRelease("0.1.0"), [], shell));
    await writeFile(join(context.prefix, "notes.txt"), "mine\n");
    const removed = await install(context, undefined, ["--uninstall"], shell);
    ok(removed);
    expect(removed.output).toContain(
      `Removed Neuve from ${await realpath(context.prefix)}.`,
    );
    expect(await read(join(context.home, ".zshrc"))).toBe("export EDITOR=vi\n");
    expect(await snapshot(context.prefix)).toEqual({
      "notes.txt": expect.any(String),
    });
    ok(await install(context, undefined, ["--uninstall"], shell));
  });

  // Six installer runs in three scratch homes. Measured on 14 November, one tiny install took 1.4 to 2.1 s at a load of 35, so
  // 6 runs come to about 11 s there, within 30 s but with little room above it; at a load of 11 to 13
  // the whole case took under 4 s. 90 s keeps a margin for a heavier machine and still catches a hang.
  test("uninstall removes a startup file the installer created once it is empty, and no other", async () => {
    const created = await scratch();
    ok(await install(created, await tinyRelease("0.1.0"), [], shell));
    expect(await Bun.file(join(created.home, ".zshrc")).exists()).toBe(true);
    const gone = await install(created, undefined, ["--uninstall"], shell);
    ok(gone);
    expect(gone.output).toContain(
      "which the installer created and which is now empty.",
    );
    expect(await snapshot(created.home)).toEqual({});
    // Created, then given a line of the user's own: kept, without the installer's block.
    const used = await scratch();
    ok(await install(used, await tinyRelease("0.1.0"), [], shell));
    await writeFile(
      join(used.home, ".zshrc"),
      `${await read(join(used.home, ".zshrc"))}alias g=git\n`,
    );
    ok(await install(used, undefined, ["--uninstall"], shell));
    expect(await read(join(used.home, ".zshrc"))).toBe("alias g=git\n");
    // Already there, even empty: kept.
    const mine = await scratch();
    await writeFile(join(mine.home, ".zshrc"), "");
    ok(await install(mine, await tinyRelease("0.1.0"), [], shell));
    ok(await install(mine, undefined, ["--uninstall"], shell));
    expect(await read(join(mine.home, ".zshrc"))).toBe("");
  }, 90_000);

  // Ten installer runs and seven tiny releases. Measured on 14 November, one tiny install took 1.4 to 2.1 s at a load of 35, so
  // 10 runs come to about 18 s there, within 30 s but with little room above it; at a load of 11 to 13
  // the whole case took under 4 s. 90 s keeps a margin for a heavier machine and still catches a hang.
  test("an installed release whose version can't be read is replaced only with --force", async () => {
    const context = await scratch();
    ok(await install(context, await tinyRelease("0.2.0"), [], shell));
    const record = join(context.prefix, "lib/neuve/release.json");
    for (const broken of [
      (text: string) => text.replace(/^ {2}"version": .*\n/m, ""),
      (text: string) => text.replace('"version": "0.2.0"', '"version": "two"'),
      // Two version lines: read as no version, never handed to the comparison as two.
      (text: string) =>
        text.replace(
          '"version": "0.2.0",',
          '"version": "0.2.0",\n  "version": "0.3.0",',
        ),
    ]) {
      await writeFile(record, broken(await read(record)));
      const before = await snapshot(context.home);
      for (const version of ["0.1.0", "0.2.0"])
        refused(
          await install(context, await tinyRelease(version), [], shell),
          `names no version this installer can read, so it can't tell whether ${version} is older than what is installed. To replace it anyway, add --force.`,
        );
      expect(await snapshot(context.home)).toEqual(before);
      ok(
        await install(context, await tinyRelease("0.2.0"), ["--force"], shell),
      );
    }
  }, 90_000);

  test("an installer from a release installs that release unless --version names another", async () => {
    const context = await scratch();
    const stamped = join(context.directory, "install.sh");
    await writeFile(stamped, stampInstaller(await read(installer), "0.2.0"));
    const from = (
      release: Awaited<ReturnType<typeof tinyRelease>>,
      extra: Array<string> = [],
    ) =>
      run(
        [
          shell,
          stamped,
          "--archive",
          release.archive,
          "--checksums",
          release.sums,
          ...extra,
        ],
        context.env,
      );
    const other = await tinyRelease("0.3.0");
    for (const extra of [[], ["--dry-run"]])
      refused(
        await from(other, extra),
        "This installer installs neuve 0.2.0, the release it came with, but the archive holds neuve 0.3.0. To install that one, add --version 0.3.0.",
      );
    expect(await Bun.file(context.prefix).exists()).toBe(false);
    const own = await from(await tinyRelease("0.2.0"));
    ok(own);
    expect(own.output).toContain("Installed neuve 0.2.0");
    const asked = await from(other, ["--version", "0.3.0"]);
    ok(asked);
    expect(asked.output).toContain("Installed neuve 0.3.0");
    const help = await run([shell, stamped, "--help"], context.env);
    expect(help.stdout).toContain(
      "Default: 0.2.0, the release this installer came with.",
    );
  });

  test("an archive whose release.json names its version twice is refused plainly", async () => {
    const context = await scratch();
    const doubled = await tinyRelease("0.1.0", {
      plant: async (stage) => {
        const record = join(stage, "lib/neuve/release.json");
        await writeFile(
          record,
          (await read(record)).replace(
            '"version": "0.1.0",',
            '"version": "0.1.0",\n  "version": "0.0.1",',
          ),
        );
      },
    });
    for (const extra of [[], ["--dry-run"]]) {
      const result = await install(context, doubled, extra, shell);
      refused(result, "The release has no valid version.");
      expect(result.output).not.toContain("awk");
    }
  });

  test("a dry run from an archive checks it against SHA256SUMS before reading it", async () => {
    const context = await scratch();
    const tampered = await tinyRelease("0.1.0");
    await writeFile(
      tampered.archive,
      Buffer.concat([await readFile(tampered.archive), Buffer.from("x")]),
    );
    const planned = await install(context, tampered, ["--dry-run"], shell);
    refused(
      planned,
      `${ASSET} doesn't match SHA256SUMS, so nothing was installed.`,
    );
    expect(planned.output).not.toContain("Release: neuve");
  });

  test("a dry run prints the plan and writes nothing, not even in the temporary folder", async () => {
    const context = await scratch();
    const release = await tinyRelease("0.1.0");
    const before = await snapshot(context.directory);
    const planned = await install(context, release, ["--dry-run"], shell);
    ok(planned);
    for (const line of [
      "Dry run: nothing is downloaded, installed or changed.",
      `Release: neuve 0.1.0 from ${release.archive}, which matches ${release.sums}.`,
      "(a new install): bin/neuve, lib/neuve and share/neuve.",
      "PATH: would add this line to",
      "Agent skills: would offer them with neuve skills install --offer",
      "Then: in a repository, run neuve setup, then neuve doctor.",
    ])
      expect(planned.output).toContain(line);
    expect(await snapshot(context.directory)).toEqual(before);
    ok(await install(context, release, [], shell));
    const installed = await snapshot(context.directory);
    const upgrade = await install(
      context,
      await tinyRelease("0.2.0"),
      ["--dry-run", "--no-skills"],
      shell,
    );
    ok(upgrade);
    expect(upgrade.output).toContain("(replacing neuve 0.1.0)");
    expect(upgrade.output).toContain(
      "Agent skills: not offered (--no-skills).",
    );
    ok(await install(context, undefined, ["--uninstall", "--dry-run"], shell));
    expect(await snapshot(context.directory)).toEqual(installed);
  });

  // A real neuve with the mark hangs at its first run while macOS assesses it (and shows a dialog), so
  // the installer must stop before it runs the unpacked CLI, change nothing, and leave the mark for the
  // person to clear. Checked by exit code, output and xattr only: a marked file is never executed.
  // The quarantine mark and xattr are macOS-only.
  test.skipIf(process.platform !== "darwin")(
    "stops on a quarantined archive before running it, names the exact fix, and clears nothing",
    async () => {
      const context = await scratch();
      const clean = await install(
        context,
        await tinyRelease("0.1.0"),
        [],
        shell,
      );
      ok(clean);
      expect(clean.output).not.toContain("com.apple.quarantine");
      const before = await snapshot(context.home);
      const marked = await tinyRelease("0.2.0");
      ok(
        await run(
          [
            "xattr",
            "-w",
            "com.apple.quarantine",
            "0081;6560a0a0;Safari;",
            marked.archive,
          ],
          context.env,
        ),
      );
      const fix = `xattr -d com.apple.quarantine "${marked.archive}"`;
      const planned = await install(context, marked, ["--dry-run"], shell);
      ok(planned);
      expect(planned.output).toContain(
        `A real install would stop here: macOS marks ${marked.archive} as downloaded from the internet. To clear the mark, run: ${fix}.`,
      );
      const stopped = await install(context, marked, [], shell);
      refused(
        stopped,
        `so it would stop neuve from running. Nothing was installed. To clear the mark, run: ${fix}. Then run the same command again.`,
      );
      expect(await read(context.log)).not.toContain("neuve 0.2.0");
      expect(await snapshot(context.home)).toEqual(before);
      expect(
        (
          await run(
            ["xattr", "-p", "com.apple.quarantine", marked.archive],
            context.env,
          )
        ).code,
      ).toBe(0);
      // Nothing that carries the mark is ever run, here or by the installer: the marked archive goes.
      await rm(marked.archive);
    },
  );

  test("says which neuve a terminal runs when another copy comes first on PATH", async () => {
    const context = await scratch();
    const local = join(context.home, ".local/bin");
    await mkdir(local, { recursive: true });
    await writeFile(
      join(local, "neuve"),
      "#!/bin/sh\necho 'neuve from source'\n",
      { mode: 0o755 },
    );
    const prefix = join(context.home, ".neuve");
    context.env.PATH = `${local}:${context.env.PATH}`;
    const added = await install(context, await tinyRelease("0.1.0"), [], shell);
    ok(added);
    expect(added.output).toContain(
      `In this terminal, the neuve command still runs ${local}/neuve. New terminals run ${await realpath(context.home)}/.neuve/bin/neuve`,
    );
    const real = await realpath(prefix);
    context.env.PATH = `${local}:${real}/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
    const shadowed = await install(
      context,
      await tinyRelease("0.2.0"),
      [],
      shell,
    );
    ok(shadowed);
    expect(shadowed.output).toContain(
      `The neuve command runs ${local}/neuve, which comes before ${real}/bin on PATH. To run this install, put ${real}/bin first on PATH`,
    );
  });

  test("refuses every platform without a release before writing", async () => {
    const context = await scratch();
    for (const [system, machine, message, getconf] of [
      ["FreeBSD", "amd64", "There's no release for FreeBSD/amd64.", "exit 1"],
      ["Darwin", "x86_64", "There's no release for Intel Macs.", "exit 1"],
      // Linux releases are built against glibc; getconf finds none here, as on musl.
      [
        "Linux",
        "x86_64",
        "Linux releases need glibc, which wasn't found here.",
        "exit 1",
      ],
      // The Graph engine needs glibc 2.34 or later.
      [
        "Linux",
        "x86_64",
        "Linux releases need glibc 2.34 or later, and this machine has glibc 2.31.",
        "echo glibc 2.31",
      ],
    ] as const) {
      const shim = await stubs({
        uname: `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; *) /usr/bin/uname "$@" ;; esac\n`,
        sysctl: "#!/bin/sh\necho 0\n",
        getconf: `#!/bin/sh\n${getconf}\n`,
      });
      refused(
        await run([shell, installer, "--dry-run"], {
          ...context.env,
          PATH: `${shim}:${context.env.PATH}`,
        }),
        message,
      );
    }
    expect(await snapshot(context.home)).toEqual({});
  });
});

// script(1) gives the installer a terminal with BSD arguments; util-linux's script takes others.
test.skipIf(process.platform !== "darwin")(
  "offers the skills through neuve on a terminal, and only when asked not to, skips them",
  async () => {
    const context = await scratch();
    const release = await tinyRelease("0.1.0", { skills: true });
    // script(1) gives the installer a terminal, as when a person runs it.
    const offered = await run(
      [
        "script",
        "-q",
        "/dev/null",
        "sh",
        installer,
        "--archive",
        release.archive,
        "--checksums",
        release.sums,
      ],
      context.env,
    );
    ok(offered);
    expect(await read(context.log)).toContain(
      "neuve 0.1.0: skills install --offer",
    );
    expect(offered.output).toContain("skills offer read a terminal");
    await rm(context.log);
    const skipped = await install(context, release, ["--force", "--no-skills"]);
    ok(skipped);
    expect(await read(context.log)).not.toContain("skills");
    // Without a terminal, it says how to add them instead of asking.
    const quiet = await install(context, release, ["--force"]);
    ok(quiet);
    expect(quiet.output).toContain(
      "To add the agent skills, run neuve skills install.",
    );
    expect(await read(context.log)).not.toContain("skills install");
  },
);

// A second release is the first one's steps again with a higher version. Each release ships its
// own stamped installer; the newer one upgrades in place, and the older one won't go back down.
// Runs the installers under BSD script(1), as the skills test does.
test.skipIf(process.platform !== "darwin")(
  "a second release upgrades the first in place, keeps every repository's setup and store, and the first's installer won't go back",
  async () => {
    const context = await scratch();
    const releases = {
      first: await tinyRelease("0.1.0-preview.1", { skills: true }),
      second: await tinyRelease("0.1.0-preview.2", { skills: true }),
    };
    const shipped = async (
      release: Awaited<ReturnType<typeof tinyRelease>>,
    ) => {
      const path = join(release.directory, "assets/install.sh");
      await writeFile(
        path,
        stampInstaller(await read(installer), release.version),
      );
      return path;
    };
    const from = async (release: Awaited<ReturnType<typeof tinyRelease>>) =>
      // script(1) gives the installer a terminal, as when a person runs it.
      run(
        [
          "script",
          "-q",
          "/dev/null",
          "sh",
          await shipped(release),
          "--archive",
          release.archive,
          "--checksums",
          release.sums,
        ],
        context.env,
      );
    ok(await from(releases.first));
    // A repository set up with the first release: its config, its exclude line, its store, and the
    // user-level list of stores.
    const repository = join(context.home, "work/app");
    const planted: Record<string, string> = {
      "neuve/config.json": '{ "version": 1 }\n',
      ".git/info/exclude": "/neuve/\n",
      ".git/neuve/records.sqlite": "store written by 0.1.0-preview.1\n",
    };
    for (const [path, data] of Object.entries(planted)) {
      await mkdir(join(repository, path, ".."), { recursive: true });
      await writeFile(join(repository, path), data);
    }
    const support = join(context.home, "Library/Application Support/Neuve");
    await mkdir(support, { recursive: true });
    await writeFile(
      join(support, "repositories.json"),
      JSON.stringify({
        version: 1,
        repositories: [{ store: join(repository, ".git/neuve"), repository }],
      }),
    );
    const kept = async () => ({
      repository: await snapshot(repository),
      support: await snapshot(support),
    });
    const before = await kept();
    await rm(context.log);
    const upgraded = await from(releases.second);
    ok(upgraded);
    expect(upgraded.output).toContain("Installed neuve 0.1.0-preview.2");
    expect(upgraded.output).toContain(
      "Repositories already set up keep their setup and records. Next, in one of them, run neuve doctor.",
    );
    expect(upgraded.output).not.toContain("run neuve setup");
    const prefix = await realpath(context.prefix);
    expect(
      (await run([join(prefix, "bin/neuve"), "--version"], context.env)).stdout,
    ).toBe("neuve 0.1.0-preview.2\n");
    // One PATH block still, and the new CLI, not the old one, makes the skills offer.
    const zshrc = await read(join(context.home, ".zshrc"));
    expect(zshrc.split(MARKER).length - 1).toBe(1);
    expect(zshrc.split(`export PATH="${prefix}/bin:$PATH"`).length - 1).toBe(1);
    const calls = await read(context.log);
    expect(calls).toContain("neuve 0.1.0-preview.2: skills install --offer");
    expect(calls).not.toContain("neuve 0.1.0-preview.1");
    expect(await kept()).toEqual(before);
    // The first release's installer, with its own archive, refuses to replace the newer release.
    const home = await snapshot(context.home);
    const back = await from(releases.first);
    expect(back.code, back.output).toBe(1);
    expect(back.output).toContain("neuve 0.1.0-preview.2 is installed in");
    expect(await snapshot(context.home)).toEqual(home);
  },
  60_000,
);

test("help names both ways to start: the GitHub CLI and a token", async () => {
  const context = await scratch();
  const help = await run(["sh", installer, "--help"], context.env);
  ok(help);
  expect(help.stdout).toContain(
    "gh release download v<version> --repo NeuveAI/neuve --pattern install.sh",
  );
  expect(help.stdout).toContain("sh install.sh");
  expect(help.stdout).toContain(
    "set GH_TOKEN to a\nGitHub token that can read NeuveAI/neuve",
  );
  expect(help.stdout).toContain("--no-skills");
  expect(help.stdout).toContain("--dry-run");
  // Once the repository is public, the one line needs no sign-in.
  expect(help.stdout).toContain("curl -fsSL https://neuve.ai/install.sh | sh");
});

// Why: a mock launchctl must report just its registered executable even if a failed plutil
// lookup writes its diagnostic to stdout. Otherwise a valid registration looks foreign on CI.
for (const shell of shells)
  test(`launchd fixture discards a failed Program lookup's stdout under ${shell}`, async () => {
    const directory = await scratchDirectory("neuve-plutil-");
    await writeFile(
      join(directory, "plutil"),
      `#!/bin/sh
if [ "$2" = Program ] || [ "\${FAIL_ALL:-0}" = 1 ]; then
  printf '/fixture.plist: Could not extract value\\n'
  exit 1
fi
printf '/fixture/bin/neuve\\n'
`,
      { mode: 0o755 },
    );
    const env = { PATH: directory, PLIST: "/fixture.plist" };
    const executable = Bun.which(shell);
    if (executable === null) throw new Error(`Missing shell: ${shell}`);
    const result = await run(
      [executable, "-c", readLaunchdProgram("$PLIST")],
      env,
    );
    expect(result).toMatchObject({
      code: 0,
      stdout: "/fixture/bin/neuve",
      stderr: "",
    });
    const refused = await run(
      [executable, "-c", readLaunchdProgram("$PLIST")],
      {
        ...env,
        FAIL_ALL: "1",
      },
    );
    expect(refused).toMatchObject({ code: 1, stdout: "" });
  });
