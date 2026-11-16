// Why: hooks write the spool and the worker parses it later (D18), so the line format is a contract
// between two processes and two builds. A written line must parse back to the same event, the
// parser must refuse partial, doubled or misnamed files, and temporary files are removed only when
// the process that wrote them is gone and was in this process table: a containerized writer's PID
// means nothing here, and removing its live temporary would lose its event.
import { afterAll, expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Effect } from "effect";
import { RecordEvent } from "@neuve/records-schema";
import { Spool, mintUlid } from "../src/index.ts";
import {
  commitEvent,
  freshLocation,
  runFs,
  removeTemporaryDirectories,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

test("a spooled event parses back unchanged; malformed spool files are refused", async () => {
  const event = RecordEvent.parse(commitEvent("9".repeat(40)));
  const path = await runFs(Spool.writeSpoolLine(freshLocation().spool, event));
  const text = await readFile(path, "utf8");
  const file = basename(path);

  expect(await Effect.runPromise(Spool.parseSpoolLine(file, text))).toEqual({
    spool: 1,
    event,
  });

  const refuse = (name: string, body: string) =>
    Effect.runPromise(Effect.flip(Spool.parseSpoolLine(name, body)));
  expect((await refuse(file, text.trimEnd()))._tag).toBe("InvalidSpoolLine");
  expect((await refuse(file, text + text))._tag).toBe("InvalidSpoolLine");
  expect(
    (await refuse(join("x", "01ARZ3NDEKTSV4RRFFQ69G5FAV.json"), text))._tag,
  ).toBe("InvalidSpoolLine");
  expect(
    (await refuse(file, text.replace('"spool":1', '"spool":2')))._tag,
  ).toBe("SpoolHeldByNewerBuild");
});

test("stale temporaries are removed only for this process table's exited writers", async () => {
  const spool = freshLocation().spool;
  const exited = Bun.spawn(["true"]);
  await exited.exited;
  const own = Spool.writerToken();
  const stale = `.${mintUlid()}.${own}.${exited.pid}.tmp`;
  const live = `.${mintUlid()}.${own}.${process.pid}.tmp`;
  // A writer in a container: another host name or PID namespace, so its PID cannot be checked here.
  const foreign = `.${mintUlid()}.${Spool.writerToken("container", "pid:[4026532201]")}.${exited.pid}.tmp`;
  await runFs(
    Spool.writeSpoolLine(spool, RecordEvent.parse(commitEvent("8".repeat(40)))),
  );
  for (const name of [stale, live, foreign])
    await writeFile(join(spool, name), "partial");

  expect(await runFs(Spool.removeStaleTemporaries(spool))).toEqual([stale]);
  expect(
    (await readdir(spool)).filter((name) => name.endsWith(".tmp")).sort(),
  ).toEqual([live, foreign].sort());
});
