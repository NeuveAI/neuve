import type { Models } from "@earendil-works/pi-ai";
import {
  createRouteModels,
  type RouteModelsOptions,
} from "@neuve/harness/coding";
import { captureNativeModels } from "@neuve/harness/native-models-capture";
import { workspaceModels } from "./workspace-models.ts";

/** Capture native dispatches independently of the configured Neuve subscription route. */
export function workspaceCaptureModels(
  native: Models,
  options: RouteModelsOptions,
): Models {
  const captured = captureNativeModels(native, {
    capture: options.capture,
    credentialInspection: options.credentialInspection,
    runId: options.runId,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.conversationId === undefined
      ? {}
      : { conversationId: options.conversationId }),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return workspaceModels(captured, createRouteModels(options), options.route);
}
