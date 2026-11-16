// The public auth status command still checks the catalogue after generation moved to pi.
// Synthetic leases and a local catalogue prove that boundary without reading a real sign-in.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { checkRoute } from "../src/openai-route.ts";
import { credentialPresent, OPENAI_BASE_URL } from "../src/route-provider.ts";
import { SOL_ROUTE } from "../src/route.ts";
import { tokenCommand } from "./pi/providers/fixture.ts";

const scratch = mkdtempSync(join(tmpdir(), "route-probe-"));
const token = tokenCommand(scratch, "lease");
const requests: Array<{
  path: string;
  method: string;
  authorization: string | null;
}> = [];
let answer = () => Response.json({ models: [{ slug: SOL_ROUTE.model }] });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    requests.push({
      path: new URL(request.url).pathname,
      method: request.method,
      authorization: request.headers.get("authorization"),
    });
    return answer();
  },
});
afterAll(() => {
  server.stop(true);
  rmSync(scratch, { recursive: true, force: true });
});
const options = {
  baseUrl: `${server.url.origin}/v1`,
  fetch: globalThis.fetch,
  auth: { directory: scratch, tokenCommand: token.path },
};

test("credential status never leases a token; the public probe lists the model without generating", async () => {
  expect(OPENAI_BASE_URL).toBe("https://api.openai.com/v1");
  expect(credentialPresent(SOL_ROUTE, options.auth)).toBe(true);
  expect(token.runs()).toBe(0);
  expect(requests).toEqual([]);
  const checked = await Effect.runPromise(checkRoute(SOL_ROUTE, options));
  expect(Date.parse(checked.expiresAt)).toBeGreaterThan(Date.now());
  expect(token.runs()).toBe(1);
  expect(requests).toEqual([
    { path: "/v1/models", method: "GET", authorization: "Bearer tok-1" },
  ]);
});

test("an unavailable sign-in fails before leasing or touching the catalogue", async () => {
  const auth = { directory: join(scratch, "signed-out"), tokenCommand: null };
  expect(credentialPresent(SOL_ROUTE, auth)).toBe(false);
  const before = requests.length;
  const result = await Effect.runPromise(
    Effect.result(checkRoute(SOL_ROUTE, { ...options, auth })),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") throw new Error("expected missing sign-in");
  expect(result.failure).toMatchObject({
    _tag: "SignInRequired",
    retryable: false,
  });
  expect(result.failure.message).not.toContain("tok-");
  expect(requests).toHaveLength(before);
});

test("catalogue refusals keep their retry class and omit token and provider text", async () => {
  for (const status of [401, 403, 503]) {
    answer = () =>
      Response.json(
        {
          error: {
            code: "catalogue_refused",
            message: "private provider text tok-1",
          },
        },
        { status },
      );
    const result = await Effect.runPromise(
      Effect.result(checkRoute(SOL_ROUTE, options)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure")
      throw new Error("expected catalogue refusal");
    expect(result.failure).toMatchObject({
      _tag: "RouteUnavailable",
      message: `the model catalogue answered HTTP ${status} (catalogue_refused)`,
      retryable: status >= 500,
    });
  }
});

test("a missing or malformed catalogue refuses the route, and a transport failure is retryable", async () => {
  for (const body of [
    { models: [{ slug: "another-model" }] },
    { data: [{ id: SOL_ROUTE.model }] },
    null,
  ]) {
    answer = () => Response.json(body);
    const result = await Effect.runPromise(
      Effect.result(checkRoute(SOL_ROUTE, options)),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") throw new Error("expected absent model");
    expect(result.failure).toMatchObject({
      _tag: "RouteUnavailable",
      message: `${SOL_ROUTE.model} is not in this ChatGPT account's model catalogue`,
      retryable: false,
    });
  }
  const result = await Effect.runPromise(
    Effect.result(
      checkRoute(SOL_ROUTE, {
        ...options,
        fetch: Object.assign(
          async () => {
            throw new Error("private network detail tok-1");
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      }),
    ),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") throw new Error("expected transport failure");
  expect(result.failure).toMatchObject({
    _tag: "RouteUnavailable",
    message: `could not reach ${options.baseUrl}`,
    retryable: true,
  });
});

// Reason: named routes use their own sign-in and give the command for that account, never the default's token command.
test("a named route resolves only its folder and names its own login command", async () => {
  const result = await Effect.runPromise(
    Effect.result(
      checkRoute(SOL_ROUTE, options, {
        name: "work",
        credential: { kind: "neuve-sign-in", folder: join(scratch, "work") },
      }),
    ),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure")
    throw new Error("expected missing named sign-in");
  expect(result.failure).toMatchObject({
    _tag: "SignInRequired",
    account: "work",
    retryable: false,
    message: "Sign in to work with neuve auth login work.",
  });
});
