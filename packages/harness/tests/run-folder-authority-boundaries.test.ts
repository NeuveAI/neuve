// Real filesystem and SQLite faults cross the attempt's onClose and removal, including the retry bound.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "real-authority-close-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const run = async (mode: string, fault: string) => {
  const directory = join(root, `${mode}-${fault}`);
  mkdirSync(directory, { recursive: true });
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/authority-close-boundary.ts"),
      directory,
      mode,
      fault,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: directory,
        TMPDIR: directory,
        NEUVE_MODE: "check",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code, error).toBe(0);
  return JSON.parse(out);
};
for (const mode of ["attempt", "remove"])
  for (const fault of ["EMFILE", "SQLITE_IOERR", "SQLITE_FULL", "DIR_SYNC"])
    test(`${mode}: checkpoint ${fault} ${mode === "attempt" ? "keeps a fresh budget for each attempt capture" : "requires three failures and the same capture age before refusal"}`, async () => {
      const result = await run(mode, fault);
      expect(result.outcomes).toEqual(
        mode === "attempt"
          ? [
              { ok: false, source: true, filed: 0 },
              { ok: false, source: true, filed: 0 },
              { ok: false, source: true, filed: 0 },
            ]
          : [
              { ok: false, source: true, filed: 0 },
              { ok: false, source: true, filed: 0 },
              { ok: true, source: false, filed: 1 },
            ],
      );
      expect(result.leftovers).toEqual([]);
      if (mode === "attempt") expect(result.status).toBeUndefined();
      else {
        expect(result.status).toBe("refused");
        expect(result.unscannable).toBe(
          "historical credential authority is unavailable; source retained privately, export refused",
        );
      }
    }, 120000);
for (const fault of ["empty", "garbage"])
  test(`remove: ${fault} authority files an immediate refusal and later closes do not block`, async () => {
    const result = await run("remove", fault);
    expect(result.outcomes).toEqual([
      { ok: true, source: false, filed: 1 },
      { ok: true, source: false, filed: 1 },
      { ok: true, source: false, filed: 1 },
    ]);
    expect(result.status).toBe("refused");
  }, 120000);

for (const fault of ["OPEN_EMFILE", "OPEN_EIO"])
  test(`remove: real authority ${fault} retries twice then files a refusal`, async () => {
    const result = await run("remove", fault);
    expect(result.outcomes).toEqual([
      { ok: false, source: true, filed: 0 },
      { ok: false, source: true, filed: 0 },
      { ok: true, source: false, filed: 1 },
    ]);
    expect(result.status).toBe("refused");
  }, 120000);

test("EMFILE on closes 1, 2 and 4 does not spend the new capture's retry budget", async () => {
  const result = await run("reset", "EMFILE");
  expect(result.outcomes).toEqual([
    { ok: false, source: true, filed: 0 },
    { ok: false, source: true, filed: 0 },
    { ok: true, source: true, filed: 1 },
    { ok: false, source: true, filed: 1 },
  ]);
  expect(result.counters[2]).toBeNull();
  expect(result.counters[3].failures).toBe(1);
  expect(result.unscannable).toBeNull();
  expect(result.status).toBe("clean");
}, 120000);

for (const mode of ["attempt", "remove"])
  for (const fault of ["COUNT_EMFILE", "COUNT_ENOSPC"])
    test(`${mode}: an old folder and unavailable retry metadata retain the capture`, async () => {
      const result = await run(mode, fault);
      expect(result.outcomes).toEqual(
        Array.from({ length: 3 }, () => ({
          ok: false,
          source: true,
          filed: 0,
        })),
      );
      expect(result.publicFailures.length).toBe(3);
      expect(JSON.stringify(result.visibleFailures)).not.toContain(
        "PRIVATE-AUTHORITY-PATH",
      );
      expect(JSON.stringify(result.publicFailures)).not.toContain(
        "PRIVATE-AUTHORITY-PATH",
      );
      expect(
        result.publicFailures.every(
          (reason: string) =>
            reason === "EMFILE" ||
            reason === "capture close failed (private details suppressed)",
        ),
      ).toBe(true);
      if (mode === "attempt") expect(result.closeCalls).toBe(3);
      expect(result.status).toBeUndefined();
    }, 120000);
