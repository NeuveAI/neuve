// Why: a release build isn't byte-reproducible, so the release that ships must be the measured
// folder's exact files. `--from` builds nothing and uploads them as they are, so it must refuse
// every folder that isn't exactly this version's release built at the commit the tag goes on: a
// changed byte, a missing, extra or linked file, another commit, another version, a tree with
// local changes, a target off origin/main, a link inside the archive. It must also never run a CLI
// with a quarantine mark, and gh must get arguments it reads as the checked files whatever the
// folder's path holds. A stub `gh` records its working directory and each argument; a scratch
// repository stands in for the checkout; the folder holds a real archive whose bin/neuve is a
// script that records each run.
import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import {
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { releaseSchema } from "../../apps/neuve-cli/src/release-metadata.ts";
import { writeChecksums } from "../../scripts/release/checksums.ts";
import {
  quote,
  type ReleaseOptions,
  runRelease,
  stampInstaller,
} from "../../scripts/release/release.ts";
import {
  ASSET,
  ghInvocations,
  git,
  hash,
  installer,
  releaseCheckout,
  removeAllScratch,
  scratchDirectory,
  type Checkout,
} from "./release-fixture.ts";

// bun run release builds and checks a darwin-arm64 release on the owner's Mac: it refuses any
// other host, and reads macOS's quarantine marks with xattr. So these run on macOS only.
const test = process.platform === "darwin" ? bunTest : bunTest.skip;

const VERSION = "0.1.0-preview.2";

let checkout: Checkout;
/** Every run of the archive's bin/neuve, one line each. */
let cliRuns: string;

interface Measured {
  readonly folder: string;
  readonly files: ReadonlyArray<string>;
}

/** A folder as the release build leaves it: the archive, the stamped installer and SHA256SUMS. */
const measuredFolder = async (
  release: Readonly<{
    commit?: string | null;
    version?: string;
    dirty?: boolean;
    installerVersion?: string;
    /** A folder inside the scratch folder to hold the files, to give their path odd characters. */
    subfolder?: string;
    /** Changes the staged archive tree before it is packed. */
    plant?: (stage: string) => Promise<void>;
  }> = {},
): Promise<Measured> => {
  const stage = await scratchDirectory("neuve-measured-stage-");
  const name = "neuve-darwin-arm64";
  const cli = join(stage, name, "bin/neuve");
  await mkdir(join(stage, name, "bin"), { recursive: true });
  await mkdir(join(stage, name, "lib/neuve"), { recursive: true });
  await writeFile(
    cli,
    `#!/bin/sh\nprintf '%s\\n' "$*" >>"${cliRuns}"\n[ "$1" = doctor ] && exit 0\necho "neuve: Unknown command: $1" >&2; exit 2\n`,
    { mode: 0o755 },
  );
  await release.plant?.(join(stage, name));
  const metadata = releaseSchema.parse({
    schemaVersion: 1,
    version: release.version ?? VERSION,
    target: "darwin-arm64",
    repository: "NeuveAI/neuve",
    cliSha256: await hash(cli).catch(() => "0".repeat(64)),
    commit: release.commit === undefined ? checkout.head : release.commit,
    dirty: release.dirty ?? false,
    graphRevision: checkout.graph,
    files: ["bin/neuve", "lib/neuve"],
  });
  await writeFile(
    join(stage, name, "lib/neuve/release.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  const scratch = await scratchDirectory("neuve-measured-");
  const folder =
    release.subfolder === undefined
      ? scratch
      : join(scratch, release.subfolder);
  await mkdir(folder, { recursive: true });
  const packed = Bun.spawnSync(
    ["tar", "--no-xattrs", "-czf", join(folder, ASSET), "-C", stage, name],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, stderr: "pipe" },
  );
  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
  await writeFile(
    join(folder, "install.sh"),
    stampInstaller(
      await readFile(installer, "utf8"),
      release.installerVersion ?? VERSION,
    ),
  );
  await writeChecksums(folder, [ASSET, "install.sh"]);
  return {
    folder,
    files: [ASSET, "install.sh", "SHA256SUMS"].map((file) =>
      join(folder, file),
    ),
  };
};

const lines: Array<string> = [];
const output = () => lines.join("\n");
const release = (measured: Measured, overrides: Partial<ReleaseOptions> = {}) =>
  runRelease({
    version: VERSION,
    dryRun: false,
    root: checkout.root,
    host: "darwin-arm64",
    bunVersion: "1.4.4",
    env: checkout.env,
    say: (line) => lines.push(line),
    from: measured.folder,
    build: () => Promise.reject(new Error("--from must not build")),
    ...overrides,
  });
const ghCalls = async () =>
  (await ghInvocations(checkout.ghLog)).map((call) => call.args.join(" "));
const uploads = async () =>
  (await ghCalls()).filter((call) => call.startsWith("release create"));
const createCall = (commit: string) =>
  [
    `release create v${VERSION} --repo NeuveAI/neuve`,
    `--target ${commit} --prerelease --generate-notes --title Neuve ${VERSION}`,
    "neuve-darwin-arm64.tar.gz install.sh SHA256SUMS",
  ].join(" ");
/** The one gh release create call: it must run inside the folder with the three bare names. */
const expectUploadFrom = async (measured: Measured) => {
  const creates = (await ghInvocations(checkout.ghLog)).filter(
    (call) => call.args[0] === "release" && call.args[1] === "create",
  );
  expect(creates).toHaveLength(1);
  expect(creates[0]?.cwd).toBe(await realpath(measured.folder));
  expect(creates[0]?.args.slice(-3)).toEqual([
    ASSET,
    "install.sh",
    "SHA256SUMS",
  ]);
};

/** main moves on one commit past the archive's, with its own passing check. */
const advanceMain = async () => {
  await writeFile(join(checkout.root, "later.txt"), "x\n");
  git(checkout.root, "add", "later.txt");
  git(checkout.root, "commit", "--quiet", "-m", "later on main");
  const head = git(checkout.root, "rev-parse", "HEAD");
  git(checkout.root, "update-ref", "refs/remotes/origin/main", head);
  await writeFile(
    join(checkout.root, ".git/neuve-check", `${head}.json`),
    JSON.stringify({
      version: 1,
      commit: head,
      branch: "main",
      at: "2026-11-15T12:00:00.000Z",
    }),
  );
  return head;
};

beforeEach(async () => {
  lines.length = 0;
  checkout = await releaseCheckout();
  cliRuns = join(await scratchDirectory("neuve-cli-runs-"), "runs.log");
});
afterEach(removeAllScratch, 60_000);

test("a matching folder is uploaded as it is, on this commit, with nothing built", async () => {
  const measured = await measuredFolder();
  const before = await Promise.all(measured.files.map(hash));
  expect(await release(measured), output()).toBe(0);
  for (const name of [
    "tree",
    "history",
    "check receipt",
    "version",
    "host",
    "bun",
    "graph engine",
    "target",
    "release files",
    "checksums",
    "archive members",
    "archive",
    "installer",
    "built CLI",
  ])
    expect(output()).toContain(`ok     ${name}:`);
  expect(await ghCalls()).toEqual([
    "release list --repo NeuveAI/neuve --limit 1000 --json tagName --jq .[].tagName",
    `api repos/NeuveAI/neuve/git/ref/tags/v${VERSION} --jq .object.sha`,
    createCall(checkout.head),
  ]);
  await expectUploadFrom(measured);
  expect(await Promise.all(measured.files.map(hash))).toEqual(before);
  expect(await readFile(cliRuns, "utf8")).toBe("doctor --help\n");
});

test("a dry run with --from runs every check and prints the upload of the three files, and creates nothing", async () => {
  const measured = await measuredFolder();
  expect(await release(measured, { dryRun: true }), output()).toBe(0);
  expect(output()).toContain("The GitHub step a real release takes (not run):");
  expect(output()).toContain(
    `cd ${quote([measured.folder])} && gh release create v${VERSION} --repo NeuveAI/neuve --target ${checkout.head} --prerelease --generate-notes --title 'Neuve ${VERSION}' ${ASSET} install.sh SHA256SUMS`,
  );
  expect(output()).toContain(
    "Every guard passes: a real release would go ahead.",
  );
  expect(await uploads()).toEqual([]);
});

const refusals: ReadonlyArray<
  readonly [string, string, string, () => Promise<Measured>]
> = [
  [
    "a changed byte",
    "checksums",
    `${ASSET} doesn't match its line in SHA256SUMS`,
    async () => {
      const measured = await measuredFolder();
      const archive = join(measured.folder, ASSET);
      const bytes = await readFile(archive);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
      await writeFile(archive, bytes);
      return measured;
    },
  ],
  [
    "a missing file",
    "release files",
    "install.sh is missing",
    async () => {
      const measured = await measuredFolder();
      await rm(join(measured.folder, "install.sh"));
      return measured;
    },
  ],
  [
    "an extra file",
    "release files",
    "notes.txt is there too, and only the release files may be",
    async () => {
      const measured = await measuredFolder();
      await writeFile(join(measured.folder, "notes.txt"), "x\n");
      return measured;
    },
  ],
  [
    "a link",
    "release files",
    "install.sh is a link",
    async () => {
      const measured = await measuredFolder();
      const elsewhere = join(await scratchDirectory("neuve-elsewhere-"), "i");
      await writeFile(
        elsewhere,
        await readFile(join(measured.folder, "install.sh")),
      );
      await rm(join(measured.folder, "install.sh"));
      await symlink(elsewhere, join(measured.folder, "install.sh"));
      return measured;
    },
  ],
  [
    "a different commit",
    "archive",
    "the archive was built at 1111111111, not",
    () => measuredFolder({ commit: "1".repeat(40) }),
  ],
  [
    "a different version",
    "archive",
    `the archive is 0.1.0-preview.3, not ${VERSION}`,
    () => measuredFolder({ version: "0.1.0-preview.3" }),
  ],
  [
    "an installer of a different version",
    "installer",
    `install.sh installs 0.1.0-preview.3, not ${VERSION}`,
    () => measuredFolder({ installerVersion: "0.1.0-preview.3" }),
  ],
  [
    "dirty: true",
    "archive",
    "the archive was built from a tree with local changes",
    () => measuredFolder({ dirty: true }),
  ],
];

for (const [label, name, detail, plant] of refusals)
  test(`--from refuses ${label} and uploads nothing, and a dry run says so`, async () => {
    const measured = await plant();
    expect(await release(measured), output()).toBe(1);
    expect(output()).toContain(`refuse ${name}: `);
    expect(output()).toContain(detail);
    expect(output()).toContain("Nothing was uploaded or created.");
    expect(await uploads()).toEqual([]);
    lines.length = 0;
    expect(await release(measured, { dryRun: true }), output()).toBe(0);
    expect(output()).toMatch(
      new RegExp(`A real release would refuse: (.+, )?${name}[,.]`),
    );
    expect(await uploads()).toEqual([]);
  });

test("an archive measured at an earlier commit ships from a later main with --target, and is refused without it", async () => {
  const measured = await measuredFolder();
  const archiveCommit = checkout.head;
  const head = await advanceMain();
  expect(await release(measured), output()).toBe(1);
  expect(output()).toContain(
    `refuse archive: the archive was built at ${archiveCommit.slice(0, 10)}, not ${head.slice(0, 10)}, the commit the tag goes on`,
  );
  expect(await uploads()).toEqual([]);
  lines.length = 0;
  expect(
    await release(measured, { target: archiveCommit.slice(0, 12) }),
    output(),
  ).toBe(0);
  expect(output()).toContain(
    `ok     target: the tag goes on ${archiveCommit.slice(0, 10)}, which is on origin/main's history`,
  );
  expect(await uploads()).toEqual([createCall(archiveCommit)]);
  await expectUploadFrom(measured);
});

test("--from refuses a target that isn't on origin/main, even when the archive was built there", async () => {
  const off = git(
    checkout.root,
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    "HEAD",
    "-m",
    "not on main",
  );
  const measured = await measuredFolder({ commit: off });
  expect(await release(measured, { target: off }), output()).toBe(1);
  expect(output()).toContain(
    `refuse target: ${off.slice(0, 10)} is not on origin/main's history`,
  );
  expect(output()).toContain("Nothing was uploaded or created.");
  expect(await uploads()).toEqual([]);
});

test("gh uploads the checked files from a folder whose path holds #, [, * and a space", async () => {
  // gh reads text after # as a label and *, ? and [ as a pattern, so a full path here would name
  // other files than the ones checked. Inside the folder, the bare names are read as they are.
  const measured = await measuredFolder({ subfolder: "rel #1 [a] *" });
  expect(await release(measured, { dryRun: true }), output()).toBe(0);
  expect(output()).toContain(
    `cd '${measured.folder}' && gh release create v${VERSION} --repo NeuveAI/neuve --target ${checkout.head} --prerelease --generate-notes --title 'Neuve ${VERSION}' ${ASSET} install.sh SHA256SUMS`,
  );
  lines.length = 0;
  expect(await release(measured), output()).toBe(0);
  await expectUploadFrom(measured);
});

const linked: ReadonlyArray<
  readonly [string, string, (archive: string) => Promise<void>]
> = [
  [
    "a bin/neuve that links to a program outside the archive",
    "neuve-darwin-arm64/bin/neuve is a symbolic link",
    async (archive) => {
      const outside = join(await scratchDirectory("neuve-outside-"), "neuve");
      await writeFile(
        outside,
        `#!/bin/sh\nprintf '%s\\n' "$*" >>"${cliRuns}"\nexit 0\n`,
        { mode: 0o755 },
      );
      await rm(join(archive, "bin/neuve"));
      await symlink(outside, join(archive, "bin/neuve"));
    },
  ],
  [
    "a hard link",
    "is a hard link",
    async (archive) => {
      await link(join(archive, "bin/neuve"), join(archive, "lib/neuve/neuve"));
    },
  ],
  [
    "a bin/neuve that is a folder",
    "the archive's bin/neuve is not a regular file",
    async (archive) => {
      await rm(join(archive, "bin/neuve"));
      await mkdir(join(archive, "bin/neuve"));
      await writeFile(join(archive, "bin/neuve/x"), "x\n");
    },
  ],
];

for (const [label, detail, plant] of linked)
  test(`--from refuses an archive with ${label}, before anything in it is read out or run`, async () => {
    const measured = await measuredFolder({ plant });
    expect(await release(measured), output()).toBe(1);
    expect(output()).toContain("refuse archive members: ");
    expect(output()).toContain(detail);
    expect(output()).toContain(
      "refuse built CLI: not run: the archive's members don't pass",
    );
    expect(output()).toContain("Nothing was uploaded or created.");
    expect(await Bun.file(cliRuns).exists()).toBe(false);
    expect(await uploads()).toEqual([]);
  });

// Archives built byte by byte, as review 2 built them: each hides a symbolic link at bin/neuve where
// a hand-written tar reader saw data, while macOS tar reads it as a member and unpacks it.
const P = "neuve-darwin-arm64/";
const tarHeader = (
  name: string,
  options: Readonly<{
    type?: string;
    size?: number;
    link?: string;
    badSum?: boolean;
    mode?: number;
  }> = {},
) => {
  const header = Buffer.alloc(512);
  header.write(name, 0, "latin1");
  header.write(
    `${(options.mode ?? 0o755).toString(8).padStart(7, "0")}\0`,
    100,
    "latin1",
  );
  header.write("0000765\0", 108, "latin1");
  header.write("0000024\0", 116, "latin1");
  header.write(
    `${(options.size ?? 0).toString(8).padStart(11, "0")}\0`,
    124,
    "latin1",
  );
  header.write("14712345670\0", 136, "latin1");
  header.write("        ", 148, "latin1");
  header.write(options.type ?? "0", 156, "latin1");
  if (options.link !== undefined) header.write(options.link, 157, "latin1");
  header.write("ustar\u000000", 257, "latin1");
  let sum = header.reduce((total, byte) => total + byte, 0);
  if (options.badSum) sum += 1;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return header;
};
const padded = (data: Buffer) =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
const tarMember = (
  name: string,
  data: Buffer = Buffer.alloc(0),
  type = "0",
  mode = 0o755,
) =>
  Buffer.concat([
    tarHeader(name, { type, size: data.length, mode }),
    padded(data),
  ]);
/** A pax header whose `size=0` replaces the next header's size for tar. */
const paxSizeZero = () => {
  const record = " size=0\n";
  let length = record.length + 1;
  while (String(length).length + record.length !== length) length += 1;
  const body = Buffer.from(`${length}${record}`, "latin1");
  return Buffer.concat([
    tarHeader("PaxHeader/x", { type: "x", size: body.length }),
    padded(body),
  ]);
};

const crafted: ReadonlyArray<
  readonly [string, (common: Buffer, hidden: Buffer, script: Buffer) => Buffer]
> = [
  [
    "a pax size that hides a link where the header's size says data",
    (common, hidden) =>
      Buffer.concat([
        common,
        paxSizeZero(),
        tarHeader(`${P}bin/neuve`, { size: 512 }),
        hidden,
      ]),
  ],
  [
    "a folder whose size hides a link",
    (common, hidden, script) =>
      Buffer.concat([
        common,
        tarMember(`${P}bin/neuve`, script),
        tarHeader(`${P}zz/`, { type: "5", size: 512 }),
        hidden,
      ]),
  ],
  [
    "a header with a bad checksum that hides a link",
    (common, hidden, script) =>
      Buffer.concat([
        common,
        tarHeader(`${P}bin/neuve`, { size: 512, badSum: true }),
        hidden,
        tarMember(`${P}bin/x`, script),
      ]),
  ],
  [
    "a pax size on another member that hides a link after a regular bin/neuve",
    (common, hidden, script) =>
      Buffer.concat([
        common,
        tarMember(`${P}bin/neuve`, script),
        paxSizeZero(),
        tarHeader(`${P}pad`, { size: 512 }),
        hidden,
      ]),
  ],
];

/** A matching folder whose archive is `build`'s bytes, around the release's folders and record. */
const craftedFolder = async (
  build: (common: Buffer, hidden: Buffer, script: Buffer) => Buffer,
) => {
  const outside = join(await scratchDirectory("neuve-outside-"), "runner");
  await writeFile(
    outside,
    `#!/bin/sh\nprintf '%s\\n' "$*" >>"${cliRuns}"\nexit 0\n`,
    { mode: 0o755 },
  );
  const record = Buffer.from(
    `${JSON.stringify(
      releaseSchema.parse({
        schemaVersion: 1,
        version: VERSION,
        target: "darwin-arm64",
        repository: "NeuveAI/neuve",
        cliSha256: "0".repeat(64),
        commit: checkout.head,
        dirty: false,
        graphRevision: checkout.graph,
        files: ["bin/neuve", "lib/neuve"],
      }),
    )}\n`,
  );
  const common = Buffer.concat([
    tarMember(P, undefined, "5"),
    tarMember(`${P}lib/`, undefined, "5"),
    tarMember(`${P}lib/neuve/`, undefined, "5"),
    tarMember(`${P}lib/neuve/release.json`, record),
    tarMember(`${P}bin/`, undefined, "5"),
  ]);
  const hidden = tarHeader(`${P}bin/neuve`, { type: "2", link: outside });
  const script = Buffer.from("#!/bin/sh\nexit 0\n");
  const measured = await measuredFolder();
  await writeFile(
    join(measured.folder, ASSET),
    gzipSync(
      Buffer.concat([build(common, hidden, script), Buffer.alloc(1024)]),
    ),
  );
  await writeChecksums(measured.folder, [ASSET, "install.sh"]);
  return measured;
};

for (const [label, build] of crafted)
  test(`--from refuses ${label}, and runs nothing`, async () => {
    const measured = await craftedFolder(build);
    expect(await release(measured), output()).toBe(1);
    expect(output()).toContain(
      "refuse archive members: neuve-darwin-arm64/bin/neuve is a symbolic link",
    );
    expect(output()).toContain(
      "refuse built CLI: not run: the archive's members don't pass",
    );
    expect(output()).toContain("Nothing was uploaded or created.");
    expect(await Bun.file(cliRuns).exists()).toBe(false);
    expect(await uploads()).toEqual([]);
  });

/** The unpack folders inspectArchive has left in TMPDIR. */
const unpackFolders = async () =>
  (await readdir(tmpdir())).filter((name) =>
    name.startsWith("neuve-release-archive-"),
  );

// tar restores a folder's mode, so an archive can hold a folder its owner can't read or write; the
// check must still end with a plain line, and remove everything it unpacked.
const lockedFolders: ReadonlyArray<
  readonly [string, string, (common: Buffer, script: Buffer) => Buffer]
> = [
  [
    "a folder with mode 0000",
    "neuve-darwin-arm64/locked can't be read (mode 0000)",
    (common, script) =>
      Buffer.concat([
        common,
        tarMember(`${P}bin/neuve`, script),
        tarMember(`${P}locked/`, undefined, "5", 0o000),
      ]),
  ],
  [
    "a folder with mode 0555",
    "neuve-darwin-arm64/ro can't be written to (mode 0555), so the installer couldn't replace it",
    (common, script) =>
      Buffer.concat([
        common,
        tarMember(`${P}bin/neuve`, script),
        tarMember(`${P}ro/`, undefined, "5", 0o555),
        tarMember(`${P}ro/f`, Buffer.from("x\n"), "0", 0o644),
      ]),
  ],
];

for (const [label, detail, build] of lockedFolders)
  test(`--from refuses an archive with ${label} plainly, and leaves no unpack folder`, async () => {
    const before = await unpackFolders();
    const measured = await craftedFolder((common, _hidden, script) =>
      build(common, script),
    );
    expect(await release(measured), output()).toBe(1);
    expect(output()).toContain(`refuse archive members: ${detail}`);
    expect(output()).toContain(
      "refuse built CLI: not run: the archive's members don't pass",
    );
    expect(output()).toContain("Nothing was uploaded or created.");
    expect(await uploads()).toEqual([]);
    expect(await unpackFolders()).toEqual(before);
  });

// What the installer refuses in tar's listings is refused here too, before anything is unpacked,
// even when the tree tar would leave behind looks clean.
const listingRefusals: ReadonlyArray<
  readonly [
    string,
    string,
    (common: Buffer, hidden: Buffer, script: Buffer) => Buffer,
  ]
> = [
  [
    "a link that a later regular file overwrites",
    "neuve-darwin-arm64/bin/neuve is a symbolic link",
    (common, hidden, script) =>
      Buffer.concat([common, hidden, tarMember(`${P}bin/neuve`, script)]),
  ],
  [
    "a second release.json",
    "neuve-darwin-arm64/lib/neuve/release.json appears 2 times",
    (common, _hidden, script) =>
      Buffer.concat([
        tarMember(`${P}lib/neuve/release.json`, Buffer.from("{}\n")),
        common,
        tarMember(`${P}bin/neuve`, script),
      ]),
  ],
  // tar's listing is read untrimmed: a space at either end of a name, or a name of only spaces,
  // must not slip past the checks the installer makes.
  [
    "a first member whose name starts with a space",
    '" neuve-darwin-arm64/z" is outside neuve-darwin-arm64/',
    (common, _hidden, script) =>
      Buffer.concat([
        tarMember(` ${P}z`, Buffer.from("x\n")),
        common,
        tarMember(`${P}bin/neuve`, script),
      ]),
  ],
  [
    "a first member named only with spaces",
    '"   " is outside neuve-darwin-arm64/',
    (common, _hidden, script) =>
      Buffer.concat([
        tarMember("   ", Buffer.from("x\n")),
        common,
        tarMember(`${P}bin/neuve`, script),
      ]),
  ],
  [
    "a last member named only with spaces",
    '"   " is outside neuve-darwin-arm64/',
    (common, _hidden, script) =>
      Buffer.concat([
        common,
        tarMember(`${P}bin/neuve`, script),
        tarMember("   ", Buffer.from("x\n")),
      ]),
  ],
  [
    "a bare entry for the release's folder",
    "neuve-darwin-arm64 is a bare entry for the release's folder",
    (common, _hidden, script) =>
      Buffer.concat([
        tarMember("neuve-darwin-arm64", undefined, "5"),
        common,
        tarMember(`${P}bin/neuve`, script),
      ]),
  ],
];

for (const [label, detail, build] of listingRefusals)
  test(`--from refuses ${label} before unpacking, as the installer does`, async () => {
    const before = await unpackFolders();
    const measured = await craftedFolder(build);
    expect(await release(measured), output()).toBe(1);
    expect(output()).toContain("refuse archive members: ");
    expect(output()).toContain(detail);
    expect(output()).toContain("so it wasn't unpacked");
    expect(output()).toContain(
      "refuse built CLI: not run: the archive's members don't pass",
    );
    expect(await Bun.file(cliRuns).exists()).toBe(false);
    expect(await uploads()).toEqual([]);
    expect(await unpackFolders()).toEqual(before);
  });

test("a CLI with a quarantine mark is never run, and the release is refused", async () => {
  const measured = await measuredFolder();
  const marked = Bun.spawnSync([
    "/usr/bin/xattr",
    "-w",
    "com.apple.quarantine",
    "0081;00000000;release-test;",
    join(measured.folder, ASSET),
  ]);
  expect(marked.exitCode).toBe(0);
  expect(await release(measured), output()).toBe(1);
  expect(output()).toContain(
    "refuse built CLI: the archive carries a quarantine mark, so its bin/neuve was not run",
  );
  expect(await Bun.file(cliRuns).exists()).toBe(false);
  expect(await uploads()).toEqual([]);
});

test("--target goes with --from only, and --from takes no --out", async () => {
  const measured = await measuredFolder();
  expect(
    await runRelease({
      version: VERSION,
      dryRun: true,
      root: checkout.root,
      env: checkout.env,
      say: (line) => lines.push(line),
      target: checkout.head,
    }),
  ).toBe(1);
  expect(output()).toContain("--target goes with --from");
  expect(await release(measured, { out: measured.folder })).toBe(1);
  expect(output()).toContain("--out doesn't apply");
  expect(await ghCalls()).toEqual([]);
});
