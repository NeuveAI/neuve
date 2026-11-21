// Why: a lane reads a Codex chat's protocol log from its channel's folder, so the file must be
// where the name says, readable by its owner only, and keep each session's lines apart when
// chats run at once. A write that fails must be reported, once, and never break the session.
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountName } from "@neuve/runtime";
import { protocolLogs } from "../src/runtimes.ts";

const codex = AccountName.parse("codex");
const entry = (n: number) => ({
  at: "2026-11-21T12:00:00Z",
  direction: "in" as const,
  message: { id: n },
});

test("each session's lines go to the account's file in the channel's folder, owner only, labelled by session", () => {
  const folder = mkdtempSync(join(tmpdir(), "protocol-logs-"));
  try {
    const logs = protocolLogs(folder, () => {
      throw new Error("no failure expected");
    });
    const first = logs(codex);
    const second = logs(codex);
    first(entry(1));
    second(entry(2));
    first(entry(3));
    const path = join(folder, "codex-protocol.jsonl");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const lines = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { session: string; message: unknown });
    expect(lines.map((line) => line.message)).toEqual([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    expect(lines[0]!.session).toBe(lines[2]!.session);
    expect(lines[0]!.session).not.toBe(lines[1]!.session);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a folder that cannot be written is reported once per session, and the session goes on", () => {
  const root = mkdtempSync(join(tmpdir(), "protocol-logs-"));
  try {
    const folder = join(root, "not-a-folder");
    writeFileSync(folder, "");
    const reported: string[] = [];
    const sink = protocolLogs(folder, (path) => reported.push(path))(codex);
    expect(() => {
      sink(entry(1));
      sink(entry(2));
    }).not.toThrow();
    expect(reported).toEqual([join(folder, "codex-protocol.jsonl")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
