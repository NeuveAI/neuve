import { preserveUnknown } from "@neuve/records-schema";
import { readData } from "@neuve/records-core";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import {
  authDirectory,
  TOKEN_COMMAND_VARIABLE,
  type AuthOptions,
} from "../../openai-auth.ts";
import {
  requireDirectRoute,
  routeCredentialVariable,
  type AnyRouteConfig,
} from "../../route.ts";
import { retryAfterAt } from "./retry-admission.ts";
import { routeModel } from "./route-model.ts";

const Deadline = z.strictObject({
  version: z.literal(1),
  key: z.string().regex(/^[a-f0-9]{64}$/),
  until: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/** HTTP admission for one configured route, shared by every model factory in its worker. */
export interface RouteAdmission {
  wait(signal?: AbortSignal): Promise<void>;
  observe(header: string | null, receivedAt: number, status?: number): void;
}

export interface RouteAdmissionInput {
  readonly path: string;
  readonly route: AnyRouteConfig;
  readonly auth?: AuthOptions | undefined;
  readonly baseUrl?: string | undefined;
  readonly onThrottle?: (observation: {
    retryAfter: boolean;
    throttled: boolean;
  }) => void;
}

const routeIdentity = (input: Omit<RouteAdmissionInput, "path">) => {
  const route = requireDirectRoute(input.route);
  const auth = input.auth ?? {};
  const command =
    auth.tokenCommand === null ||
    (auth.tokenCommand === undefined && auth.directory !== undefined)
      ? undefined
      : (auth.tokenCommand ?? process.env[TOKEN_COMMAND_VARIABLE]);
  const source =
    route.provider === "anthropic"
      ? ["variable", routeCredentialVariable(route)]
      : command
        ? ["command", command]
        : ["directory", auth.directory ?? authDirectory()];
  return {
    provider: route.provider,
    baseUrl: input.baseUrl ?? routeModel(route).baseUrl,
    source,
  };
};

/** Capacity shares credential-source identity across models; no credential value is read. */
export const providerAccountKey = (
  input: Omit<RouteAdmissionInput, "path">,
): string => {
  requireDirectRoute(input.route);
  const identity = routeIdentity(input);
  return createHash("sha256")
    .update(
      JSON.stringify([identity.provider, identity.baseUrl, identity.source]),
    )
    .digest("hex");
};

/** The worker owns this file under its channel lock. No token value enters its bytes. */
export const openRouteAdmission = (
  input: RouteAdmissionInput,
): RouteAdmission => {
  requireDirectRoute(input.route);
  const identity = routeIdentity(input);
  // Keep the original persisted gate identity, independently of the shared capacity identity.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        identity.provider,
        input.route.model,
        identity.baseUrl,
        identity.source,
      ]),
    )
    .digest("hex");
  let until = 0;
  try {
    const stored = readData(
      Deadline,
      JSON.parse(readFileSync(input.path, "utf8")),
      { source: input.path },
    );
    if (stored.key === key) until = stored.until;
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
      throw cause;
  }
  let failed = false;
  const requireHealthy = () => {
    if (failed)
      throw new Error(
        "Route admission persistence failed; restart only after repairing its state",
      );
  };
  return {
    async wait(signal) {
      for (;;) {
        requireHealthy();
        signal?.throwIfAborted();
        const remaining = until - Date.now();
        if (remaining <= 0) return;
        await setTimeout(Math.min(remaining, 2_147_483_647), undefined, {
          signal,
        });
      }
    },
    observe(header, receivedAt, status) {
      requireHealthy();
      const parsed = retryAfterAt(header, receivedAt);
      if (status === 429 || parsed !== undefined)
        input.onThrottle?.({
          throttled: status === 429,
          retryAfter: parsed !== undefined,
        });
      if (parsed === undefined) return;
      const next = Math.ceil(parsed);
      if (next <= until || next <= Date.now()) return;
      until = next;
      const temporary = `${input.path}.${randomUUID()}.partial`;
      try {
        const fd = openSync(temporary, "wx", 0o600);
        try {
          const next = { version: 1, key, until };
          const stored = (() => {
            try {
              return JSON.parse(readFileSync(input.path, "utf8")) as unknown;
            } catch (error) {
              if (!(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              ))
                throw error;
              return undefined;
            }
          })();
          writeFileSync(
            fd,
            JSON.stringify(
              stored === undefined
                ? next
                : preserveUnknown(Deadline, stored, next, {
                    source: input.path,
                  }),
            ),
          );
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temporary, input.path);
        const directory = openSync(dirname(input.path), "r");
        try {
          fsyncSync(directory);
        } finally {
          closeSync(directory);
        }
      } catch (cause) {
        failed = true;
        throw new Error("Route admission deadline could not be persisted", {
          cause,
        });
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
};
