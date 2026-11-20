// Run by initial-context.test.ts in a process of its own, and prints one JSON line: the work the
// opening render does at each file count given as an argument.
//
// Why its own process: counting array work replaces built-ins on `Array.prototype` and on the array
// iterator. They are put back, but the engine does not take its fast paths for array iteration
// again afterwards: the same array-heavy loop measured 2.3 times slower for the rest of a process
// that had patched and restored them once. A test process runs many files, so the patch must never
// share one with other tests.
//
// Counted: every property the render reads from a hunk; each step of an array iterator (a spread, a
// `for...of`, `Array.from` of an array, a Map or Set built from one); and each call of an
// `Array.prototype` method, as the length of the array it is called on. The methods are taken from
// `Array.prototype` itself, so a method the language adds later is counted without a change here.
//
// Not counted, so work written this way goes unseen: an indexed loop (`for (let i = 0; ...)`), work
// on a Map, a Set or a string, and the comparisons inside a sort.
import { renderOpening } from "../../src/initial-context.ts";
import type { ManifestHunk } from "../../src/manifest.ts";
import { frame, hunk } from "../find-fixture.ts";

const ARRAY_ITERATOR = Object.getPrototypeOf([][Symbol.iterator]()) as {
  next: (this: unknown) => IteratorResult<unknown>;
};
/** `Array.prototype` functions that walk no elements themselves, each with why. */
const WALKS_NOTHING = new Set([
  "constructor", // not a method on elements
  "push", // these three touch one end or one element
  "pop",
  "at",
  "keys", // these three only make an iterator; its steps are counted
  "values",
  "entries",
  "toString", // calls `join`, which is counted
]);
const WALKING = Object.getOwnPropertyNames(Array.prototype).filter(
  (name) =>
    !WALKS_NOTHING.has(name) &&
    typeof Object.getOwnPropertyDescriptor(Array.prototype, name)?.value ===
      "function",
);

let reads = 0;
let visits = 0;
const methods = Array.prototype as unknown as Record<
  string,
  (this: ArrayLike<unknown>, ...args: unknown[]) => unknown
>;
const next = ARRAY_ITERATOR.next;
const original = WALKING.map((name) => [name, methods[name]!] as const);
const count = (on: boolean) => {
  ARRAY_ITERATOR.next = on
    ? function (this: unknown) {
        visits++;
        return next.call(this);
      }
    : next;
  for (const [name, method] of original)
    methods[name] = on
      ? function (this: ArrayLike<unknown>, ...args: unknown[]) {
          visits += Number(this?.length) || 0;
          return method.apply(this, args);
        }
      : method;
};

/** `files` one-line changes in four folders: the case where a per-folder cost is largest. */
const range = (files: number) =>
  new Map(
    Array.from({ length: files }, (_, i) => {
      const path = `packages/p${i % 4}/src/f${i}.ts`;
      const one: ManifestHunk = {
        ...hunk,
        hunkId: `h${i}`,
        path,
        oldPath: path,
        newPath: path,
        status: "modified",
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        added: 1,
        deleted: 0,
        text: "@@ -1,0 +1,1 @@\n+x",
        ownedRanges: [{ side: "new", startLine: 1, lineCount: 1 }],
        declared: [],
        enclosing: null,
      };
      return [
        one.hunkId,
        new Proxy(one, {
          get: (target, key, receiver) => {
            reads++;
            return Reflect.get(target, key, receiver);
          },
        }),
      ] as const;
    }),
  );

const measured = process.argv.slice(2).map((argument) => {
  const files = Number(argument);
  const hunks = range(files);
  const commits = Array.from({ length: files / 2 }, (_, i) => ({
    oid: i.toString(16).padStart(40, "0"),
    subject: `change ${i}`,
    body: "",
  }));
  reads = 0;
  visits = 0;
  count(true);
  let result: ReturnType<typeof renderOpening>;
  try {
    result = renderOpening({ frame, hunks, commits });
  } finally {
    count(false);
  }
  return {
    files,
    reads,
    visits,
    indexed: result.counts.filesNamed + result.counts.filesFolded,
    characters: result.text.length,
  };
});
process.stdout.write(`${JSON.stringify(measured)}\n`);
