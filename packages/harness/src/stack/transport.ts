import { Data } from "effect";
import { dirname } from "node:path";

/**
 * How stack fetches reach the network (proposal SC7). Neuve builds every URL itself: package URLs
 * from the capability's registry host and a validated name, git URLs from a registry-stated
 * repository normalised to `https://<allowed host>/<path>.git`. Nothing a lockfile says is ever used
 * as a URL. Fetches carry no credentials and run in a scrubbed environment: the worker starts the
 * fetching process with `scrubbedEnvironment`, so neither `fetch` nor git sees a proxy, an agent
 * socket, a credential helper or the user's git configuration.
 */

export class TransportRefused extends Data.TaggedError("TransportRefused")<{
  readonly message: string;
  readonly reason:
    | "not-https"
    | "host-not-allowed"
    | "redirect-refused"
    | "over-cap"
    | "timeout"
    | "http-status"
    | "network";
  readonly status?: number;
}> {}

/** Git configuration every store git command runs with, on top of an empty system and global one. */
export const GIT_CONFIG: ReadonlyArray<string> = [
  "protocol.allow=never",
  "protocol.https.allow=always",
  "http.followRedirects=false",
  "core.symlinks=false",
  "core.hooksPath=/dev/null",
  "core.fsmonitor=false",
  "core.askPass=",
  "credential.helper=",
  "maintenance.auto=false",
  "gc.auto=0",
  "pack.threads=2",
  "index.threads=2",
  "fetch.recurseSubmodules=false",
  "submodule.recurse=false",
  "transfer.credentialsInUrl=die",
].flatMap((setting) => ["-c", setting]);

/** The variables a store git process gets beyond the scrubbed environment. */
export const GIT_ENVIRONMENT: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  // The first guard against a lazy fetch from a filtered tree (SC5).
  GIT_NO_LAZY_FETCH: "1",
  GIT_ATTR_NOSYSTEM: "1",
};

/**
 * The environment of the fetching process, built from an allowlist: a fixed `PATH` that also holds
 * the directory of the git that `gitPath` names, a temporary `HOME` and `TMPDIR`, the C locale, and
 * the git variables above. Nothing else of the worker's environment passes: no `SSH_AUTH_SOCK`, no
 * proxies, no `GIT_*` other than those set here, no askpass programs.
 */
export const scrubbedEnvironment = (options: {
  readonly gitPath: string;
  readonly home: string;
}): Record<string, string> => ({
  PATH: [dirname(options.gitPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    .filter((entry, index, all) => all.indexOf(entry) === index)
    .join(":"),
  HOME: options.home,
  TMPDIR: options.home,
  LANG: "C",
  LC_ALL: "C",
  ...GIT_ENVIRONMENT,
});

/** Who may be reached: hosts, and, in tests only, plain HTTP to the loopback address. */
export interface TransportPolicy {
  readonly hosts: ReadonlyArray<string>;
  /** Tests' fake registry: `http://127.0.0.1:<port>`. Never set from settings or the command line. */
  readonly loopbackForTests?: boolean;
}

export const checkUrl = (url: string, policy: TransportPolicy) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TransportRefused({
      message: `not a URL: ${url}`,
      reason: "not-https",
    });
  }
  const loopback =
    policy.loopbackForTests === true &&
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !loopback)
    throw new TransportRefused({
      message: `${url} is not HTTPS`,
      reason: "not-https",
    });
  if (parsed.username !== "" || parsed.password !== "")
    throw new TransportRefused({
      message: `${parsed.host} carries credentials in its URL`,
      reason: "not-https",
    });
  if (!loopback && !policy.hosts.includes(parsed.hostname))
    throw new TransportRefused({
      message: `${parsed.hostname} is not a declared host`,
      reason: "host-not-allowed",
    });
  return parsed;
};

export interface BoundedFetch {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly accept?: string;
  /** Attempts in total for 429 and 5xx answers (2.6's backoff). */
  readonly attempts?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One GET with every SC7 bound: HTTPS to a declared host, redirects followed only to declared
 * hosts, no credentials, the byte cap enforced while reading (the read stops at the cap), one
 * timeout for the whole call with its retries, and backoff on 429 and 5xx. A 404 is returned as
 * `undefined`.
 */
export const fetchBounded = async (
  url: string,
  policy: TransportPolicy,
  options: BoundedFetch,
): Promise<Uint8Array | undefined> => {
  const attempts = options.attempts ?? 3;
  // One timeout for the whole call, retries and their backoff included, so a download never takes
  // longer than its stated limit.
  const signal = AbortSignal.timeout(options.timeoutMs);
  const started = Date.now();
  const pause = (ms: number) =>
    sleep(
      Math.max(0, Math.min(ms, options.timeoutMs - (Date.now() - started))),
    );
  for (let attempt = 1; ; attempt++) {
    let target = checkUrl(url, policy);
    try {
      let response: Response | undefined;
      for (let hop = 0; hop <= 3; hop++) {
        response = await fetch(target, {
          redirect: "manual",
          signal,
          headers: {
            accept: options.accept ?? "*/*",
            "user-agent": "neuve-stack",
          },
        });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (location === null || hop === 3)
          throw new TransportRefused({
            message: `${target.host} redirected without a usable location`,
            reason: "redirect-refused",
          });
        try {
          target = checkUrl(new URL(location, target).toString(), policy);
        } catch (error) {
          throw new TransportRefused({
            message: `refused a redirect from ${target.host}: ${error instanceof TransportRefused ? error.message : String(error)}`,
            reason: "redirect-refused",
          });
        }
      }
      if (response === undefined)
        throw new TransportRefused({
          message: "no response",
          reason: "network",
        });
      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel();
        return undefined;
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        if (attempt < attempts) {
          const after = Number(response.headers.get("retry-after"));
          await pause(
            Number.isFinite(after) && after > 0
              ? Math.min(after, 30) * 1000
              : 1000 * 2 ** (attempt - 1),
          );
          continue;
        }
      }
      if (response.status !== 200) {
        await response.body?.cancel();
        throw new TransportRefused({
          message: `${target.host} answered ${response.status}`,
          reason: "http-status",
          status: response.status,
        });
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        await response.body?.cancel();
        throw new TransportRefused({
          message: `${target.host} declares ${declared} bytes, over the ${options.maxBytes}-byte cap`,
          reason: "over-cap",
        });
      }
      const parts: Array<Uint8Array> = [];
      let total = 0;
      const reader = response.body?.getReader();
      if (reader !== undefined)
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > options.maxBytes) {
            await reader.cancel();
            throw new TransportRefused({
              message: `the download passed the ${options.maxBytes}-byte cap and was stopped`,
              reason: "over-cap",
            });
          }
          parts.push(value);
        }
      const out = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.byteLength;
      }
      return out;
    } catch (error) {
      if (error instanceof TransportRefused) throw error;
      if (signal.aborted)
        throw new TransportRefused({
          message: `${target.host} did not answer within ${options.timeoutMs} ms`,
          reason: "timeout",
        });
      if (attempt < attempts) {
        await pause(1000 * 2 ** (attempt - 1));
        continue;
      }
      throw new TransportRefused({
        message: `${target.host}: ${String(error).slice(0, 200)}`,
        reason: "network",
      });
    }
  }
};

/** A JSON document under the metadata cap, or undefined when the registry has none. */
export const fetchJson = async (
  url: string,
  policy: TransportPolicy,
  maxBytes: number,
  timeoutMs: number,
): Promise<unknown> => {
  const bytes = await fetchBounded(url, policy, {
    maxBytes,
    timeoutMs,
    accept: "application/json",
  });
  if (bytes === undefined) return undefined;
  return JSON.parse(new TextDecoder().decode(bytes));
};
