import { setTimeout } from "node:timers/promises";
import {
  DEFAULT_RETRY_POLICY,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import {
  CaptureFailed,
  type CaptureLoss,
  type ModelCapture,
  type ModelCaptureEvent,
} from "../capture/types.ts";

type WritableEvent = Exclude<ModelCaptureEvent, { type: "credential.guard" }>;

export class CallCapture {
  #lost = false;
  #credentialCoverage = false;
  readonly #retry;
  readonly #capture: ModelCapture;

  constructor(capture: ModelCapture, retry?: HarnessSettings["retry"]) {
    this.#capture = capture;
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...retry };
  }

  async write(event: WritableEvent, signal?: AbortSignal): Promise<void> {
    this.#credentialCoverage ||=
      event.type === "credential.registration" ||
      (event.type === "model.request" &&
        event.credentialCoverage === "required");
    for (let attempt = 1; !this.#lost; attempt++) {
      try {
        this.#capture(event);
        return;
      } catch (cause) {
        const recordLoss = this.#capture.recordLoss;
        if (
          recordLoss === undefined ||
          !(cause instanceof CaptureFailed) ||
          (cause.kind !== "io" && cause.kind !== "full")
        )
          throw cause;
        if (
          this.#retry.enabled &&
          attempt <= this.#retry.maxRetries &&
          !signal?.aborted &&
          !this.#capture.journalFull?.()
        ) {
          await setTimeout(retryDelayMs(this.#retry, attempt), undefined, {
            signal,
          }).catch((error: unknown) => {
            if (!signal?.aborted) throw error;
          });
          if (!signal?.aborted) continue;
        }
        this.#lost = true;
        const loss: CaptureLoss = {
          callId: event.callId,
          event: event.type,
          at: new Date().toISOString(),
          ...(this.#credentialCoverage
            ? { credentialCoverage: "required" }
            : {}),
          kind: cause.kind,
          reason:
            cause.kind === "full"
              ? cause.journalFull
                ? "journal limit"
                : "object limit"
              : cause.writeCode === "EACCES" || cause.writeCode === "EPERM"
                ? "permission denied"
                : cause.writeCode === "ENOSPC"
                  ? "disk full"
                  : "I/O error",
        };
        try {
          recordLoss(loss, cause.journalFull === true);
        } catch (error) {
          if (event.type === "credential.registration") throw error;
        }
        return;
      }
    }
  }
}
