import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import {
  createPrivateInspection,
  openPrivateInspection,
} from "../../../src/pi/capture/private-inspection.ts";
import {
  checkpointNativeAuthority,
  nativeSourceExportState,
  prepareNativeSourceImport,
} from "../../../src/pi/capture/native-source-authority.ts";
import {
  CredentialEpochId,
  CredentialJson,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import {
  openCaptureJournal,
  readCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import { buildDump } from "../../../src/pi/capture/build.ts";
import { openManagedCredentialInspection } from "../../../src/pi/capture/safety.ts";
import { historicalEvidence } from "../../../src/pi/providers/credential-evidence.ts";

const root = mkdtempSync(join(tmpdir(), "native-authority-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const KEY = "synthetic-old-native-authority-marker-827ef292";
const digest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const fixture = () => {
  const base = mkdtempSync(join(root, "case-"));
  mkdirSync(join(base, "private"), { mode: 0o700 });
  mkdirSync(join(base, "backups"), { mode: 0o700 });
  const target = (name: string) => {
    const source = join(base, name);
    mkdirSync(source, { mode: 0o700 });
    const ownership = SourceOwnership.acquire(source);
    return {
      source,
      ownership,
      directory: join(base, "private", name),
      excludedRoots: [source, join(base, "backups")],
      nativeDatabase: join(source, "channel.sqlite"),
      runId: name,
    };
  };
  return { base, target };
};
const header = (runId: string) =>
  ({
    type: "run.start",
    scope: { runId },
    runKind: "coding",
    sourceRevision: { status: "not-applicable", reason: "owned fixture" },
    route: "openai",
    pricing: "subscription",
  }) satisfies Parameters<ReturnType<typeof openCaptureJournal>["capture"]>[0];
const original = async () => {
  const f = fixture(),
    source = f.target("original");
  const authority = createPrivateInspection(source);
  await authority.register({
    epoch: CredentialEpochId.parse("old-call"),
    headers: new Headers({ authorization: `Bearer ${KEY}` }),
    budget: new InspectionBudget(),
  });
  const journal = openCaptureJournal(
    join(source.source, "capture"),
    source.runId,
  );
  journal.capture(header(source.runId));
  journal.close();
  const db = new Database(source.nativeDatabase);
  db.exec(
    "CREATE TABLE entries (value TEXT); CREATE TABLE documents (value TEXT)",
  );
  db.query("INSERT INTO entries VALUES (?)").run(
    JSON.stringify({ nested: JSON.stringify(KEY) }),
  );
  db.close();
  const frozen = join(f.base, "backups", "native.sqlite");
  copyFileSync(source.nativeDatabase, frozen);
  chmodSync(frozen, 0o600);
  return { ...f, source, authority, frozen, nativeSha256: digest(frozen) };
};

test("private native checkpoint preserves old credential detectors after target re-MAC and restart", async () => {
  const f = await original(),
    target = f.target("restored");
  let adopted: ReturnType<typeof createPrivateInspection> | undefined;
  try {
    const exposure = openCaptureJournal(
      join(f.source.source, "capture"),
      f.source.runId,
    );
    exposure.capture({
      type: "credential.guard",
      scope: { runId: f.source.runId },
      callId: "old-call",
      status: "exposed",
    });
    exposure.close();
    const receipt = await checkpointNativeAuthority(f.authority, {
      nativeDatabase: f.frozen,
      nativeSha256: f.nativeSha256,
      runId: f.source.runId,
      journal: join(f.source.source, "capture"),
    });
    expect(Object.keys(receipt).sort()).toEqual([
      "id",
      "nativeSha256",
      "version",
    ]);
    expect(JSON.stringify(receipt)).not.toContain(KEY);
    adopted = await prepareNativeSourceImport({
      ...target,
      origin: { kind: "backup", nativeSha256: f.nativeSha256, receipt },
    });
    expect(nativeSourceExportState(adopted)).toEqual({
      kind: "uncertified-import",
    });
    copyFileSync(f.frozen, target.nativeDatabase);
    const native = new Database(target.nativeDatabase, { readonly: true });
    expect(native.query("SELECT count(*) AS count FROM entries").get()).toEqual(
      { count: 1 },
    );
    native.close();
    const masked = await historicalEvidence(
      { quoted: JSON.stringify({ token: KEY }) },
      adopted,
      () => {},
    );
    expect(JSON.stringify(masked.data)).not.toContain(KEY);
    expect(masked.exposedEpochs).toEqual(["old-call"]);
    expect(() => adopted?.assertExportable()).toThrow("not export certified");
    adopted.close();
    adopted = openManagedCredentialInspection({
      ...target,
      journal: join(target.source, "capture"),
    });
    expect(
      (
        await adopted.inspectJson({
          json: CredentialJson.serialize({ token: KEY }),
          budget: new InspectionBudget(),
        })
      ).status,
    ).toBe("complete");
    expect(() => adopted?.assertExportable()).toThrow("not export certified");
    const parentPrivate = join(
      f.base,
      "private",
      "snapshots",
      receipt.id,
      "authority.sqlite",
    );
    expect(readFileSync(parentPrivate).includes(KEY)).toBe(false);
    const row = new Database(join(target.directory, "authority.sqlite"), {
      readonly: true,
    });
    const metadata = row
      .query<{ value: string }, []>("SELECT value FROM provenance WHERE id=1")
      .get();
    row.close();
    expect(metadata).not.toBeNull();
    expect(JSON.parse(metadata?.value ?? "null")).toMatchObject({
      kind: "inherited-native",
      exposedEpochs: ["old-call"],
      ancestors: [
        {
          source: f.source.source,
          runId: f.source.runId,
          journal: join(f.source.source, "capture"),
          nativeSha256: f.nativeSha256,
        },
      ],
    });
  } finally {
    adopted?.close();
    target.ownership.release();
    f.authority.close();
    f.source.ownership.release();
  }
});

test("wrong digest, live native path and altered private source proof are rejected before target authority creation", async () => {
  const f = await original(),
    target = f.target("wrong-proof");
  try {
    await expect(
      checkpointNativeAuthority(f.authority, {
        nativeDatabase: f.frozen,
        nativeSha256: "0".repeat(64),
        runId: f.source.runId,
        journal: join(f.source.source, "capture"),
      }),
    ).rejects.toThrow();
    await expect(
      checkpointNativeAuthority(f.authority, {
        nativeDatabase: f.source.nativeDatabase,
        nativeSha256: digest(f.source.nativeDatabase),
        runId: f.source.runId,
        journal: join(f.source.source, "capture"),
      }),
    ).rejects.toThrow();
    const receipt = await checkpointNativeAuthority(f.authority, {
      nativeDatabase: f.frozen,
      nativeSha256: f.nativeSha256,
      runId: f.source.runId,
      journal: join(f.source.source, "capture"),
    });
    await expect(
      prepareNativeSourceImport({
        ...target,
        origin: { kind: "backup", nativeSha256: "0".repeat(64), receipt },
      }),
    ).rejects.toThrow();
    expect(existsSync(target.directory)).toBe(false);
    const privateDb = new Database(
      join(f.base, "private", "snapshots", receipt.id, "authority.sqlite"),
    );
    privateDb.query("UPDATE authority SET source=?").run(target.source);
    privateDb.close();
    await expect(
      prepareNativeSourceImport({
        ...target,
        origin: { kind: "backup", nativeSha256: f.nativeSha256, receipt },
      }),
    ).rejects.toThrow();
    expect(existsSync(target.directory)).toBe(false);
  } finally {
    target.ownership.release();
    f.authority.close();
    f.source.ownership.release();
  }
});

test("poisoned ancestor cannot publish a new authority checkpoint", async () => {
  const f = await original();
  try {
    const db = new Database(join(f.source.directory, "authority.sqlite"));
    db.exec("UPDATE authority SET mac=zeroblob(32)");
    db.close();
    expect(
      (
        await f.authority.inspectText({
          text: "synthetic",
          budget: new InspectionBudget(),
        })
      ).status,
    ).toBe("unavailable");
    await expect(
      checkpointNativeAuthority(f.authority, {
        nativeDatabase: f.frozen,
        nativeSha256: f.nativeSha256,
        runId: f.source.runId,
        journal: join(f.source.source, "capture"),
      }),
    ).rejects.toThrow();
  } finally {
    f.authority.close();
    f.source.ownership.release();
  }
});

test.each(["seed", "detached"] as const)(
  "explicit %s precreation permits SQLite writes but permanently refuses zero-call export without optional authority",
  async (kind) => {
    const f = fixture(),
      target = f.target(kind);
    const seed = join(f.base, "backups", "seed.json");
    writeFileSync(seed, JSON.stringify({ format: "synthetic-seed" }));
    const origin =
      kind === "seed"
        ? ({ kind: "seed", file: seed, sha256: digest(seed) } as const)
        : ({ kind: "backup", nativeSha256: digest(seed) } as const);
    const authority = await prepareNativeSourceImport({ ...target, origin });
    const storage = await openNodeSqliteStorage(target.nativeDatabase);
    try {
      expect(() => authority.assertExportable()).toThrow(
        "not export certified",
      );
      const journal = readCaptureJournal(join(target.source, "capture"));
      expect(journal._tag).toBe("Read");
      if (journal._tag === "Read")
        expect(
          journal.lines.find(({ event }) => event.type === "native.import")
            ?.event,
        ).toMatchObject({
          scope: { runId: target.runId },
          origin: kind === "seed" ? "external-seed" : "detached-backup",
        });
      await expect(
        buildDump({
          runId: target.runId,
          journal: join(target.source, "capture"),
        }),
      ).rejects.toThrow("not export certified");
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
      authority.close();
      target.ownership.release();
    }
  },
);

test("normal unknown historical startup still refuses and a present target cannot enroll as a fresh import", async () => {
  const f = await original(),
    target = f.target("unknown");
  try {
    copyFileSync(f.frozen, target.nativeDatabase);
    expect(() =>
      openManagedCredentialInspection({
        ...target,
        journal: join(target.source, "capture"),
      }),
    ).toThrow("Unregistered historical");
    await expect(
      prepareNativeSourceImport({
        ...target,
        origin: { kind: "backup", nativeSha256: f.nativeSha256 },
      }),
    ).rejects.toThrow();
    expect(existsSync(target.directory)).toBe(false);
  } finally {
    target.ownership.release();
    f.authority.close();
    f.source.ownership.release();
  }
});

test("fresh normal zero-call native source retains its existing export behavior", async () => {
  const f = fixture(),
    target = f.target("fresh");
  const authority = createPrivateInspection(target);
  const storage = await openNodeSqliteStorage(target.nativeDatabase);
  const journal = openCaptureJournal(
    join(target.source, "capture"),
    target.runId,
  );
  journal.capture(header(target.runId));
  journal.capture({
    type: "run.end",
    scope: { runId: target.runId },
    status: "completed",
  });
  journal.close();
  try {
    expect(() => authority.assertExportable()).not.toThrow();
    const built = await buildDump({
      runId: target.runId,
      journal: join(target.source, "capture"),
      nativeDatabase: target.nativeDatabase,
      native: { reads: storage, context: BACKGROUND_CONTEXT },
      credentialInspection: authority,
    });
    expect(built.run.runId).toBe("fresh");
    expect(built.run.complete).toBe(true);
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
    authority.close();
    target.ownership.release();
  }
});

test("native import and reopen use the canonical authority root behind an alias", async () => {
  const f = await original();
  const target = f.target("alias-restored");
  const alias = join(f.base, "private-alias");
  symlinkSync(join(f.base, "private"), alias);
  target.directory = join(alias, "alias-restored");
  let adopted: ReturnType<typeof createPrivateInspection> | undefined;
  try {
    const receipt = await checkpointNativeAuthority(f.authority, {
      nativeDatabase: f.frozen,
      nativeSha256: f.nativeSha256,
      runId: f.source.runId,
      journal: join(f.source.source, "capture"),
    });
    adopted = await prepareNativeSourceImport({
      ...target,
      origin: { kind: "backup", nativeSha256: f.nativeSha256, receipt },
    });
    adopted.close();
    adopted = openPrivateInspection(target);
    const result = await adopted.inspectText({
      text: KEY,
      budget: new InspectionBudget(),
    });
    expect(result.status).toBe("complete");
    if (result.status === "complete")
      expect(result.matches.some((match) => match.epoch === "old-call")).toBe(
        true,
      );
    expect(nativeSourceExportState(adopted)).toEqual({
      kind: "uncertified-import",
    });
    expect(() => adopted?.assertExportable()).toThrow("not export certified");
  } finally {
    adopted?.close();
    f.authority.close();
    f.source.ownership.release();
    target.ownership.release();
  }
});

test("a checkpoint cannot escape through a symlinked snapshots child", async () => {
  const f = await original();
  const outside = join(f.base, "outside");
  mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, join(f.base, "private", "snapshots"));
  try {
    await expect(
      checkpointNativeAuthority(f.authority, {
        nativeDatabase: f.frozen,
        nativeSha256: f.nativeSha256,
        runId: f.source.runId,
        journal: join(f.source.source, "capture"),
      }),
    ).rejects.toThrow("no-symbolic-link");
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    f.authority.close();
    f.source.ownership.release();
  }
});
