// A publication the shared index cannot make (here a planted schema refusal: the declarations carry
// one key the strict publication schema does not know) must not cost the builder its index. The
// plant is a module mock, which Bun never undoes in a process, so it runs in a child process
// (`fixtures/index-keep-refusal.ts`), the repository's pattern for such fixtures.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inlinePublicationFailure } from "../src/shared-publication.ts";

// Why: when only the publication fails (a schema refusal, as `unrecognized_keys` was on
// `60513de0`), the built index is still valid: the builder's own call keeps and returns it, the
// reason is logged once, and a subscriber in another process (this one) reads the recorded failure.
test("a refused publication leaves the builder its index and subscribers the failure", () => {
  const root = mkdtempSync(join(tmpdir(), "index-keep-"));
  try {
    const git = (args: string[], input?: string) => {
      const child = Bun.spawnSync(["git", "-C", root, ...args], {
        ...(input === undefined
          ? {}
          : { stdin: new TextEncoder().encode(input) }),
      });
      if (child.exitCode !== 0) throw new Error(child.stderr.toString());
      return child.stdout.toString().trim();
    };
    git(["init", "-q"]);
    const blob = git(
      ["hash-object", "-w", "--stdin"],
      "# Small\n\nSome text.\n",
    );
    const tree = git(["mktree"], `100644 blob ${blob}\tREADME.md\n`);
    const child = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "fixtures/index-keep-refusal.ts"),
        root,
        tree,
      ],
      {
        env: { ...process.env, NEUVE_BUDGET_DIRECTORY: join(root, "budget") },
      },
    );
    expect(child.exitCode, child.stderr.toString()).toBe(0);
    const line = child.stdout
      .toString()
      .split("\n")
      .find((each) => each.startsWith('{"built"'));
    const result = JSON.parse(line ?? "{}") as {
      built: { cached?: boolean; tree?: string; failed?: string };
      logged: Array<string>;
      publication?: string;
      key?: string;
      delivered: { kind?: string; tag?: string };
    };
    // The builder's own call keeps the index it built.
    expect(result.built).toEqual({ cached: false, tree });
    // The reason is logged once.
    expect(result.logged).toHaveLength(1);
    expect(JSON.parse(result.logged[0] ?? "{}")).toMatchObject({
      tag: "PublicationFailed",
    });
    // A subscriber reads the recorded failure: in the child through the publication host, and
    // here, in another process, from the publication it was given.
    expect(result.delivered).toEqual({
      kind: "failed",
      tag: "PublicationFailed",
    });
    expect(
      inlinePublicationFailure(result.publication, result.key ?? "")?.tag,
    ).toBe("PublicationFailed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
