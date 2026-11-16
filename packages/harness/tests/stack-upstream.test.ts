import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  storeLayout,
  withStoreLock,
  CI_ISSUERS,
  GIT_CONFIG,
  NPM_REGISTRY,
  UpstreamFetchStopped,
  fetchUpstreamTree,
  gitVersionRefusal,
  normaliseRepository,
  resolveGitBinary,
  runGit,
  runWatched,
  scrubbedEnvironment,
  verifyAttestations,
  type StoreGit,
} from "../src/stack/index.ts";
import { repositoryGit } from "../src/stack/pins.ts";
import { git, repositoryWith, scratch } from "./fixtures/stack/repos.ts";

/**
 * Why: these are the guards that keep a fetch inside its bounds and its trust level honest (SC4,
 * SC5, SC7). A watchdog that kills only git would leave `git-remote-https` downloading; a protocol
 * rule that let `file:` or a redirect through would let a registry-stated URL reach anything; and a
 * provenance check that skipped the digest or the repository would label an unverified commit as
 * attested. None of these would fail on its own.
 */

setDefaultTimeout(60_000);
const root = scratch("neuve-stack-upstream-");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const gitPath = resolveGitBinary() ?? "git";
const storeGit: StoreGit = {
  gitPath,
  env: scrubbedEnvironment({ gitPath, home: root }),
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the fetch watchdog", () => {
  test("kills the whole process group once the directory passes its cap", async () => {
    const watch = join(root, "watched");
    const pidFile = join(root, "grandchild.pid");
    const started = Date.now();
    let stopped: unknown;
    try {
      await runWatched(
        [
          "/bin/sh",
          "-c",
          // A grandchild that keeps writing, as git-remote-https and index-pack would.
          'mkdir -p "$WATCH"; (while true; do head -c 20000 /dev/zero >> "$WATCH/pack"; sleep 0.05; done) & echo $! > "$PID_FILE"; wait',
        ],
        { PATH: "/usr/bin:/bin", WATCH: watch, PID_FILE: pidFile },
        {
          watch,
          capBytes: 100_000,
          timeoutMs: 30_000,
          killGraceMs: 500,
          pollMs: 100,
        },
      );
    } catch (error) {
      stopped = error;
    }
    expect(stopped).toBeInstanceOf(UpstreamFetchStopped);
    expect((stopped as UpstreamFetchStopped).reason).toBe("over-cap");
    expect(Date.now() - started).toBeLessThan(10_000);
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    await Bun.sleep(700);
    expect(alive(grandchild)).toBe(false);
  });

  test("kills a fetch that passes its time limit, SIGKILL after the grace when SIGTERM is ignored", async () => {
    let stopped: unknown;
    try {
      await runWatched(
        ["/bin/sh", "-c", "trap '' TERM; while true; do sleep 0.1; done"],
        { PATH: "/usr/bin:/bin" },
        {
          watch: root,
          capBytes: 1e12,
          timeoutMs: 300,
          killGraceMs: 300,
          pollMs: 100,
        },
      );
    } catch (error) {
      stopped = error;
    }
    expect((stopped as UpstreamFetchStopped).reason).toBe("timeout");
  });

  test("a job's stop reaches its running git command", async () => {
    const gitPath = join(root, "slow-git");
    writeFileSync(gitPath, "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const controller = new AbortController();
    const started = performance.now();
    const run = runGit(
      { gitPath, env: {}, signal: controller.signal },
      undefined,
      ["status"],
      { allowFailure: true },
    );
    const read = repositoryGit(root, {}, gitPath, controller.signal).run([
      "ls-tree",
      "HEAD",
    ]);
    setTimeout(() => controller.abort(), 50);
    await Promise.all([
      run,
      expect(read).rejects.toThrow("git ls-tree failed"),
    ]);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  test("stops a fetch that starts after its job was interrupted", async () => {
    const controller = new AbortController();
    controller.abort();
    let stopped: unknown;
    try {
      await runWatched(
        ["/bin/sh", "-c", "while true; do sleep 0.1; done"],
        { PATH: "/usr/bin:/bin" },
        {
          watch: root,
          capBytes: 1e12,
          timeoutMs: 30_000,
          killGraceMs: 300,
          signal: controller.signal,
        },
      );
    } catch (error) {
      stopped = error;
    }
    expect((stopped as UpstreamFetchStopped).reason).toBe("interrupted");
  });
});

describe("upstream fetches", () => {
  test("refuse every URL but HTTPS to an allowed host, before and inside git", async () => {
    const source = repositoryWith(join(root, "src"), { a: "a" });
    const refuse = async (url: string) => {
      try {
        await fetchUpstreamTree(
          storeGit,
          join(root, `q-${Math.random()}.git`),
          url,
          source.commit,
          {
            capBytes: 1e8,
            timeoutMs: 30_000,
            killGraceMs: 1_000,
            hosts: ["github.com"],
            blobLimit: "1m",
          },
        );
      } catch (error) {
        return error instanceof UpstreamFetchStopped
          ? error.reason
          : String(error);
      }
      return "fetched";
    };
    expect(await refuse(`file://${source.repo}`)).toBe("failed");
    expect(await refuse("http://github.com/owner/repo.git")).toBe("failed");
    expect(await refuse("https://evil.example/owner/repo.git")).toBe("failed");
    // Git itself refuses the file transport under the store's configuration.
    const direct = Bun.spawnSync(
      [gitPath, ...GIT_CONFIG, "ls-remote", `file://${source.repo}`],
      { env: storeGit.env, stderr: "pipe" },
    );
    expect(direct.exitCode).not.toBe(0);
    expect(direct.stderr.toString()).toContain("transport 'file' not allowed");
  });

  test("keep the blob filter: the omitted blob is never fetched, and no real URL stays", async () => {
    const source = repositoryWith(join(root, "filtered"), {
      "small.txt": "small\n",
      "big.bin": new Uint8Array(1_200_000).fill(1),
    });
    git(source.repo, "config", "uploadpack.allowFilter", "true");
    const gitDir = join(root, "filtered-tree.git");
    const { tree } = await fetchUpstreamTree(
      storeGit,
      gitDir,
      `file://${source.repo}`,
      source.commit,
      {
        capBytes: 1e8,
        timeoutMs: 30_000,
        killGraceMs: 1_000,
        hosts: [],
        blobLimit: "1m",
        protocolsForTests: ["file"],
      },
    );
    expect(tree).toBe(git(source.repo, "rev-parse", `${source.commit}^{tree}`));
    const config = readFileSync(join(gitDir, "config"), "utf8");
    expect(config).not.toContain(source.repo);
    expect(config).toContain("partialClone = neuve-unreachable");
    const big = git(source.repo, "rev-parse", "HEAD:big.bin");
    // Even with the first guard off, a lazy fetch fails locally: the promisor does not exist.
    const lazy = Bun.spawnSync(
      [gitPath, ...GIT_CONFIG, `--git-dir=${gitDir}`, "cat-file", "-p", big],
      {
        env: { ...storeGit.env, GIT_NO_LAZY_FETCH: "0" },
        stderr: "pipe",
      },
    );
    expect(lazy.exitCode).not.toBe(0);
    expect(readFileSync(join(gitDir, "config"), "utf8")).toBe(config);
    // A tree whose fetch passes its cap is stopped and refused.
    let over: unknown;
    try {
      await fetchUpstreamTree(
        storeGit,
        join(root, "over.git"),
        `file://${source.repo}`,
        source.commit,
        {
          capBytes: 1_000,
          timeoutMs: 30_000,
          killGraceMs: 1_000,
          hosts: [],
          blobLimit: "2m",
          protocolsForTests: ["file"],
        },
      );
    } catch (error) {
      over = error;
    }
    expect((over as UpstreamFetchStopped).reason).toBe("over-cap");
  });

  test("the git floor is the CVE-2024-32002 fix or a patched release", () => {
    expect(
      gitVersionRefusal("git version 2.54.0 (Apple Git-157)"),
    ).toBeUndefined();
    expect(gitVersionRefusal("git version 2.45.1")).toBeUndefined();
    expect(gitVersionRefusal("git version 2.42.2")).toBeUndefined();
    expect(gitVersionRefusal("git version 2.45.0")).toContain("2.45.1");
    expect(gitVersionRefusal("git version 2.42.1")).toContain("2.45.1");
  });
});

describe("source levels", () => {
  const document = JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        "fixtures/stack/react-start-1.169.3-attestations.json",
      ),
      "utf8",
    ),
  ) as { attestations: Array<{ predicateType: string; bundle: unknown }> };
  // The published archive's sha512, as the registry and the lockfile state it.
  const sha512Hex = Buffer.from(
    "tujqzu41T6c74zMj9c8rUpNOA5MExSHyLxCoE/m7QpfDLzTrloD5TUhk/9Z97c8AM91oFGdsQYN4JC5iUxl6Ow==",
    "base64",
  ).toString("hex");
  const check = {
    subject: NPM_REGISTRY.attestationSubject(
      "@tanstack/react-start",
      "1.169.3",
    ),
    sha512Hex,
    repository: { host: "github.com", path: "TanStack/router" },
  };

  test("a real npm provenance attestation verifies against the Sigstore root and names its commit", () => {
    expect(verifyAttestations(document, check)).toEqual({
      commit: "caaf32da35e250c1344a350fdd80cfc631c24b3c",
    });
  });

  test("anything short of full verification is not attested", () => {
    const refused = (value: ReturnType<typeof verifyAttestations>) =>
      "refused" in value;
    expect(
      refused(
        verifyAttestations(document, { ...check, sha512Hex: "0".repeat(128) }),
      ),
    ).toBe(true);
    expect(
      refused(
        verifyAttestations(document, {
          ...check,
          repository: { host: "github.com", path: "Evil/router" },
        }),
      ),
    ).toBe(true);
    expect(
      refused(
        verifyAttestations(document, {
          ...check,
          subject: NPM_REGISTRY.attestationSubject(
            "@tanstack/react-start",
            "1.169.4",
          ),
        }),
      ),
    ).toBe(true);
    // The certificate must come from the host's own CI issuer.
    const issuers = CI_ISSUERS as Record<string, string>;
    const github = issuers["github.com"] ?? "";
    issuers["github.com"] = "https://issuer.example";
    try {
      const other = verifyAttestations(document, check);
      expect("refused" in other && other.refused).toContain("issuer");
    } finally {
      issuers["github.com"] = github;
    }
    const tampered = structuredClone(document);
    const provenance = tampered.attestations.find((entry) =>
      entry.predicateType.startsWith("https://slsa.dev/provenance/"),
    ) as { bundle: { dsseEnvelope: { payload: string } } };
    provenance.bundle.dsseEnvelope.payload = Buffer.from(
      Buffer.from(provenance.bundle.dsseEnvelope.payload, "base64")
        .toString()
        .replace("caaf32da35e250c1344a350fdd80cfc631c24b3c", "1".repeat(40)),
    ).toString("base64");
    expect(refused(verifyAttestations(tampered, check))).toBe(true);
  });

  test("registry-stated repositories are normalised to HTTPS on their host, or refused", () => {
    expect(
      normaliseRepository({
        url: "git+https://github.com/TanStack/router.git",
        directory: "packages/react-start",
      }),
    ).toEqual({
      host: "github.com",
      path: "TanStack/router",
      directory: "packages/react-start",
    });
    expect(normaliseRepository("github:owner/repo")).toEqual({
      host: "github.com",
      path: "owner/repo",
    });
    expect(normaliseRepository("owner/repo")).toEqual({
      host: "github.com",
      path: "owner/repo",
    });
    expect(normaliseRepository("git@gitlab.com:group/sub/repo.git")).toEqual({
      host: "gitlab.com",
      path: "group/sub/repo",
    });
    expect(
      normaliseRepository("https://github.com/owner/repo/tree/main/x"),
    ).toEqual({
      host: "github.com",
      path: "owner/repo",
    });
    expect(normaliseRepository("file:///etc/passwd")).toBeUndefined();
    expect(normaliseRepository("https://github.com/../etc")).toBeUndefined();
    expect(
      normaliseRepository({ url: "https://github.com/a/b", directory: "../x" }),
    ).toEqual({
      host: "github.com",
      path: "a/b",
    });
  });
});

describe("the store lock", () => {
  test("serialises workers, and breaks a dead owner's lock without taking a live one's", async () => {
    const store = join(root, "locked-store");
    let inside = 0;
    let most = 0;
    const work = () =>
      withStoreLock(store, async () => {
        inside++;
        most = Math.max(most, inside);
        await Bun.sleep(30);
        inside--;
      });
    await Promise.all(Array.from({ length: 6 }, work));
    expect(most).toBe(1);
    // A lock left by a process that no longer exists is taken over.
    const dead = Bun.spawnSync(["/bin/sh", "-c", "echo $$"])
      .stdout.toString()
      .trim();
    writeFileSync(storeLayout(store).lock, `${dead} stale\n`);
    await work();
    expect(existsSync(storeLayout(store).lock)).toBe(false);
    // A live owner's lock is waited for, never broken.
    writeFileSync(storeLayout(store).lock, `${process.pid} other\n`);
    let timedOut = false;
    await withStoreLock(store, async () => {}, 300).catch(() => {
      timedOut = true;
    });
    expect(timedOut).toBe(true);
    expect(readFileSync(storeLayout(store).lock, "utf8")).toBe(
      `${process.pid} other\n`,
    );
  });
});
