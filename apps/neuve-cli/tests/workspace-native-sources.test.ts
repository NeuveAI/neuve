import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  SourceOwnership,
  openManagedCredentialInspection,
  privateInspectionDirectory,
} from "@neuve/harness/coding";
import { nativeSourceExportState } from "@neuve/harness/native-source-authority";
import { PI_TRANSITION_STORAGE_PROFILE } from "../../../scripts/pi-storage.ts";
import { workspaceNativeSources } from "../src/workspace-native-sources.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workspace-native-source-"));
  roots.push(root);
  const paths = {
    ...PI_TRANSITION_STORAGE_PROFILE.paths,
    state: join(root, "state"),
    captures: join(root, "captures"),
    tmp: join(root, "tmp"),
  };
  const source = join(paths.state, "channel");
  for (const path of [source, paths.captures, paths.tmp])
    mkdirSync(path, { recursive: true });
  const file = join(root, "source-input.json");
  const bytes = JSON.stringify({ fixture: "noncredential imported input" });
  writeFileSync(file, bytes);
  return {
    paths,
    source,
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    nativeDatabase: join(source, "channel.sqlite"),
  };
}

test("trusted source creation holds ownership through real native close and retains its export fence", async () => {
  const at = fixture();
  const lease = await workspaceNativeSources({ paths: at.paths }).prepare({
    channel: "0123456789abcdef",
    stateDirectory: at.source,
    nativeDatabase: at.nativeDatabase,
    origin: { kind: "seed", file: at.file, sha256: at.sha256 },
  });
  expect(existsSync(at.nativeDatabase)).toBe(false);
  expect(() => SourceOwnership.acquire(at.source)).toThrow();
  const native = await openNodeSqliteStorage(at.nativeDatabase);
  await native.close(BACKGROUND_CONTEXT);
  await lease.close();
  await lease.close();
  const owner = SourceOwnership.acquire(at.source);
  try {
    const authority = openManagedCredentialInspection({
      ownership: owner,
      source: at.source,
      directory: privateInspectionDirectory(at.source, dirname(at.paths.state)),
      journal: join(at.source, "capture"),
      nativeDatabase: at.nativeDatabase,
      excludedRoots: [at.paths.state, at.paths.captures, at.paths.tmp],
    });
    try {
      expect(nativeSourceExportState(authority)).toEqual({
        kind: "uncertified-import",
      });
    } finally {
      authority.close();
    }
  } finally {
    owner.release();
  }
});

test("a rejected source digest releases ownership without creating native storage", async () => {
  const at = fixture();
  await expect(
    workspaceNativeSources({ paths: at.paths }).prepare({
      channel: "fedcba9876543210",
      stateDirectory: at.source,
      nativeDatabase: at.nativeDatabase,
      origin: { kind: "seed", file: at.file, sha256: "0".repeat(64) },
    }),
  ).rejects.toThrow();
  expect(existsSync(at.nativeDatabase)).toBe(false);
  const owner = SourceOwnership.acquire(at.source);
  owner.release();
});
