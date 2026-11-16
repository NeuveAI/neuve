import { gzipSync } from "node:zlib";

/** One tar entry for a crafted archive: a file by default, or another type with a link name. */
export interface TarEntry {
  readonly path: string;
  readonly content?: string | Uint8Array;
  /** The ustar type flag: "0" file, "5" folder, "1" hard link, "2" symlink, "3" device. */
  readonly type?: string;
  readonly linkname?: string;
}

const header = (entry: TarEntry, size: number) => {
  const block = new Uint8Array(512);
  const put = (at: number, length: number, value: string) => {
    const bytes = new TextEncoder().encode(value);
    block.set(bytes.subarray(0, length), at);
  };
  put(0, 100, entry.path);
  put(100, 8, "0000644\0");
  put(108, 8, "0000000\0");
  put(116, 8, "0000000\0");
  put(124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, 12, "00000000000\0");
  put(156, 1, entry.type ?? "0");
  put(157, 100, entry.linkname ?? "");
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  for (let i = 148; i < 156; i++) block[i] = 32;
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
};

/** A gzipped tar of `entries`, every path as given (npm archives put them under `package/`). */
export const tarGz = (entries: ReadonlyArray<TarEntry>) => {
  const parts: Array<Uint8Array> = [];
  for (const entry of entries) {
    const content =
      typeof entry.content === "string"
        ? new TextEncoder().encode(entry.content)
        : (entry.content ?? new Uint8Array());
    parts.push(header(entry, content.byteLength));
    parts.push(content);
    const pad = (512 - (content.byteLength % 512)) % 512;
    parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const tar = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    tar.set(part, at);
    at += part.byteLength;
  }
  return new Uint8Array(gzipSync(tar));
};

/** npm's integrity notation for bytes. */
export const integrityOf = (bytes: Uint8Array) =>
  `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
