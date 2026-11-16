/**
 * The hold's replay for the gates (NEU-148 rounds 22 and 28): every section's lane from a review's
 * stored readings, floors, moves and gaps, as published, under lane rule 3 with the `finding` floor
 * (`lift`, and `hold` with the relations gap held where the lift took it), under lane rule 4, the
 * matrix (`matrixLift`, `matrixHold`), and under lane rule 5, the matrix with a confirmed request
 * for changes also moving both axes (`confirmedLift`, `confirmedHold`), as JSON on stdout, one object per run or decision, with its
 * `notes`. It reads the store only (`readings/replay-hold.ts`, `openStoreReader`) and calls no model.
 *
 *   bun packages/harness/scripts/replay-hold.ts <store folder (.git/neuve)> --run <run ID>
 *   bun packages/harness/scripts/replay-hold.ts <store folder (.git/neuve)> --cycle <cycle ID or run key>
 *   bun packages/harness/scripts/replay-hold.ts <store folder> --records <records.sqlite> --decision <key>
 *   bun packages/harness/scripts/replay-hold.ts <store folder> --records <records.sqlite> --list
 *
 * `--run` and `--cycle` read the store's run logs (`run-logs/<run ID>.jsonl`), whose rows say which
 * sections were shown. `--decision` reads one stored decision with no run log (a copied database)
 * and derives the shown sections from its entries; `--list` names the decisions a database holds.
 * `--records` reads another copy of the database; file blobs are read from the store folder.
 */
import { join, resolve } from "node:path";
import {
  decisionsIn,
  replayDecision,
  replayNotes,
  replayRun,
  runLogsOf,
} from "../src/readings/replay-hold.ts";

const args = process.argv.slice(2);
const value = (flag: string) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
const folder = args[0];
const run = value("--run");
const cycle = value("--cycle");
const decision = value("--decision");
const list = args.includes("--list");
const modes = [run, cycle, decision].filter((m) => m !== undefined).length;
if (
  folder === undefined ||
  folder.startsWith("--") ||
  modes + (list ? 1 : 0) !== 1
)
  throw new Error(
    "Usage: bun packages/harness/scripts/replay-hold.ts <store folder> (--run <run ID> | --cycle <cycle ID or run key> | --decision <key> | --list) [--records <records.sqlite>]",
  );
const directory = resolve(folder);
const database = resolve(
  value("--records") ?? join(directory, "records.sqlite"),
);
const out = list
  ? decisionsIn(database)
  : decision !== undefined
    ? [decision].map((key) => {
        const sections = replayDecision({
          database,
          directory,
          decisionKey: key,
        });
        return { decision: key, notes: replayNotes(sections), sections };
      })
    : runLogsOf(
        join(directory, "run-logs"),
        run === undefined ? { cycle: cycle! } : { run },
      ).map(({ run: id, path }) => ({
        run: id,
        ...(replayRun({ database, directory, runLog: path }) ?? {
          decision: null,
          notes: [],
          sections: [],
        }),
      }));
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
