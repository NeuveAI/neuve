// Why: the release command is the one step that writes to GitHub, so its guards must refuse every
// case the owner ruled out (a dirty tree, a commit off main, no passing check for this commit, a
// version that isn't new, another host or Bun, a Graph engine not from the commit's pointer), a dry
// run must never create anything on GitHub, and the real step must be exactly one
// `gh release create` of a prerelease on this commit with the three release files. A stub `gh`
// records every call; a scratch repository stands in for the checkout; the archive build is replaced
// by a stand-in because archive.test.ts covers the real one.
import { afterEach, beforeEach, expect, test as bunTest } from "bun:test";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  highestRelease,
  isPrerelease,
  publishCommand,
  quote,
  type ReleaseOptions,
  runRelease,
} from "../../scripts/release/release.ts";
import {
  ghInvocations,
  git,
  installer,
  releaseCheckout,
  removeAllScratch,
  scratchDirectory,
  type Checkout,
} from "./release-fixture.ts";

// bun run release builds and checks a darwin-arm64 release on the owner's Mac: it refuses any
// other host, and reads macOS's quarantine marks with xattr. So these run on macOS only.
const test = process.platform === "darwin" ? bunTest : bunTest.skip;

let checkout: Checkout;
let built: Array<string>;
/** Whether the stand-in archive's neuve answers `doctor --help`, as slice A's CLI does. */
let withDoctor: boolean;

/** A real archive whose bin/neuve is a script, standing in for the archive build. */
const fakeArchive = async (out: string, version: string) => {
  const stage = await scratchDirectory("neuve-fake-archive-");
  await mkdir(join(stage, "neuve-darwin-arm64/bin"), { recursive: true });
  await writeFile(
    join(stage, "neuve-darwin-arm64/bin/neuve"),
    `#!/bin/sh\n[ "$1" = --version ] && { echo "neuve ${version}"; exit 0; }\n${withDoctor ? '[ "$1" = doctor ] && exit 0\n' : ""}echo "neuve: Unknown command: $1" >&2; exit 2\n`,
    { mode: 0o755 },
  );
  const packed = Bun.spawnSync([
    "tar",
    "-czf",
    join(out, "neuve-darwin-arm64.tar.gz"),
    "-C",
    stage,
    "neuve-darwin-arm64",
  ]);
  if (packed.exitCode !== 0) throw new Error("tar failed");
};

const lines: Array<string> = [];
const release = (overrides: Partial<ReleaseOptions> = {}) =>
  runRelease({
    version: "0.1.0-preview.2",
    dryRun: false,
    root: checkout.root,
    host: "darwin-arm64",
    bunVersion: "1.4.4",
    env: checkout.env,
    say: (line) => lines.push(line),
    build: async (version, out) => {
      built.push(version);
      await fakeArchive(out, version);
    },
    ...overrides,
  });
const ghCalls = async () =>
  (await ghInvocations(checkout.ghLog)).map((call) => call.args.join(" "));
const output = () => lines.join("\n");

beforeEach(async () => {
  lines.length = 0;
  built = [];
  withDoctor = true;
  checkout = await releaseCheckout();
});
afterEach(removeAllScratch, 60_000);

test("with every guard passing, the release is one gh release create of a prerelease on this commit", async () => {
  expect(await release(), output()).toBe(0);
  for (const name of [
    "tree",
    "history",
    "check receipt",
    "version",
    "host",
    "bun",
    "graph engine",
  ])
    expect(output()).toContain(`ok     ${name}:`);
  expect(output()).toContain(
    "0.1.0-preview.2 is higher than 0.1.0-preview.1, the highest release of NeuveAI/neuve, and v0.1.0-preview.2 is free",
  );
  expect(output()).toContain(
    `built from ${checkout.graph.slice(0, 10)}, the commit's Graph pointer`,
  );
  const out = join(checkout.root, "dist/release/0.1.0-preview.2");
  const calls = await ghCalls();
  expect(calls).toEqual([
    "release list --repo NeuveAI/neuve --limit 1000 --json tagName --jq .[].tagName",
    "api repos/NeuveAI/neuve/git/ref/tags/v0.1.0-preview.2 --jq .object.sha",
    [
      "release create v0.1.0-preview.2 --repo NeuveAI/neuve",
      `--target ${checkout.head} --prerelease --generate-notes --title Neuve 0.1.0-preview.2`,
      "neuve-darwin-arm64.tar.gz install.sh SHA256SUMS",
    ].join(" "),
  ]);
  // gh runs inside the folder with the bare names, which hold nothing gh reads as a label or pattern.
  const create = (await ghInvocations(checkout.ghLog)).at(-1);
  expect(create?.cwd).toBe(await realpath(out));
  expect(create?.args.slice(-4)).toEqual([
    "Neuve 0.1.0-preview.2",
    "neuve-darwin-arm64.tar.gz",
    "install.sh",
    "SHA256SUMS",
  ]);
  const sums = await readFile(join(out, "SHA256SUMS"), "utf8");
  expect(sums).toMatch(
    /^[0-9a-f]{64} {2}install\.sh\n[0-9a-f]{64} {2}neuve-darwin-arm64\.tar\.gz\n$/,
  );
  expect(await readFile(join(out, "install.sh"), "utf8")).toBe(
    (await readFile(installer, "utf8")).replace(
      "\nshipped_version=\n",
      "\nshipped_version=0.1.0-preview.2\n",
    ),
  );
});

test("a dry run builds the files and prints the GitHub step, and creates nothing on GitHub", async () => {
  expect(await release({ dryRun: true }), output()).toBe(0);
  expect(built).toEqual(["0.1.0-preview.2"]);
  expect(output()).toContain("The GitHub step a real release takes (not run):");
  expect(output()).toContain(
    `cd ${quote([join(checkout.root, "dist/release/0.1.0-preview.2")])} && gh release create v0.1.0-preview.2 --repo NeuveAI/neuve --target ${checkout.head} --prerelease --generate-notes --title 'Neuve 0.1.0-preview.2' neuve-darwin-arm64.tar.gz install.sh SHA256SUMS`,
  );
  expect(output()).toContain(
    "Every guard passes: a real release would go ahead.",
  );
  const calls = await ghCalls();
  expect(calls.some((call) => call.startsWith("release create"))).toBe(false);
  // Its only GitHub calls read.
  for (const call of calls)
    expect(call).toMatch(
      /^(release list|api repos\/NeuveAI\/neuve\/git\/ref\/tags\/)/,
    );
});

/** The options a case plants before the release runs. */
type Planted = { -readonly [K in keyof ReleaseOptions]?: ReleaseOptions[K] };

const refusals: ReadonlyArray<
  readonly [
    string,
    string,
    (overrides: { options: Planted }) => Promise<void> | void,
  ]
> = [
  [
    "tree",
    "this checkout has local changes",
    () => writeFile(join(checkout.root, "stray.txt"), "x\n"),
  ],
  [
    "history",
    "is not on origin/main's history",
    async () => {
      await writeFile(join(checkout.root, "later.txt"), "x\n");
      git(checkout.root, "add", "later.txt");
      git(checkout.root, "commit", "--quiet", "-m", "not on main");
    },
  ],
  [
    "check receipt",
    "no passing `bun run check` recorded for",
    () => rm(join(checkout.root, ".git/neuve-check", `${checkout.head}.json`)),
  ],
  [
    "version",
    "0.1.0-preview.2 is not higher than 0.1.0-preview.10",
    () => {
      checkout.env.STUB_TAGS = "v0.1.0-preview.10\n";
    },
  ],
  [
    "version",
    "the tag v0.1.0-preview.2 already exists on NeuveAI/neuve",
    () => {
      checkout.env.STUB_TAG_EXISTS = "1";
    },
  ],
  [
    "version",
    "is not a semantic version",
    ({ options }) => {
      options.version = "v0.1.0";
    },
  ],
  [
    "host",
    "linux-x64; the release is built on darwin-arm64 only",
    ({ options }) => {
      options.host = "linux-x64";
    },
  ],
  [
    "bun",
    "Bun 1.4.3; the release is built with Bun 1.4.4",
    ({ options }) => {
      options.bunVersion = "1.4.3";
    },
  ],
  [
    "graph engine",
    "not the commit's pointer",
    async () => {
      // The checkout's Graph moves past the pointer (the tree guard refuses too).
      const graphRoot = join(checkout.root, "apps/neuve-graph");
      await writeFile(join(graphRoot, "later.go"), "package graph\n");
      git(graphRoot, "add", ".");
      git(graphRoot, "commit", "--quiet", "-m", "moved");
    },
  ],
];

for (const [name, detail, plant] of refusals)
  test(`refuses a real release when the ${name} guard fails (${detail}), and a dry run says so`, async () => {
    const options: Planted = {};
    await plant({ options });
    expect(await release(options), output()).toBe(1);
    expect(output()).toContain(`refuse ${name}: `);
    expect(output()).toContain(detail);
    expect(output()).toContain("Nothing was built or created.");
    expect(built).toEqual([]);
    expect(
      (await ghCalls()).some((call) => call.startsWith("release create")),
    ).toBe(false);
    lines.length = 0;
    const dry = await release({ ...options, dryRun: true });
    if (options.version === "v0.1.0") {
      expect(dry).toBe(1);
      expect(output()).toContain("Nothing was built: the version isn't valid.");
    } else {
      expect(dry, output()).toBe(0);
      expect(output()).toMatch(
        new RegExp(`A real release would refuse: (.+, )?${name}[,.]`),
      );
    }
    expect(
      (await ghCalls()).some((call) => call.startsWith("release create")),
    ).toBe(false);
  });

test("a second release is a re-run with the next version: preview.2 after preview.1 goes ahead, preview.1 again is refused", async () => {
  checkout.env.STUB_TAGS = "v0.1.0-preview.1\n";
  expect(await release({ dryRun: true }), output()).toBe(0);
  expect(output()).toContain(
    "Every guard passes: a real release would go ahead.",
  );
  expect(built).toEqual(["0.1.0-preview.2"]);
  lines.length = 0;
  checkout.env.STUB_TAG_EXISTS = "1";
  expect(await release({ version: "0.1.0-preview.1" }), output()).toBe(1);
  expect(output()).toContain(
    "0.1.0-preview.1 is not higher than 0.1.0-preview.1",
  );
  expect(output()).toContain("Nothing was built or created.");
  expect(
    (await ghCalls()).some((call) => call.startsWith("release create")),
  ).toBe(false);
});

test("the newest release is chosen by version, previews below their release", () => {
  expect(
    highestRelease([
      "v0.1.0-preview.2",
      "v0.1.0-preview.10",
      "v0.0.9",
      "nightly",
    ]),
  ).toBe("0.1.0-preview.10");
  expect(highestRelease(["v0.1.0-preview.10", "v0.1.0"])).toBe("0.1.0");
  expect(highestRelease(["latest", "0.2.0"])).toBeUndefined();
});

test("a CLI without neuve doctor is not released, and a dry run says so", async () => {
  withDoctor = false;
  expect(await release(), output()).toBe(1);
  expect(output()).toContain(
    "refuse built CLI: has no neuve doctor, which the installer's last step names",
  );
  expect(output()).toContain(
    "Refused: built CLI. Nothing was created on GitHub.",
  );
  expect(
    (await ghCalls()).some((call) => call.startsWith("release create")),
  ).toBe(false);
  lines.length = 0;
  expect(await release({ dryRun: true }), output()).toBe(0);
  expect(output()).toContain("A real release would refuse: built CLI.");
  withDoctor = true;
  lines.length = 0;
  expect(
    await release({ dryRun: true, version: "0.1.0-preview.3" }),
    output(),
  ).toBe(0);
  expect(output()).toContain("ok     built CLI: has neuve doctor");
});

test("the shipped installer names its own release's tag, and SHA256SUMS lists only what is uploaded", async () => {
  const out = join(checkout.root, "dist/release/0.1.0-preview.2");
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, "neuve-old-stale.tar.gz"),
    "left from another run\n",
  );
  expect(await release({ dryRun: true }), output()).toBe(0);
  const shipped = await readFile(join(out, "install.sh"), "utf8");
  expect(shipped).toContain("\nshipped_version=0.1.0-preview.2\n");
  expect(
    shipped.replace("shipped_version=0.1.0-preview.2", "shipped_version="),
  ).toBe(await readFile(installer, "utf8"));
  expect(await readFile(join(out, "SHA256SUMS"), "utf8")).not.toContain(
    "stale",
  );
  const help = Bun.spawnSync(["sh", join(out, "install.sh"), "--help"], {
    stdout: "pipe",
  }).stdout.toString();
  expect(help).toContain(
    "gh release download v0.1.0-preview.2 --repo NeuveAI/neuve --pattern install.sh",
  );
});

// The one-line install resolves GitHub's latest release, which never includes a prerelease. So
// only a version with a prerelease part is published as one; any other is the latest full release.
// Both the build path and --from publish through publishCommand. Runs on every host.
bunTest(
  "a prerelease version publishes as a prerelease, and a plain version as the latest release",
  () => {
    const command = (version: string) =>
      publishCommand({
        version,
        commit: "0".repeat(40),
        repository: "NeuveAI/neuve",
        files: ["install.sh"],
      });
    for (const version of [
      "0.1.0-preview.3",
      "1.0.0-rc.1",
      "0.2.0-preview.1+build.7",
    ]) {
      expect(isPrerelease(version)).toBe(true);
      expect(command(version)).toContain("--prerelease");
      expect(command(version)).not.toContain("--latest");
    }
    for (const version of ["0.1.0", "1.2.3", "0.1.0+build-7"]) {
      expect(isPrerelease(version)).toBe(false);
      expect(command(version)).toContain("--latest");
      expect(command(version)).not.toContain("--prerelease");
    }
  },
);
