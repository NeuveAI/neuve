import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  BUN_LOCK,
  ECOSYSTEM_CAPABILITIES,
  defaultHead,
  detectPins,
  rankPins,
  repositoryGit,
} from "../src/stack/index.ts";
import { git, repositoryWith, scratch } from "./fixtures/stack/repos.ts";

/**
 * Why: detection decides what is fetched and from where (SC4). A package resolved through a
 * private registry looked up publicly under the same name is how dependency confusion works, and a
 * manifest range instead of the lockfile's exact version would fetch code the repository does not
 * run; neither would fail, it would just fetch the wrong thing.
 */

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const HASH = `sha512-${"A".repeat(86)}==`;

// The layout Bun writes: workspace-scoped keys where a workspace resolves its own version.
const LOCK = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "root",
      "dependencies": { "effect": "4.0.0", "local": "workspace:*" },
      "devDependencies": { "typescript": "7.0.2" },
    },
    "apps/web": {
      "name": "web",
      "dependencies": {
        "@tanstack/react-start": "1.168.58",
        "from-git": "github:owner/repo",
        "private-pkg": "1.0.0",
        "unhashed": "1.0.0",
      },
      "devDependencies": { "typescript": "^6.0.2" },
      "optionalDependencies": { "@acme/internal": "2.0.0" },
    },
  },
  "packages": {
    "effect": ["effect@4.0.0", "", {}, "${HASH}"],
    "local": ["local@workspace:packages/local"],
    "typescript": ["typescript@7.0.2", "", {}, "${HASH}"],
    "web/typescript": ["typescript@6.0.3", "", {}, "${HASH}"],
    "@tanstack/react-start": ["@tanstack/react-start@1.168.58", "", {}, "${HASH}"],
    "from-git": ["from-git@github:owner/repo#abc", {}, "owner-repo-abc"],
    "private-pkg": ["private-pkg@1.0.0", "https://npm.internal.example/private-pkg/-/private-pkg-1.0.0.tgz", {}, "${HASH}"],
    "unhashed": ["unhashed@1.0.0", "", {}],
    "@acme/internal": ["@acme/internal@2.0.0", "", {}, "${HASH}"],
  }
}
`;

describe("the bun.lock capability", () => {
  test("reads each workspace's direct dependencies at their exact versions, and discloses the rest", () => {
    const read = BUN_LOCK.readLockfile(LOCK);
    expect(read.pins.map((pin) => `${pin.name}@${pin.version}`)).toEqual([
      "@acme/internal@2.0.0",
      "@tanstack/react-start@1.168.58",
      "effect@4.0.0",
      "typescript@6.0.3",
      "typescript@7.0.2",
    ]);
    expect(read.gaps.map((gap) => gap.reason).sort()).toEqual([
      "no-hash",
      "not-a-registry-package",
      "private-registry",
    ]);
    expect(
      read.gaps.find((gap) => gap.reason === "private-registry")?.detail,
    ).toContain("npm.internal.example");
  });

  test("a committed scoped registry, or a private default, turns entries into gaps at the revision", async () => {
    const root = scratch("neuve-stack-detect-");
    roots.push(root);
    const { repo, commit } = repositoryWith(root, {
      "bun.lock": LOCK,
      ".npmrc":
        "@acme:registry=https://npm.acme.example/\n//npm.acme.example/:_authToken=secret\n",
    });
    const read = await detectPins(repositoryGit(repo), commit, {
      privateDefaultRegistry: false,
    });
    expect(read.pins.map((pin) => pin.key)).not.toContain(
      "npm:@acme/internal@2.0.0",
    );
    const scoped = read.gaps.find(
      (gap) => gap.key === "npm:@acme/internal@2.0.0",
    );
    expect(scoped?.reason).toBe("private-registry");
    expect(JSON.stringify(read)).not.toContain("secret");
    expect(read.lockfiles).toEqual([
      { path: "bun.lock", blob: git(repo, "rev-parse", `${commit}:bun.lock`) },
    ]);

    const bunfig = repositoryWith(scratch("neuve-stack-detect-"), {
      "bun.lock": LOCK,
      "bunfig.toml": '[install]\nregistry = "https://mirror.example/"\n',
    });
    roots.push(bunfig.repo.replace(/\/repo$/, ""));
    const mirrored = await detectPins(
      repositoryGit(bunfig.repo),
      bunfig.commit,
      {
        privateDefaultRegistry: false,
      },
    );
    expect(mirrored.pins).toEqual([]);

    const user = await detectPins(repositoryGit(repo), commit, {
      privateDefaultRegistry: true,
    });
    expect(user.pins).toEqual([]);
    expect(
      user.gaps.filter((gap) => gap.reason === "private-registry").length,
    ).toBe(6);
  });

  test("reads git objects at the revision, never the working tree", async () => {
    const root = scratch("neuve-stack-detect-");
    roots.push(root);
    const { repo, commit } = repositoryWith(root, { "bun.lock": LOCK });
    await Bun.write(`${repo}/bun.lock`, "not json");
    await Bun.write(`${repo}/yarn.lock`, "untracked");
    const read = await detectPins(repositoryGit(repo), commit, {
      privateDefaultRegistry: false,
    });
    expect(read.pins.length).toBe(5);
    expect(read.gaps.some((gap) => gap.reason === "no-capability")).toBe(false);
  });

  test("a lockfile no capability reads, and a manifest without a lockfile, are each one gap", async () => {
    const root = scratch("neuve-stack-detect-");
    roots.push(root);
    const { repo, commit } = repositoryWith(root, {
      "package.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "tools/package.json": "{}",
    });
    const read = await detectPins(repositoryGit(repo), commit, {
      privateDefaultRegistry: false,
    });
    expect(read.pins).toEqual([]);
    expect(read.gaps.map((gap) => `${gap.reason} ${gap.path}`)).toEqual([
      "no-capability pnpm-lock.yaml",
    ]);
    const bare = repositoryWith(scratch("neuve-stack-detect-"), {
      "package.json": "{}",
    });
    roots.push(bare.repo.replace(/\/repo$/, ""));
    const none = await detectPins(repositoryGit(bare.repo), bare.commit, {
      privateDefaultRegistry: false,
    });
    expect(none.gaps.map((gap) => gap.reason)).toEqual(["no-lockfile"]);
  });

  test("the default branch's head comes from origin's HEAD, else the review's base branch", async () => {
    const root = scratch("neuve-stack-detect-");
    roots.push(root);
    const { repo, commit } = repositoryWith(root, { a: "a" });
    const reader = repositoryGit(repo);
    expect(await defaultHead(reader)).toBeUndefined();
    expect(await defaultHead(reader, "main")).toBe(commit);
    git(repo, "update-ref", "refs/remotes/origin/trunk", commit);
    git(
      repo,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    );
    expect(await defaultHead(reader)).toBe(commit);
  });

  test("ranking counts the files that reference an entry in quoted forms, never manifests or lockfiles", async () => {
    const root = scratch("neuve-stack-detect-");
    roots.push(root);
    const { repo, commit } = repositoryWith(root, {
      "bun.lock": LOCK,
      "package.json":
        '{"dependencies":{"effect":"4.0.0","@tanstack/react-start":"1.168.58"}}',
      "src/a.ts":
        'import { Effect } from "effect";\nimport { Schema } from "effect/Schema";\n',
      "src/b.ts": "import * as E from 'effect';\n",
      "src/route.tsx":
        'import { createFileRoute } from "@tanstack/react-start";\n',
      "docs/note.md": "effect without quotes is not a reference\n",
    });
    const { pins } = await detectPins(repositoryGit(repo), commit, {
      privateDefaultRegistry: false,
    });
    const ranking = await rankPins(repo, commit, pins, ECOSYSTEM_CAPABILITIES);
    expect(ranking.ranks.get("npm:effect@4.0.0")).toBe(2);
    expect(ranking.ranks.get("npm:@tanstack/react-start@1.168.58")).toBe(1);
    expect(ranking.ranks.get("npm:typescript@7.0.2")).toBe(0);
    expect([...ranking.referencedBy(["src/route.tsx"])]).toEqual([
      "npm:@tanstack/react-start@1.168.58",
    ]);
    expect(ranking.truncated).toBe(false);
  });
});
