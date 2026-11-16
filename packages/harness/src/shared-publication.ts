import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { Context } from "effect";
import { z } from "zod";
import { Computations } from "@neuve/records-core";
import type { SharedWorkTransport } from "@neuve/records-core/shared-work";
import {
  budgetDirectory,
  sharedWorkSocket,
  sharedWorkDelivery,
} from "@neuve/records-core/shared-work-socket";
import { safeRead } from "@neuve/records-schema";

export const PUBLICATION_MAX_BYTES = 128 * 2 ** 20;
export const PUBLICATION_RECORDS = 4;
export const PUBLICATION_MAGIC = Buffer.from("NPUB4\0");
const METADATA_MAX_BYTES = 16 * 2 ** 10;
export interface PublicationAuthority {
  readonly transport: SharedWorkTransport;
  readonly host: () => string | undefined;
  readonly status: (key: string) => ReturnType<typeof sharedWorkDelivery>;
}
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
const authorityFor = (scope: string): PublicationAuthority => {
  let host: string | undefined;
  return {
    transport: sharedWorkSocket({
      deliveryAcknowledgement: true,
      onHost: (value) => {
        host = value;
      },
    }),
    host: () => host,
    status: (key) => sharedWorkDelivery({ store: digest(scope), key }),
  };
};
export const PublicationPolicy = Context.Reference<{
  readonly maximumBytes: number;
  readonly maximumRecords: number;
  readonly authority: (scope: string) => PublicationAuthority;
}>("@neuve/harness/PublicationPolicy", {
  defaultValue: () => ({
    maximumBytes: PUBLICATION_MAX_BYTES,
    maximumRecords: PUBLICATION_RECORDS,
    authority: authorityFor,
  }),
});
export class PublicationTooLarge extends Error {
  constructor(
    readonly bytes: number,
    readonly maximum: number,
  ) {
    super(`Shared publication is ${bytes} bytes; limit is ${maximum}`);
  }
}
export class PublicationCapacity extends Error {
  constructor() {
    super("Shared publication storage is full of live keys");
  }
}
export class PublicationHostGone extends Error {
  constructor(readonly attemptId: string) {
    super("Publication host ended before delivery");
  }
}
class PartialPublication extends Error {}
const identity = z.string().regex(/^[a-f0-9]{64}$/);
const Header = z.object({
  version: z.literal(4),
  store: identity,
  key: identity,
  requestKey: z.string(),
  publication: z.uuid(),
  previous: z.uuid().nullable(),
  host: z.uuid(),
});
const Envelope = Header.extend({ value: z.unknown() });

/** The parts of a zod schema's definition the fit check reads. */
type Def = {
  readonly type: string;
  readonly checks?: ReadonlyArray<unknown>;
  readonly shape?: Readonly<Record<string, z.ZodType>>;
  readonly element?: z.ZodType;
  readonly keyType?: z.ZodType;
  readonly valueType?: z.ZodType;
  readonly innerType?: z.ZodType;
  readonly options?: ReadonlyArray<z.ZodType>;
  readonly discriminator?: string;
  readonly unionFallback?: boolean;
};
const defOf = (schema: z.ZodType) => schema._zod.def as unknown as Def;
const plain = (value: unknown, prototype: object) =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === prototype;
const denseArray = (value: ReadonlyArray<unknown>) => {
  for (let at = 0; at < value.length; at++) if (!(at in value)) return false;
  return Object.keys(value).length === value.length;
};
/**
 * The objects one fit check has met, in the value and in the parse's copies of its leaves. Weak, so
 * a copy made only to be compared is not kept alive by it.
 */
type Met = WeakSet<object>;
/**
 * False when `value` is an object this fit check met before. `serialize` writes an object reachable
 * from two places once and then points back to it, while the parse gives each place its own copy:
 * such a value is parsed, so its bytes and its size are those of the copy, as before.
 */
const firstMeeting = (value: unknown, met: Met) => {
  if (typeof value !== "object" || value === null) return true;
  if (met.has(value)) return false;
  met.add(value);
  return true;
};
/**
 * A typed array, a `DataView` or an `ArrayBuffer`: no object a walked field can reach is inside it,
 * so the parse handing it back as it is changes no byte.
 */
const opaque = (value: object) =>
  ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
/**
 * Equal in every byte `serialize` writes: the same primitives, prototypes, key order and entries,
 * and no object met twice. An object the parse hands back as it is (`z.unknown`, `z.any`,
 * `z.custom`, `z.instanceof`) is not walked, so an object inside it could also be reached from a
 * walked field, which the parse copies: unless it is opaque, it answers false.
 */
const same = (a: unknown, b: unknown, met: Met): boolean => {
  if (Object.is(a, b))
    return typeof b === "object" && b !== null
      ? opaque(b) && firstMeeting(b, met)
      : typeof b !== "function";
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (!firstMeeting(a, met) || !firstMeeting(b, met)) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return (
      a.length === b.length &&
      denseArray(a) &&
      denseArray(b) &&
      a.every((item, at) => same(item, b[at], met))
    );
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    const other = b.entries();
    for (const [key, item] of a) {
      const next = other.next().value as [unknown, unknown];
      // A key is a value `serialize` writes like any other: the parse's copy of it compares by
      // content, and one handed back as it is answers as any pass-through object does.
      if (!same(key, next[0], met) || !same(item, next[1], met)) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    const other = b.values();
    for (const item of a)
      if (!same(item, other.next().value, met)) return false;
    return true;
  }
  if (!plain(a, Object.prototype)) return false;
  const keys = Object.keys(a),
    others = Object.keys(b);
  return (
    keys.length === others.length &&
    keys.every(
      (key, at) =>
        key === others[at] &&
        same(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
          met,
        ),
    )
  );
};
/**
 * Whether `schema.parse(value)` would give `value` back exactly: valid, with no key stripped, added
 * or reordered, no default applied, nothing transformed, and no object reachable from two places
 * (the parse would copy it at each). Then `serialize` writes the same bytes for `value` as for its
 * parsed copy, so publishing `value` itself writes the file the parse would have, without making
 * that copy. Plain objects, arrays, maps and sets the schema declares without checks are walked
 * here, so only leaves are parsed; anything else, a refined container included, is parsed and
 * compared with its copy, so every refinement runs. Any doubt answers false, and the caller then
 * parses as before.
 */
export const fitsExactly = (schema: z.ZodType, value: unknown): boolean =>
  fits(schema, value, new WeakSet());
const fits = (schema: z.ZodType, value: unknown, met: Met): boolean => {
  const def = defOf(schema);
  if (!def.checks?.length) {
    // `.optional()` keeps `undefined` as it is only over a schema with no part in absence: over a
    // default or a prefault it substitutes that value, and `.exactOptional()` refuses `undefined`.
    if (def.type === "optional" && def.innerType)
      return value === undefined
        ? !(schema instanceof z.core.$ZodExactOptional) &&
            def.innerType._zod.optin === undefined
        : fits(def.innerType, value, met);
    if (def.type === "nullable" && def.innerType)
      return value === null || fits(def.innerType, value, met);
    if (def.type === "object" && def.shape && plain(value, Object.prototype)) {
      const shape = def.shape,
        record = value as Record<string, unknown>,
        names = Object.keys(shape),
        keys = Object.keys(record);
      // A symbol key in the shape is parsed too: `Object.keys` does not see it.
      if (
        keys.length === names.length &&
        keys.every((key, at) => key === names[at]) &&
        Object.getOwnPropertySymbols(shape).length === 0
      )
        return (
          firstMeeting(record, met) &&
          names.every((name) => {
            const field = shape[name]!;
            // A key present as undefined is kept only where the schema says optional.
            if (record[name] === undefined && defOf(field).type !== "optional")
              return false;
            return fits(field, record[name], met);
          })
        );
    }
    if (
      def.type === "array" &&
      def.element &&
      plain(value, Array.prototype) &&
      denseArray(value as ReadonlyArray<unknown>)
    ) {
      const element = def.element;
      return (
        firstMeeting(value, met) &&
        (value as ReadonlyArray<unknown>).every((item) =>
          fits(element, item, met),
        )
      );
    }
    if (
      def.type === "map" &&
      def.keyType &&
      def.valueType &&
      plain(value, Map.prototype)
    ) {
      if (!firstMeeting(value, met)) return false;
      for (const [key, item] of value as Map<unknown, unknown>)
        if (!fits(def.keyType, key, met) || !fits(def.valueType, item, met))
          return false;
      return true;
    }
    if (def.type === "set" && def.valueType && plain(value, Set.prototype)) {
      if (!firstMeeting(value, met)) return false;
      for (const item of value as Set<unknown>)
        if (!fits(def.valueType, item, met)) return false;
      return true;
    }
    // A discriminated union parses with the one option its discriminator's value names, so that
    // option alone decides; when not exactly one option names it, the union is parsed below.
    if (
      def.type === "union" &&
      def.discriminator !== undefined &&
      !def.unionFallback &&
      def.options &&
      plain(value, Object.prototype)
    ) {
      const tag = (value as Record<string, unknown>)[def.discriminator];
      const claims = def.options.map(
        (option) =>
          option._zod.propValues?.[def.discriminator!] as
            ReadonlySet<unknown> | undefined,
      );
      const named = def.options.filter((_, at) => claims[at]?.has(tag));
      if (claims.every((values) => values !== undefined) && named.length === 1)
        return fits(named[0]!, value, met);
    }
  }
  const parsed = schema.safeParse(value);
  return parsed.success && same(parsed.data, value, met);
};
/** Writes `parts` one after another into a new file, without joining them into one buffer. */
const writeParts = async (path: string, parts: ReadonlyArray<Uint8Array>) => {
  const file = await open(path, "w", 0o600);
  try {
    for (const part of parts)
      for (let at = 0; at < part.length;) {
        const { bytesWritten } = await file.write(part, at, part.length - at);
        at += bytesWritten;
      }
  } finally {
    await file.close();
  }
};
const absent = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const occupied = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "EEXIST" || error.code === "ENOTEMPTY");
const emptyDirectory = async (path: string) => {
  try {
    await rmdir(path);
  } catch (error) {
    if (!absent(error) && !occupied(error)) throw error;
  }
};
const uuidBytes = (uuid: string) =>
  Buffer.from(uuid.replaceAll("-", ""), "hex").toString("base64url");
const uuidFrom = (value: string | undefined) => {
  if (!value) return undefined;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== value)
    return undefined;
  const hex = bytes.toString("hex"),
    uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return z.uuid().safeParse(uuid).success ? uuid : undefined;
};
export const successPublication = (host: string, publication: string) =>
  `p.${uuidBytes(host)}.${uuidBytes(publication)}`;
export const publicationIdentity = (reference: string) => {
  const [kind, host, attempt, ...extra] = reference.split(".");
  if (kind !== "p" || extra.length) return undefined;
  const hostId = uuidFrom(host),
    attemptId = uuidFrom(attempt);
  return hostId && attemptId ? { host: hostId, attemptId } : undefined;
};
const boundedText = (text: string, maximum: number) => {
  const bytes = Buffer.from(text);
  if (bytes.length <= maximum) return bytes;
  let end = maximum - 3;
  while (end > 0) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
      break;
    } catch {
      end--;
    }
  }
  return Buffer.concat([bytes.subarray(0, end), Buffer.from("...")]);
};
/** The claimed key supplies key identity; this immutable reference carries its run, tag and message. */
export const createPublicationFailure = (
  attemptId: string,
  tag: string,
  key: string,
  message = tag === "PublicationCapacity"
    ? "Shared publication storage is full of live keys"
    : tag === "PublicationHostGone"
      ? "Publication host ended before delivery"
      : "Shared publication exceeds its byte limit",
) => {
  const encodedTag = boundedText(tag, 24),
    encodedMessage = boundedText(message, 48);
  return {
    publication: `f.${uuidBytes(attemptId)}.${encodedTag.toString("base64url")}.${encodedMessage.toString("base64url")}`,
    failure: new Computations.SharedAttemptFailed({
      key,
      attemptId,
      tag: encodedTag.toString(),
      message: encodedMessage.toString(),
    }),
  };
};
export const inlinePublicationFailure = (
  publication: string | undefined,
  key: string,
) => {
  if (!publication) return undefined;
  const [kind, id, tag, message, ...extra] = publication.split(".");
  const attemptId = uuidFrom(id);
  if (
    kind !== "f" ||
    !attemptId ||
    tag === undefined ||
    message === undefined ||
    extra.length
  )
    return undefined;
  const decodedTag = Buffer.from(tag, "base64url"),
    decodedMessage = Buffer.from(message, "base64url");
  if (
    decodedTag.length > 24 ||
    decodedMessage.length > 48 ||
    decodedTag.toString("base64url") !== tag ||
    decodedMessage.toString("base64url") !== message
  )
    return undefined;
  return new Computations.SharedAttemptFailed({
    key,
    attemptId,
    tag: decodedTag.toString(),
    message: decodedMessage.toString(),
  });
};
export const heldPublication = (attemptId: string) =>
  `h.${uuidBytes(attemptId)}`;
export const isHeldPublication = (reference: string) => {
  const [kind, id, ...extra] = reference.split(".");
  return kind === "h" && !extra.length && uuidFrom(id) !== undefined;
};

/** Four key slots cover the entire store. Same-key successors replace responses without a clock. */
export const sharedPublication = <P extends { readonly publication: string }>(
  input: {
    readonly namespace: "shared-indexes-v4" | "shared-outlines-v4";
    readonly scope: string;
    readonly key: string;
    readonly group: string;
    readonly schema: z.ZodType<P>;
    readonly reusable: (value: P) => boolean;
  } & Partial<ReturnType<typeof PublicationPolicy.defaultValue>>,
) => {
  const policy = { ...PublicationPolicy.defaultValue(), ...input },
    authority = policy.authority(input.scope);
  const store = digest(input.scope),
    key = digest(input.key),
    folder = join(budgetDirectory(), input.namespace, store);
  const readPublication = (data: unknown, path: string) => {
    const envelope = safeRead(Envelope, data, { source: path });
    if (!envelope.success) return envelope;
    const value = safeRead(input.schema, envelope.data.value, { source: path });
    if (!value.success) return value;
    return {
      success: envelope.success,
      data: { ...envelope.data, value: value.data },
      droppedKeys: [...envelope.droppedKeys, ...value.droppedKeys],
    };
  };
  const encode = (value: unknown) =>
    Buffer.concat([PUBLICATION_MAGIC, serialize(value)]);
  const load = async (path: string, maximum: number) => {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (info.size > maximum)
        throw new PublicationTooLarge(info.size, maximum);
      const bytes = await file.readFile();
      if (bytes.length > maximum)
        throw new PublicationTooLarge(bytes.length, maximum);
      if (
        bytes.length < PUBLICATION_MAGIC.length &&
        bytes.equals(PUBLICATION_MAGIC.subarray(0, bytes.length))
      )
        throw new PartialPublication();
      if (
        !bytes.subarray(0, PUBLICATION_MAGIC.length).equals(PUBLICATION_MAGIC)
      )
        return undefined;
      try {
        return deserialize(bytes.subarray(PUBLICATION_MAGIC.length));
      } catch {
        throw new PartialPublication();
      }
    } finally {
      await file.close();
    }
  };
  const entries = async (path: string) =>
    readdir(path).catch((error) => {
      if (absent(error)) return [];
      throw error;
    });
  type Record = {
    path: string;
    directory: string;
    header: z.infer<typeof Header>;
    value: P;
    known: boolean;
  };
  const records = async (keyDirectory: string): Promise<Record[]> => {
    for (;;) {
      const found: Record[] = [];
      let retired = false;
      for (const name of await entries(keyDirectory)) {
        if (!/^run-[0-9a-f-]{36}$/.test(name)) continue;
        const id = name.slice(4),
          directory = join(keyDirectory, name),
          path = join(directory, "value", id);
        try {
          const data = await load(path, policy.maximumBytes);
          if (data === undefined) continue;
          const parsed = readPublication(data, path);
          if (!parsed.success) continue;
          if (
            parsed.data.store !== store ||
            parsed.data.key !==
              keyDirectory.slice(keyDirectory.lastIndexOf("/") + 5) ||
            parsed.data.publication !== id ||
            digest(parsed.data.requestKey) !== parsed.data.key ||
            parsed.data.value.publication !== id
          )
            continue;
          found.push({
            path,
            directory,
            header: parsed.data,
            value: parsed.data.value,
            known: parsed.droppedKeys.length === 0,
          });
        } catch (error) {
          if (!absent(error)) throw error;
          // Pending installs still have their run directory. Retired runs cannot hide their successor.
          try {
            await stat(directory);
          } catch (error) {
            if (!absent(error)) throw error;
            retired = true;
          }
        }
      }
      if (!retired) return found;
    }
  };
  const newest = (rows: Record[]) => {
    const parents = new Set(rows.map((row) => row.header.previous));
    return (
      rows
        .filter((row) => !parents.has(row.header.publication))
        .sort((a, b) =>
          b.header.publication.localeCompare(a.header.publication),
        )[0] ?? rows[0]
    );
  };
  const locate = async () => {
    for (let n = 0; n < policy.maximumRecords; n++) {
      const directory = join(folder, `slot-${n}`, `key-${key}`),
        rows = await records(directory);
      const latest = newest(rows);
      if (latest) return { directory, rows, latest };
    }
    return undefined;
  };
  const read = async (reference?: string): Promise<P | undefined> => {
    const requested =
      reference === undefined ? undefined : publicationIdentity(reference);
    if (
      reference !== undefined &&
      !requested &&
      !z.uuid().safeParse(reference).success
    )
      return undefined;
    const located = await locate();
    if (located) {
      if (reference === undefined && !input.reusable(located.latest.value))
        return undefined;
      return {
        ...located.latest.value,
        publication:
          reference ??
          successPublication(
            located.latest.header.host,
            located.latest.header.publication,
          ),
      };
    }
    if (requested) {
      const state = await authority.status(key);
      if (!state || state.host !== requested.host)
        throw new PublicationHostGone(requested.attemptId);
    }
    return undefined;
  };
  const removeRun = async (
    directory: string,
    id: string,
    canRemove: boolean,
  ) => {
    if (!canRemove) return;
    const names = await entries(directory);
    for (const name of names) {
      if (name === `ready-${id}` || name === "value") {
        if ((await entries(join(directory, name))).some((file) => file !== id))
          return;
      } else if (
        name !== `meta-${id}` &&
        name !== `meta-${id}.tmp` &&
        name !== `data-${id}.tmp`
      )
        return;
    }
    // Retire discovery atomically before removing any payload. A missed open can then distinguish
    // replacement from an unfinished install without waiting for that install to become ready.
    if (directory.endsWith(`/run-${id}`)) {
      const retired = join(dirname(directory), `retired-${id}`);
      try {
        await rename(directory, retired);
      } catch (error) {
        if (absent(error)) return;
        throw error;
      }
      directory = retired;
    }
    // Immutable names are enumerated even when metadata was lost before recovery.
    for (const name of await entries(directory)) {
      if (
        name === `meta-${id}` ||
        name === `meta-${id}.tmp` ||
        name === `data-${id}.tmp`
      )
        await rm(join(directory, name), { force: true });
      else if (name === `ready-${id}` || name === "value") {
        await rm(join(directory, name, id), { force: true });
        await emptyDirectory(join(directory, name));
      }
    }
    await emptyDirectory(directory);
  };
  const prune = async (current?: string) => {
    for (const slot of await entries(folder)) {
      if (!/^slot-\d+$/.test(slot) && !/^prepare-[0-9a-f-]{36}$/.test(slot))
        continue;
      const slotDirectory = join(folder, slot);
      for (const name of await entries(slotDirectory)) {
        if (!/^key-[a-f0-9]{64}$/.test(name)) continue;
        const keyHash = name.slice(4),
          keyDirectory = join(slotDirectory, name),
          rows = await records(keyDirectory),
          latest = newest(rows);
        let state:
          Awaited<ReturnType<PublicationAuthority["status"]>> | undefined;
        const status = async () =>
          state ?? (state = await authority.status(keyHash));
        for (const run of await entries(keyDirectory)) {
          if (!/^(?:run|retired)-[0-9a-f-]{36}$/.test(run)) continue;
          const id = run.slice(run.indexOf("-") + 1),
            directory = join(keyDirectory, run);
          if (current === id && keyHash === key) continue;
          const row = rows.find((value) => value.header.publication === id);
          if (row) {
            if (!row.known) continue;
            const replaced = latest !== undefined && latest !== row;
            const live = await status();
            if (
              replaced ||
              (keyHash !== key && live && !live.claimed && !live.unread)
            )
              await removeRun(directory, id, true);
          } else {
            // Never discard a newer format merely because this reader cannot project it.
            let understood = true;
            for (const candidate of [
              join(directory, `meta-${id}`),
              join(directory, `meta-${id}.tmp`),
              join(directory, "value", id),
              join(directory, `ready-${id}`, id),
              join(directory, `data-${id}.tmp`),
            ]) {
              try {
                const data = await load(
                  candidate,
                  candidate.includes(`/meta-${id}`)
                    ? METADATA_MAX_BYTES
                    : policy.maximumBytes,
                );
                if (data === undefined) {
                  understood = false;
                  continue;
                }
                const parsed = candidate.includes(`/meta-${id}`)
                  ? safeRead(Header, data, { source: candidate })
                  : readPublication(data, candidate);
                if (
                  !parsed.success ||
                  parsed.droppedKeys.length ||
                  parsed.data.store !== store ||
                  parsed.data.key !== keyHash ||
                  parsed.data.publication !== id
                )
                  understood = false;
              } catch (error) {
                if (!absent(error) && !(error instanceof PartialPublication))
                  understood = false;
              }
            }
            const live = await status();
            const ownPrior = current !== undefined && keyHash === key;
            if (understood && (ownPrior || (live && !live.claimed)))
              await removeRun(directory, id, true);
          }
        }
        await emptyDirectory(keyDirectory);
      }
      await emptyDirectory(slotDirectory);
    }
  };
  return {
    read,
    prune: () => prune(),
    transport: authority.transport,
    async publish(inputValue: unknown): Promise<P> {
      // The builder's own value is published as it is when parsing it would give it back exactly
      // (`fitsExactly`), so no second copy of a large value is made; otherwise it is parsed, and a
      // value that does not fit is refused here, as before anything is written. Readers parse.
      let fits = false;
      try {
        fits = fitsExactly(input.schema, inputValue);
      } catch {
        fits = false;
      }
      const value = fits ? (inputValue as P) : input.schema.parse(inputValue),
        host = authority.host();
      if (!host) throw new Error("Acknowledged publication host is required");
      const existing = await locate();
      if (existing?.rows.some((row) => !row.known))
        return {
          ...existing.latest.value,
          publication: successPublication(
            host,
            existing.latest.header.publication,
          ),
        };
      if (existing?.latest.header.publication === value.publication)
        return {
          ...existing.latest.value,
          publication: successPublication(host, value.publication),
        };
      const header = {
        version: 4,
        store,
        key,
        requestKey: input.key,
        publication: value.publication,
        previous: existing?.latest.header.publication ?? null,
        host,
      } satisfies z.infer<typeof Header>;
      // The file is the magic and then the envelope, as `encode` gives them, written in two parts.
      const payload = serialize({ ...header, value }),
        size = PUBLICATION_MAGIC.length + payload.length;
      if (size > policy.maximumBytes)
        throw new PublicationTooLarge(size, policy.maximumBytes);
      const metadata = encode(header);
      if (metadata.length > METADATA_MAX_BYTES)
        throw new PublicationTooLarge(metadata.length, METADATA_MAX_BYTES);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await prune(value.publication);
      let keyDirectory = (await locate())?.directory;
      const prepared = join(folder, `prepare-${value.publication}`),
        runName = `run-${value.publication}`;
      let directory: string | undefined,
        installed = false;
      try {
        if (keyDirectory) {
          directory = join(keyDirectory, runName);
          try {
            await mkdir(directory, { mode: 0o700 });
          } catch (error) {
            if (!absent(error)) throw error;
            directory = undefined;
            keyDirectory = undefined;
          }
        }
        if (!directory) {
          const preparations = (await entries(folder)).filter((name) =>
            name.startsWith("prepare-"),
          );
          if (preparations.length >= policy.maximumRecords)
            throw new PublicationCapacity();
          directory = join(prepared, `key-${key}`, runName);
          await mkdir(directory, { recursive: true, mode: 0o700 });
        }
        const meta = `meta-${value.publication}`;
        await writeFile(join(directory, `${meta}.tmp`), metadata, {
          mode: 0o600,
        });
        await rename(join(directory, `${meta}.tmp`), join(directory, meta));
        if (!keyDirectory) {
          let slot: string | undefined;
          for (let n = 0; n < policy.maximumRecords; n++) {
            try {
              const path = join(folder, `slot-${n}`);
              await rename(prepared, path);
              slot = path;
              break;
            } catch (error) {
              if (!occupied(error)) throw error;
            }
          }
          if (!slot) throw new PublicationCapacity();
          keyDirectory = join(slot, `key-${key}`);
          directory = join(keyDirectory, runName);
        }
        const ready = join(directory, `ready-${value.publication}`);
        await mkdir(ready, { mode: 0o700 });
        await writeParts(join(ready, value.publication), [
          PUBLICATION_MAGIC,
          payload,
        ]);
        await rename(ready, join(directory, "value"));
        installed = true;
        await prune(value.publication);
        return {
          ...value,
          publication: successPublication(host, value.publication),
        };
      } finally {
        if (directory && !installed)
          await removeRun(directory, value.publication, true);
        await emptyDirectory(join(prepared, `key-${key}`));
        await emptyDirectory(prepared);
      }
    },
  };
};
