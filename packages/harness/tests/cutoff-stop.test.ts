// Why: an explicit stop must not spend the finalization reserve or freeze scope, even past cutoff.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReview, toolTurn } from "./fixtures/pi-review.ts";

const directory = mkdtempSync(join(tmpdir(), "cutoff-stop-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const range = {
  base: { "a.ts": "export const a = 1;\n" },
  head: { "a.ts": "export const a = 2;\n" },
  message: "Raise a",
  answer: (agent: string) => {
    if (agent === "frame")
      return toolTurn([
        {
          name: "submit_frame",
          id: "frame",
          args: {
            goal: "Raise a",
            stratum: "nothing",
            sourceIds: [],
            doneWhen: [
              { text: "The value is two.", candidateId: null, sectionId: null },
            ],
          },
        },
      ]);
    if (agent === "map")
      return toolTurn([
        {
          name: "submit_map",
          id: "map",
          args: {
            groups: [
              {
                label: "Raise a",
                why: "The constant changes.",
                tier: "core",
                doneWhen: ["D1"],
                entries: ["f1"],
              },
            ],
          },
        },
      ]);
    throw new Error("Unexpected finder after the skip boundary");
  },
};
test.each([-1, 60_000])(
  "user stop publishes nothing with cutoff offset %i",
  async (cutoffAfterMs) => {
    const run = await runReview({
      ...range,
      directory: join(directory, `stop-${cutoffAfterMs}`),
      cutoffAfterMs,
      abortBeforeFill: true,
    });
    expect(run.outcome.status).toBe("aborted");
    expect(
      run.publicationHistory.filter((entry) =>
        ["unit.recorded@2", "packet.published@1"].includes(entry.event.kind),
      ),
    ).toHaveLength(0);
  },
  30_000,
);
