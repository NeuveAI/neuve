import { z } from "zod";

import { SdkFailure, SdkFrameType } from "@neuve/records-schema";
export { SdkFailure, SdkFrameType } from "@neuve/records-schema";
export const sdkFrameType = (value: unknown) => {
  const parsed = SdkFrameType.safeParse(value);
  return parsed.success ? parsed.data : "other";
};
export const SdkDiagnostic = z.strictObject({
  reason: SdkFailure,
  callbacks: z.int().nonnegative(),
  originalCallbacks: z.int().nonnegative().nullable(),
  frameIndex: z.int().nonnegative(),
  frameType: SdkFrameType,
  expectedFrameType: SdkFrameType,
});
export type SdkDiagnostic = z.infer<typeof SdkDiagnostic>;
export const sdkFailure = (error: unknown) => {
  const parsed = SdkFailure.safeParse(
    error instanceof Error ? error.message : undefined,
  );
  return parsed.success ? parsed.data : "SDK replay failed";
};
