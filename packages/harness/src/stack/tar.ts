import { Data } from "effect";
import { CollisionCheck, cleanPath, pathRefusal } from "./paths.ts";

/**
 * A reader for the published archives of registries (npm's `.tgz`): gzip, then tar in its ustar,
 * pax and GNU long-name forms. It is Neuve's own so every rule of SC7 is applied before a byte is
 * written: only regular files and folders are accepted; links, devices and FIFOs refuse the
 * archive, as do the path rules in `paths.ts`. Nothing in an archive is ever run.
 */

export class ArchiveRefused extends Data.TaggedError("ArchiveRefused")<{
  readonly message: string;
  readonly reason:
    | "path"
    | "collision"
    | "link-or-device"
    | "unsupported-entry"
    | "malformed"
    | "over-cap"
    | "too-many-entries";
}> {}

export interface ArchiveFile {
  /** Relative to the archive's single top folder (npm's `package/`), cleaned. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ArchiveLimits {
  /** The files' bytes in total. */
  readonly maxBytes: number;
  readonly maxEntries: number;
}

const decoder = new TextDecoder();

const text = (block: Uint8Array, at: number, length: number) => {
  const slice = block.subarray(at, at + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
};

/** A numeric header field: octal text, or GNU base-256 when its first byte has the high bit set. */
const number = (block: Uint8Array, at: number, length: number) => {
  const first = block[at] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + (block[at + i] ?? 0);
    return value;
  }
  const raw = text(block, at, length).trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/.test(raw))
    throw new ArchiveRefused({
      message: `a header field is not octal: ${JSON.stringify(raw)}`,
      reason: "malformed",
    });
  return Number.parseInt(raw, 8);
};

const checksumOk = (block: Uint8Array) => {
  const stored = number(block, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++)
    sum += i >= 148 && i < 156 ? 32 : (block[i] ?? 0);
  return sum === stored;
};

/** Pax extended header records: `<length> <key>=<value>\n`. */
const paxRecords = (bytes: Uint8Array) => {
  const out = new Map<string, string>();
  let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(decoder.decode(bytes.subarray(at, space)));
    if (!Number.isInteger(length) || length <= 0 || at + length > bytes.length)
      throw new ArchiveRefused({
        message: "a pax header record is malformed",
        reason: "malformed",
      });
    const record = decoder.decode(bytes.subarray(space + 1, at + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) out.set(record.slice(0, equals), record.slice(equals + 1));
    at += length;
  }
  return out;
};

/**
 * Gunzips `compressed`, stopping once the tar stream passes the files' cap plus its own headers and
 * padding, so an archive cannot expand without bound in memory.
 */
export const gunzipBounded = async (
  compressed: Uint8Array,
  limits: ArchiveLimits,
): Promise<Uint8Array> => {
  // Headers and padding are at most 1,024 bytes per entry beyond the files' own bytes.
  const streamCap = limits.maxBytes + limits.maxEntries * 1024 + 1024 * 1024;
  const stream = new Blob([compressed as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const parts: Array<Uint8Array> = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > streamCap)
        throw new ArchiveRefused({
          message: `the archive expands past ${streamCap} bytes`,
          reason: "over-cap",
        });
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof ArchiveRefused) throw error;
    throw new ArchiveRefused({
      message: `the archive is not valid gzip: ${String(error).slice(0, 200)}`,
      reason: "malformed",
    });
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

/**
 * The regular files of a tar stream under its single top folder, after every rule is checked.
 * Throws `ArchiveRefused` on the first violation; a refused archive writes nothing.
 */
export const readTar = (
  tar: Uint8Array,
  limits: ArchiveLimits,
): ReadonlyArray<ArchiveFile> => {
  const files: Array<ArchiveFile> = [];
  const collisions = new CollisionCheck();
  let at = 0;
  let total = 0;
  let entries = 0;
  let longName: string | undefined;
  let pax = new Map<string, string>();
  let top: string | undefined;
  while (at + 512 <= tar.length) {
    const block = tar.subarray(at, at + 512);
    if (block.every((byte) => byte === 0)) break;
    if (!checksumOk(block))
      throw new ArchiveRefused({
        message: `a header checksum does not match at byte ${at}`,
        reason: "malformed",
      });
    const type = String.fromCharCode(block[156] ?? 0);
    const size = number(block, 124, 12);
    const dataStart = at + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length)
      throw new ArchiveRefused({
        message: "an entry runs past the end of the archive",
        reason: "malformed",
      });
    const data = tar.subarray(dataStart, dataEnd);
    at = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = paxRecords(data);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = text(data, 0, data.length);
      continue;
    }
    entries++;
    if (entries > limits.maxEntries)
      throw new ArchiveRefused({
        message: `the archive has more than ${limits.maxEntries} entries`,
        reason: "too-many-entries",
      });
    // POSIX ustar ("ustar\0" "00") keeps a path prefix at 345; old GNU tar ("ustar  \0") keeps
    // other fields there, and its long names come as "L" entries instead.
    const posix =
      decoder.decode(block.subarray(257, 263)) === "ustar\0" &&
      decoder.decode(block.subarray(263, 265)) === "00";
    const prefix = posix ? text(block, 345, 155) : "";
    const ustarName =
      prefix !== "" ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100);
    const raw = pax.get("path") ?? longName ?? ustarName;
    const entrySize = pax.has("size") ? Number(pax.get("size")) : size;
    pax = new Map();
    longName = undefined;
    if (entrySize !== size)
      throw new ArchiveRefused({
        message: `${raw}: the pax size disagrees with the header`,
        reason: "malformed",
      });
    if (
      type === "1" ||
      type === "2" ||
      type === "3" ||
      type === "4" ||
      type === "6"
    )
      throw new ArchiveRefused({
        message: `${raw} is a link, device or FIFO`,
        reason: "link-or-device",
      });
    if (type !== "0" && type !== "\0" && type !== "7" && type !== "5")
      throw new ArchiveRefused({
        message: `${raw} has entry type ${JSON.stringify(type)}, which is not read`,
        reason: "unsupported-entry",
      });
    const refusal = pathRefusal(raw.replace(/\/+$/, "") || raw);
    if (refusal !== undefined)
      throw new ArchiveRefused({
        message: `${raw}: refused (${refusal})`,
        reason: "path",
      });
    const cleaned = cleanPath(raw);
    const [first = "", ...rest] = cleaned.split("/");
    top ??= first;
    if (first !== top)
      throw new ArchiveRefused({
        message: `${raw} is outside the archive's top folder ${top}`,
        reason: "path",
      });
    if (type === "5" || rest.length === 0) continue;
    const path = rest.join("/");
    const collision = collisions.add(path);
    if (collision !== undefined)
      throw new ArchiveRefused({ message: collision, reason: "collision" });
    total += size;
    if (total > limits.maxBytes)
      throw new ArchiveRefused({
        message: `the files pass ${limits.maxBytes} bytes`,
        reason: "over-cap",
      });
    files.push({ path, bytes: data });
  }
  return files;
};
