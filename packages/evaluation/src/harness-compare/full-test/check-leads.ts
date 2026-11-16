import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { ensureDir } from "../common.ts";
import { baseEnv, ensureCommit, run, scratch } from "../runner.ts";
import {
  FULL_TEST_RESULTS,
  LEADS_ARMS,
  extraLeadsFile,
  leadsFile,
  type LeadsArm,
} from "./config.ts";
import { readKnownCases, readProofRanges } from "./known-cases.ts";
import { planRanges, sourceOf } from "./phases.ts";
import { readFullTestSelection } from "./select.ts";

/**
 * The offline pre-pilot check of the leads files (no model call), over every range the full test
 * runs: each range is cloned into scratch (`git clone --shared --no-checkout`), and the harness side
 * (`check-leads`, from this workspace's harness) compares the rows with the harness's own hunks by
 * this runner's matcher and by the committed frozen seam, and samples the seam's served top 3 and
 * their mapping to harness chunks. Written to `check-leads.json`; each clone is deleted after.
 */

const rawRows = (path: string) =>
  existsSync(path)
    ? gunzipSync(readFileSync(path))
        .toString("utf8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map(
          (line) =>
            JSON.parse(line) as Record<string, unknown> & { caseId: string },
        )
    : [];

const forRange = (
  rows: ReadonlyArray<{ caseId: string }>,
  baseOid: string,
  headOid: string,
) =>
  rows.filter((row) => {
    const [base, head] = (row.caseId.split(":")[1] ?? "").split("..") as [
      string,
      string,
    ];
    return baseOid.startsWith(base) && headOid.startsWith(head);
  });

export const checkLeadsFiles = async (options: { readonly sample: number }) => {
  const ranges = planRanges(
    readFullTestSelection(),
    readKnownCases(),
    readProofRanges(),
  );
  const rows = Object.fromEntries(
    LEADS_ARMS.map((arm) => [
      arm,
      [...rawRows(leadsFile(arm)), ...rawRows(extraLeadsFile(arm))],
    ]),
  ) as Record<LeadsArm, ReturnType<typeof rawRows>>;
  const work = join(scratch(), "ft", "check");
  ensureDir(work);
  const home = join(scratch(), "ft", "home");
  ensureDir(home);
  const env = baseEnv(home);
  const side = join(import.meta.dir, "..", "harness-side.ts");
  const perRange: Array<Record<string, unknown>> = [];
  for (const range of ranges) {
    const clone = join(work, range.key);
    rmSync(clone, { recursive: true, force: true });
    try {
      const source = sourceOf(range.source);
      await run(
        ["git", "clone", "--quiet", "--shared", "--no-checkout", source, clone],
        { env },
      );
      await ensureCommit(clone, source, range.base, env).catch(() => undefined);
      await ensureCommit(clone, source, range.head, env);
      const oid = async (rev: string) =>
        (
          await run(
            ["git", "-C", clone, "rev-parse", "--verify", `${rev}^{commit}`],
            { env },
          )
        ).stdout.trim();
      const baseOid = await oid(range.base);
      const headOid = await oid(range.head);
      const byArm: Record<string, unknown> = {};
      for (const arm of LEADS_ARMS) {
        const mine = forRange(rows[arm], baseOid, headOid);
        const input = join(
          work,
          `${range.key}-${arm.replace(/[^A-Za-z0-9-]/g, "_")}.json`,
        );
        const out = `${input}.out`;
        writeFileSync(
          input,
          JSON.stringify({
            base: baseOid,
            head: headOid,
            rows: mine,
            sample: options.sample,
          }),
        );
        await run(
          [
            process.execPath,
            side,
            "check-leads",
            "--repo",
            clone,
            "--input",
            input,
            "--out",
            out,
          ],
          { env },
        );
        byArm[arm] = JSON.parse(readFileSync(out, "utf8"));
        rmSync(input, { force: true });
        rmSync(out, { force: true });
      }
      perRange.push({ caseId: range.caseId, kind: range.kind, byArm });
    } catch (error) {
      perRange.push({
        caseId: range.caseId,
        kind: range.kind,
        error:
          error instanceof Error ? error.message.slice(0, 500) : String(error),
      });
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  }
  type ArmReport = {
    harnessTextHunks: number;
    rows: number;
    rowsMatchedOnce: number;
    rowsUnmatched: ReadonlyArray<string>;
    matcherAgreement: number;
    hunksWithoutRow: ReadonlyArray<string>;
    sample: ReadonlyArray<{
      sameTop3: boolean;
      served: ReadonlyArray<{ overlapsMost: boolean }>;
    }>;
  };
  const arms = perRange.flatMap((entry) =>
    entry["byArm"] === undefined
      ? []
      : Object.values(entry["byArm"] as Record<string, ArmReport>),
  );
  const sum = (pick: (report: ArmReport) => number) =>
    arms.reduce((total, report) => total + pick(report), 0);
  const summary = {
    ranges: perRange.length,
    errors: perRange
      .filter((entry) => entry["error"] !== undefined)
      .map((entry) => `${String(entry["caseId"])}: ${String(entry["error"])}`),
    rows: sum((r) => r.rows),
    rowsMatchedOnce: sum((r) => r.rowsMatchedOnce),
    rowsUnmatched: sum((r) => r.rowsUnmatched.length),
    matcherAgreement: sum((r) => r.matcherAgreement),
    harnessTextHunks: sum((r) => r.harnessTextHunks),
    hunksWithoutRow: sum((r) => r.hunksWithoutRow.length),
    sampled: sum((r) => r.sample.length),
    sampledSameTop3: sum((r) => r.sample.filter((s) => s.sameTop3).length),
    servedLeads: sum((r) => r.sample.reduce((t, s) => t + s.served.length, 0)),
    servedMappedToBestChunk: sum((r) =>
      r.sample.reduce(
        (t, s) => t + s.served.filter((x) => x.overlapsMost).length,
        0,
      ),
    ),
  };
  ensureDir(FULL_TEST_RESULTS);
  writeFileSync(
    join(FULL_TEST_RESULTS, "check-leads.json"),
    `${JSON.stringify({ schemaVersion: 1, checkedAt: new Date().toISOString(), summary, perRange }, null, 2)}\n`,
  );
  return { summary, perRange };
};
