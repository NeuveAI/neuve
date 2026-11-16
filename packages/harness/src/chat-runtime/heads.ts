import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ContinuationIdentity } from "@neuve/runtime";
import { preserveUnknown, safeRead } from "@neuve/records-schema";
import { resumeFailed } from "./failure.ts";

const Head = z.strictObject({
  session: z.string(),
  resumePoint: z.string().optional(),
  forkedFrom: z
    .strictObject({ session: z.string(), resumePoint: z.string() })
    .optional(),
  digest: z.string(),
  completed: z.literal(true).optional(),
  // The input prefix at a native receipt, including when pi has not published its assistant yet.
  checkpointThrough: z.string().optional(),
  // Read legacy steer metadata; recovery uses pre-input receipts or completed pointers.
  steers: z.array(z.string()).optional(),
  // Every offered input keeps its pre-input point until a completed turn proves storage.
  inputs: z
    .array(
      z.strictObject({
        kind: z.enum(["message", "steer", "result"]),
        through: z.string(),
        before: z
          .strictObject({
            session: z.string(),
            resumePoint: z.string(),
            digest: z.string(),
          })
          .optional(),
      }),
    )
    .optional(),
  // Read legacy files; acceptance-based delivery never authorizes continuation.
  deliveredThrough: z.string().optional(),
  forkRequired: z.literal(true).optional(),
  pending: z.literal(true).optional(),
  continuation: ContinuationIdentity.optional(),
  previousDigest: z.string().optional(),
});
type StoredHead = { raw: unknown; text: string } & (
  { kind: "known"; value: z.infer<typeof Head> } | { kind: "refused" }
);

// JSON.parse has already validated the object. Retain entry slices, including number
// spellings and string escapes, so another chat's write cannot alter a refused entry.
function headTexts(json: string) {
  const texts = new Map<string, string>();
  let depth = 0;
  let owner = "";
  let start = 0;
  let entryStart = 0;
  for (const token of json.matchAll(/"(?:\\.|[^"\\])*"|[{}[\],:]/g)) {
    const text = token[0];
    if (depth === 1) {
      if (text === ":") start = token.index + 1;
      else if ((text === "," || text === "}") && start) {
        texts.set(owner, json.slice(entryStart, token.index));
        start = 0;
        entryStart = token.index + 1;
      } else if (!start && text.startsWith('"'))
        owner = z.string().parse(JSON.parse(text));
    }
    if (text === "{" || text === "[") {
      if (depth === 0) entryStart = token.index + 1;
      depth++;
    } else if (text === "}" || text === "]") depth--;
  }
  return texts;
}

export class NativeHeads {
  private readonly values = new Map<string, StoredHead>();
  private writing = Promise.resolve();
  private constructor(private readonly directory?: string) {}
  private get source() {
    return this.directory
      ? join(this.directory, "native-heads.json")
      : "native-heads.json";
  }
  static async open(directory?: string) {
    const heads = new NativeHeads(directory);
    if (directory) {
      try {
        const json = await readFile(heads.source, "utf8");
        const stored = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(json));
        const texts = headTexts(json);
        for (const [owner, raw] of Object.entries(stored)) {
          const read = safeRead(Head, raw, { source: heads.source });
          const original = { raw, text: texts.get(owner)! };
          if (!read.success) {
            heads.values.set(owner, { ...original, kind: "refused" });
            continue;
          }
          const head = read.data;
          // Older heads did not mark input delivery, so their native suffix is unproven.
          if (!head.continuation || head.previousDigest === undefined)
            head.pending = true;
          heads.values.set(owner, { ...original, kind: "known", value: head });
        }
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          throw error;
      }
    }
    return heads;
  }
  get(owner: string) {
    const head = this.values.get(owner);
    return head?.kind === "known" ? head.value : undefined;
  }
  isRefused(owner: string) {
    return this.values.get(owner)?.kind === "refused";
  }
  async set(owner: string, head: z.infer<typeof Head>): Promise<void> {
    const stored = this.values.get(owner);
    if (stored?.kind === "refused") throw new Error(resumeFailed);
    let raw: unknown;
    try {
      raw = stored
        ? preserveUnknown(Head, stored.raw, head, { source: this.source })
        : Head.parse(head);
    } catch (error) {
      if (!stored) throw error;
      this.values.set(owner, {
        raw: stored.raw,
        text: stored.text,
        kind: "refused",
      });
      throw new Error(resumeFailed);
    }
    this.values.set(owner, {
      kind: "known",
      value: head,
      raw,
      text: `${JSON.stringify(owner)}:${JSON.stringify(raw)}`,
    });
    return this.write();
  }
  async restore(
    owner: string,
    expected: z.infer<typeof Head>,
    previous: z.infer<typeof Head> | undefined,
  ): Promise<void> {
    if (this.isRefused(owner)) throw new Error(resumeFailed);
    if (this.get(owner) !== expected) return;
    if (previous) return this.set(owner, previous);
    this.values.delete(owner);
    return this.write();
  }
  private write(): Promise<void> {
    const directory = this.directory;
    if (!directory) return Promise.resolve();
    const snapshot = `{${[...this.values.values()].map((head) => head.text).join(",")}}`;
    const write = this.writing.then(async () => {
      await mkdir(directory, { recursive: true });
      const path = join(directory, "native-heads.json");
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, path);
    });
    this.writing = write.catch(() => {});
    return write;
  }
  async close() {
    await this.writing;
  }
}
