// Why: the `linguist` reader reaches the review only through the range manifest's computation; a
// file Linguist's lists mark must come out of it excluded from Map with its reason and `by`, an
// ordinary file must stay an entry, and the reader's run-time gaps must reach the manifest once
// each, beside the standing gaps.
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import { CodeWork } from "../src/code-work.ts";
import { DECLARATION_GAPS, LINGUIST_GAP } from "../src/declarations.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import { defaultManifestSettings, frontManifest } from "../src/manifest.ts";
import { buildMapManifest } from "../src/review-map.ts";
import { storedSectionRules } from "../src/section-rules.ts";

const root = mkdtempSync(join(tmpdir(), "manifest-linguist-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const scratchRepository = (name: string) => {
  const repository = join(root, name);
  const run = (...args: Array<string>) => {
    const done = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: GIT_ENV,
    });
    if (done.exitCode !== 0) throw new Error(done.stderr.toString());
    return done.stdout.toString().trim();
  };
  Bun.spawnSync(["git", "init", "-q", repository], { env: GIT_ENV });
  /** Files by path; `{ link }` writes a symbolic link, `null` removes the path. */
  const commit = (
    files: Readonly<Record<string, string | { link: string } | null>>,
  ) => {
    for (const [path, text] of Object.entries(files)) {
      const at = join(repository, path);
      rmSync(at, { force: true });
      if (text === null) continue;
      mkdirSync(dirname(at), { recursive: true });
      if (typeof text === "string") writeFileSync(at, text);
      else symlinkSync(text.link, at);
    }
    run("add", "-A");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
    return run("rev-parse", "HEAD");
  };
  return { repository, run, commit };
};

/** An effect run with a store of its own name and the services the manifest and the rules need. */
const withStore = <A, E>(name: string, effect: Effect.Effect<A, E, any>) => {
  const location = storeLocationIn(join(root, `${name}-store`));
  const layer = Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
  return Effect.runPromise(
    (effect as Effect.Effect<A, E, never>).pipe(
      Effect.provideService(CpuWork, {
        budget: new Scheduler(1),
        priority: { class: "interactive", position: "understand", stage: 0 },
        inherited: true,
      }),
      Effect.provideService(CodeWork, undefined),
      Effect.provide(layer),
    ) as Effect.Effect<A, E, never>,
  );
};

const manifestOf = (
  name: string,
  repository: string,
  range: { readonly baseOid: string; readonly headOid: string },
) =>
  withStore(
    name,
    frontManifest(
      repository,
      range,
      defaultManifestSettings(1_000_000),
      captureOutlineSource(),
    ),
  );

test("through the range manifest: a file Linguist's vendored list marks is excluded from Map with its reason and by, an ordinary file is an entry, and the standing gaps appear once", async () => {
  const repo = scratchRepository("wiring");
  const baseOid = repo.commit({
    "dist/out.js": "export const built = 1;\n",
    "src/a.ts": "export const a = 1;\n",
  });
  const headOid = repo.commit({
    "dist/out.js": "export const built = 2;\n",
    "src/a.ts": "export const a = 2;\n",
  });
  const manifest = await manifestOf("wiring", repo.repository, {
    baseOid,
    headOid,
  });
  const map = buildMapManifest(manifest.value);
  expect(
    map.excluded.map((entry) => [entry.path, entry.reason, entry.by]),
  ).toEqual([
    [
      "dist/out.js",
      "linguist-vendored",
      "linguist v9.7.0 vendored: (^|/)dist/",
    ],
  ]);
  expect(map.entries.map((entry) => entry.path)).toEqual(["src/a.ts"]);
  expect(manifest.value.declarations.gaps).toEqual([
    ...DECLARATION_GAPS,
    LINGUIST_GAP,
  ]);
}, 240_000);

test("through the range manifest: a run-time gap of the reader (the attribute read cannot see .gitattributes) reaches the manifest's gaps, and nothing is excluded by the lists", async () => {
  const repo = scratchRepository("runtime-gap");
  const baseOid = repo.commit({
    ".gitattributes": "dist/** -linguist-vendored\n",
    "dist/out.js": "export const built = 1;\n",
  });
  const headOid = repo.commit({ "dist/out.js": "export const built = 2;\n" });
  const oid = repo.run("rev-parse", `${headOid}:.gitattributes`);
  rmSync(
    join(repo.repository, ".git", "objects", oid.slice(0, 2), oid.slice(2)),
  );
  const manifest = await manifestOf("runtime-gap", repo.repository, {
    baseOid,
    headOid,
  });
  const gaps = manifest.value.declarations.gaps;
  expect(gaps.slice(0, DECLARATION_GAPS.length + 1)).toEqual([
    ...DECLARATION_GAPS,
    LINGUIST_GAP,
  ]);
  expect(gaps.filter((gap) => gap === LINGUIST_GAP)).toHaveLength(1);
  expect(
    gaps.filter(
      (gap) =>
        gap.startsWith("linguist: The attribute read cannot see") &&
        gap.endsWith("no file was marked by Linguist's lists"),
    ),
  ).toHaveLength(1);
  expect(buildMapManifest(manifest.value).excluded).toEqual([]);
}, 240_000);

// A minified script: one line far above Linguist's average of 110 characters (`minified_files?`).
const MINIFIED = `var a=${"1+".repeat(300)}1;\n`;

test("through the range manifest: a type change is decided at the head alone, as the generated rule reads it: a minified file that becomes a link is not excluded (the rule does not hold), a link that becomes a minified file is; and a deleted file's attributes are the head's", async () => {
  // Why: a type change is deleted and added on one path; the base's mark of the old blob must not
  // exclude the new link (the unsafe direction: no reading, no review lines). And a deleted file
  // is judged by the head's attributes, as the rule reads them.
  const repo = scratchRepository("type-change");
  const baseOid = repo.commit({
    README: "read me\n",
    "web/app.js": MINIFIED,
    "lib/link.js": { link: "../README" },
    "dist/old.txt": "bundle\n",
    "src/a.ts": "export const a = 1;\n",
  });
  const headOid = repo.commit({
    "web/app.js": { link: "../README" },
    "lib/link.js": MINIFIED,
    "dist/old.txt": null,
    ".gitattributes": "dist/** -linguist-vendored\n",
    "src/a.ts": "export const a = 2;\n",
  });
  const manifest = await manifestOf("type-change", repo.repository, {
    baseOid,
    headOid,
  });
  const map = buildMapManifest(manifest.value);
  expect(
    map.excluded.map((entry) => [entry.path, entry.reason, entry.by]),
  ).toEqual([
    [
      "lib/link.js",
      "linguist-generated",
      "linguist v9.7.0 generated: minified_files?",
    ],
  ]);
  const stored = await withStore(
    "type-change-rules",
    storedSectionRules(
      repo.repository,
      headOid,
      manifest.value.hunks,
      captureOutlineSource(),
    ),
  );
  const outcome = new Map(
    stored.rules
      .filter((judgement) => judgement.rule === "generated")
      .map((judgement) => [
        judgement.about.path,
        [judgement.result, judgement.reason],
      ]),
  );
  expect(outcome.get("web/app.js")).toEqual([
    "not-evaluated",
    "contents-not-read",
  ]);
  expect(outcome.get("lib/link.js")).toEqual(["holds", null]);
  // The deleted file: the head's `-linguist-vendored` turns the pattern off, in both.
  expect(outcome.get("dist/old.txt")).toEqual([
    "not-held",
    "repository-declares-not-vendored",
  ]);
  expect(
    map.entries.flatMap((entry) => entry.files.map((f) => f.path)).sort(),
  ).toEqual([".gitattributes", "dist/old.txt", "src/a.ts", "web/app.js"]);
}, 240_000);
