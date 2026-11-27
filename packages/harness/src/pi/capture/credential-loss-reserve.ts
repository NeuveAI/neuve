import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { z } from "zod";
import {
  CaptureFailed,
  CaptureLoss,
  captureLossCredential,
  CREDENTIAL_LOSS_RESERVE_BYTES,
  type JournalLine,
} from "./types.ts";

const STOPPED_CALL =
  "The call stopped because a credential could slip through unrecorded.";
export const RESERVE_FULL_REASON = `The credential registration loss reserve is full. ${STOPPED_CALL}`;
export const RESERVE_UNWRITABLE_REASON = `Could not record credential registration loss. ${STOPPED_CALL}`;

const slotBytes = 512;
const digestBytes = 32;
const emptySlot = Buffer.alloc(slotBytes, 0xa5);
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest();
const decoder = new TextDecoder("utf-8", { fatal: true });
const OrdinaryLossMarker = z.strictObject({
  version: z.literal(1),
  loss: CaptureLoss.refine((loss) => loss.ordinaryOverflow !== undefined),
});

const decodeReserve = (bytes: Uint8Array) => {
  try {
    if (bytes.byteLength !== CREDENTIAL_LOSS_RESERVE_BYTES)
      throw new Error("reserve size changed");
    const reserve = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    const readSlot = (offset: number): unknown => {
      const slot = reserve.subarray(offset, offset + slotBytes);
      if (slot.equals(emptySlot)) return undefined;
      const body = slot.subarray(digestBytes);
      if (!digest(body).equals(slot.subarray(0, digestBytes)))
        throw new Error("invalid reserve slot");
      return JSON.parse(decoder.decode(body));
    };
    const marker = readSlot(0);
    const ordinary =
      marker === undefined ? undefined : OrdinaryLossMarker.parse(marker);
    const credentials = new Map<string, CaptureLoss>();
    for (let offset = slotBytes; offset < reserve.length; offset += slotBytes) {
      const value = readSlot(offset);
      if (value === undefined) continue;
      const loss = CaptureLoss.parse(value);
      if (
        offset !== (credentials.size + 1) * slotBytes ||
        loss.event !== "credential.registration" ||
        loss.credentialCoverage !== undefined ||
        loss.ordinaryOverflow !== undefined
      )
        throw new Error("invalid credential slot");
      const epoch = loss.epochId ?? loss.callId;
      if (credentials.has(epoch)) throw new Error("duplicate credential epoch");
      credentials.set(epoch, loss);
    }
    return { ordinary, credentials };
  } catch {
    throw new Error(
      "credential registration loss reserve is damaged; export refused",
    );
  }
};

export const emptyCredentialLossReserve = () =>
  Buffer.alloc(CREDENTIAL_LOSS_RESERVE_BYTES, emptySlot);

export const expectsCredentialLossReserve = (lines: readonly JournalLine[]) =>
  lines.some(
    ({ event }) =>
      event.type === "journal.open" && event.credentialLossReserve === true,
  );

export const readLossFile = (path: string, limit: number) => {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > limit)
      throw new Error("Capture loss file is outside its file or size limits");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
};

export const decodeCredentialLossReserve = (
  bytes: Uint8Array | undefined,
  expected: boolean,
): CaptureLoss[] => {
  if (bytes === undefined) {
    if (expected)
      throw new Error(
        "credential registration loss reserve is missing; export refused",
      );
    return [];
  }
  const { ordinary, credentials } = decodeReserve(bytes);
  return [
    ...(ordinary === undefined ? [] : [ordinary.loss]),
    ...credentials.values(),
  ];
};

const writeSlot = (fd: number, offset: number, record: unknown) => {
  const json = Buffer.from(JSON.stringify(record));
  const slot = Buffer.alloc(slotBytes, " ");
  const body = slot.subarray(digestBytes);
  if (json.byteLength > body.byteLength)
    throw new Error("capture loss does not fit in a reserve slot");
  json.copy(body);
  digest(body).copy(slot);
  if (writeSync(fd, slot, 0, slot.byteLength, offset) !== slot.byteLength)
    throw new Error(
      "credential registration loss reserve write was incomplete",
    );
};

export const recordReservedCaptureLoss = (
  path: string,
  loss: CaptureLoss,
  destination: "ordinary" | "credential",
  reserveNamed = true,
) => {
  try {
    if (!reserveNamed) throw new Error("the loss reserve is unavailable");
    const fd = openSync(
      path,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = fstatSync(fd);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size !== CREDENTIAL_LOSS_RESERVE_BYTES
      )
        throw new Error("credential registration loss reserve is damaged");
      const { ordinary, credentials } = decodeReserve(readFileSync(fd));
      const record = CaptureLoss.parse(loss);
      if (destination === "ordinary") {
        const first = ordinary?.loss ?? record;
        // A later registered loss can require a whole-source scan even when the first loss did not.
        const newCoverage =
          captureLossCredential(first) === undefined &&
          first.ordinaryOverflow?.credential === undefined
            ? captureLossCredential(record)
            : undefined;
        if (ordinary === undefined || newCoverage !== undefined)
          writeSlot(fd, 0, {
            version: 1,
            loss: {
              ...first,
              ordinaryOverflow:
                newCoverage === undefined ? {} : { credential: newCoverage },
            },
          });
      } else {
        if (record.event !== "credential.registration")
          throw new Error("credential slot requires a registration loss");
        if (!credentials.has(record.epochId ?? record.callId)) {
          const offset = (credentials.size + 1) * slotBytes;
          if (offset === CREDENTIAL_LOSS_RESERVE_BYTES)
            throw new CaptureFailed({
              kind: "full",
              event: "credential.registration.reserve",
              detail: RESERVE_FULL_REASON,
            });
          delete record.credentialCoverage;
          writeSlot(fd, offset, record);
        }
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    if (cause instanceof CaptureFailed) throw cause;
    throw new CaptureFailed({
      kind: "io",
      event: "credential.registration.reserve",
      detail: `Could not record credential registration loss. ${cause instanceof Error ? cause.message : String(cause)}. ${STOPPED_CALL}`,
    });
  }
};
