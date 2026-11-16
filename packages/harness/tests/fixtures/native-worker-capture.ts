import "../../../../apps/neuve-host/tests/fixtures/memory-secrets.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InMemoryCredentialStore, Type } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { runWorker } from "@ace/host/worker";
import { codingWorkerSetup } from "../../../../apps/neuve-cli/src/workspace-cli.ts";
import { PI_TRANSITION_STORAGE_PROFILE } from "../../../../scripts/pi-storage.ts";
import { SOL_ROUTE } from "../../src/route.ts";

const root = process.env["NATIVE_CAPTURE_ROOT"];
const endpoint = process.env["NATIVE_CAPTURE_ENDPOINT"];
if (!root || !endpoint)
  throw new Error("Native capture fixture is not configured");
const credential = "synthetic-native-worker-key-a37b9f";
const credentials = new InMemoryCredentialStore();
await credentials.modify("openai", async () => ({
  type: "api_key",
  key: credential,
}));
const native = builtinModels({
  credentials,
  authContext: { env: async () => undefined, fileExists: async () => false },
});
const selected = native
  .getModels("openai")
  .find(
    (model) => model.api === "openai-responses" && model.id !== SOL_ROUTE.model,
  );
if (!selected)
  throw new Error("Pinned SDK has no non-route OpenAI builtin model");
mkdirSync(join(root, "captures/coding"), { recursive: true });
writeFileSync(
  join(root, "selection.json"),
  JSON.stringify({
    native: {
      provider: selected.provider,
      modelId: selected.id,
      api: selected.api,
    },
    configured: { provider: SOL_ROUTE.provider, modelId: SOL_ROUTE.model },
  }),
);
const configured = codingWorkerSetup(
  {
    paths: {
      ...PI_TRANSITION_STORAGE_PROFILE.paths,
      state: join(root, "home"),
      captures: join(root, "captures"),
      tmp: join(root, "tmp"),
    },
  },
  SOL_ROUTE,
  {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const original = new URL(request.url);
        if (original.origin !== "https://api.openai.com")
          throw new Error("Fixture refused unexpected provider");
        return globalThis.fetch(new URL(original.pathname, endpoint), {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
          signal: request.signal,
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  },
);

const { planning: _planning, ...setup } = configured;
await runWorker({
  ...setup,
  models: (worker) => configured.models(worker, native),
  nonTurnModels: (worker, purpose, conversation) =>
    configured.nonTurnModels!(worker, purpose, conversation, native),
  defaultModel: async () => ({
    provider: selected.provider,
    modelId: selected.id,
  }),
  tool(worker, tool) {
    const original = configured.tool?.(worker, tool) ?? tool;
    return tool.name === "bash"
      ? {
          ...original,
          parameters: Type.Object({
            command: Type.String(),
            thought: Type.String({ description: "synthetic-schema-thought" }),
            thoughts: Type.Array(Type.String()),
          }),
          execute: async () => ({
            content: [{ type: "text", text: "native-tool-proof" }],
          }),
        }
      : original;
  },
});
