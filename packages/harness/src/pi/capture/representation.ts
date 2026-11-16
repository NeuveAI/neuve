import { MIMEType } from "node:util";

export const ARTIFACT_TEXT_POLICY = "declared-text-encoding-v1";

export type ArtifactSource = {
  readonly mediaType: string;
  readonly bytes: Uint8Array;
};
type Encoding = "utf-8" | "utf-16le" | "utf-16be";
export type ArtifactRepresentation =
  | { readonly _tag: "Binary" }
  | { readonly _tag: "Malformed"; readonly reason: string }
  | {
      readonly _tag: "Text";
      readonly text: string;
      readonly json: boolean;
      readonly encoding: Encoding;
      readonly bom: Uint8Array;
    };

const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const TYPE = new RegExp(`^${TOKEN}/${TOKEN}$`);
const PARAMETER = new RegExp(
  `^;[\\t ]*(${TOKEN})[\\t ]*=[\\t ]*(\"(?:[\\t !#-\\[\\]-~]|\\\\[\\t -~])*\"|${TOKEN})[\\t ]*`,
);

/** MIME parsing is forgiving; admission also requires complete, unambiguous parameters. */
export const artifactRepresentation = ({
  mediaType,
  bytes,
}: ArtifactSource): ArtifactRepresentation => {
  try {
    const declaration = mediaType.trim();
    const split = declaration.indexOf(";");
    const essence = (
      split < 0 ? declaration : declaration.slice(0, split)
    ).trim();
    if (!TYPE.test(essence)) throw new Error("invalid media type");
    let remaining = split < 0 ? "" : declaration.slice(split);
    const names = new Set<string>();
    while (remaining.length > 0) {
      const parameter = PARAMETER.exec(remaining);
      if (parameter === null) throw new Error("malformed media parameter");
      const name = parameter[1]!.toLowerCase();
      if (names.has(name)) throw new Error("duplicate media parameter");
      names.add(name);
      remaining = remaining.slice(parameter[0].length);
    }
    const mime = new MIMEType(declaration);
    const json = /^application\/(?:[\w.-]+\+)?json$/.test(mime.essence);
    const charset = mime.params.get("charset");
    if (!json && mime.type !== "text") {
      if (charset !== null) throw new Error("charset on non-text media type");
      return { _tag: "Binary" };
    }
    const bomEncoding =
      bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
        ? "utf-8"
        : bytes[0] === 0xff && bytes[1] === 0xfe
          ? "utf-16le"
          : bytes[0] === 0xfe && bytes[1] === 0xff
            ? "utf-16be"
            : undefined;
    const decoder = new TextDecoder(charset ?? bomEncoding ?? "utf-8", {
      fatal: true,
      ignoreBOM: true,
    });
    const encoding = decoder.encoding;
    if (
      encoding !== "utf-8" &&
      encoding !== "utf-16le" &&
      encoding !== "utf-16be"
    )
      throw new Error("unsupported text encoding");
    if (bomEncoding !== undefined && bomEncoding !== encoding)
      throw new Error("BOM contradicts declared charset");
    const bom = bytes.slice(
      0,
      bomEncoding === undefined ? 0 : encoding === "utf-8" ? 3 : 2,
    );
    return {
      _tag: "Text",
      json,
      encoding,
      bom,
      text: decoder.decode(bytes.subarray(bom.length)),
    };
  } catch {
    return {
      _tag: "Malformed",
      reason: "invalid or unsupported artifact text representation",
    };
  }
};

/** Preserve the declared representation, including byte order and its original BOM. */
export const encodeArtifactText = (
  text: string,
  representation: Extract<ArtifactRepresentation, { _tag: "Text" }>,
): Uint8Array => {
  let body: Uint8Array;
  if (representation.encoding === "utf-8")
    body = new TextEncoder().encode(text);
  else {
    body = new Uint8Array(text.length * 2);
    const view = new DataView(body.buffer);
    for (let i = 0; i < text.length; i++)
      view.setUint16(
        i * 2,
        text.charCodeAt(i),
        representation.encoding === "utf-16le",
      );
  }
  const bytes = new Uint8Array(representation.bom.length + body.length);
  bytes.set(representation.bom);
  bytes.set(body, representation.bom.length);
  return bytes;
};
