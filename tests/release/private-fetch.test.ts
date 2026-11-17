// Why: the release lives on a private repository, so the installer downloads it with the friend's
// own GitHub sign-in. These cases run the real installer against a stub `gh` and against a local
// server that answers like GitHub's API (a release list, a release by tag, assets that redirect to
// another host). They pin that the token goes only in a header to the API host, never to the
// redirect host, never into a process's arguments, a file or the output; that the newest release
// counts previews but not drafts; that SHA256SUMS is checked before anything is installed; and that
// without a sign-in the installer stops and says how to sign in.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  ASSET,
  filesContaining,
  install,
  removeAllScratch,
  run,
  scratch,
  snapshot,
  stubs,
  TARGET,
  tinyRelease,
  type Scratch,
  type TinyRelease,
} from "./release-fixture.ts";
import { stampInstaller } from "../../scripts/release/release.ts";
import { writeChecksums } from "../../scripts/release/checksums.ts";

const TOKEN = "ghp_fakeTokenForTheReleaseTests0123456789";
const REPO = "NeuveAI/neuve";

interface Seen {
  readonly server: "api" | "download" | "public";
  readonly host: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly accept: string | null;
}
const seen: Array<Seen> = [];
const releases = new Map<string, TinyRelease>();
let tamper = false;
let api: ReturnType<typeof Bun.serve>;
let files: ReturnType<typeof Bun.serve>;
/** github.com's public release downloads, as for a public repository; `privateRepo` answers 404. */
let publicFiles: ReturnType<typeof Bun.serve>;
let privateRepo = false;

beforeAll(async () => {
  releases.set("v0.2.0-preview.1", await tinyRelease("0.2.0-preview.1"));
  releases.set("v0.1.0", await tinyRelease("0.1.0"));
  files = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({
        server: "download",
        host: request.headers.get("host") ?? "",
        url: request.url,
        authorization: request.headers.get("authorization"),
        accept: request.headers.get("accept"),
      });
      const [, , tag, name] = url.pathname.split("/");
      const release = releases.get(tag ?? "");
      if (release === undefined || name === undefined)
        return new Response("missing", { status: 404 });
      const bytes = await readFile(join(release.directory, "assets", name));
      return new Response(
        tamper && name === ASSET
          ? Buffer.concat([bytes, Buffer.from("x")])
          : bytes,
      );
    },
  });
  publicFiles = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      seen.push({
        server: "public",
        host: request.headers.get("host") ?? "",
        url: request.url,
        authorization: request.headers.get("authorization"),
        accept: request.headers.get("accept"),
      });
      const prefix = `/${REPO}/releases/`;
      if (privateRepo || !url.pathname.startsWith(prefix))
        return new Response("Not Found", { status: 404 });
      const rest = url.pathname.slice(prefix.length).split("/");
      // latest/download is the newest release that isn't a preview: v0.1.0 here.
      const [tag, name] =
        rest[0] === "latest" && rest[1] === "download"
          ? ["v0.1.0", rest[2]]
          : rest[0] === "download"
            ? [rest[1], rest[2]]
            : [undefined, undefined];
      const release = releases.get(tag ?? "");
      if (release === undefined || name === undefined)
        return new Response("Not Found", { status: 404 });
      const bytes = await readFile(
        join(release.directory, "assets", name),
      ).catch(() => null);
      if (bytes === null) return new Response("Not Found", { status: 404 });
      return new Response(bytes);
    },
  });
  api = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      seen.push({
        server: "api",
        host: request.headers.get("host") ?? "",
        url: request.url,
        authorization: request.headers.get("authorization"),
        accept: request.headers.get("accept"),
      });
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`)
        return Response.json({ message: "Bad credentials" }, { status: 401 });
      const base = `/repos/${REPO}/releases`;
      if (url.pathname === base)
        return Response.json([
          { tag_name: "v0.3.0", draft: true, prerelease: false, body: null },
          {
            tag_name: "v0.2.0-preview.1",
            draft: false,
            prerelease: true,
            body: null,
          },
          {
            tag_name: "v0.1.0",
            draft: false,
            prerelease: false,
            body: "first",
          },
        ]);
      if (url.pathname.startsWith(`${base}/tags/`)) {
        const tag = url.pathname.slice(`${base}/tags/`.length);
        const index = [...releases.keys()].indexOf(tag);
        if (index === -1)
          return Response.json({ message: "Not Found" }, { status: 404 });
        return Response.json({
          tag_name: tag,
          draft: false,
          body: null,
          assets: ["install.sh", ASSET, "SHA256SUMS"].map((name, position) => ({
            id: (index + 1) * 100 + position,
            name,
            label: null,
            url: `http://127.0.0.1:${api.port}${base}/assets/${(index + 1) * 100 + position}`,
          })),
        });
      }
      if (url.pathname.startsWith(`${base}/assets/`)) {
        const id = Number(url.pathname.slice(`${base}/assets/`.length));
        const tag = [...releases.keys()][Math.floor(id / 100) - 1];
        const name = ["install.sh", ASSET, "SHA256SUMS"][id % 100];
        if (
          tag === undefined ||
          name === undefined ||
          request.headers.get("accept") !== "application/octet-stream"
        )
          return Response.json({ message: "Not Found" }, { status: 404 });
        // GitHub answers with a redirect to a signed address on another host.
        return Response.redirect(
          `http://localhost:${files.port}/files/${tag}/${name}`,
          302,
        );
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    },
  });
});
afterAll(async () => {
  await api?.stop(true);
  await files?.stop(true);
  await publicFiles?.stop(true);
  await removeAllScratch();
});
afterEach(() => {
  seen.length = 0;
  tamper = false;
  privateRepo = false;
});

/** A scratch home whose curl records its arguments, then runs the real curl. */
const withToken = async (token = TOKEN) => {
  const context = await scratch();
  const argv = join(context.directory, "curl-argv.log");
  const shim = await stubs({
    curl: `#!/bin/sh\nprintf '%s\\n' '--- call' >>"${argv}"\nfor word in "$@"; do printf '%s\\n' "$word" >>"${argv}"; done\nexec /usr/bin/curl "$@"\n`,
  });
  context.env = {
    ...context.env,
    PATH: `${shim}:${context.env.PATH}`,
    GH_TOKEN: token,
    NEUVE_GITHUB_API: `http://127.0.0.1:${api.port}`,
  };
  return { context, argv };
};

const expectNoToken = async (
  context: Scratch,
  output: string,
  argv: string,
  token = TOKEN,
) => {
  expect(output).not.toContain(token);
  expect(await readFile(argv, "utf8")).not.toContain(token);
  expect(await filesContaining(context.directory, token)).toEqual([]);
  for (const request of seen) expect(request.url).not.toContain(token);
};

// The token route reads GitHub's answers with plutil, which only macOS has (NEU-375).
describe.skipIf(process.platform !== "darwin")("the token route", () => {
  // A user's ~/.curlrc can turn on verbose output or a trace file, which would hold the request
  // headers, the token among them. The installer's curl must not read it.
  test("a ~/.curlrc that turns on verbose output and a trace file never sees the token", async () => {
    const { context, argv } = await withToken();
    const trace = join(context.home, "curl-trace.txt");
    await writeFile(
      join(context.home, ".curlrc"),
      `verbose\ntrace-ascii = "${trace}"\n`,
    );
    const result = await install(context, undefined);
    expect(result.code, result.output).toBe(0);
    expect(await Bun.file(trace).exists()).toBe(false);
    await expectNoToken(context, result.output, argv);
    const words = (await readFile(argv, "utf8")).split("\n");
    // Every call starts with -q, curl's switch for skipping ~/.curlrc.
    const calls = words.filter((_, index) => words[index - 1] === "--- call");
    expect(calls.length).toBeGreaterThan(3);
    for (const first of calls) expect(first).toBe("-q");
  });

  test("installs the newest release, previews included and drafts not, sending the token only to the API", async () => {
    const { context, argv } = await withToken();
    const result = await install(context, undefined);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Installed neuve 0.2.0-preview.1");
    expect((await run([context.cli, "--version"], context.env)).stdout).toBe(
      "neuve 0.2.0-preview.1\n",
    );
    const fromApi = seen.filter((request) => request.server === "api");
    const fromFiles = seen.filter((request) => request.server === "download");
    expect(fromApi.map((request) => new URL(request.url).pathname)).toEqual([
      `/repos/${REPO}/releases`,
      `/repos/${REPO}/releases/tags/v0.2.0-preview.1`,
      `/repos/${REPO}/releases/assets/101`,
      `/repos/${REPO}/releases/assets/102`,
    ]);
    for (const request of fromApi)
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    expect(fromFiles.map((request) => new URL(request.url).pathname)).toEqual([
      `/files/v0.2.0-preview.1/${ASSET}`,
      "/files/v0.2.0-preview.1/SHA256SUMS",
    ]);
    for (const request of fromFiles) {
      expect(request.host).toBe(`localhost:${files.port}`);
      expect(request.authorization).toBeNull();
    }
    await expectNoToken(context, result.output, argv);
    // The private download folder is gone; nothing else was left in the temporary folder.
    expect(await readdir(context.temporary)).toEqual([]);
  });

  test("an installer from a release downloads that release; only --version latest asks for the newest", async () => {
    const { context, argv } = await withToken();
    const stamped = join(context.directory, "install.sh");
    await writeFile(
      stamped,
      stampInstaller(
        await readFile(
          join(import.meta.dir, "../../scripts/install.sh"),
          "utf8",
        ),
        "0.1.0",
      ),
    );
    const own = await run(["sh", stamped], context.env);
    expect(own.code, own.output).toBe(0);
    expect(own.output).toContain("Installed neuve 0.1.0");
    const paths = seen.map((request) => new URL(request.url).pathname);
    expect(paths).not.toContain(`/repos/${REPO}/releases`);
    expect(paths).toContain(`/repos/${REPO}/releases/tags/v0.1.0`);
    seen.length = 0;
    const newest = await run(
      ["sh", stamped, "--version", "latest"],
      context.env,
    );
    expect(newest.code, newest.output).toBe(0);
    expect(newest.output).toContain("Installed neuve 0.2.0-preview.1");
    expect(seen.map((request) => new URL(request.url).pathname)[0]).toBe(
      `/repos/${REPO}/releases`,
    );
    await expectNoToken(context, own.output + newest.output, argv);
  });

  test("--version picks that release by its tag", async () => {
    const { context, argv } = await withToken();
    const result = await install(context, undefined, ["--version", "0.1.0"]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Installed neuve 0.1.0");
    expect(
      seen.some(
        (request) =>
          new URL(request.url).pathname === `/repos/${REPO}/releases`,
      ),
    ).toBe(false);
    await expectNoToken(context, result.output, argv);
  });

  test("checks SHA256SUMS before anything is installed", async () => {
    const { context, argv } = await withToken();
    tamper = true;
    const result = await install(context, undefined);
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      `${ASSET} doesn't match SHA256SUMS, so nothing was installed.`,
    );
    expect(await Bun.file(context.prefix).exists()).toBe(false);
    await expectNoToken(context, result.output, argv);
  });

  test("says plainly when the release is missing or the token is refused, without showing the token", async () => {
    const { context, argv } = await withToken();
    const missing = await install(context, undefined, ["--version", "9.9.9"]);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain(
      `Couldn't find the release v9.9.9 in ${REPO} (HTTP 404).`,
    );
    await expectNoToken(context, missing.output, argv);
    const wrong = "ghp_aWrongTokenThatGitHubRefuses000000";
    const refused = await withToken(wrong);
    const denied = await install(refused.context, undefined);
    expect(denied.code).toBe(1);
    expect(denied.output).toContain("GitHub refused the token (HTTP 401).");
    await expectNoToken(refused.context, denied.output, refused.argv, wrong);
    const odd = await withToken("not a token; rm -rf ~");
    const rejected = await install(odd.context, undefined);
    expect(rejected.code).toBe(1);
    expect(rejected.output).toContain(
      "holds characters a GitHub token never has",
    );
    expect(rejected.output).not.toContain("rm -rf");
    expect(await Bun.file(odd.argv).exists()).toBe(false);
  });

  test("a dry run reads the release list only, and writes nothing", async () => {
    const { context, argv } = await withToken();
    const before = await snapshot(context.directory);
    const result = await install(context, undefined, ["--dry-run"]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(
      `Release: v0.2.0-preview.1 (the newest release) of ${REPO}, downloaded with the token in GH_TOKEN or GITHUB_TOKEN, sent only to GitHub.`,
    );
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
      `/repos/${REPO}/releases`,
    ]);
    const after = await snapshot(context.directory);
    // The curl recorder's own log is the only new file.
    expect(Object.keys(after).filter((path) => !(path in before))).toEqual([
      "curl-argv.log",
    ]);
    await expectNoToken(context, result.output, argv);
  });
});

describe("the GitHub CLI route", () => {
  const ghStub = async (context: Scratch, signedIn: boolean) => {
    const log = join(context.directory, "gh-argv.log");
    const release = releases.get("v0.2.0-preview.1");
    if (release === undefined) throw new Error("fixture release missing");
    const shim = await stubs({
      gh: [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >>"${log}"`,
        `if [ "$1 $2" = "auth status" ]; then exit ${signedIn ? 0 : 1}; fi`,
        'if [ "$1" = api ]; then echo v0.2.0-preview.1; exit 0; fi',
        'if [ "$1 $2" = "release download" ]; then',
        '  dir=; while [ "$#" -gt 0 ]; do [ "$1" = --dir ] && dir=$2; shift; done',
        `  cp "${release.archive}" "${release.sums}" "$dir/"; exit 0`,
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    });
    context.env = { ...context.env, PATH: `${shim}:${context.env.PATH}` };
    return log;
  };

  test("downloads with gh release download into a private temporary folder", async () => {
    const context = await scratch();
    const log = await ghStub(context, true);
    const result = await install(context, undefined);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Installed neuve 0.2.0-preview.1");
    const calls = (await readFile(log, "utf8")).trim().split("\n");
    expect(calls[0]).toBe("auth status --hostname github.com");
    expect(calls[1]).toBe(
      `api repos/${REPO}/releases?per_page=30 --jq [.[] | select(.draft | not)][0].tag_name // ""`,
    );
    const temporary = await realpath(context.temporary);
    expect(calls[2]).toMatch(
      new RegExp(
        `^release download v0\\.2\\.0-preview\\.1 --repo ${REPO} --pattern ${ASSET.replaceAll(".", "\\.")} --pattern SHA256SUMS --dir ${temporary.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}/neuve-install\\.[A-Za-z0-9]+/download$`,
      ),
    );
    expect(calls).toHaveLength(3);
    expect(await readdir(context.temporary)).toEqual([]);
  });

  test("the repository comes from NEUVE_REPO, the one place it is set", async () => {
    const context = await scratch();
    const log = await ghStub(context, true);
    context.env.NEUVE_REPO = "Someone/fork";
    expect(
      (await install(context, undefined, ["--version", "0.2.0-preview.1"]))
        .code,
    ).toBe(0);
    expect(await readFile(log, "utf8")).toContain(
      "release download v0.2.0-preview.1 --repo Someone/fork",
    );
  });

  test("without a sign-in, a private repository's 404 says how to sign in, and writes nothing", async () => {
    privateRepo = true;
    for (const signedIn of [undefined, false]) {
      const context = await scratch();
      context.env.NEUVE_GITHUB_DOWNLOADS = `http://127.0.0.1:${publicFiles.port}`;
      if (signedIn === false) await ghStub(context, false);
      const before = await snapshot(context.home);
      const result = await install(context, undefined);
      expect(result.code).toBe(1);
      // The token route runs on macOS only, so on Linux the hint names only the GitHub CLI.
      const signIn =
        process.platform === "darwin"
          ? `sign in with the GitHub CLI (gh auth login), or set GH_TOKEN to a GitHub token that can read ${REPO}.`
          : "sign in with the GitHub CLI (gh auth login).";
      expect(result.output).toContain(
        `Can't find ${ASSET} for a release that isn't a preview in ${REPO}. If the repository is private, ${signIn}`,
      );
      expect(await snapshot(context.home)).toEqual(before);
      expect(await readdir(context.temporary)).toEqual([]);
    }
  });
});

// Once the repository is public, `curl -fsSL https://neuve.ai/install.sh | sh` needs no sign-in.
describe("the public route", () => {
  const publicContext = async () => {
    const context = await scratch();
    context.env.NEUVE_GITHUB_DOWNLOADS = `http://127.0.0.1:${publicFiles.port}`;
    return context;
  };

  test("installs the newest release that isn't a preview, with no sign-in and no API call", async () => {
    const context = await publicContext();
    const result = await install(context, undefined);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Installed neuve 0.1.0");
    expect(seen.every((request) => request.server === "public")).toBe(true);
    expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
      `/${REPO}/releases/latest/download/${ASSET}`,
      `/${REPO}/releases/latest/download/SHA256SUMS`,
    ]);
    expect(seen.every((request) => request.authorization === null)).toBe(true);
    expect(await readdir(context.temporary)).toEqual([]);
  });

  test("--version downloads that release's tag, previews included", async () => {
    const context = await publicContext();
    const result = await install(context, undefined, [
      "--version",
      "0.2.0-preview.1",
    ]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("Installed neuve 0.2.0-preview.1");
    expect(new URL(seen[0]!.url).pathname).toBe(
      `/${REPO}/releases/download/v0.2.0-preview.1/${ASSET}`,
    );
  });

  test("names a missing release and installs nothing", async () => {
    const context = await publicContext();
    const before = await snapshot(context.home);
    const missing = await install(context, undefined, ["--version", "9.9.9"]);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain(
      `Can't find ${ASSET} for the release v9.9.9 in ${REPO}.`,
    );
    expect(await snapshot(context.home)).toEqual(before);
  });

  // v0.1.0 shipped for Macs only: a release can hold SHA256SUMS and no archive for this machine.
  // The installer then says there's no build here yet, on the public and GitHub CLI routes alike,
  // instead of suggesting a sign-in.
  test("says plainly when a release has no build for this machine, and installs nothing", async () => {
    const other = TARGET === "darwin-arm64" ? "linux-x64" : "darwin-arm64";
    const otherBuild =
      other === "darwin-arm64" ? "Macs with Apple silicon" : "Linux on x64";
    const system = TARGET.startsWith("darwin") ? "macOS" : "Linux";
    const release = await tinyRelease("0.3.0");
    const assets = join(release.directory, "assets");
    await rename(join(assets, ASSET), join(assets, `neuve-${other}.tar.gz`));
    await writeChecksums(assets);
    releases.set("v0.3.0", release);
    try {
      const publicRoute = await publicContext();
      const ghRoute = await scratch();
      const gh = await stubs({
        gh: [
          "#!/bin/sh",
          'if [ "$1 $2" = "auth status" ]; then exit 0; fi',
          'if [ "$1 $2" = "release download" ]; then',
          '  dir=; while [ "$#" -gt 0 ]; do [ "$1" = --dir ] && dir=$2; shift; done',
          `  cp "${join(assets, "SHA256SUMS")}" "$dir/"; exit 0`,
          "fi",
          "exit 1",
          "",
        ].join("\n"),
      });
      ghRoute.env = { ...ghRoute.env, PATH: `${gh}:${ghRoute.env.PATH}` };
      for (const context of [publicRoute, ghRoute]) {
        const before = await snapshot(context.home);
        const result = await install(context, undefined, [
          "--version",
          "0.3.0",
        ]);
        expect(result.code).toBe(1);
        expect(result.output).toContain(
          `The release v0.3.0 of ${REPO} has no ${system} build for this machine yet (${ASSET}), so nothing was installed. It has builds for ${otherBuild} only.`,
        );
        expect(result.output).not.toContain("sign in");
        expect(await snapshot(context.home)).toEqual(before);
        expect(await readdir(context.temporary)).toEqual([]);
      }
    } finally {
      releases.delete("v0.3.0");
    }
  });

  // Review F2: Codespaces set GITHUB_TOKEN, and neuve upgrade passes the environment on. On Linux
  // the token route can't run (it reads GitHub's answers with plutil), so a token there must fall
  // through to the public download, never stop the install. Linux is stood up here with stubs.
  test("on Linux a token in the environment falls through to the public download", async () => {
    const context = await publicContext();
    const tools = join(context.directory, "linux-tools");
    await mkdir(tools);
    for (const folder of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])
      for (const name of await readdir(folder).catch(() => []))
        if (!["plutil", "gh", "uname", "getconf"].includes(name))
          await symlink(join(folder, name), join(tools, name)).catch(() => {});
    const linux = await stubs({
      uname:
        '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n',
      getconf: "#!/bin/sh\necho glibc 2.35\n",
    });
    context.env = {
      ...context.env,
      PATH: `${linux}:${tools}`,
      GITHUB_TOKEN: TOKEN,
      NEUVE_GITHUB_API: `http://127.0.0.1:${api.port}`,
    };
    const result = await install(context, undefined);
    expect(result.output).not.toContain("isn't supported on Linux");
    expect(result.output).not.toContain(TOKEN);
    expect(seen.length, result.output).toBeGreaterThan(0);
    expect(seen.every((request) => request.server === "public")).toBe(true);
    expect(seen.every((request) => request.authorization === null)).toBe(true);
    expect(new URL(seen[0]!.url).pathname).toBe(
      `/${REPO}/releases/latest/download/neuve-linux-x64.tar.gz`,
    );
  });

  test("a dry run downloads nothing and says it needs no sign-in", async () => {
    const context = await publicContext();
    const result = await install(context, undefined, ["--dry-run"]);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(
      `Release: the newest release of ${REPO} that isn't a preview, downloaded without a sign-in, from http://127.0.0.1:${publicFiles.port}.`,
    );
    expect(seen).toEqual([]);
  });
});

// The installer offers the agent skills through neuve itself and never writes a coding agent's
// configuration. (The background worker's launchd agent or systemd timer, decision 13.14, is
// neuve's own and is set up through `neuve worker install-agent`; --no-agent skips it.)
test("the installer never writes an agent's configuration itself", async () => {
  const text = await readFile(
    join(import.meta.dir, "../../scripts/install.sh"),
    "utf8",
  );
  for (const forbidden of [".claude", ".codex"])
    expect(text).not.toContain(forbidden);
});
