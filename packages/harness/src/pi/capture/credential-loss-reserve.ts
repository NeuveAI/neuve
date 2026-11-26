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
import {
  CaptureFailed,
  CaptureLoss,
  CREDENTIAL_LOSS_RESERVE_BYTES,
  type JournalLine,
} from "./types.ts";

export const RESERVE_FULL_REASON =
  "The credential registration loss reserve is full. The call stopped because a credential could slip through unrecorded.";

const slotBytes = 512;
const digestBytes = 32;
const emptySlot = Buffer.alloc(slotBytes, 0xa5);
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest();
const decoder = new TextDecoder("utf-8", { fatal: true });
const registrationLoss = CaptureLoss.omit({ credentialCoverage: true }).extend({
  event: CaptureLoss.shape.event.extract(["credential.registration"]),
});

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
  try {
    if (bytes.byteLength !== CREDENTIAL_LOSS_RESERVE_BYTES)
      throw new Error("reserve size changed");
    const reserve = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    const losses: CaptureLoss[] = [];
    for (let offset = 0; offset < reserve.length; offset += slotBytes) {
      const slot = reserve.subarray(offset, offset + slotBytes);
      if (slot.equals(emptySlot)) continue;
      const body = slot.subarray(digestBytes);
      if (
        offset !== losses.length * slotBytes ||
        !digest(body).equals(slot.subarray(0, digestBytes))
      )
        throw new Error("invalid reserve slot");
      losses.push(registrationLoss.parse(JSON.parse(decoder.decode(body))));
    }
    return losses;
  } catch {
    throw new Error(
      "credential registration loss reserve is damaged; export refused",
    );
  }
};

export const recordCredentialLoss = (path: string, loss: CaptureLoss) => {
  try {
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
      const losses = decodeCredentialLossReserve(readFileSync(fd), true);
      if (losses.some(({ callId }) => callId === loss.callId)) {
        fsyncSync(fd);
        return;
      }
      const offset = losses.length * slotBytes;
      if (offset === CREDENTIAL_LOSS_RESERVE_BYTES)
        throw new CaptureFailed({
          kind: "full",
          event: "credential.registration.reserve",
          detail: RESERVE_FULL_REASON,
        });
      const { credentialCoverage: _coverage, ...record } = loss;
      const json = Buffer.from(JSON.stringify(registrationLoss.parse(record)));
      const slot = Buffer.alloc(slotBytes, " ");
      const body = slot.subarray(digestBytes);
      if (json.byteLength > body.byteLength)
        throw new Error(
          "credential registration loss does not fit in a reserve slot",
        );
      json.copy(body);
      digest(body).copy(slot);
      if (writeSync(fd, slot, 0, slot.byteLength, offset) !== slot.byteLength)
        throw new Error(
          "credential registration loss reserve write was incomplete",
        );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    if (cause instanceof CaptureFailed) throw cause;
    throw new CaptureFailed({
      kind: "io",
      event: "credential.registration.reserve",
      detail: `Could not record credential registration loss. ${cause instanceof Error ? cause.message : String(cause)}. The call stopped because a credential could slip through unrecorded.`,
    });
  }
};
