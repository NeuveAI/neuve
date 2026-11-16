import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { randomBytes } from "node:crypto";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import {
  CredentialDetectors,
  CredentialEpochId,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import {
  createPrivateInspection,
  openPrivateInspection,
  PrivateInspectionError,
} from "../../../src/pi/capture/private-inspection.ts";

const directory = mkdtempSync(
  join(realpathSync(tmpdir()), "private-inspection-tests-"),
);
afterAll(() => {
  if (process.env["NEUVE_CAPTURE_INTEGRITY_KEEP"] === "1")
    console.log(`Private inspection synthetic evidence: ${directory}`);
  else rmSync(directory, { recursive: true, force: true });
});
const fixture = () => {
  const root = mkdtempSync(join(directory, "case-"));
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  const ownership = SourceOwnership.acquire(source);
  const options = {
    ownership,
    source,
    directory: join(root, "private"),
    excludedRoots: [source],
  };
  return { root, source, ownership, options };
};
const headers = new Headers({ authorization: "Bearer synthetic-original" });
const register = (
  authority: ReturnType<typeof createPrivateInspection>,
  id = "original",
) =>
  authority.register({
    epoch: CredentialEpochId.parse(id),
    headers,
    budget: new InspectionBudget(),
  });
const child = async (mode: string, root: string) => {
  const process = Bun.spawn(
    [
      Bun.which("bun") ?? "bun",
      join(
        dirname(fileURLToPath(import.meta.url)),
        "private-inspection-child.ts",
      ),
      mode,
      root,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { stdout, stderr, code };
};

test("committed epochs survive unclean child exit, rotated registration and a fresh process", async () => {
  const f = fixture();
  const authority = createPrivateInspection(f.options);
  expect((await register(authority)).status).toBe("registered");
  expect(JSON.stringify(authority)).toBe('"[Private credential inspection]"');
  expect(inspect(authority)).toBe("[Private credential inspection]");
  expect(statSync(f.options.directory).mode & 0o777).toBe(0o700);
  expect(
    statSync(join(f.options.directory, "authority.sqlite")).mode & 0o777,
  ).toBe(0o600);
  authority.close();
  f.ownership.release();
  expect(await child("register", f.root)).toEqual({
    stdout: '{"registered":true}',
    stderr: "",
    code: 0,
  });
  expect(await child("inspect", f.root)).toEqual({
    stdout: '{"epochs":["child-committed","original"]}',
    stderr: "",
    code: 0,
  });
});

test("an uncommitted key write rolls back on crash without replacing committed detectors", async () => {
  const f = fixture();
  const authority = createPrivateInspection(f.options);
  await register(authority);
  authority.close();
  f.ownership.release();
  expect((await child("uncommitted", f.root)).code).toBe(93);
  const ownership = SourceOwnership.acquire(f.source);
  const reopened = openPrivateInspection({ ...f.options, ownership });
  const result = await reopened.inspectText({
    text: "synthetic-original",
    budget: new InspectionBudget(),
  });
  expect(result.status).toBe("complete");
  if (result.status === "complete")
    expect(result.matches.some((match) => match.epoch === "original")).toBe(
      true,
    );
  reopened.close();
  ownership.release();
});

test("same-source handles serialize concurrent registration without losing epochs", async () => {
  const f = fixture();
  const one = createPrivateInspection(f.options),
    two = openPrivateInspection(f.options);
  const results = await Promise.all([
    register(one, "one"),
    register(two, "two"),
    register(one, "three"),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "registered",
    "registered",
    "registered",
  ]);
  const result = await two.inspectText({
    text: "synthetic-original",
    budget: new InspectionBudget(),
  });
  expect(result.status).toBe("complete");
  if (result.status === "complete")
    expect(
      [...new Set(result.matches.map((match) => String(match.epoch)))].sort(),
    ).toEqual(["one", "three", "two"]);
  one.close();
  two.close();
  f.ownership.release();
});

test("ownership release forbids certification even when the native lock remains retained", async () => {
  const f = fixture();
  const authority = createPrivateInspection(f.options);
  await register(authority);
  const releaseNative = f.ownership.retainNative({});
  f.ownership.release();
  expect(() => SourceOwnership.acquire(f.source)).toThrow();
  expect(
    await authority.inspectText({
      text: "safe",
      budget: new InspectionBudget(),
    }),
  ).toEqual({
    status: "unavailable",
    reason: "private-store",
    exposedEpochs: [],
  });
  authority.close();
  releaseNative();
});

test("wrong-key, missing-key, changed-prefix and truncated metadata cannot become absence", async () => {
  for (const damage of ["key", "missing-key", "prefix", "truncated"] as const) {
    const f = fixture();
    const authority = createPrivateInspection(f.options);
    await register(authority);
    authority.close();
    const database = new Database(
      join(f.options.directory, "authority.sqlite"),
    );
    if (damage === "key" || damage === "missing-key")
      database
        .query("UPDATE authority SET key=? WHERE id=1")
        .run(Buffer.alloc(damage === "key" ? 32 : 0));
    else {
      const row = database
        .query("SELECT state FROM authority WHERE id=1")
        .get();
      if (
        typeof row !== "object" ||
        row === null ||
        !("state" in row) ||
        !(row.state instanceof Uint8Array)
      )
        throw new Error("fixture metadata missing");
      const source = new TextDecoder().decode(row.state);
      const changed =
        damage === "prefix"
          ? source.replace(/"prefix":\d+/, '"prefix":42')
          : source.slice(0, -1);
      database
        .query("UPDATE authority SET state=? WHERE id=1")
        .run(Buffer.from(changed));
    }
    database.close();
    const before = readFileSync(join(f.options.directory, "authority.sqlite"));
    expect(() => openPrivateInspection(f.options)).toThrow(
      PrivateInspectionError,
    );
    expect(readFileSync(join(f.options.directory, "authority.sqlite"))).toEqual(
      before,
    );
    expect(() => createPrivateInspection(f.options)).toThrow(
      PrivateInspectionError,
    );
    f.ownership.release();
  }
});

test("metadata authenticity binds the acceleration inventory even outside the private store", async () => {
  const key = randomBytes(32),
    engine = CredentialDetectors.empty(key);
  await engine.register({
    epoch: CredentialEpochId.parse("bound"),
    headers,
    budget: new InspectionBudget(),
  });
  const bytes = engine.encodePrivate();
  expect(() =>
    CredentialDetectors.restorePrivate(randomBytes(32), bytes),
  ).toThrow("Credential inspection unavailable");
  const changed = new TextDecoder()
    .decode(bytes)
    .replace(/"prefix":\d+/, '"prefix":42');
  expect(() =>
    CredentialDetectors.restorePrivate(key, Buffer.from(changed)),
  ).toThrow("Credential inspection unavailable");
});

test("private directories, databases, sidecars and excluded roots reject aliases and unsafe modes", async () => {
  for (const damage of [
    "directory-mode",
    "file-mode",
    "hardlink",
    "symlink",
    "sidecar",
  ] as const) {
    const f = fixture();
    const authority = createPrivateInspection(f.options);
    await register(authority);
    authority.close();
    const file = join(f.options.directory, "authority.sqlite");
    if (damage === "directory-mode") chmodSync(f.options.directory, 0o755);
    if (damage === "file-mode") chmodSync(file, 0o644);
    if (damage === "hardlink") linkSync(file, join(f.root, "alias.sqlite"));
    if (damage === "symlink") {
      const held = readFileSync(file);
      rmSync(file);
      writeFileSync(join(f.root, "elsewhere"), held, { mode: 0o600 });
      symlinkSync(join(f.root, "elsewhere"), file);
    }
    if (damage === "sidecar") symlinkSync(file, file + "-journal");
    const check =
      damage === "directory-mode" || damage === "file-mode"
        ? "private-mode"
        : damage === "hardlink"
          ? "single-link"
          : "no-symbolic-link";
    const path =
      damage === "directory-mode"
        ? f.options.directory
        : damage === "sidecar"
          ? file + "-journal"
          : file;
    try {
      expect(() => openPrivateInspection(f.options)).toThrow(
        `Private credential inspection unavailable: ${check} at ${JSON.stringify(path)}`,
      );
    } finally {
      f.ownership.release();
    }
  }
  const f = fixture();
  for (const root of [
    f.source,
    join(f.root, "spill"),
    join(f.root, "dataset"),
    join(f.root, "logs"),
  ]) {
    mkdirSync(root, { recursive: true });
    expect(() =>
      createPrivateInspection({
        ...f.options,
        directory: join(root, "private"),
        excludedRoots: [root],
      }),
    ).toThrow(PrivateInspectionError);
    expect(existsSync(join(root, "private"))).toBe(false);
  }
  f.ownership.release();
});

test("existing empty or missing-key authorities are not initialized on reopen or create", () => {
  const f = fixture();
  mkdirSync(f.options.directory, { mode: 0o700 });
  writeFileSync(join(f.options.directory, "authority.sqlite"), "", {
    mode: 0o600,
  });
  expect(() => openPrivateInspection(f.options)).toThrow(
    PrivateInspectionError,
  );
  expect(() => createPrivateInspection(f.options)).toThrow(
    PrivateInspectionError,
  );
  expect(
    readFileSync(join(f.options.directory, "authority.sqlite")).length,
  ).toBe(0);
  f.ownership.release();
});

test("closed handles and failed complete registration never certify empty coverage", async () => {
  const f = fixture();
  const authority = createPrivateInspection(f.options);
  expect(
    await authority.register({
      epoch: CredentialEpochId.parse("truncated"),
      headers: new Headers({ authorization: "Bearer " + "k".repeat(8186) }),
      escapedUnits: 8192,
      budget: new InspectionBudget(),
    }),
  ).toEqual({ status: "unavailable", reason: "budget", exposedEpochs: [] });
  expect(
    await authority.inspectText({
      text: "safe",
      budget: new InspectionBudget(),
    }),
  ).toEqual({
    status: "unavailable",
    reason: "invalid-metadata",
    exposedEpochs: [],
  });
  await register(authority);
  expect((await register(authority)).status).toBe("registered");
  expect(
    await authority.register({
      epoch: CredentialEpochId.parse("original"),
      headers: new Headers({ "x-api-key": "conflicting" }),
      budget: new InspectionBudget(),
    }),
  ).toEqual({
    status: "unavailable",
    reason: "invalid-metadata",
    exposedEpochs: [],
  });
  authority.close();
  expect(await register(authority, "later")).toEqual({
    status: "unavailable",
    reason: "closed",
    exposedEpochs: [],
  });
  f.ownership.release();
});

test("register-versus-scan shares one source queue and reports the exact scanned inventory", async () => {
  const f = fixture(),
    one = createPrivateInspection(f.options),
    two = openPrivateInspection(f.options);
  await register(one);
  const scan = one.inspectText({
    text: "x".repeat(1024 * 1024),
    budget: new InspectionBudget(),
  });
  const next = two.register({
    epoch: CredentialEpochId.parse("during-scan"),
    headers: new Headers({ "x-api-key": "synthetic-later" }),
    budget: new InspectionBudget(),
  });
  const [before, after] = await Promise.all([scan, next]);
  expect(before.status).toBe("complete");
  if (before.status === "complete")
    expect(before.epochs.map(String)).toEqual(["original"]);
  expect(after.status).toBe("registered");
  const current = await one.inspectText({
    text: "synthetic-later",
    budget: new InspectionBudget(),
  });
  expect(current.status).toBe("complete");
  if (current.status === "complete") {
    expect(current.epochs.map(String)).toEqual(["original", "during-scan"]);
    expect(current.matches.some((match) => match.epoch === "during-scan")).toBe(
      true,
    );
  }
  one.close();
  two.close();
  f.ownership.release();
});

test("warm caches refuse subsequent key or acceleration metadata corruption", async () => {
  for (const damage of ["key", "prefix"] as const) {
    const f = fixture(),
      authority = createPrivateInspection(f.options);
    await register(authority);
    expect(
      (
        await authority.inspectText({
          text: "safe",
          budget: new InspectionBudget(),
        })
      ).status,
    ).toBe("complete");
    const database = new Database(
      join(f.options.directory, "authority.sqlite"),
    );
    if (damage === "key")
      database
        .query("UPDATE authority SET key=? WHERE id=1")
        .run(Buffer.alloc(32));
    else {
      const row = database
        .query("SELECT state FROM authority WHERE id=1")
        .get();
      if (
        typeof row !== "object" ||
        row === null ||
        !("state" in row) ||
        !(row.state instanceof Uint8Array)
      )
        throw new Error("fixture metadata missing");
      database
        .query("UPDATE authority SET state=? WHERE id=1")
        .run(
          Buffer.from(
            new TextDecoder()
              .decode(row.state)
              .replace(/"prefix":\d+/, '"prefix":42'),
          ),
        );
    }
    database.close();
    expect(
      await authority.inspectText({
        text: "synthetic-original",
        budget: new InspectionBudget(),
      }),
    ).toEqual({
      status: "unavailable",
      reason: "private-store",
      exposedEpochs: [],
    });
    authority.close();
    f.ownership.release();
  }
});

// These boundaries must stay live even after successful inspections warm the engine.
for (const damage of ["replacement", "mode", "symlink"] as const) {
  for (const boundary of ["before-access", "before-return"] as const) {
    test(`a warm authority refuses ${damage} ${boundary}`, async () => {
      const f = fixture();
      const authority = createPrivateInspection(f.options);
      const file = join(f.options.directory, "authority.sqlite");
      const damageFile = () => {
        if (damage === "mode") chmodSync(file, 0o644);
        else {
          const held = join(f.root, "held.sqlite");
          renameSync(file, held);
          if (damage === "symlink") symlinkSync(held, file);
          else {
            copyFileSync(held, file);
            chmodSync(file, 0o600);
          }
        }
      };
      let scanned = false;
      class DamagingBudget extends InspectionBudget {
        override charge(
          kind: Parameters<InspectionBudget["charge"]>[0],
          amount: number,
        ): void {
          super.charge(kind, amount);
          if (kind !== "units" || scanned) return;
          scanned = true;
          if (boundary === "before-return") damageFile();
        }
      }
      try {
        await register(authority);
        expect(
          (
            await authority.inspectText({
              text: "safe",
              budget: new InspectionBudget(),
            })
          ).status,
        ).toBe("complete");
        if (boundary === "before-access") damageFile();
        expect(
          await authority.inspectText({
            text: "safe",
            budget: new DamagingBudget(),
          }),
        ).toEqual({
          status: "unavailable",
          reason: "private-store",
          exposedEpochs: [],
        });
        expect(scanned).toBe(boundary === "before-return");
        expect(authority.inspectionFailureCheck).toBe(
          damage === "replacement"
            ? "file-identity"
            : damage === "mode"
              ? "private-mode"
              : "no-symbolic-link",
        );
      } finally {
        authority.close();
        f.ownership.release();
      }
    });
  }
}

test("a closed warm authority refuses inspection before scanning", async () => {
  const f = fixture();
  const authority = createPrivateInspection(f.options);
  try {
    await register(authority);
    authority.close();
    const budget = new InspectionBudget();
    expect(await authority.inspectText({ text: "safe", budget })).toEqual({
      status: "unavailable",
      reason: "closed",
      exposedEpochs: [],
    });
    expect(budget.usage.units).toBe(0);
  } finally {
    authority.close();
    f.ownership.release();
  }
});

test("a dangling SQLite sidecar alias cannot create a key-bearing file outside the private directory", async () => {
  const f = fixture(),
    authority = createPrivateInspection(f.options);
  await register(authority);
  authority.close();
  const outside = join(f.root, "missing-outside");
  symlinkSync(outside, join(f.options.directory, "authority.sqlite-journal"));
  expect(() => openPrivateInspection(f.options)).toThrow(
    PrivateInspectionError,
  );
  expect(existsSync(outside)).toBe(false);
  f.ownership.release();
});

test("private directory aliases and physical excluded-root aliases are refused", async () => {
  const f = fixture(),
    authority = createPrivateInspection(f.options);
  await register(authority);
  authority.close();
  const alias = join(f.root, "directory-alias");
  symlinkSync(f.options.directory, alias);
  expect(() =>
    openPrivateInspection({ ...f.options, directory: alias }),
  ).toThrow(PrivateInspectionError);
  expect(() =>
    openPrivateInspection({ ...f.options, excludedRoots: [alias] }),
  ).toThrow(PrivateInspectionError);
  f.ownership.release();
});

test("filesystem case aliases cannot bypass physical containment or the one-owner queue", async () => {
  const f = fixture();
  const aliasSource = join(f.root, "sOURCE");
  if (existsSync(aliasSource)) {
    expect(() =>
      createPrivateInspection({
        ...f.options,
        directory: join(aliasSource, "hidden-private"),
      }),
    ).toThrow(PrivateInspectionError);
    expect(
      existsSync(join(f.source, "hidden-private", "authority.sqlite")),
    ).toBe(false);
    const authority = createPrivateInspection(f.options);
    expect(() =>
      openPrivateInspection({
        ...f.options,
        directory: join(f.root, "pRIVATE"),
      }),
    ).toThrow(PrivateInspectionError);
    authority.close();
  }
  f.ownership.release();
});

test("creation diagnostics identify filesystem operations and preserve the safe error code", () => {
  const f = fixture();
  const missingParent = join(f.root, "missing", "private");
  try {
    try {
      createPrivateInspection({ ...f.options, directory: missingParent });
      throw new Error("authority creation unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateInspectionError);
      if (!(error instanceof PrivateInspectionError)) throw error;
      expect(error.check).toBe("mkdir-authority");
      expect(error.path).toBe(missingParent);
      expect(error.code).toBe("ENOENT");
      expect(error.message).toBe(
        `Private credential inspection unavailable: mkdir-authority at ${JSON.stringify(missingParent)} (ENOENT)`,
      );
      expect(error.cause).toBeUndefined();
    }
    expect(existsSync(missingParent)).toBe(false);
  } finally {
    f.ownership.release();
  }
});

test("authentication diagnostics disclose the failed check without private database values", () => {
  const f = fixture();
  const authority = createPrivateInspection(f.options);
  authority.close();
  const marker = "synthetic-private-diagnostic-marker";
  const file = join(f.options.directory, "authority.sqlite");
  const database = new Database(file);
  database.query("UPDATE authority SET source=? WHERE id=1").run(marker);
  database.close();
  try {
    try {
      openPrivateInspection(f.options);
      throw new Error("corrupt authority unexpectedly opened");
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateInspectionError);
      if (!(error instanceof PrivateInspectionError)) throw error;
      expect(error.check).toBe("state-source");
      expect(error.path).toBe(file);
      expect(inspect(error)).not.toContain(marker);
      expect(JSON.stringify(error)).not.toContain(marker);
      expect(error.cause).toBeUndefined();
    }
  } finally {
    f.ownership.release();
  }
});

const mountedFixture = () => {
  const root = mkdtempSync(join(directory, "mounted-"));
  const physical = join(
    root,
    "volume",
    "cases",
    "go",
    "293649",
    "replay-candidate-6",
  );
  mkdirSync(physical, { recursive: true });
  const alias = join(root, "case");
  symlinkSync(physical, alias);
  const source = join(alias, ".git", "neuve", "runs", "run");
  const namespace = join(alias, ".git", "neuve", "credential-inspections");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  mkdirSync(namespace, { mode: 0o700 });
  const ownership = SourceOwnership.acquire(source);
  const options = {
    ownership,
    source,
    directory: join(namespace, "a".repeat(64)),
    excludedRoots: [source],
  };
  return { root, physical, alias, options, ownership };
};

test("a symlinked case mount creates and reopens the same protected authority", async () => {
  const f = mountedFixture();
  try {
    const authority = createPrivateInspection(f.options);
    try {
      expect((await register(authority)).status).toBe("registered");
    } finally {
      authority.close();
    }
    const physicalDirectory = join(
      f.physical,
      ".git",
      "neuve",
      "credential-inspections",
      "a".repeat(64),
    );
    expect(statSync(physicalDirectory).mode & 0o777).toBe(0o700);
    expect(
      statSync(join(physicalDirectory, "authority.sqlite")).mode & 0o777,
    ).toBe(0o600);
    for (const path of [f.options.directory, physicalDirectory]) {
      const reopened = openPrivateInspection({ ...f.options, directory: path });
      try {
        const result = await reopened.inspectText({
          text: "synthetic-original",
          budget: new InspectionBudget(),
        });
        expect(result.status).toBe("complete");
        if (result.status === "complete")
          expect([
            ...new Set(result.matches.map((match) => String(match.epoch))),
          ]).toEqual(["original"]);
      } finally {
        reopened.close();
      }
    }
  } finally {
    f.ownership.release();
  }
});

test("a live authority pins the canonical namespace instead of following a retargeted mount alias", async () => {
  const f = mountedFixture();
  const options = {
    ...f.options,
    source: f.ownership.source,
    excludedRoots: [f.ownership.source],
  };
  const authority = createPrivateInspection(options);
  try {
    expect((await register(authority)).status).toBe("registered");
    const replacement = join(f.root, "replacement");
    mkdirSync(replacement);
    rmSync(f.alias);
    symlinkSync(replacement, f.alias);
    expect((await register(authority, "after-retarget")).status).toBe(
      "registered",
    );
    expect(existsSync(join(replacement, ".git"))).toBe(false);
    const result = await authority.inspectText({
      text: "synthetic-original",
      budget: new InspectionBudget(),
    });
    expect(result.status).toBe("complete");
    if (result.status === "complete")
      expect(result.epochs.map(String)).toEqual(["original", "after-retarget"]);
  } finally {
    authority.close();
    f.ownership.release();
  }
});

test("a substituted canonical namespace cannot redirect a live authority outside its pinned root", async () => {
  const f = mountedFixture();
  const authority = createPrivateInspection(f.options);
  try {
    expect((await register(authority)).status).toBe("registered");
    const namespace = realpathSync(dirname(f.options.directory));
    const outside = join(f.root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    renameSync(namespace, namespace + "-held");
    symlinkSync(outside, namespace);
    expect(await register(authority, "escaped")).toEqual({
      status: "unavailable",
      reason: "private-store",
      exposedEpochs: [],
    });
    expect(existsSync(join(outside, "a".repeat(64)))).toBe(false);
  } finally {
    authority.close();
    f.ownership.release();
  }
});

test("symlinked mounts do not permit authority, database or sidecar escapes", () => {
  for (const escape of [
    "authority",
    "dangling-authority",
    "database",
    "sidecar",
  ] as const) {
    const f = mountedFixture();
    const outside = join(f.root, "outside");
    const outsideFile = join(outside, "authority.sqlite");
    try {
      if (escape === "authority" || escape === "dangling-authority") {
        if (escape === "authority") {
          mkdirSync(outside, { mode: 0o700 });
          writeFileSync(outsideFile, "synthetic-outside-untouched", {
            mode: 0o600,
          });
        }
        symlinkSync(outside, f.options.directory);
        expect(() => createPrivateInspection(f.options)).toThrow(
          PrivateInspectionError,
        );
        expect(() => openPrivateInspection(f.options)).toThrow(
          PrivateInspectionError,
        );
      } else {
        const authority = createPrivateInspection(f.options);
        authority.close();
        mkdirSync(outside, { mode: 0o700 });
        writeFileSync(outsideFile, "synthetic-outside-untouched", {
          mode: 0o600,
        });
        const file = join(f.options.directory, "authority.sqlite");
        if (escape === "database") rmSync(file);
        symlinkSync(
          outsideFile,
          file + (escape === "sidecar" ? "-journal" : ""),
        );
        expect(() => openPrivateInspection(f.options)).toThrow(
          "no-symbolic-link",
        );
      }
      if (escape === "dangling-authority")
        expect(existsSync(outside)).toBe(false);
      else
        expect(readFileSync(outsideFile, "utf8")).toBe(
          "synthetic-outside-untouched",
        );
    } finally {
      f.ownership.release();
    }
  }
});

test("canonical root resolution still excludes the source and other capture roots", () => {
  const f = mountedFixture();
  try {
    const logs = join(f.root, "logs");
    mkdirSync(logs);
    const logAlias = join(f.root, "logs-alias");
    symlinkSync(logs, logAlias);
    for (const root of [f.options.source, logAlias]) {
      const destination = join(root, "hidden-private");
      expect(() =>
        createPrivateInspection({
          ...f.options,
          directory: destination,
          excludedRoots: [f.options.source, logs],
        }),
      ).toThrow("excluded-root-overlap");
      expect(existsSync(destination)).toBe(false);
    }
  } finally {
    f.ownership.release();
  }
});

test("inspection refusal preserves the first private check without exposing detector state", async () => {
  const f = fixture();
  const authority = createPrivateInspection(f.options);
  try {
    await register(authority);
    chmodSync(f.options.directory, 0o755);
    expect(
      await authority.inspectText({
        text: "safe",
        budget: new InspectionBudget(),
      }),
    ).toMatchObject({ status: "unavailable", reason: "private-store" });
    expect(authority.inspectionFailureCheck).toBe("private-mode");
    await authority.inspectText({
      text: "safe",
      budget: new InspectionBudget(),
    });
    expect(authority.inspectionFailureCheck).toBe("private-mode");
    expect(JSON.stringify(authority)).not.toContain("synthetic-original");
  } finally {
    authority.close();
    f.ownership.release();
  }
});

test("inspection budget refusal identifies the exhausted counter and remains fail closed", async () => {
  const f = fixture();
  const authority = createPrivateInspection(f.options);
  try {
    await register(authority);
    const original = new InspectionBudget();
    const budget = new InspectionBudget({ ...original.limits, fullChecks: 0 });
    expect(await authority.inspectText({ text: "safe", budget })).toMatchObject(
      { status: "unavailable", reason: "budget" },
    );
    expect(budget.exhausted).toBe("fullChecks");
    expect(
      await authority.inspectText({
        text: "safe",
        budget: new InspectionBudget(),
      }),
    ).toMatchObject({ status: "complete", matches: [] });
  } finally {
    authority.close();
    f.ownership.release();
  }
});

// Why: deferred scans must authenticate a frozen checkpoint after source deletion and tolerate parallel readers.
test("a receipt-bound checkpoint is read-only, survives source deletion and accepts concurrent scans", async () => {
  const f = fixture();
  const { openCaptureJournal, sha256Of } =
    await import("../../../src/pi/capture/journal.ts");
  const { PrivateInspection } =
    await import("../../../src/pi/capture/private-inspection.ts");
  const authority = createPrivateInspection(f.options);
  await register(authority);
  const journal = openCaptureJournal(
    join(f.source, "capture"),
    "checkpoint-run",
  );
  journal.capture({
    type: "run.start",
    scope: { runId: "checkpoint-run" },
    runKind: "coding",
    sourceRevision: "synthetic",
    route: "openai",
    pricing: "subscription",
  });
  journal.close();
  const rawJournal = readFileSync(join(f.source, "capture/events.jsonl"));
  mkdirSync(join(f.root, "backup"), { mode: 0o700 });
  const native = join(f.root, "backup/detached.sqlite");
  writeFileSync(native, "synthetic detached backup", { mode: 0o600 });
  const receipt = await authority.snapshotForNative({
    nativeDatabase: native,
    nativeSha256: sha256Of(readFileSync(native)),
    runId: "checkpoint-run",
    journal: join(f.source, "capture"),
    rawJournalSha256: sha256Of(rawJournal),
  });
  const directory = authority.checkpointDirectory(receipt);
  authority.close();
  f.ownership.release();
  rmSync(f.source, { recursive: true });
  const open = () =>
    PrivateInspection.openCaptureCheckpoint({
      directory,
      receipt,
      runId: "checkpoint-run",
      journalSha256: sha256Of(rawJournal),
    });
  expect(() =>
    PrivateInspection.openCaptureCheckpoint({
      directory,
      receipt,
      runId: "checkpoint-run",
      journalSha256: "0".repeat(64),
    }),
  ).toThrow();
  const { Database } = await import("bun:sqlite");
  const lock = new Database(join(directory, "authority.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE");
    expect(open).toThrow("credential authority is busy; retry later");
  } finally {
    lock.exec("ROLLBACK");
    lock.close();
  }
  const first = open(),
    second = open();
  try {
    const inspect = (held: typeof first) =>
      held.inspectSources({
        sources: [{ kind: "text", text: "synthetic-original" }],
        requiredEpochs: ["original"],
        budget: new InspectionBudget(),
      });
    const results = await Promise.all([inspect(first), inspect(second)]);
    expect(results.map((result) => result.status)).toEqual([
      "inspected",
      "inspected",
    ]);
    for (const result of results)
      if (result.status === "inspected")
        expect(result.results[0]).toMatchObject({
          status: "complete",
          matches: expect.arrayContaining([
            expect.objectContaining({ epoch: "original" }),
          ]),
        });
    expect(existsSync(f.source)).toBe(false);
  } finally {
    first.close();
    second.close();
  }
});
