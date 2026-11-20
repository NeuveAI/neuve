// What this must do, for initial-context.test.ts, which runs it as a process of its own: render the
// opening for each file count given as an argument and print one JSON line with the work each
// render did, counted from outside the render and independent of the machine.
//
// Why its own process: the counting replaces built-ins, and the engine does not take its fast paths
// for arrays again afterwards (the same loop ran 2.3 times slower in a process that had replaced
// and restored them once). So it never shares a process with other tests, and restores nothing.
//
// Counted as `reads`: every property the render reads from a hunk.
// Counted as `visits`: each step of an array iterator (a spread, also into a call; a `for...of`;
// `Array.from` or `Array.of` of an array; a Map or Set built from one); and each call of a function
// on `Array.prototype` or `Object`, as the length of the array it is called on plus its argument
// count and the length of every array among its arguments. The functions are taken from those two
// objects themselves, so one the language adds later is counted without a change here.
//
// Not counted, so work written this way goes unseen: an indexed loop (`for (let i = 0; ...)`); a
// built-in outside those two objects handed an array (`structuredClone`, `JSON.stringify`, a typed
// array's constructor); work on a Map, a Set or a string; and the comparisons inside a sort.
import { renderOpening } from "../../src/initial-context.ts";
import { frame, hunk } from "../find-fixture.ts";

let reads = 0;
let visits = 0;
/** Replaces every function on `holder` but `skip` with one that counts, as the header says. */
const count = (holder: object, skip: ReadonlyArray<string>) => {
  const functions = holder as Record<string, (...args: unknown[]) => unknown>;
  for (const name of Object.getOwnPropertyNames(holder)) {
    const original = Object.getOwnPropertyDescriptor(holder, name)?.value;
    if (typeof original !== "function" || skip.includes(name)) continue;
    functions[name] = function (this: unknown, ...args: unknown[]) {
      // `push` touches one end: it is charged for what it is handed, not for its array.
      if (Array.isArray(this) && name !== "push") visits += this.length;
      visits += args.length;
      for (const arg of args) if (Array.isArray(arg)) visits += arg.length;
      return Reflect.apply(original, this, args);
    };
  }
};
const iterator = Object.getPrototypeOf([][Symbol.iterator]());
const next = iterator.next;
iterator.next = function (this: unknown) {
  visits++;
  return Reflect.apply(next, this, []);
};
// Left alone: the constructor; `pop` and `at`, which touch one element; `keys`, `values` and
// `entries`, which only make an iterator whose steps are counted; `toString`, which calls `join`.
count(Array.prototype, [
  "constructor",
  "pop",
  "at",
  "keys",
  "values",
  "entries",
  "toString",
]);
count(Object, []);

const measured = process.argv.slice(2).map((argument) => {
  const files = Number(argument);
  // One-line changes in four folders: the case where a per-folder cost is largest.
  const hunks = new Map(
    Array.from({ length: files }, (_, i) => {
      const path = `packages/p${i % 4}/src/f${i}.ts`;
      const one = {
        ...hunk,
        hunkId: `h${i}`,
        path,
        oldPath: path,
        newPath: path,
      };
      const counted = new Proxy(one, {
        get: (target, key, receiver) => {
          reads++;
          return Reflect.get(target, key, receiver);
        },
      });
      return [one.hunkId, counted] as const;
    }),
  );
  const commits = Array.from({ length: files / 2 }, (_, i) => ({
    oid: i.toString(16).padStart(40, "0"),
    subject: `change ${i}`,
    body: "",
  }));
  reads = 0;
  visits = 0;
  const { counts, text } = renderOpening({ frame, hunks, commits });
  const indexed = counts.filesNamed + counts.filesFolded;
  return { files, reads, visits, indexed, characters: text.length };
});
process.stdout.write(`${JSON.stringify(measured)}\n`);
