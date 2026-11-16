import type { ScanFailureKind } from "./scan-failure.ts";
import {
  artifactRepresentation,
  type ArtifactSource,
} from "./representation.ts";
import { z } from "zod";
import { Data } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type {
  Storage,
  Cursor,
  Page,
  DocumentRecord,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPrivateCopy } from "@neuve/records-core/read-only";
import { StoredDocument, CloseMode, PriceRate } from "./dump.ts";
import { Json } from "./types.ts";

export class DumpFailed extends Data.TaggedError("DumpFailed")<{
  readonly reason: string;
  readonly failureKind?: ScanFailureKind | undefined;
}> {
  override get message() {
    return this.reason;
  }
}
export type NativeReads = Pick<
  Storage,
  | "scanConversations"
  | "scanEntries"
  | "scanTasks"
  | "scanDocuments"
  | "document"
> & {
  /** Present on harness-owned SQLite storage; used only after pi stops writing. */
  readonly captureBackup?: (
    limit: number,
  ) => ReturnType<typeof import("./build.ts").backupOnConnection>;
};
const Id = z.int().nonnegative();
const Edge = z.strictObject({ conversationId: Id, at: Id });
const Owner = z.strictObject({ conversationId: Id, taskId: Id });
const NativeRecord = z.strictObject({
  id: Id,
  parent: Edge.optional(),
  owner: Owner.optional(),
});
const NativeEntry = z
  .object({
    id: Id,
    conversationId: Id,
    kind: z.string(),
    byTaskId: Id.optional(),
    head: Id.optional(),
    model: z.array(Json).optional(),
    data: Json.optional(),
  })
  .catchall(Json);
const NativeTask = z
  .object({
    id: Id,
    conversationId: Id,
    kind: z.string(),
    owner: Id.optional(),
    state: z.object({ status: z.string() }).catchall(Json),
  })
  .catchall(Json);
export const NativeSnapshot = z.strictObject({
  conversations: z.array(
    z.strictObject({
      id: Id,
      record: NativeRecord,
      entries: z.array(NativeEntry),
      tasks: z.array(NativeTask),
      documents: z.array(StoredDocument),
      taskDocuments: z.array(
        z.strictObject({ taskId: Id, documents: z.array(StoredDocument) }),
      ),
    }),
  ),
  session: z.array(StoredDocument),
});
export type NativeSnapshot = z.infer<typeof NativeSnapshot>;
export type NativeConversation = NativeSnapshot["conversations"][number];
export const ProjectionRecipe = z.strictObject({
  version: z.literal(1),
  maskVersion: z.literal(1),
  sourceValidationVersion: z
    .union([
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
    ])
    .optional(),
  tornLines: z.int().nonnegative(),
  declared: z.array(z.string()).max(256),
  close: CloseMode.nullable(),
  rate: PriceRate.nullable(),
});
export type ProjectionRecipe = z.infer<typeof ProjectionRecipe>;
export const RECIPE_FILE = "source/projection.json";
export const encode = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);
const PAGE = 256;
const scanAll = async <T>(
  page: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>,
) => {
  const items: Array<T> = [];
  let cursor: Cursor | undefined;
  do {
    const next = await page(cursor);
    items.push(...next.items);
    cursor = next.next;
  } while (cursor !== undefined);
  return items;
};

const parse = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new DumpFailed({
      reason: `${what}: ${parsed.error.issues[0]?.message ?? "unexpected shape"}`,
    });
  return parsed.data;
};

/** A record pi handed over, checked as JSON before it enters the dump. */
const asJson = (value: unknown, what: string): Json =>
  parse(Json, value, `${what} is not JSON`);

/** Everything pi holds for the run, read once through its public scans. */
export const readNative = async (reads: NativeReads, context: Context) => {
  const documentsIn = async (scope: DocumentRecord["scope"]) =>
    Promise.all(
      (
        await scanAll((cursor) =>
          reads.scanDocuments({ scope, at: "current" }, PAGE, cursor, context),
        )
      ).map(async (record) => {
        const stored = await reads.document(record.id, "current", context);
        if (stored === undefined)
          throw new DumpFailed({
            reason: `document ${record.id} (${record.kind}) did not read back`,
          });
        return {
          kind: record.kind,
          ...(record.key === undefined ? {} : { key: record.key }),
          version: stored.version,
          value: asJson(stored.value, `document ${record.kind}`),
        };
      }),
    );
  const conversations = [];
  for (const record of await scanAll((cursor) =>
    reads.scanConversations({}, PAGE, cursor, context),
  )) {
    const conversationId = record.id;
    const entries = (
      await scanAll((cursor) =>
        reads.scanEntries({ conversationId }, PAGE, cursor, context),
      )
    )
      .toReversed()
      .filter((entry) => entry.conversationId === conversationId);
    const tasks = await scanAll((cursor) =>
      reads.scanTasks({ conversationId }, PAGE, cursor, context),
    );
    conversations.push({
      id: conversationId,
      record,
      entries,
      tasks,
      documents: await documentsIn({ kind: "conversation", conversationId }),
      taskDocuments: await Promise.all(
        tasks.map(async (task) => ({
          taskId: task.id,
          documents: await documentsIn({ kind: "task", taskId: task.id }),
        })),
      ),
    });
  }
  return NativeSnapshot.parse({
    conversations,
    session: await documentsIn({ kind: "session" }),
  });
};

/** Only for a private, isolated copy whose complete pages came from SQLite's snapshot API. */
export const readBackup = async (
  bytes: Uint8Array,
): Promise<NativeSnapshot> => {
  const staging = await mkdtemp(join(tmpdir(), "neuve-capture-read-"));
  const path = join(staging, "pi.sqlite");
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    const database = openPrivateCopy(path);
    try {
      const integrity = database.prepare("PRAGMA quick_check").all();
      if (integrity.length !== 1 || integrity[0]?.["quick_check"] !== "ok")
        throw new Error("native backup failed SQLite integrity check");
      const version = database
        .prepare("SELECT version FROM durable_schema WHERE singleton = 1")
        .get();
      if (version?.["version"] !== 1)
        throw new Error("native backup has unsupported pi-durable schema");
      for (const table of [
        "durable_metadata",
        "record_ids",
        "conversations",
        "entries",
        "tasks",
        "submissions",
        "documents",
        "document_revisions",
      ])
        if (
          database
            .prepare(
              "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
            )
            .get(table) === undefined
        )
          throw new Error("native backup lacks pi-durable storage tables");
    } finally {
      database.close();
    }
    const storage = await openNodeSqliteStorage(path);
    try {
      return await readNative(storage, BACKGROUND_CONTEXT);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

export const retainedDeclarations = (
  declared: ReadonlyArray<string>,
  native: NativeSnapshot,
  lines: ReadonlyArray<unknown>,
  artifacts: ReadonlyArray<ArtifactSource>,
) => {
  const texts: Array<string> = [];
  const strings = (value: unknown): void => {
    if (typeof value === "string") {
      texts.push(value);
      if (/^\s*[[{"]/.test(value)) {
        try {
          const parsed: unknown = JSON.parse(value);
          if (typeof parsed !== "string" || parsed !== value) strings(parsed);
        } catch {}
      }
    } else if (Array.isArray(value)) value.forEach(strings);
    else if (value !== null && typeof value === "object")
      Object.values(value).forEach(strings);
  };
  strings(native);
  strings(lines);
  for (const artifact of artifacts) {
    const representation = artifactRepresentation(artifact);
    if (representation._tag === "Text") strings(representation.text);
  }
  return declared.filter(
    (value) => value.length >= 3 && texts.some((text) => text.includes(value)),
  );
};
