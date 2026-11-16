// A refresh that ends without its release, as a killed one does: it takes a view folder, registers
// a view in it, prints the folder and exits holding nothing.
import { join } from "node:path";
import { viewFolder } from "../../src/graph-views.ts";

const repository = process.argv[2]!;
const views = await viewFolder(repository);
if (views === undefined) throw new Error("no view folder");
const view = join(views.parent, "neuve-graph-client-x", "source", "view");
Bun.spawnSync([
  "git",
  "-C",
  repository,
  "worktree",
  "add",
  "-q",
  "--detach",
  view,
]);
console.log(views.parent);
process.exit(0);
