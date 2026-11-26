// Why: the SDK can relabel a local credential-registration refusal as a connection error.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { SOL_ROUTE } from "../../../src/route.ts";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import { CaptureFailed } from "../../../src/pi/capture/types.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import { routeFailureOf } from "../../../src/pi/providers/failure.ts";
import { tokenCommand } from "./fixture.ts";

test("a full capture journal during credential registration ends before send", async () => {
  const directory = await mkdtemp(join(tmpdir(), "neuve-capture-refusal-"));
  try {
    const source = join(directory, "source");
    await mkdir(source, { mode: 0o700 });
    const ownership = SourceOwnership.acquire(source);
    const inspection = createPrivateInspection({
      ownership,
      source,
      directory: join(directory, "private"),
      excludedRoots: [source],
    });
    try {
      const token = tokenCommand(directory, "lease");
      let sent = 0;
      const models = createRouteModels({
        route: SOL_ROUTE,
        runId: "capture-refusal",
        sessionAffinity: "capture-refusal",
        auth: { tokenCommand: token.path },
        credentialInspection: inspection,
        fetch: Object.assign(
          async () => {
            sent++;
            throw new Error("The provider must not be called");
          },
          { preconnect() {} },
        ),
        capture(event) {
          expect(event.type).toBe("credential.registration");
          throw new CaptureFailed({
            kind: "io",
            event: event.type,
            detail: "Call recording reached its cap.",
          });
        },
      });
      const model = models.getModel(SOL_ROUTE.provider, SOL_ROUTE.model)!;
      const result = await models.complete(model, {
        messages: [{ role: "user", content: "Check the work.", timestamp: 1 }],
      });
      expect(result.errorMessage).toBe(
        "OpenAI API error: capture failed, the call could not be recorded",
      );
      expect(routeFailureOf(result)).toEqual({
        kind: "capture",
        detail:
          "capture failed: credential registration was not recorded: io: Call recording reached its cap.",
      });
      expect(isRetryableAssistantError(result)).toBe(false);
      expect(result.usage.totalTokens).toBe(0);
      expect(sent).toBe(0);
      expect(token.runs()).toBe(1);
    } finally {
      await inspection.close();
      ownership.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
