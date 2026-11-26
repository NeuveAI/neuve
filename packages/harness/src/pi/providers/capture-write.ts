import { setTimeout } from "node:timers/promises";
import {
  DEFAULT_RETRY_POLICY,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import {
  CredentialEpochId,
  InspectionBudget,
} from "../capture/credential-detectors.ts";
import type { PrivateInspection } from "../capture/private-inspection.ts";
import {
  CREDENTIAL_INSPECTION_POLICY,
  CaptureFailed,
  type CaptureLoss,
  type CaptureScope,
  type ModelCapture,
  type ModelCaptureEvent,
} from "../capture/types.ts";

type WritableEvent = Exclude<ModelCaptureEvent, { type: "credential.guard" }>;
type LossIdentity = {
  readonly callId: string;
  readonly type: WritableEvent["type"];
  readonly epochId?: string;
};

export class CallCapture {
  #lost = false;
  #lostRegistration = false;
  #credentialCoverage = false;
  readonly #retry;
  readonly #capture: ModelCapture;

  constructor(capture: ModelCapture, retry?: HarnessSettings["retry"]) {
    this.#capture = capture;
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...retry };
  }

  get lostRegistration(): boolean {
    return this.#lostRegistration;
  }

  async register(
    scope: CaptureScope,
    callId: string,
    authority: PrivateInspection,
    headers: Headers,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#credentialCoverage = true;
    const event = {
      type: "credential.registration" as const,
      callId,
      scope: { runId: scope.runId },
    };
    const register = () =>
      authority.register({
        epoch: CredentialEpochId.parse(callId),
        headers,
        budget: new InspectionBudget(),
        deduplicate: true,
        ...(signal === undefined ? {} : { signal }),
      });
    const registration = this.#capture.allowCredentialLoss?.()
      ? await this.#write(event, register, signal, true)
      : await register();
    if (registration === undefined) {
      this.#lostRegistration = true;
      return;
    }
    if (registration.status !== "registered")
      throw new Error("Durable credential registration is unavailable");
    await this.write(
      {
        ...event,
        epochId: registration.epoch,
        policy: CREDENTIAL_INSPECTION_POLICY,
      },
      signal,
    );
  }

  async write(event: WritableEvent, signal?: AbortSignal): Promise<void> {
    this.#credentialCoverage ||=
      event.type === "credential.registration" ||
      (event.type === "model.request" &&
        event.credentialCoverage === "required");
    await this.#write(event, () => this.#capture(event), signal);
  }

  async #write<T>(
    event: LossIdentity,
    write: () => T | Promise<T>,
    signal?: AbortSignal,
    privateRegistration = false,
  ): Promise<T | undefined> {
    for (let attempt = 1; !this.#lost; attempt++) {
      try {
        return await write();
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
          (privateRegistration || !this.#capture.journalFull?.())
        ) {
          await setTimeout(retryDelayMs(this.#retry, attempt), undefined, {
            signal,
          }).catch((error: unknown) => {
            if (!signal?.aborted) throw error;
          });
          if (!signal?.aborted) continue;
        }
        const mayLoseRegistration =
          this.#capture.allowCredentialLoss?.() === true;
        if (privateRegistration && !mayLoseRegistration) throw cause;
        this.#lost = true;
        const loss: CaptureLoss = {
          callId: event.callId,
          event: event.type,
          at: new Date().toISOString(),
          ...(this.#credentialCoverage
            ? { credentialCoverage: "required" }
            : {}),
          ...(event.epochId !== undefined && event.epochId !== event.callId
            ? { epochId: event.epochId }
            : {}),
          kind: cause.kind,
          reason: cause.lossReason,
        };
        try {
          recordLoss(loss, cause.journalFull === true, privateRegistration);
        } catch (error) {
          if (event.type === "credential.registration") throw error;
        }
        return;
      }
    }
  }
}
