import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MEMBERS } from "./council.ts";
import { isLimitFailure } from "./credentials.ts";
import { readJson } from "./routes.ts";
import { RunReceipt } from "./schema.ts";

const tally = (values: ReadonlyArray<string>) => {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
};

/**
 * Telemetry for the labelling track (decision 10.16): per stage, runs, refusals and retries, wall
 * time (p50, p95, total), tokens in and out, API-equivalent cost where reported, credential route
 * counts and rate-limit or credit events. Built from receipts only; no prompt or credential values.
 */
export interface TelemetryInputs {
  /** Each hunk's private folder (its `receipts/` and `labels/`). */
  readonly hunkDirs: ReadonlyArray<string>;
  readonly briefingsDir: string;
  readonly councilDir: string;
  /** The folder holding the run logs (`<logPrefix>-*.log`). */
  readonly logsDir: string;
  /** The split's log prefix: `dev` or `heldout`. */
  readonly logPrefix: string;
  readonly auditFile: string;
}

export const buildTelemetry = (inputs: TelemetryInputs) => {
  const briefingsDir = () => inputs.briefingsDir;
  const councilDir = () => inputs.councilDir;
  const quantile = (values: ReadonlyArray<number>, q: number) => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return (
      Math.round(
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! *
          10,
      ) / 10
    );
  };
  const stage = (
    receipts: ReadonlyArray<RunReceipt>,
    extra: { refusals: number; retries: number; limitEvents?: number },
  ) => {
    const wall = receipts.map((r) => r.wallSeconds);
    return {
      runs: receipts.length,
      refusals: extra.refusals,
      retries: extra.retries,
      wallSeconds: {
        p50: quantile(wall, 0.5),
        p95: quantile(wall, 0.95),
        total: Math.round(wall.reduce((t, v) => t + v, 0)),
      },
      inputTokens: receipts.reduce((t, r) => t + (r.inputTokens ?? 0), 0),
      cachedInputTokens: receipts.reduce(
        (t, r) => t + (r.cachedInputTokens ?? 0),
        0,
      ),
      outputTokens: receipts.reduce((t, r) => t + (r.outputTokens ?? 0), 0),
      apiEquivalentUsd:
        Math.round(
          receipts.reduce((t, r) => t + (r.apiEquivalentUsd ?? 0), 0) * 100,
        ) / 100,
      byFamily: tally(
        receipts.map((r) => (r.route === "codex-exec" ? "sol" : "opus")),
      ),
      credentialRoutes: tally(
        receipts.flatMap((r) =>
          r.route !== "claude-print"
            ? []
            : // Claude runs before the credential routes used the host's own sign-in.
              [r.credentialRoute ?? "host-login"],
        ),
      ),
      // The variable each Claude run received (routes before 9.55 used the host's own sign-in).
      credentialVariables: tally(
        receipts.flatMap((r) =>
          r.route !== "claude-print"
            ? []
            : [
                r.credentialVariable ??
                  (r.credentialRoute === "subscription-token"
                    ? "CLAUDE_CODE_OAUTH_TOKEN"
                    : r.credentialRoute === "api-key"
                      ? "ANTHROPIC_API_KEY"
                      : "none (host login)"),
              ],
        ),
      ),
      limitEvents:
        (extra.limitEvents ?? 0) +
        receipts.filter((r) => r.note !== null && isLimitFailure(r.note))
          .length,
    };
  };
  const hunkReceipts = inputs.hunkDirs.flatMap((hunkDir) => {
    const dir = join(hunkDir, "receipts");
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((file) => file.endsWith(".json"))
          .map((file) => RunReceipt.parse(readJson(join(dir, file))))
      : [];
  });
  const resets = inputs.hunkDirs.reduce((total, hunkDir) => {
    const dir = join(hunkDir, "labels");
    return (
      total +
      (existsSync(dir)
        ? readdirSync(dir).filter((file) => file.includes(".reset-")).length
        : 0)
    );
  }, 0);
  const briefingFiles = existsSync(briefingsDir())
    ? readdirSync(briefingsDir())
    : [];
  const briefings = briefingFiles
    .filter((file) => /^q-[0-9a-f]{12}\.json$/.test(file))
    .map(
      (file) =>
        readJson(join(briefingsDir(), file)) as {
          attempts: Array<{ receipt: RunReceipt; refused: string | null }>;
        },
    );
  const briefingAttempts = briefings.flatMap((b) => b.attempts);
  const councilFiles = existsSync(councilDir())
    ? readdirSync(councilDir()).filter((file) =>
        /^q-[0-9a-f]{12}\.json$/.test(file),
      )
    : [];
  const council = councilFiles.map(
    (file) =>
      readJson(join(councilDir(), file)) as {
        roundReached: number;
        toOwner: boolean;
        members: Record<
          string,
          { trail: Array<{ step: string; attempt: number; error?: string }> }
        >;
        receipts: Array<RunReceipt & { member: string; step: string }>;
      },
  );
  const councilReceipts = council.flatMap((c) => c.receipts);
  const trails = council.flatMap((c) =>
    Object.entries(c.members).flatMap(([member, value]) =>
      value.trail.map((s) => ({ member, ...s })),
    ),
  );
  const councilStage = (
    pick: (r: RunReceipt & { member: string; step: string }) => boolean,
    trailPick: (t: { member: string; step: string }) => boolean,
  ) =>
    stage(councilReceipts.filter(pick), {
      refusals: trails.filter(
        (t) => trailPick(t) && "error" in t && t.error !== undefined,
      ).length,
      retries: trails.filter((t) => trailPick(t) && t.attempt > 1).length,
    });
  const auditFile = inputs.auditFile;
  return {
    decision: "10.16",
    generatedAt: new Date().toISOString(),
    // Run-log events: credential route switches (9.55) and items stopped mid-way.
    events: readdirSync(inputs.logsDir)
      .filter(
        (file) =>
          file.startsWith(`${inputs.logPrefix}-`) && file.endsWith(".log"),
      )
      .sort()
      .flatMap((file) =>
        readFileSync(join(inputs.logsDir, file), "utf8")
          .split("\n")
          .filter((line) => /credential route switched|INCOMPLETE/.test(line))
          .map((line) => ({ log: file, event: line.slice(0, 200) })),
      ),
    stages: {
      labelling: stage(
        hunkReceipts.filter((r) => r.role === "labeller"),
        { refusals: resets, retries: resets },
      ),
      gradingAdditions: stage(
        hunkReceipts.filter((r) => r.role === "addition-grader"),
        { refusals: 0, retries: 0 },
      ),
      briefings: stage(
        briefingAttempts.map((a) => a.receipt),
        {
          refusals: briefingAttempts.filter((a) => a.refused !== null).length,
          retries: briefings.reduce(
            (t, b) => t + Math.max(0, b.attempts.length - 1),
            0,
          ),
          limitEvents: briefingFiles.filter((file) =>
            file.endsWith(".credit-failed"),
          ).length,
        },
      ),
      council: {
        items: council.length,
        // Records discarded because a member step had failed (the 18 October limit event) and
        // items stopped mid-way, retried in a later run.
        discarded: (() => {
          const records = existsSync(councilDir())
            ? readdirSync(councilDir())
                .filter((file) =>
                  /\.(discarded-limit|discarded-briefing|prior-tie)$/.test(
                    file,
                  ),
                )
                .sort()
                .map(
                  (file) =>
                    readJson(join(councilDir(), file)) as {
                      itemId: string;
                      receipts: Array<RunReceipt>;
                    },
                )
            : [];
          const receipts = records.flatMap((record) =>
            record.receipts.map((r) => {
              // Council receipts carry the member and step beside the receipt fields.
              const {
                member: _member,
                step: _step,
                ...receipt
              } = r as RunReceipt & {
                member?: string;
                step?: string;
              };
              return RunReceipt.parse(receipt);
            }),
          );
          return {
            // Superseded council records: "discarded-limit", a member step had failed (18 October);
            // "discarded-briefing", rerun once its missing briefing existed; "prior-tie", the first
            // deliberation of a tie that 9.56 sent back to the council.
            reasons: tally(
              readdirSync(councilDir())
                .filter((file) =>
                  /\.(discarded-limit|discarded-briefing|prior-tie)$/.test(
                    file,
                  ),
                )
                .map((file) => file.slice(file.lastIndexOf(".") + 1)),
            ),
            items: records.map((record) => record.itemId),
            // Their runs and cost, counted apart from the council's real outcomes.
            ...stage(receipts, { refusals: 0, retries: 0 }),
          };
        })(),
        incomplete: existsSync(councilDir())
          ? readdirSync(councilDir()).filter((file) =>
              file.endsWith(".incomplete.json"),
            ).length
          : 0,
        ties: council.filter((c) => c.toOwner).length,
        roundReached: tally(council.map((c) => `round ${c.roundReached}`)),
        all: councilStage(
          () => true,
          () => true,
        ),
        byMember: Object.fromEntries(
          MEMBERS.map((member) => [
            member.id,
            councilStage(
              (r) => r.member === member.id,
              (t) => t.member === member.id,
            ),
          ]),
        ),
        byStep: Object.fromEntries(
          [...new Set(councilReceipts.map((r) => r.step))]
            .sort()
            .map((step) => [
              step,
              councilStage(
                (r) => r.step === step,
                (t) => t.step === step,
              ),
            ]),
        ),
      },
      verifyExport: {
        modelRuns: 0,
        items: existsSync(auditFile)
          ? (readJson(auditFile) as { items: Array<unknown> }).items.length
          : null,
        bytes: existsSync(auditFile) ? statSync(auditFile).size : null,
      },
    },
  };
};
