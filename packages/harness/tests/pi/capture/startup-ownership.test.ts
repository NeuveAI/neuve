import { readCapturedDump } from "../../../src/pi/capture/export.ts";
import { afterAll, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Blobs, storeLocationIn } from "@neuve/records-core";
import { Cause, Effect, Exit, Option } from "effect";
import {
  captureFolder,
  captureNativeRun,
  piDatabase,
  runFolder,
} from "../../../src/run-folder.ts";
import {
  SourceOwned,
  SourceOwnership,
} from "../../../src/pi/source-ownership.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import {
  PrivateInspection,
  PrivateInspectionError,
} from "../../../src/pi/capture/private-inspection.ts";
import {
  openManagedCredentialInspection,
  privateInspectionDirectory,
} from "../../../src/pi/capture/safety.ts";
import {
  CredentialEpochId,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import { CREDENTIAL_INSPECTION_POLICY } from "../../../src/pi/capture/types.ts";
import { runIn, value, scanCaptures } from "./fixture.ts";

const root = mkdtempSync(join(tmpdir(), "startup-ownership-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fixture = async (name: string) => {
  const location = storeLocationIn(join(root, name));
  const runId = "owned-startup";
  const source = runFolder(location, runId);
  mkdirSync(source, { recursive: true, mode: 0o700 });
  const database = piDatabase(location, runId);
  await (await openNodeSqliteStorage(database)).close(BACKGROUND_CONTEXT);
  const journal = openCaptureJournal(captureFolder(location, runId), runId);
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "coding",
    sourceRevision: "owned-synthetic",
    route: "local",
    pricing: "subscription",
  });
  journal.close();
  const directory = privateInspectionDirectory(source, location.directory);
  const managed = (ownership: SourceOwnership) =>
    openManagedCredentialInspection({
      ownership,
      source,
      directory,
      journal: captureFolder(location, runId),
      nativeDatabase: database,
      excludedRoots: [source, tmpdir()],
    });
  return { location, runId, source, database, directory, managed };
};
const reacquire = (source: string) => {
  const owner = SourceOwnership.acquire(source);
  owner.release();
};
const failure = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : "succeeded";
const capture = (
  f: Awaited<ReturnType<typeof fixture>>,
  options: Parameters<typeof captureNativeRun>[2] = {},
) =>
  runIn(f.location)(
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      return yield* captureNativeRun(f.location, f.runId, options).pipe(
        Effect.provideService(Blobs.BlobStore, {
          ...blobs,
          put: () =>
            Effect.fail(
              new Blobs.BlobWriteFailed({
                hash: "0".repeat(64),
                cause: "owned capture write failure",
              }),
            ),
        }),
      );
    }),
  );

for (const damage of [
  "corrupt",
  "missing",
  "missing-file",
  "guard-only",
] as const) {
  test(`${damage} authority is deferred to inspection while filing failure releases native ownership`, async () => {
    const f = await fixture(damage);
    if (damage === "corrupt" || damage === "missing-file") {
      mkdirSync(f.directory, { recursive: true, mode: 0o700 });
      if (damage === "corrupt")
        writeFileSync(
          join(f.directory, "authority.sqlite"),
          "owned corrupt authority",
          { mode: 0o600 },
        );
    } else {
      const journal = openCaptureJournal(
        captureFolder(f.location, f.runId),
        f.runId,
      );
      if (damage === "guard-only")
        journal.capture({
          type: "credential.guard",
          scope: { runId: f.runId },
          callId: "owned",
          status: "pending",
        });
      else
        journal.capture({
          type: "credential.registration",
          scope: { runId: f.runId },
          callId: "owned",
          epochId: "owned",
          policy: CREDENTIAL_INSPECTION_POLICY,
        });
      journal.close();
    }
    const before = readFileSync(f.database);
    const journalBefore = readFileSync(
      join(captureFolder(f.location, f.runId), "events.jsonl"),
    );
    const authorityBefore =
      damage === "corrupt"
        ? readFileSync(join(f.directory, "authority.sqlite"))
        : undefined;
    const retained = spyOn(SourceOwnership.prototype, "retainNative");
    const http = spyOn(globalThis, "fetch");
    let opened = 0;
    try {
      const result = await capture(f, {
        openNative: async (path) => {
          opened++;
          return openNodeSqliteStorage(path);
        },
      });
      expect(Exit.isFailure(result)).toBe(true);
      expect(failure(result)).toBeInstanceOf(Blobs.BlobWriteFailed);
      expect(opened).toBe(1);
      expect(retained).toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
      expect(() => reacquire(f.source)).not.toThrow();
      expect(readFileSync(f.database)).toEqual(before);
      expect(
        readFileSync(join(captureFolder(f.location, f.runId), "events.jsonl")),
      ).toEqual(journalBefore);
      if (damage === "missing" || damage === "guard-only")
        expect(existsSync(f.directory)).toBe(false);
      if (authorityBefore)
        expect(readFileSync(join(f.directory, "authority.sqlite"))).toEqual(
          authorityBefore,
        );
    } finally {
      retained.mockRestore();
      http.mockRestore();
    }
  });
}

test("opaque native open failure closes authority and quarantines the source", async () => {
  const f = await fixture("open-fails");
  const owner = SourceOwnership.acquire(f.source);
  const created = f.managed(owner);
  expect(
    await created.register({
      epoch: CredentialEpochId.parse("owned-first-epoch"),
      headers: new Headers({ authorization: "Bearer owned-retry-key" }),
      budget: new InspectionBudget(),
    }),
  ).toMatchObject({ status: "registered" });
  created.close();
  owner.release();
  const before = readFileSync(join(f.directory, "authority.sqlite"));
  const inode = statSync(join(f.directory, "authority.sqlite")).ino;
  const nativeBefore = readFileSync(f.database);
  const closed = spyOn(PrivateInspection.prototype, "close");
  try {
    const result = await capture(f, {
      openNative: async () => {
        throw new Error("owned open failure");
      },
    });
    expect(failure(result)).toMatchObject({
      _tag: "NativeStorageFailed",
      reason: "owned open failure",
    });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(() => reacquire(f.source)).toThrow(SourceOwned);
    expect(readFileSync(join(f.directory, "authority.sqlite"))).toEqual(before);
    expect(statSync(join(f.directory, "authority.sqlite")).ino).toBe(inode);
    expect(readFileSync(f.database)).toEqual(nativeBefore);
  } finally {
    closed.mockRestore();
  }
});

test("native retention failure refuses before opening storage and closes authority", async () => {
  const f = await fixture("retain-fails");
  const owner = SourceOwnership.acquire(f.source);
  f.managed(owner).close();
  owner.release();
  const retained = spyOn(
    SourceOwnership.prototype,
    "retainNative",
  ).mockImplementation(() => {
    throw new SourceOwned({
      source: f.source,
      message: "owned retention failure",
    });
  });
  const inspectionClosed = spyOn(PrivateInspection.prototype, "close");
  let closed = 0,
    opened = 0;
  try {
    const result = await capture(f, {
      openNative: async (path) => {
        opened++;
        const native = await openNodeSqliteStorage(path);
        const close = native.close.bind(native);
        native.close = async (context) => {
          closed++;
          await close(context);
        };
        return native;
      },
    });
    expect(failure(result)).toBeInstanceOf(SourceOwned);
    expect(opened).toBe(0);
    expect(closed).toBe(0);
    expect(inspectionClosed).toHaveBeenCalledTimes(1);
    expect(() => reacquire(f.source)).not.toThrow();
  } finally {
    retained.mockRestore();
    inspectionClosed.mockRestore();
  }
});

test("capture and native cleanup failures both survive and uncertain native ownership stays held", async () => {
  const f = await fixture("close-fails");
  const owner = SourceOwnership.acquire(f.source);
  f.managed(owner).close();
  owner.release();
  let raw: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let actualClose: (() => Promise<void>) | undefined;
  let release: (() => void) | undefined;
  const original = SourceOwnership.prototype.retainNative;
  const retained = spyOn(
    SourceOwnership.prototype,
    "retainNative",
  ).mockImplementation(function (this: SourceOwnership, resource) {
    release = original.call(this, resource);
    return release;
  });
  try {
    const result = await capture(f, {
      openNative: async (path) => {
        raw = await openNodeSqliteStorage(path);
        actualClose = raw.close.bind(raw, BACKGROUND_CONTEXT);
        raw.close = async () => {
          throw new Error("owned uncertain close");
        };
        return raw;
      },
    });
    expect(Exit.isFailure(result)).toBe(true);
    const detail = Exit.isFailure(result)
      ? String(result.cause) + JSON.stringify(result.cause)
      : "succeeded";
    expect(detail).toContain("owned capture write failure");
    expect(detail).toContain("owned uncertain close");
    expect(() => reacquire(f.source)).toThrow(SourceOwned);
  } finally {
    retained.mockRestore();
    await actualClose?.();
    release?.();
  }
  expect(() => reacquire(f.source)).not.toThrow();
});

test("legacy unauthenticated native state exports twice without creating a private authority", async () => {
  const f = await fixture("legacy-unauthenticated");
  const native = await openNodeSqliteStorage(f.database);
  const harness = await Harness.open(
    native,
    {
      models: createModels(),
      registry: createRegistry(),
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
    },
    BACKGROUND_CONTEXT,
  );
  await harness.root(BACKGROUND_CONTEXT);
  await harness.close(BACKGROUND_CONTEXT);
  const before = readFileSync(f.database);
  const journal = readFileSync(
    join(captureFolder(f.location, f.runId), "events.jsonl"),
  );
  let opened = 0,
    closed = 0;
  for (let claim = 0; claim < 2; claim++) {
    const receipt = value(
      await runIn(f.location)(
        captureNativeRun(f.location, f.runId, {
          openNative: async (path) => {
            opened++;
            const raw = await openNodeSqliteStorage(path);
            const close = raw.close.bind(raw);
            raw.close = async (context) => {
              closed++;
              await close(context);
            };
            return raw;
          },
        }),
      ),
    );
    expect(Option.isSome(receipt)).toBe(true);
    expect(() => reacquire(f.source)).not.toThrow();
  }
  expect(opened).toBe(2);
  expect(closed).toBe(2);
  expect(existsSync(f.directory)).toBe(false);
  expect(readFileSync(f.database)).toEqual(before);
  expect(
    readFileSync(join(captureFolder(f.location, f.runId), "events.jsonl")),
  ).toEqual(journal);
});

test("capture failure closes native and private resources before ownership is released", async () => {
  const f = await fixture("capture-fails");
  const owner = SourceOwnership.acquire(f.source);
  f.managed(owner).close();
  owner.release();
  const before = readFileSync(join(f.directory, "authority.sqlite"));
  const inspectionClosed = spyOn(PrivateInspection.prototype, "close");
  let closed = 0;
  try {
    const result = await capture(f, {
      openNative: async (path) => {
        const raw = await openNodeSqliteStorage(path);
        const close = raw.close.bind(raw);
        raw.close = async (context) => {
          closed++;
          await close(context);
        };
        return raw;
      },
    });
    expect(failure(result)).toMatchObject({
      _tag: "BlobWriteFailed",
      cause: "owned capture write failure",
    });
    expect(Exit.isFailure(result)).toBe(true);
    expect(closed).toBe(1);
    expect(inspectionClosed).toHaveBeenCalledTimes(1);
    expect(() => reacquire(f.source)).not.toThrow();
    expect(readFileSync(join(f.directory, "authority.sqlite"))).toEqual(before);
  } finally {
    inspectionClosed.mockRestore();
  }
});

for (const coverage of [undefined, "none"] as const) {
  test(`authenticated historical coverage ${String(coverage)} keeps the existing provenance refusal`, async () => {
    const f = await fixture(`unknown-${String(coverage)}`);
    const journal = openCaptureJournal(
      captureFolder(f.location, f.runId),
      f.runId,
    );
    journal.capture({
      type: "model.request",
      scope: { runId: f.runId },
      callId: "owned",
      route: "local",
      provider: "openai",
      model: "owned",
      headerNames: ["authorization"],
      ...(coverage === undefined ? {} : { credentialCoverage: coverage }),
      body: { status: "sent", json: {} },
    });
    journal.close();
    let closed = 0;
    const result = await runIn(f.location)(
      captureNativeRun(f.location, f.runId, {
        openNative: async (path) => {
          const native = await openNodeSqliteStorage(path);
          const close = native.close.bind(native);
          native.close = async (context) => {
            closed++;
            await close(context);
          };
          return native;
        },
      }),
    );
    const raw = Option.getOrThrow(value(result));
    value(await runIn(f.location)(scanCaptures(f.location)));
    const refused = await runIn(f.location)(readCapturedDump(raw.capture));
    expect(Exit.isFailure(refused)).toBe(true);
    expect(JSON.stringify(refused)).toContain(
      "credential coverage declaration is missing or contradicts",
    );
    expect(closed).toBe(1);
    expect(existsSync(f.directory)).toBe(false);
    expect(() => reacquire(f.source)).not.toThrow();
  });
}

test("native preflight releases a no-resource source while same-owner managed handles keep unrelated native claims excluded", async () => {
  const source = join(root, "managed-native");
  mkdirSync(source, { recursive: true });
  const owner = SourceOwnership.acquire(source);
  const blocked = join(source, "blocker");
  writeFileSync(blocked, "ordinary file");
  let opened = 0;
  await expect(
    owner.openNative(join(blocked, "pi.sqlite"), async () => {
      opened++;
      throw new Error("must not open");
    }),
  ).rejects.toThrow();
  expect(opened).toBe(0);
  owner.release();
  const again = SourceOwnership.acquire(source);
  let closes = 0;
  const storage = await again.openNative(
    join(source, "pi.sqlite"),
    async (path) => {
      const raw = await openNodeSqliteStorage(path);
      const close = raw.close.bind(raw);
      raw.close = async (context) => {
        closes++;
        await close(context);
      };
      return raw;
    },
  );
  const releaseHost = again.retainNative(storage);
  expect(() => again.retainNative(storage)).toThrow(SourceOwned);
  expect(() => again.retainNative({})).toThrow(SourceOwned);
  again.release();
  expect(() => reacquire(source)).toThrow(SourceOwned);
  await Promise.all([
    storage.close(BACKGROUND_CONTEXT),
    storage.close(BACKGROUND_CONTEXT),
  ]);
  expect(closes).toBe(1);
  expect(() => reacquire(source)).toThrow(SourceOwned);
  releaseHost();
  expect(() => reacquire(source)).not.toThrow();
});

test("managed admission is revoked synchronously at close and cannot authorize an old handle beside a new one", async () => {
  const source = join(root, "managed-revocation");
  mkdirSync(source, { recursive: true });
  const owner = SourceOwnership.acquire(source);
  const storage = await owner.openNative(
    join(source, "pi.sqlite"),
    openNodeSqliteStorage,
  );
  const closing = storage.close(BACKGROUND_CONTEXT);
  expect(() => owner.retainNative(storage)).toThrow(SourceOwned);
  await closing;
  const next = await owner.openNative(
    join(source, "pi.sqlite"),
    openNodeSqliteStorage,
  );
  expect(() => owner.retainNative(storage)).toThrow(SourceOwned);
  await next.close(BACKGROUND_CONTEXT);
  owner.release();
  expect(() => reacquire(source)).not.toThrow();
});
