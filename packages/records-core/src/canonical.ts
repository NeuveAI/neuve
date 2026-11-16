import canonicalize from "canonicalize";

/** RFC 8785 (JCS) canonical JSON, via the RFC author's reference implementation. */
export const canonicalJson = (value: unknown): string => {
  const text = canonicalize(value);
  if (text === undefined)
    throw new TypeError("Value has no JSON representation");
  return text;
};

export const sha256Hex = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

export const sha256Bytes = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export const utf8Length = (text: string): number =>
  Buffer.byteLength(text, "utf8");
