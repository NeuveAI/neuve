import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OutlineSource } from "../../src/graph-outline.ts";

/**
 * A fake Graph engine for relations reads: it writes a small compact snapshot stream for whatever
 * commit it is asked for, and records each snapshot run's commit (`spawns`) and `--repo` (`repos`)
 * in its control folder. `capable` is baked in (capabilities are taken once per build); the mode is
 * read per run: `valid`, `fail` (exit 3 after the header), `gated` (holds before its summary
 * until `release`), or `gated-fail` (holds after the header until `release`, then exits 3). Any
 * other command exits 2.
 * Shared by the round's tests, commit preparation's and their child processes.
 */
export const fakeRelationsEngine = (root: string, capable = true) => {
  const control = join(root, "control");
  mkdirSync(control, { recursive: true });
  if (!existsSync(join(control, "mode")))
    writeFileSync(join(control, "mode"), "valid");
  const executable = join(root, capable ? "engine" : "engine-old");
  const script = `#!${process.execPath}
import { createHash } from "node:crypto";
import { readFileSync, appendFileSync, existsSync } from "node:fs";
const args = process.argv.slice(2);
const control = ${JSON.stringify(control)};
const out = (row) => process.stdout.write(JSON.stringify(row) + "\\n");
if (args[0] === "version") out({version:"fixture",provider:"entire-graph",identity_revision:"4",build_identity:createHash("sha256").update(readFileSync(import.meta.path)).digest("hex")});
else if (args[0] === "capabilities") out({schema_version:"1.3",provider:"entire-graph",supported_file_extensions:[".ts"],supported_languages:["TypeScript"],semantic_languages:["TypeScript"],inventory_only_languages:[],supported_relation_types:["CALLS"],relation_support_by_language:{},relation_support_by_profile:{full:["CALLS"]},heuristic_relation_types:[],parser_versions:{},unsupported_but_detected_language_hints:[],optional_local_only_features:{compact_snapshot_ndjson_v1:true,exact_commit_bulk_streams:${capable}},features_requiring_network_access:{}});
else if (args[0] !== "snapshot") process.exit(2);
else {
  const mode = readFileSync(control + "/mode", "utf8");
  const commit = args[args.indexOf("--commit") + 1];
  appendFileSync(control + "/spawns", commit + "\\n");
  appendFileSync(control + "/repos", args[args.indexOf("--repo") + 1] + "\\n");
  out(["h", 1, {schema_version:"1.3",provider:"entire-graph",provider_version:"fixture",identity_revision:"4",repo_root:args[args.indexOf("--repo") + 1],repo_key:"local/r",commit,tree:"2".repeat(40),profile:"full",relation_set:["CALLS","IMPORTS"],skipped_relation_families:[]}]);
  if (mode === "fail") process.exit(3);
  if (mode === "gated-fail") { while (!existsSync(control + "/release")) await new Promise((resolve) => setTimeout(resolve, 10)); process.exit(3); }
  out(["d", 1, ["file:a.ts","a.ts","blob","TypeScript","file:b.ts","b.ts","file:tests/a.test.ts","tests/a.test.ts"]]);
  out(["f", 1, 2, 3, 4, 10]); out(["f", 5, 6, 3, 4, 10]); out(["f", 7, 8, 3, 4, 10]);
  out(["d", 9, ["s:f","compound-v1","function","f","s:g","g"]]);
  out(["s", 9, 10, 11, 12, 12, 2, 1, 3, 0, 0, 4, 0, []]);
  out(["s", 13, 10, 11, 14, 14, 6, 1, 3, 0, 0, 4, 0, []]);
  out(["d", 15, ["CALLS","import_resolved","IMPORTS","call_site"]]);
  out(["r", 13, 9, 15, 0.9, 0, 0, 16, 0, [[18, 6, 2, 0, 0]], []]);
  out(["r", 7, 9, 15, 0.8, 0, 0, 16, 0, [[18, 8, 0, 0, 0]], []]);
  out(["r", 5, 1, 17, 0.9, 0, 0, 16, 0, [], []]);
  if (mode === "gated") while (!existsSync(control + "/release")) await new Promise((resolve) => setTimeout(resolve, 10));
  out(["m", {record_type:"summary",languages:["TypeScript"],language_tiers:{TypeScript:"semantic"},warnings:[],partial_failures:[],stats:{files:3,parsed_files:3,symbols:2,relations:3,partial_failures:0,completeness_level:"ok"},completeness:{languages:{},relations:{}}}]);
}
`;
  writeFileSync(executable, script, { mode: 0o700 });
  const source: OutlineSource = {
    executable,
    key: { sha256: createHash("sha256").update(script).digest("hex") },
  };
  const lines = (file: string) =>
    existsSync(join(control, file))
      ? readFileSync(join(control, file), "utf8").trim().split("\n")
      : [];
  return {
    source,
    control,
    mode: (mode: "valid" | "fail" | "gated" | "gated-fail") =>
      writeFileSync(join(control, "mode"), mode),
    release: () => writeFileSync(join(control, "release"), ""),
    spawns: () => lines("spawns"),
    /** The `--repo` each snapshot run was given. */
    repos: () => lines("repos"),
  };
};
