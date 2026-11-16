import { expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { RouteModelsOptions } from "@neuve/harness/coding";
import { SOL_ROUTE } from "../../../packages/harness/src/route.ts";
import { workspaceCaptureModels } from "../src/workspace-capture-models.ts";

test("another OpenAI model stays executable and reports its native capture gap", async () => {
  const native = createModels();
  const provider = fauxProvider({
    provider: "openai",
    models: [{ id: "other-openai" }],
  });
  native.setProvider(provider.provider);
  provider.setResponses([fauxAssistantMessage("Original Ace model path")]);
  const events: Array<Parameters<RouteModelsOptions["capture"]>[0]> = [];
  const models = workspaceCaptureModels(native, {
    route: SOL_ROUTE,
    runId: "workspace-native-model-fixture",
    sessionAffinity: "workspace-native-model-fixture",
    capture: (event) => events.push(event),
    credentialInspection: "ephemeral",
  });
  const model = models.getModel("openai", "other-openai");
  if (!model) throw new Error("Native OpenAI model disappeared");
  const response = await models.completeSimple(model, { messages: [] });
  expect(response.content).toEqual([
    { type: "text", text: "Original Ace model path" },
  ]);
  expect(
    events.some(
      (event) =>
        event.type === "model.event" && event.name === "native_capture_gap",
    ),
  ).toBe(true);
  expect(
    events.some(
      (event) =>
        event.type === "model.request" && event.body.status === "missing",
    ),
  ).toBe(true);
  expect(models.getModel("openai", "gpt-6.1-sol")?.id).toBe("gpt-6.1-sol");
});
