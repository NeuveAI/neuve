// Why: the runner's request step must only queue a job, never start a worker of its own, so no
// sign-in may be visible to it. Hiding the config folder is not enough once Neuve also takes a
// sign-in folder or a token program from the environment (the cloud's machines, 10.131): a request
// that inherited either would hold a credential.
import { afterEach, expect, test } from "bun:test";
import { requestEnv } from "../src/harness-compare/runner.ts";

const saved = { ...process.env };
afterEach(() => {
  for (const name of Object.keys(process.env))
    if (!(name in saved)) delete process.env[name];
  Object.assign(process.env, saved);
});

test("the request sees no sign-in variable and an empty config folder", () => {
  process.env["NEUVE_OPENAI_AUTH_DIR"] = "/signin/openai";
  process.env["NEUVE_OPENAI_TOKEN_COMMAND"] = "/opt/replay/lease-token";
  const env = requestEnv("/tmp/run/home", true);
  expect(env["NEUVE_OPENAI_AUTH_DIR"]).toBeUndefined();
  expect(env["NEUVE_OPENAI_TOKEN_COMMAND"]).toBeUndefined();
  expect(env["XDG_CONFIG_HOME"]).toBe("/tmp/run/request-config");
  expect(env["HOME"]).toBe("/tmp/run/home");
  expect(env["NEUVE_DEV_STUBS"]).toBe("1");
});
