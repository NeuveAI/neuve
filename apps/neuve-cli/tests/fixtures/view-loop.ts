// One of several processes taking and releasing view folders in a loop, each on its own
// repository, all under one temporary folder. Prints how many uses failed, and how many landed
// anywhere but the temporary folder (a level another use removed made this one move on).
// The second argument may name another build of graph-views.ts, to show a race before a fix.
import { resolve } from "node:path";

const [repository, uses, module] = process.argv.slice(2);
const { viewFolder } = (await import(
  resolve(module ?? `${import.meta.dir}/../../src/graph-views.ts`)
)) as typeof import("../../src/graph-views.ts");
const temporary = process.env["TMPDIR"]!;
let failed = 0;
let elsewhere = 0;
const errors: string[] = [];
for (let use = 0; use < Number(uses); use++) {
  try {
    const views = await viewFolder(repository!);
    if (views === undefined) throw new Error("no view folder");
    if (!views.parent.startsWith(temporary)) elsewhere++;
    await views.release();
  } catch (error) {
    failed++;
    if (errors.length < 3) errors.push(String(error).slice(0, 200));
  }
}
console.log(JSON.stringify({ failed, elsewhere, errors }));
