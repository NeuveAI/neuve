import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  renameSync,
  symlinkSync,
  readdirSync,
  chmodSync,
  copyFileSync,
  linkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import {
  createPrivateInspection,
  openPrivateInspection,
} from "../../../src/pi/capture/private-inspection.ts";
import {
  CredentialEpochId,
  InspectionBudget,
  type CredentialSource,
} from "../../../src/pi/capture/credential-detectors.ts";

const fixture = async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "inspection-batch-"));
  const physical = join(root, "volume/cases/go/293649/replay-candidate-9");
  mkdirSync(physical, { recursive: true });
  const alias = join(root, "case");
  symlinkSync(physical, alias);
  const source = join(alias, "source");
  mkdirSync(source);
  const ownership = SourceOwnership.acquire(source);
  const options = {
    ownership,
    source,
    directory: join(alias, "authority"),
    excludedRoots: [source],
  };
  const authority = createPrivateInspection(options);
  const r = await authority.register({
    epoch: CredentialEpochId.parse("original"),
    headers: new Headers({ authorization: "Bearer synthetic-prior" }),
    budget: new InspectionBudget(),
  });
  if (r.status !== "registered") throw new Error("registration failed");
  return {
    root,
    authority,
    options,
    ownership,
    close: () => {
      authority.close();
      ownership.release();
      rmSync(root, { recursive: true, force: true });
    },
  };
};
const sources: ReadonlyArray<CredentialSource> = Array.from(
  { length: 100 },
  (_, i) => ({ kind: "text", text: `safe-record-${i}` }),
);

test("one authenticated transaction inspects the entire inventory under the same full-check limit", async () => {
  const f = await fixture();
  try {
    const limits = { ...new InspectionBudget().limits, fullChecks: 16 };
    const serial = new InspectionBudget(limits);
    let refused = false;
    for (const source of sources) {
      if (source.kind !== "text") throw new Error("fixture type");
      const result = await f.authority.inspectText({
        text: source.text,
        budget: serial,
      });
      if (result.status === "unavailable") {
        expect(result.reason).toBe("budget");
        refused = true;
        break;
      }
    }
    expect(refused).toBe(true);
    const budget = new InspectionBudget(limits);
    const result = await f.authority.inspectSources({
      sources,
      requiredEpochs: ["original"],
      budget,
    });
    expect(result.status).toBe("inspected");
    if (result.status !== "inspected") throw new Error("batch unavailable");
    expect(result.results).toHaveLength(100);
    expect(
      result.results.every(
        (r) =>
          r.status === "complete" &&
          r.matches.length === 0 &&
          r.epochs.join() === "original",
      ),
    ).toBe(true);
    expect(budget.usage.fullChecks).toBe(2);
  } finally {
    f.close();
  }
});

test("queued registration cannot change history between batch records", async () => {
  const f = await fixture();
  const other = openPrivateInspection(f.options);
  try {
    const batch = f.authority.inspectSources({
      sources: [
        { kind: "text", text: "x".repeat(100000) },
        { kind: "text", text: "safe" },
      ],
      requiredEpochs: ["original"],
      budget: new InspectionBudget(),
    });
    const register = other.register({
      epoch: CredentialEpochId.parse("later"),
      headers: new Headers({ "x-api-key": "synthetic-later" }),
      budget: new InspectionBudget(),
    });
    const [r, registered] = await Promise.all([batch, register]);
    expect(registered.status).toBe("registered");
    if (r.status !== "inspected") throw new Error("batch unavailable");
    expect(r.results).toHaveLength(2);
    expect(
      r.results.every(
        (r) => r.status === "complete" && r.epochs.join() === "original",
      ),
    ).toBe(true);
    expect(
      await f.authority.inspectText({
        text: "safe",
        budget: new InspectionBudget(),
      }),
    ).toMatchObject({ status: "complete", epochs: ["original", "later"] });
  } finally {
    other.close();
    f.close();
  }
});

test("the inventory boundary refuses a redirected authority without writing outside it", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  class DamagingBudget extends InspectionBudget {
    #done = false;
    override charge(
      kind: Parameters<InspectionBudget["charge"]>[0],
      amount: number,
    ): void {
      super.charge(kind, amount);
      if (kind === "units" && !this.#done) {
        this.#done = true;
        renameSync(f.options.directory, join(f.root, "held"));
        symlinkSync(outside, f.options.directory);
      }
    }
  }
  try {
    const result = await f.authority.inspectSources({
      sources,
      requiredEpochs: ["original"],
      budget: new DamagingBudget(),
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "private-store",
      record: 100,
    });
    expect(f.authority.inspectionFailureCheck).toBe("canonical-directory");
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    f.close();
  }
});

test("batch cancellation, missing epochs and credential matches remain refusals", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    controller.abort();
    expect(
      await f.authority.inspectSources({
        sources,
        requiredEpochs: ["original"],
        budget: new InspectionBudget(
          new InspectionBudget().limits,
          controller.signal,
        ),
      }),
    ).toMatchObject({ status: "unavailable", reason: "cancelled", record: 0 });
    const missing = await f.authority.inspectSources({
      sources,
      requiredEpochs: ["absent"],
      budget: new InspectionBudget(),
    });
    expect(missing.status).toBe("inspected");
    if (missing.status !== "inspected") throw new Error("fixture unavailable");
    expect(missing.results).toMatchObject([
      { status: "complete", epochs: ["original"], matches: [] },
    ]);
    const exposed = await f.authority.inspectSources({
      sources: [
        { kind: "text", text: "safe" },
        { kind: "text", text: "synthetic-prior" },
        ...sources,
      ],
      requiredEpochs: ["original"],
      budget: new InspectionBudget(),
    });
    if (exposed.status !== "inspected") throw new Error("fixture unavailable");
    expect(exposed.results).toHaveLength(2);
    expect(exposed.results[1]).toMatchObject({
      status: "complete",
      matches: [{ epoch: "original" }],
    });
  } finally {
    f.close();
  }
});

test("an independent SQLite writer is fenced until the authenticated inventory finishes", async () => {
  const f = await fixture();
  const { Database } = await import("bun:sqlite");
  const writer = new Database(join(f.options.directory, "authority.sqlite"));
  writer.exec("PRAGMA busy_timeout=0");
  class WriterBudget extends InspectionBudget {
    #tried = false;
    blocked = false;
    override charge(
      kind: Parameters<InspectionBudget["charge"]>[0],
      amount: number,
    ): void {
      super.charge(kind, amount);
      if (kind !== "units" || this.#tried) return;
      this.#tried = true;
      try {
        writer.exec("UPDATE authority SET source=source WHERE id=1");
      } catch (error) {
        this.blocked =
          error instanceof Error &&
          "code" in error &&
          error.code === "SQLITE_BUSY";
      }
    }
  }
  try {
    const budget = new WriterBudget();
    const result = await f.authority.inspectSources({
      sources,
      requiredEpochs: ["original"],
      budget,
    });
    expect(result.status).toBe("inspected");
    expect(budget.blocked).toBe(true);
    writer.exec("UPDATE authority SET source=source WHERE id=1");
    expect(
      await f.authority.inspectText({
        text: "safe",
        budget: new InspectionBudget(),
      }),
    ).toMatchObject({ status: "complete", epochs: ["original"], matches: [] });
  } finally {
    writer.close();
    f.close();
  }
});

for (const damage of [
  "directory-mode",
  "file-mode",
  "file-link",
  "file-replacement",
  "sidecar-mode",
] as const) {
  test(`inventory revalidation refuses ${damage} before returning any scan result`, async () => {
    const f = await fixture();
    const file = join(f.options.directory, "authority.sqlite");
    class DamagingBudget extends InspectionBudget {
      #done = false;
      override charge(
        kind: Parameters<InspectionBudget["charge"]>[0],
        amount: number,
      ): void {
        super.charge(kind, amount);
        if (kind !== "units" || this.#done) return;
        this.#done = true;
        if (damage === "directory-mode") chmodSync(f.options.directory, 0o755);
        else if (damage === "file-mode") chmodSync(file, 0o644);
        else if (damage === "file-link")
          linkSync(file, join(f.root, "extra-link"));
        else if (damage === "file-replacement") {
          renameSync(file, join(f.root, "held.sqlite"));
          copyFileSync(join(f.root, "held.sqlite"), file);
          chmodSync(file, 0o600);
        } else writeFileSync(file + "-wal", "synthetic", { mode: 0o644 });
      }
    }
    try {
      expect(
        await f.authority.inspectSources({
          sources,
          requiredEpochs: ["original"],
          budget: new DamagingBudget(),
        }),
      ).toMatchObject({
        status: "unavailable",
        reason: "private-store",
        record: 100,
      });
      expect(f.authority.inspectionFailureCheck).toBe(
        damage === "file-link"
          ? "single-link"
          : damage === "file-replacement"
            ? "file-identity"
            : "private-mode",
      );
    } finally {
      f.close();
    }
  });
}

test("a final namespace failure preserves an observed credential match", async () => {
  const f = await fixture();
  class DamagingBudget extends InspectionBudget {
    #done = false;
    override charge(
      kind: Parameters<InspectionBudget["charge"]>[0],
      amount: number,
    ): void {
      super.charge(kind, amount);
      if (kind === "units" && !this.#done) {
        this.#done = true;
        chmodSync(f.options.directory, 0o755);
      }
    }
  }
  try {
    expect(
      await f.authority.inspectSources({
        sources: [{ kind: "text", text: "synthetic-prior" }],
        requiredEpochs: ["original"],
        budget: new DamagingBudget(),
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: "private-store",
      record: 1,
      exposedEpochs: ["original"],
    });
  } finally {
    f.close();
  }
});

test("inventory revalidation refuses source ownership released during scanning", async () => {
  const f = await fixture();
  class RevokingBudget extends InspectionBudget {
    #done = false;
    override charge(
      kind: Parameters<InspectionBudget["charge"]>[0],
      amount: number,
    ): void {
      super.charge(kind, amount);
      if (kind === "units" && !this.#done) {
        this.#done = true;
        f.ownership.release();
      }
    }
  }
  try {
    expect(
      await f.authority.inspectSources({
        sources,
        requiredEpochs: ["original"],
        budget: new RevokingBudget(),
      }),
    ).toMatchObject({
      status: "unavailable",
      reason: "private-store",
      record: 100,
    });
    expect(f.authority.inspectionFailureCheck).toBe("source-ownership");
  } finally {
    f.close();
  }
});

// Why: streamed worker results remain private until the same authority fence validates them.
test("streamed sources preserve an exposure when the final authority namespace fails", async () => {
  const f = await fixture();
  try {
    const result = await f.authority.inspectSources({
      sources: async (consume) => {
        chmodSync(f.options.directory, 0o755);
        await consume({ kind: "text", text: "synthetic-prior" });
      },
      requiredEpochs: ["original"],
      budget: new InspectionBudget(),
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "private-store",
      exposedEpochs: ["original"],
    });
  } finally {
    f.close();
  }
});
