import type { Models } from "@earendil-works/pi-ai";
import {
  createRouteModels,
  type RouteModelsOptions,
} from "@neuve/harness/coding";
import { captureNativeModels } from "@neuve/harness/native-models-capture";
import { workspaceModels } from "./workspace-models.ts";

/**
 * Capture native dispatches independently of the configured Neuve subscription route. A Claude
 * route has no direct transport to add: its model is the account's, which the account chat runtime
 * (`workspace-chat-runtime.ts`) layers over these models, so only the captured native ones return.
 */
export function workspaceCaptureModels(
  native: Models,
  options: RouteModelsOptions,
): Models {
  const captured = captureNativeModels(native, {
    capture: options.capture,
    retry: options.retry,
    credentialInspection: options.credentialInspection,
    runId: options.runId,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.conversationId === undefined
      ? {}
      : { conversationId: options.conversationId }),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  if (options.route.provider === "claude") return captured;
  return workspaceModels(captured, createRouteModels(options), options.route);
}
