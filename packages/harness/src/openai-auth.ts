import { preserveUnknown, safeRead } from "@neuve/records-schema";
import { SharedWork } from "@neuve/records-core/shared-work";
import { xdgPath } from "@neuve/records-core/xdg-path";
import { OPENAI_BASE_URL } from "./provider-urls.ts";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

/**
 * The Neuve sign-in for the OpenAI route (10.85): OpenAI's official "Sign in with ChatGPT" for
 * local open-source tools, so the run spends the owner's ChatGPT plan through
 * `https://api.openai.com/v1`. The protocol follows OpenAI's documentation
 * (developers.openai.com/siwc/token-sharing-open-source/sign-in and /profiles-and-sessions):
 *
 * - The first sign-in registers the client itself: `client_id=dynamic_agent_client` with an
 *   `agent_name_hint` and this host's `ext_agent_host_id`; the browser callback returns the issued
 *   client ID, which every later sign-in and refresh reuses. No client secret exists.
 * - PKCE (S256), a fresh `state` and OIDC `nonce` per attempt, and a loopback callback on
 *   `http://127.0.0.1:<port>/auth/callback` (never `localhost`; only the port varies).
 * - The ID token is verified against the issuer's JWKS (RS256, `iss`, `aud`, `exp`, `nonce`, `azp`).
 * - Access tokens last an hour and are refreshed near expiry; refresh tokens rotate, so refreshes
 *   are serialised across processes with a lock file.
 *
 * The credential file lives in `$XDG_CONFIG_HOME/neuve/` (or `~/.config/neuve/`), or the folder
 * `NEUVE_OPENAI_AUTH_DIR` names, written atomically with mode 0600 in a 0700 folder, and refused when
 * anyone else could read it. No token ever leaves this module except as the bearer value handed to
 * the provider's HTTP request, and as the lease below: errors name OAuth error codes and HTTP
 * statuses, never token text, and `status` reports the account and expiry only.
 *
 * Cloud machines (10.129) share one sign-in through a single refresher. Refresh tokens rotate and
 * this module's lock serialises refreshes only within one filesystem, so machines that each held the
 * sign-in would spend one another's refresh token. Instead one process owns the sign-in folder and
 * runs every refresh (`neuve auth lease openai` prints it a usable access token), and each review
 * machine holds no sign-in at all: `NEUVE_OPENAI_TOKEN_COMMAND` names a program that asks the
 * refresher for an access token, which is kept in memory only, until it nears expiry.
 */

export const OPENAI_ISSUER = "https://auth.openai.com";
export const OPENAI_RESOURCE = OPENAI_BASE_URL;
/** Identity scopes, then the scopes that allow ChatGPT plan usage (sign-in, step 2). */
export const OPENAI_SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
/** The app name shown to the owner when the client registers (display metadata only). */
export const AGENT_NAME = "Neuve";
const CALLBACK_PATH = "/auth/callback";
/**
 * The listener's start page, `/auth/start/<random>`: it redirects the browser to the authorisation
 * request once, then answers 404, so another local process can neither guess it nor read the
 * request (its `state`, or the `id_token_hint`) after the browser has.
 */
const START_PREFIX = "/auth/start/";
const DYNAMIC_CLIENT = "dynamic_agent_client";
/** Refresh this long before the access token expires (it lasts an hour). */
export const REFRESH_MARGIN_MS = 5 * 60_000;
/** Refresh tokens last 30 days from their issue and rotate on every refresh (token reference). */
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/**
 * Every request to the issuer is aborted after this long, so the lock (held across at most a
 * discovery, a token request and a key fetch) is always released well before it counts as stale.
 */
const ISSUER_TIMEOUT_MS = 8_000;
/** A lock older than this was left by a process that died holding it (3 × the issuer timeout, doubled). */
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 45_000;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/** OAuth codes after which the refresh token is unusable: clear it and sign in again (errors). */
const UNUSABLE_REFRESH = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export type AuthErrorCode =
  | "signed-out"
  | "access-expired"
  | "plan-usage-not-granted"
  | "refresh-unusable"
  | "file-mode"
  | "file-unreadable"
  | "discovery"
  | "token-endpoint"
  | "invalid-token-response"
  | "invalid-id-token"
  | "account-mismatch"
  | "registration-incomplete"
  | "access-denied"
  | "callback-timeout"
  | "lock-timeout"
  | "network"
  | "configuration"
  | "lease"
  | "stopped";

/** A sign-in failure. Its message names codes and statuses, never a token. */
export class OpenAiAuthError extends Error {
  override readonly name = "OpenAiAuthError";
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    /** Whether a later attempt can succeed without the owner signing in again. */
    readonly transient = false,
  ) {
    super(message);
  }
}

/** Names the sign-in's folder itself, such as one on a cloud machine's mounted volume (10.129). */
export const AUTH_DIRECTORY_VARIABLE = "NEUVE_OPENAI_AUTH_DIR";

/**
 * Where the sign-in is kept: the folder `NEUVE_OPENAI_AUTH_DIR` names, which must be absolute; else
 * `$XDG_CONFIG_HOME/neuve` when it is absolute (XDG), else `~/.config/neuve`.
 */
export const authDirectory = (
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
) => {
  const explicit = env[AUTH_DIRECTORY_VARIABLE];
  if (explicit !== undefined && explicit !== "") {
    if (!isAbsolute(explicit))
      throw new OpenAiAuthError(
        "configuration",
        `${AUTH_DIRECTORY_VARIABLE} must be an absolute path`,
      );
    return explicit;
  }
  return join(
    xdgPath("XDG_CONFIG_HOME", env) ?? join(home, ".config"),
    "neuve",
  );
};

export const authFilePath = (directory: string) =>
  join(directory, "openai-auth.json");

const Session = z.strictObject({
  accessToken: z.string().min(1),
  /** Absent when a refresh answered without a replacement: the spent one is never kept. */
  refreshToken: z.string().min(1).optional(),
  /** Sent as `id_token_hint` on the next sign-in, and checked against the account on refresh. */
  idToken: z.string().min(1),
  /**
   * Set when a refresh rotated the tokens but the new identity could not be confirmed: the pair is
   * kept (the old refresh token is spent) and the reason is shown. `mismatch` and `invalid` stop
   * the session's use until the owner signs in again; `unverified` (the keys were unreachable) does
   * not, and the next refresh checks again.
   */
  identity: z
    .strictObject({
      state: z.enum(["unverified", "invalid", "mismatch"]),
      reason: z.string().max(300),
    })
    .optional(),
  /** Epoch milliseconds. */
  expiresAt: z.number(),
  scopes: z.array(z.string()),
  /** When the refresh token in hand was issued, for its 30-day lifetime. */
  refreshIssuedAt: z.iso.datetime(),
});

const StoredAuth = z.strictObject({
  version: z.literal(1),
  issuer: z.string().min(1),
  /** This host's stable `ext_agent_host_id`; not a credential. */
  hostId: z.string().regex(/^urn:uuid:[0-9a-f-]{36}$/),
  /** The issued client and the verified account it is bound to; kept across sign-outs. */
  registration: z
    .strictObject({
      clientId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
      subject: z.string().min(1).optional(),
      email: z.string().optional(),
      name: z.string().optional(),
    })
    .optional(),
  session: Session.optional(),
});
type StoredAuth = z.infer<typeof StoredAuth>;

/** What `neuve auth status` shows: the account and expiry, never a token. */
export interface AuthStatus {
  readonly signedIn: boolean;
  readonly file: string;
  readonly email?: string | undefined;
  readonly name?: string | undefined;
  readonly clientRegistered: boolean;
  readonly planUsage: boolean;
  readonly accessExpiresAt?: string | undefined;
  readonly refreshExpiresBy?: string | undefined;
  /** Why the session's identity is not confirmed, when a refresh could not confirm it. */
  readonly identityNotice?: string | undefined;
}

/** Options every operation takes; tests point `issuer` and `fetch` at a local fake server. */
export interface AuthOptions {
  readonly directory?: string | undefined;
  readonly issuer?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly now?: (() => number) | undefined;
  /**
   * The program that leases access tokens, or null for the sign-in folder. Left out, it is
   * `NEUVE_OPENAI_TOKEN_COMMAND`, unless `directory` is given.
   */
  readonly tokenCommand?: string | null | undefined;
  /**
   * Stops a refresh that has not yet been sent: the wait for the lock and the issuer's discovery.
   * Once the refresh token is sent it is spent, so the refresh runs on to write back its replacement.
   */
  readonly signal?: AbortSignal | undefined;
  /** How long leasing may take, every run of the token command included; tests shorten it. */
  readonly tokenCommandTimeoutMs?: number | undefined;
  /** The waits before each retry of a token command that exits 75; tests shorten them. */
  readonly leaseRetryDelaysMs?: ReadonlyArray<number> | undefined;
}

/** A named sign-in never inherits the default account's external token command. */
export const authOptionsFor = (credential: {
  readonly kind: "neuve-sign-in";
  readonly folder?: string | undefined;
}): AuthOptions =>
  credential.folder === undefined
    ? {}
    : { directory: credential.folder, tokenCommand: null };

const resolve = (options: AuthOptions) => ({
  directory: options.directory ?? authDirectory(),
  issuer: (options.issuer ?? OPENAI_ISSUER).replace(/\/$/, ""),
  fetch: options.fetch ?? globalThis.fetch,
  now: options.now ?? Date.now,
});

// The credential file

/** Reads the file, refusing one that anyone but the owner can read or write. */
export const readAuth = (directory: string): StoredAuth | undefined => {
  const path = authFilePath(directory);
  if (!existsSync(path)) return undefined;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0)
    throw new OpenAiAuthError(
      "file-mode",
      `${path} has mode ${mode.toString(8).padStart(4, "0")}; it must be readable only by you (0600). Remove it and run neuve auth login openai again.`,
    );
  const parsed = safeRead(
    StoredAuth,
    (() => {
      try {
        return JSON.parse(readFileSync(path, "utf8")) as unknown;
      } catch {
        return undefined;
      }
    })(),
    { source: path },
  );
  if (!parsed.success)
    throw new OpenAiAuthError(
      "file-unreadable",
      `${path} is not a Neuve sign-in file; remove it and run neuve auth login openai again.`,
    );
  return parsed.data;
};

/** Plan preservation before a token exchange or revocation can spend a credential. */
const authToWrite = (
  directory: string,
  auth: StoredAuth,
  removeSession = false,
) => {
  const stored = readAuth(directory);
  if (stored === undefined) return StoredAuth.parse(auth);
  const raw = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(readFileSync(authFilePath(directory), "utf8")));
  // Signing out explicitly removes the entire session, including its newer fields.
  if (removeSession) delete raw["session"];
  return preserveUnknown(StoredAuth, raw, auth, {
    source: authFilePath(directory),
  });
};

/** Writes an already planned value atomically, without another compatibility refusal. */
const persistAuth = (directory: string, next: unknown) => {
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(directory, DIRECTORY_MODE);
  const path = authFilePath(directory);
  const temporary = `${path}.${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, {
      mode: FILE_MODE,
      flag: "wx",
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
};

export const writeAuth = (directory: string, auth: StoredAuth) =>
  persistAuth(directory, authToWrite(directory, auth));

/** Session and registration fields are scalars or arrays of strings; identity is a flat object.
 * Capture their unknown fields now, while refusing is still safe. A rotated pair then has no
 * preservation check left to fail, even when identity verification changes its known fields. */
const sessionWriter = (directory: string, auth: StoredAuth) => {
  const object = z.record(z.string(), z.unknown());
  const held = object.parse(authToWrite(directory, auth));
  const session =
    held["session"] === undefined ? {} : object.parse(held["session"]);
  const registration =
    held["registration"] === undefined
      ? {}
      : object.parse(held["registration"]);
  const identity =
    session["identity"] === undefined
      ? undefined
      : object.parse(session["identity"]);
  const identityRead = safeRead(Session.shape.identity, identity, {
    source: authFilePath(directory),
  });
  const newerIdentity =
    identityRead.success && identityRead.droppedKeys.length > 0;
  return (next: StoredAuth) => {
    const checked = StoredAuth.parse(next);
    persistAuth(directory, {
      ...held,
      ...checked,
      registration:
        checked.registration === undefined
          ? held["registration"]
          : {
              ...registration,
              ...checked.registration,
              subject: checked.registration.subject,
              email: checked.registration.email,
              name: checked.registration.name,
            },
      session:
        checked.session === undefined
          ? undefined
          : {
              ...session,
              ...checked.session,
              // An omitted replacement refresh token must never resurrect the spent token.
              refreshToken: checked.session.refreshToken,
              identity:
                checked.session.identity === undefined
                  ? newerIdentity
                    ? identity
                    : undefined
                  : { ...identity, ...checked.session.identity },
            },
    });
  };
};

const freshAuth = (issuer: string): StoredAuth => ({
  version: 1,
  issuer,
  hostId: `urn:uuid:${randomUUID()}`,
});

/**
 * Serialises refreshes and sign-ins across processes (profiles-and-sessions: refreshing tokens).
 * The lock file holds this attempt's own marker; it is released only while it still holds that
 * marker, and a lock older than `LOCK_STALE_MS` is broken only if it is still the one that was
 * judged stale (it is moved aside, compared, and put back if another process took it meanwhile).
 */
export const withLock = async <A>(
  directory: string,
  body: () => Promise<A>,
  timing: {
    readonly staleMs?: number;
    readonly waitMs?: number;
    /** Stops the wait for the lock; the body, once started, is not interrupted. */
    readonly signal?: AbortSignal | undefined;
  } = {},
) => {
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  const lock = join(directory, "openai-auth.lock");
  const marker = `${process.pid} ${randomUUID()}\n`;
  const staleMs = timing.staleMs ?? LOCK_STALE_MS;
  const waitMs = timing.waitMs ?? LOCK_WAIT_MS;
  const contents = (path: string) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };
  const started = Date.now();
  while (true) {
    try {
      writeFileSync(lock, marker, { mode: FILE_MODE, flag: "wx" });
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      const seen = contents(lock);
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (seen !== undefined && age > staleMs) {
        const aside = `${lock}.stale.${randomUUID()}`;
        try {
          renameSync(lock, aside);
          if (contents(aside) === seen) rmSync(aside, { force: true });
          else {
            // Another process took the lock after it was judged stale: give it back.
            try {
              linkSync(aside, lock);
            } catch {
              // A third process holds it now; the moved copy's owner will find its marker gone.
            }
            rmSync(aside, { force: true });
          }
        } catch {
          // Another process moved it first.
        }
        continue;
      }
      if (Date.now() - started > waitMs)
        throw new OpenAiAuthError(
          "lock-timeout",
          `another Neuve process held ${lock} for over ${Math.round(waitMs / 1000)} s`,
          true,
        );
      if (timing.signal?.aborted === true) throw stoppedError();
      await Bun.sleep(50 + Math.floor(Math.random() * 100));
    }
  }
  try {
    return await body();
  } finally {
    if (contents(lock) === marker) rmSync(lock, { force: true });
  }
};

// The issuer

interface Discovery {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly revocation_endpoint?: string | undefined;
}

const discoveries = new Map<string, Discovery>();
const discoveryWork = new SharedWork<Discovery>();

const fetchJson = async (
  fetcher: typeof globalThis.fetch,
  url: string,
  init?: RequestInit,
) => {
  let response: Response;
  let text: string;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(ISSUER_TIMEOUT_MS),
    });
    text = await response.text();
  } catch {
    throw new OpenAiAuthError(
      "network",
      `could not reach ${new URL(url).origin} within ${ISSUER_TIMEOUT_MS / 1000} s`,
      true,
    );
  }
  let body: unknown;
  try {
    body = text === "" ? undefined : (JSON.parse(text) as unknown);
  } catch {
    body = undefined;
  }
  return { response, body };
};

/** The issuer's OpenID configuration; every endpoint must be on the issuer's own origin. */
const discover = async (issuer: string, fetcher: typeof globalThis.fetch) => {
  const cached = discoveries.get(issuer);
  if (cached !== undefined) return cached;
  const result = await discoveryWork.run({
    scope: "openid-discovery",
    key: issuer,
    run: async () => {
      const known = discoveries.get(issuer);
      if (known !== undefined) return { kind: "succeeded", value: known };
      const { response, body } = await fetchJson(
        fetcher,
        `${issuer}/.well-known/openid-configuration`,
      );
      const data = body as Record<string, unknown> | undefined;
      const origin = new URL(issuer).origin;
      const sameOrigin = (value: unknown) =>
        typeof value === "string" && new URL(value).origin === origin;
      if (
        !response.ok ||
        data === undefined ||
        data["issuer"] !== issuer ||
        !sameOrigin(data["authorization_endpoint"]) ||
        !sameOrigin(data["token_endpoint"]) ||
        !sameOrigin(data["jwks_uri"]) ||
        (data["revocation_endpoint"] !== undefined &&
          !sameOrigin(data["revocation_endpoint"]))
      )
        throw new OpenAiAuthError(
          "discovery",
          `the sign-in configuration at ${issuer} could not be verified (HTTP ${response.status})`,
          true,
        );
      const value = data as unknown as Discovery;
      discoveries.set(issuer, value);
      return { kind: "succeeded", value };
    },
  });
  if (result.outcome.kind === "failed") throw result.outcome.error;
  return result.outcome.value;
};

const base64url = (bytes: Uint8Array | Buffer) =>
  Buffer.from(bytes).toString("base64url");
const randomValue = () => base64url(randomBytes(32));

/** Verifies an ID token's RS256 signature against the issuer's JWKS and checks its claims. */
const verifyIdToken = async (
  idToken: string,
  expected: {
    readonly issuer: string;
    readonly clientId: string;
    readonly nonce?: string | undefined;
    readonly now: number;
  },
  fetcher: typeof globalThis.fetch,
) => {
  const invalid = (why: string) =>
    new OpenAiAuthError(
      "invalid-id-token",
      `the ChatGPT identity could not be verified (${why}); sign in again`,
    );
  const parts = idToken.split(".");
  if (parts.length !== 3) throw invalid("malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [
    string,
    string,
    string,
  ];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(
      Buffer.from(headerPart, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw invalid("malformed");
  }
  if (header["alg"] !== "RS256") throw invalid("algorithm");
  const discovery = await discover(expected.issuer, fetcher);
  const { response, body } = await fetchJson(fetcher, discovery.jwks_uri);
  const keys = (body as { keys?: unknown } | undefined)?.keys;
  if (!response.ok || !Array.isArray(keys))
    throw new OpenAiAuthError(
      "invalid-id-token",
      `the issuer's signing keys are unavailable (HTTP ${response.status})`,
      true,
    );
  const jwk = (keys as Array<Record<string, unknown>>).find(
    (key) =>
      key["kty"] === "RSA" &&
      (header["kid"] === undefined || key["kid"] === header["kid"]),
  );
  if (jwk === undefined) throw invalid("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk["n"] as string, e: jwk["e"] as string },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(signaturePart, "base64url"),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!valid) throw invalid("signature");
  const nowSeconds = expected.now / 1000;
  const aud = payload["aud"];
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (payload["iss"] !== expected.issuer) throw invalid("issuer");
  if (!audiences.includes(expected.clientId)) throw invalid("audience");
  if (
    (audiences.length > 1 || payload["azp"] !== undefined) &&
    payload["azp"] !== expected.clientId
  )
    throw invalid("authorized party");
  if (typeof payload["exp"] !== "number" || payload["exp"] + 5 < nowSeconds)
    throw invalid("expired");
  if (typeof payload["iat"] !== "number") throw invalid("issued-at");
  if (expected.nonce !== undefined && payload["nonce"] !== expected.nonce)
    throw invalid("nonce");
  if (typeof payload["sub"] !== "string" || payload["sub"] === "")
    throw invalid("subject");
  return {
    subject: payload["sub"],
    email: typeof payload["email"] === "string" ? payload["email"] : undefined,
    name: typeof payload["name"] === "string" ? payload["name"] : undefined,
  };
};

/** A token-endpoint POST. A failure names the OAuth error code and HTTP status only. */
const tokenRequest = async (
  issuer: string,
  fetcher: typeof globalThis.fetch,
  form: Record<string, string>,
) => {
  const discovery = await discover(issuer, fetcher);
  const { response, body } = await fetchJson(
    fetcher,
    discovery.token_endpoint,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form),
    },
  );
  const data = (body ?? {}) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof data["error"] === "string" ? data["error"] : undefined;
    throw new OpenAiAuthError(
      form["grant_type"] === "refresh_token" &&
        code !== undefined &&
        UNUSABLE_REFRESH.has(code)
        ? "refresh-unusable"
        : "token-endpoint",
      `the token endpoint answered HTTP ${response.status}${code === undefined ? "" : ` (${code})`}`,
      response.status >= 500,
    );
  }
  return data;
};

/** The credentials in a token response, validated as the sign-in guide's step 3 requires. */
/** The documented access-token lifetime, used when a refresh answer omits `expires_in`. */
const ACCESS_LIFETIME_S = 3_600;

/**
 * The credentials in a token response. A sign-in's answer is validated as the sign-in guide's step 3
 * requires. A refresh's answer has already spent the old refresh token, so whatever new credentials
 * it holds are kept even when it omits `token_type`, `expires_in` or a replacement refresh token:
 * the spent token is never fallen back to.
 */
const sessionFrom = (
  data: Record<string, unknown>,
  previous: {
    readonly scopes?: ReadonlyArray<string>;
    readonly idToken?: string;
  },
  now: number,
  kind: "sign-in" | "refresh",
) => {
  const scopeText =
    typeof data["scope"] === "string"
      ? data["scope"]
      : previous.scopes?.join(" ");
  const idToken =
    typeof data["id_token"] === "string" && data["id_token"] !== ""
      ? data["id_token"]
      : previous.idToken;
  const access =
    typeof data["access_token"] === "string" && data["access_token"] !== ""
      ? data["access_token"]
      : undefined;
  const refresh =
    typeof data["refresh_token"] === "string" && data["refresh_token"] !== ""
      ? data["refresh_token"]
      : undefined;
  const expiresIn =
    typeof data["expires_in"] === "number" && data["expires_in"] > 0
      ? data["expires_in"]
      : undefined;
  const bearer =
    typeof data["token_type"] === "string" &&
    data["token_type"].toLowerCase() === "bearer";
  if (
    access === undefined ||
    scopeText === undefined ||
    idToken === undefined ||
    (kind === "sign-in" &&
      (refresh === undefined || !bearer || expiresIn === undefined))
  )
    throw new OpenAiAuthError(
      "invalid-token-response",
      "the token endpoint returned incomplete credentials; sign in again",
    );
  return {
    accessToken: access,
    ...(refresh === undefined ? {} : { refreshToken: refresh }),
    idToken,
    expiresAt: now + (expiresIn ?? ACCESS_LIFETIME_S) * 1000,
    scopes: scopeText.split(/\s+/).filter((scope) => scope !== ""),
    refreshIssuedAt: new Date(now).toISOString(),
  };
};

// Sign-in

export interface SignInOptions extends AuthOptions {
  /** Opens the authorisation URL; the CLI uses the system browser. */
  /**
   * Opens the sign-in in the browser. The URL is the loopback listener's own start page, which
   * redirects to the authorisation request: the request carries `id_token_hint`, which must never
   * reach a terminal, a log or a process's arguments (profiles-and-sessions: credential security).
   */
  readonly openBrowser: (url: string) => Promise<void> | void;
  readonly timeoutMs?: number | undefined;
}

/**
 * Signs in through the browser: a loopback listener on 127.0.0.1, the authorisation request, the
 * code exchange with PKCE, the ID token check, then the credential file. A returning account keeps
 * its issued client; a different account on the same registration is refused.
 */
export const signIn = async (options: SignInOptions): Promise<AuthStatus> => {
  const { directory, issuer, fetch: fetcher, now } = resolve(options);
  const stored = readAuth(directory) ?? freshAuth(issuer);
  if (stored.issuer !== issuer)
    throw new OpenAiAuthError(
      "file-unreadable",
      `${authFilePath(directory)} belongs to ${stored.issuer}, not ${issuer}`,
    );
  // A confirmed sign-in clears the old identity notice. Refuse before opening the browser if
  // doing that would remove newer identity metadata; sign-out can explicitly remove that session.
  const signInWritable = (auth: StoredAuth) =>
    authToWrite(directory, {
      ...auth,
      ...(auth.session === undefined
        ? {}
        : { session: { ...auth.session, identity: undefined } }),
    });
  signInWritable(stored);
  const discovery = await discover(issuer, fetcher);
  const state = randomValue();
  const nonce = randomValue();
  const verifier = randomValue();
  const saved = stored.registration?.clientId;

  let settle!: (value: { code: string; clientId: string } | Error) => void;
  const callback = new Promise<{ code: string; clientId: string } | Error>(
    (resolveCallback) => {
      settle = resolveCallback;
    },
  );
  let done = false;
  let authorizeUrl: string | undefined;
  const startPath = `${START_PREFIX}${randomValue()}`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const url = new URL(request.url);
      const page = (status: number, text: string) =>
        new Response(
          `<!doctype html><meta charset="utf-8"><title>Neuve</title><p>${text}</p>`,
          {
            status,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
              "content-security-policy": "default-src 'none'",
            },
          },
        );
      if (
        request.method !== "GET" ||
        request.headers.get("host") !== `127.0.0.1:${server.port}` ||
        done
      )
        return page(404, "Not found.");
      if (url.pathname === startPath && authorizeUrl !== undefined) {
        const location = authorizeUrl;
        authorizeUrl = undefined;
        return new Response(null, {
          status: 302,
          headers: {
            location,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (url.pathname !== CALLBACK_PATH) return page(404, "Not found.");
      const returned = url.searchParams.getAll("state");
      const given = Buffer.from(returned[0] ?? "");
      const wanted = Buffer.from(state);
      if (
        returned.length !== 1 ||
        given.length !== wanted.length ||
        !timingSafeEqual(given, wanted)
      )
        return page(
          400,
          "This sign-in link does not match. Return to the terminal and try again.",
        );
      done = true;
      const error = url.searchParams.get("error");
      if (error !== null) {
        settle(
          new OpenAiAuthError(
            error === "access_denied" ? "access-denied" : "token-endpoint",
            error === "access_denied"
              ? "the sign-in was declined in the browser"
              : `the authorisation server answered ${error}`,
          ),
        );
        return page(200, "Sign-in stopped. You can close this tab.");
      }
      const code = url.searchParams.get("code");
      const returnedClient = url.searchParams.get("client_id");
      const clientId = returnedClient ?? saved;
      if (
        code === null ||
        url.searchParams.getAll("code").length !== 1 ||
        url.searchParams.getAll("client_id").length > 1 ||
        clientId === undefined ||
        clientId === DYNAMIC_CLIENT ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(clientId) ||
        (saved !== undefined &&
          returnedClient !== null &&
          returnedClient !== saved)
      ) {
        settle(
          new OpenAiAuthError(
            "registration-incomplete",
            "ChatGPT did not complete the app registration; run neuve auth login openai again",
          ),
        );
        return page(400, "Sign-in did not complete. Return to the terminal.");
      }
      settle({ code, clientId });
      return page(200, "Signed in to Neuve. You can close this tab.");
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}${CALLBACK_PATH}`;
  const timer = setTimeout(
    () =>
      settle(
        new OpenAiAuthError(
          "callback-timeout",
          `no answer from the browser within ${Math.round((options.timeoutMs ?? SIGN_IN_TIMEOUT_MS) / 1000)} s`,
        ),
      ),
    options.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
  );
  try {
    const authorize = new URL(discovery.authorization_endpoint);
    authorize.search = new URLSearchParams({
      client_id: saved ?? DYNAMIC_CLIENT,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: OPENAI_SCOPES,
      resource: OPENAI_RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      ext_agent_host_id: stored.hostId,
      ...(saved === undefined ? { agent_name_hint: AGENT_NAME } : {}),
      ...(stored.registration?.email === undefined
        ? {}
        : { login_hint: stored.registration.email }),
    }).toString();
    // A returning sign-in names its account with the retained ID token (sign-in, step 2).
    const hint = stored.session?.idToken;
    if (hint !== undefined) authorize.searchParams.set("id_token_hint", hint);
    authorizeUrl = authorize.toString();
    await options.openBrowser(`http://127.0.0.1:${server.port}${startPath}`);
    const result = await callback;
    if (result instanceof Error) throw result;

    // A new registration is saved only with the session, after the code exchange and the ID
    // token check succeed: a callback carrying a client ID that cannot complete the exchange (one
    // a local process planted) leaves nothing behind. A failed exchange means the next sign-in
    // registers again, which the owner sees and approves in the browser.
    return await withLock(directory, async () => {
      const current = readAuth(directory) ?? stored;
      signInWritable(current);
      const saveSession = sessionWriter(directory, current);
      const data = await tokenRequest(issuer, fetcher, {
        grant_type: "authorization_code",
        client_id: result.clientId,
        code: result.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: OPENAI_RESOURCE,
      });
      if (typeof data["id_token"] !== "string")
        throw new OpenAiAuthError(
          "invalid-token-response",
          "the token endpoint returned no ID token; sign in again",
        );
      const identity = await verifyIdToken(
        data["id_token"],
        { issuer, clientId: result.clientId, nonce, now: now() },
        fetcher,
      );
      const subject = current.registration?.subject;
      if (subject !== undefined && subject !== identity.subject)
        throw new OpenAiAuthError(
          "account-mismatch",
          "this sign-in returned a different ChatGPT account than the one registered; choose the original account",
        );
      const session = sessionFrom(data, {}, now(), "sign-in");
      const next: StoredAuth = {
        ...current,
        registration: {
          clientId: result.clientId,
          subject: identity.subject,
          ...(identity.email === undefined ? {} : { email: identity.email }),
          ...(identity.name === undefined ? {} : { name: identity.name }),
        },
        session,
      };
      saveSession(next);
      return statusOf(directory, next);
    });
  } finally {
    clearTimeout(timer);
    void server.stop(true);
  }
};

// Use

/**
 * A usable access token: the stored one while it has more than five minutes left, otherwise a
 * refreshed one. Refreshes are serialised across processes; after taking the lock the file is read
 * again, so a token another process just refreshed is used rather than refreshed twice.
 * A rejected token is refreshed even when it has more than five minutes left.
 */
export const accessToken = async (
  options: AuthOptions = {},
  rejected?: string,
): Promise<{ readonly token: string; readonly expiresAt: number }> => {
  const command = tokenCommandOf(options);
  if (command !== undefined)
    return leased(
      command,
      options.now ?? Date.now,
      options.tokenCommandTimeoutMs ?? LEASE_TIMEOUT_MS,
      options.leaseRetryDelaysMs ?? LEASE_RETRY_DELAYS_MS,
      rejected,
    );
  const { directory, fetch: fetcher, now } = resolve(options);
  /** The stored session's token while it has time left; undefined when it needs a refresh. */
  const usable = (auth: StoredAuth | undefined) => {
    const session = sessionProblem(auth, now());
    return session.accessToken !== rejected &&
      session.expiresAt - now() > REFRESH_MARGIN_MS
      ? session
      : undefined;
  };
  const current = usable(readAuth(directory));
  if (current !== undefined)
    return { token: current.accessToken, expiresAt: current.expiresAt };
  return withLock(
    directory,
    async () => {
      const auth = readAuth(directory);
      const again = usable(auth);
      if (again !== undefined)
        return { token: again.accessToken, expiresAt: again.expiresAt };
      const stored = auth as StoredAuth;
      const session = stored.session!;
      const clientId = stored.registration?.clientId;
      const spent = session.refreshToken;
      if (clientId === undefined || spent === undefined)
        throw new OpenAiAuthError(
          session.expiresAt <= now() ? "access-expired" : "signed-out",
          "the OpenAI session cannot be renewed; run neuve auth login openai",
        );
      const saveSession = sessionWriter(directory, stored);
      // The last point at which stopping spends nothing.
      await discover(stored.issuer, fetcher);
      if (options.signal?.aborted === true) throw stoppedError();
      let data: Record<string, unknown>;
      try {
        data = await tokenRequest(stored.issuer, fetcher, {
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: spent,
          resource: OPENAI_RESOURCE,
        });
      } catch (error) {
        if (
          !(error instanceof OpenAiAuthError) ||
          error.code !== "refresh-unusable"
        )
          throw error;
        // An unusable refresh token ends the session; the registration and host stay (errors). The
        // file is read again first: a session another process saved meanwhile is never wiped.
        const latest = readAuth(directory);
        if (
          latest?.session !== undefined &&
          latest.session.refreshToken !== spent
        ) {
          const fresh = usable(latest);
          if (fresh !== undefined)
            return { token: fresh.accessToken, expiresAt: fresh.expiresAt };
          throw new OpenAiAuthError(
            "network",
            "another process replaced the OpenAI session during this refresh; try again",
            true,
          );
        }
        if (latest !== undefined) {
          const { session: _cleared, ...rest } = latest;
          persistAuth(directory, authToWrite(directory, rest, true));
        }
        throw new OpenAiAuthError(
          "refresh-unusable",
          `${error.message}; the OpenAI session ended. Run neuve auth login openai`,
        );
      }
      // The old refresh token is spent: the rotated pair is saved before anything else can fail.
      const refreshed = {
        ...sessionFrom(data, session, now(), "refresh"),
        ...(session.identity === undefined
          ? {}
          : { identity: session.identity }),
      };
      saveSession({ ...stored, session: refreshed });
      if (typeof data["id_token"] === "string" && data["id_token"] !== "") {
        const keep = (identity: z.infer<typeof Session>["identity"]) =>
          saveSession({
            ...stored,
            session: {
              ...refreshed,
              identity,
            },
          });
        try {
          const identity = await verifyIdToken(
            data["id_token"],
            { issuer: stored.issuer, clientId, now: now() },
            fetcher,
          );
          if (identity.subject !== stored.registration?.subject) {
            keep({
              state: "mismatch",
              reason: "the refreshed identity is a different ChatGPT account",
            });
            throw new OpenAiAuthError(
              "account-mismatch",
              "the refreshed identity is a different ChatGPT account; sign in again",
            );
          }
          keep(undefined);
        } catch (error) {
          if (!(error instanceof OpenAiAuthError)) throw error;
          if (error.code === "account-mismatch") throw error;
          if (error.transient) {
            // The keys could not be fetched: the tokens are used, the notice shown, the next refresh checks.
            keep({ state: "unverified", reason: error.message.slice(0, 300) });
            return {
              token: refreshed.accessToken,
              expiresAt: refreshed.expiresAt,
            };
          }
          keep({ state: "invalid", reason: error.message.slice(0, 300) });
          throw error;
        }
      }
      return { token: refreshed.accessToken, expiresAt: refreshed.expiresAt };
    },
    { signal: options.signal },
  );
};

const stoppedError = () =>
  new OpenAiAuthError(
    "stopped",
    "stopped before the refresh was sent; the sign-in is unchanged",
    true,
  );

/**
 * The stored session when it can be used or renewed, or the reason it cannot: signed out, no plan
 * usage, an identity a refresh found invalid or foreign, or an expired token with nothing to renew it.
 */
const sessionProblem = (auth: StoredAuth | undefined, now: number) => {
  const session = auth?.session;
  if (auth === undefined || session === undefined)
    throw new OpenAiAuthError(
      "signed-out",
      "not signed in to OpenAI; run neuve auth login openai",
    );
  if (!session.scopes.includes(PLAN_SCOPE))
    throw new OpenAiAuthError(
      "plan-usage-not-granted",
      "the OpenAI sign-in does not allow ChatGPT plan usage; run neuve auth login openai and allow it",
    );
  if (session.identity?.state === "mismatch")
    throw new OpenAiAuthError(
      "account-mismatch",
      "a refresh returned a different ChatGPT account; run neuve auth login openai",
    );
  if (session.identity?.state === "invalid")
    throw new OpenAiAuthError(
      "invalid-id-token",
      `a refresh returned an identity that did not verify (${session.identity.reason}); run neuve auth login openai`,
    );
  if (
    session.refreshToken === undefined &&
    session.expiresAt - now <= REFRESH_MARGIN_MS
  )
    throw new OpenAiAuthError(
      session.expiresAt <= now ? "access-expired" : "signed-out",
      "the OpenAI session cannot be renewed; run neuve auth login openai",
    );
  return session;
};

/**
 * Why this process cannot use the OpenAI route, or undefined when a sign-in with plan usage is on
 * file or a token command can be run. Tokens are not checked with the server, and the command is
 * not run.
 */
export const signInProblem = (options: AuthOptions = {}) => {
  try {
    const command = tokenCommandOf(options);
    if (command !== undefined) {
      try {
        accessSync(command, constants.X_OK);
      } catch {
        return `${TOKEN_COMMAND_VARIABLE} (${command}) is not a program this process can run`;
      }
      return undefined;
    }
    const { directory, now } = resolve(options);
    sessionProblem(readAuth(directory), now());
    return undefined;
  } catch (error) {
    return error instanceof OpenAiAuthError
      ? error.message
      : "the OpenAI sign-in could not be read";
  }
};

/** Whether a sign-in with plan usage is on file, or a token command can be run (`signInProblem`). */
export const signedIn = (options: AuthOptions = {}) =>
  signInProblem(options) === undefined;

// Leases (10.129)

/** Names the program a machine with no sign-in runs for an access token. */
export const TOKEN_COMMAND_VARIABLE = "NEUVE_OPENAI_TOKEN_COMMAND";
/** The exit status by which a token command says a later attempt can succeed (sysexits' EX_TEMPFAIL). */
export const LEASE_TEMPORARY_FAILURE = 75;
/** A refresher may first wait out another refresh's lock (`LOCK_WAIT_MS`), then refresh. */
const LEASE_TIMEOUT_MS = 90_000;
/**
 * The one refresher serves every machine and every model call, so under load it is often busy and
 * exits 75. A lease then tries four times, waiting about this long between tries (each wait jittered
 * by ±50%, so busy machines spread out), all within `LEASE_TIMEOUT_MS`.
 */
const LEASE_RETRY_DELAYS_MS = [500, 1_000, 2_000];
/**
 * A retry is skipped unless its run would still get this long after the wait: a run cut short by
 * the deadline would fail as a timeout and hide that the refresher was only busy.
 */
const LEASE_RETRY_MIN_RUN_MS = 1_000;
const LEASE_OUTPUT_LIMIT = 64 * 1024;

/**
 * What `neuve auth lease openai` prints and a token command must print: one JSON object, the access
 * token and its expiry in epoch milliseconds. Nothing else is leased: the refresh token, the ID
 * token and the registration stay with the refresher.
 */
export const Lease = z.strictObject({
  access_token: z.string().regex(/^[\x21-\x7e]{1,8192}$/),
  expires_at: z.number().int().positive(),
});
export type Lease = z.infer<typeof Lease>;

/**
 * The token command this call uses, if any. An explicit option wins; a `directory` option means the
 * sign-in folder. A process given both the variable and `NEUVE_OPENAI_AUTH_DIR` is refused rather
 * than guessed at: a review machine that refreshed a shared sign-in itself would race the refresher.
 */
const tokenCommandOf = (
  options: AuthOptions,
  env: Record<string, string | undefined> = process.env,
) => {
  if (options.tokenCommand === null) return undefined;
  if (options.tokenCommand === undefined && options.directory !== undefined)
    return undefined;
  const command = options.tokenCommand ?? env[TOKEN_COMMAND_VARIABLE];
  if (command === undefined || command === "") return undefined;
  if (!isAbsolute(command))
    throw new OpenAiAuthError(
      "configuration",
      `${TOKEN_COMMAND_VARIABLE} must be the absolute path of a program`,
    );
  const directory = env[AUTH_DIRECTORY_VARIABLE];
  if (
    options.tokenCommand === undefined &&
    directory !== undefined &&
    directory !== ""
  )
    throw new OpenAiAuthError(
      "configuration",
      `set either ${TOKEN_COMMAND_VARIABLE} (a machine that leases access tokens) or ${AUTH_DIRECTORY_VARIABLE} (the machine that holds the sign-in), not both`,
    );
  return command;
};

/** After the program exits, its output gets this long to close; a descendant holding it open is killed. */
const LEASE_DRAIN_MS = 1_000;

/** The token command's exit 75: the only failure a lease retries. */
class LeaseTemporaryFailure extends OpenAiAuthError {}

/**
 * Runs the token command once, in its own process group, so the time limit and the output cap stop
 * whatever it started too: a script that runs curl without `exec` and stalls is killed whole, and its
 * output is never awaited past the limit. Its standard error is discarded, and its output never quoted.
 */
const runTokenCommand = async (
  command: string,
  now: () => number,
  timeoutMs: number,
) => {
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "ignore">>;
  try {
    child = Bun.spawn([command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    });
  } catch {
    throw new OpenAiAuthError(
      "configuration",
      `${TOKEN_COMMAND_VARIABLE} (${command}) could not be run`,
    );
  }
  const killGroup = () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is gone already.
    }
  };
  const reader = child.stdout.getReader();
  let stopped: "timeout" | "too-long" | undefined;
  const stop = (why: "timeout" | "too-long") => {
    stopped ??= why;
    killGroup();
    void reader.cancel().catch(() => undefined);
  };
  const deadline = setTimeout(() => stop("timeout"), timeoutMs);
  let drain: ReturnType<typeof setTimeout> | undefined;
  void child.exited.then(() => {
    drain = setTimeout(() => stop("timeout"), LEASE_DRAIN_MS);
  });
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  let exitCode: number;
  try {
    while (true) {
      const next = await reader.read().catch(() => undefined);
      if (next === undefined || next.done) break;
      size += next.value.byteLength;
      if (size > LEASE_OUTPUT_LIMIT) {
        stop("too-long");
        break;
      }
      chunks.push(next.value);
    }
    if (stopped === undefined) killGroup();
    exitCode = await child.exited;
  } finally {
    clearTimeout(deadline);
    clearTimeout(drain);
  }
  if (stopped === "timeout")
    throw new OpenAiAuthError(
      "lease",
      `the token command ${command} did not finish within ${Math.round(timeoutMs / 100) / 10} s, or left a process holding its output; it was stopped`,
      true,
    );
  if (stopped === "too-long")
    throw new OpenAiAuthError(
      "lease",
      `the token command ${command} printed more than ${LEASE_OUTPUT_LIMIT / 1024} KiB; it was stopped`,
    );
  if (exitCode === LEASE_TEMPORARY_FAILURE && child.signalCode === null)
    throw new LeaseTemporaryFailure(
      "lease",
      `the token command ${command} exited with ${exitCode} (a temporary failure)`,
      true,
    );
  if (exitCode !== 0)
    throw new OpenAiAuthError(
      "lease",
      child.signalCode !== null
        ? `the token command ${command} was stopped (${child.signalCode})`
        : `the token command ${command} exited with ${exitCode}; check the refresher's sign-in`,
      child.signalCode !== null,
    );
  const parsed = safeRead(
    Lease,
    (() => {
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      } catch {
        return undefined;
      }
    })(),
    { source: "openai token-command lease" },
  );
  if (!parsed.success)
    throw new OpenAiAuthError(
      "lease",
      `the token command ${command} did not print a lease ({"access_token", "expires_at"})`,
    );
  if (parsed.data.expires_at <= now())
    throw new OpenAiAuthError(
      "lease",
      `the token command ${command} leased an access token that has already expired; check this machine's clock`,
      true,
    );
  return { token: parsed.data.access_token, expiresAt: parsed.data.expires_at };
};

/**
 * Runs the token command until it leases a token, retrying only exit 75 (the refresher is busy)
 * after a jittered wait, while the wait still leaves the retry `LEASE_RETRY_MIN_RUN_MS` before the
 * deadline; each run may take only the time left. Any other exit fails at once: the sign-in is gone, or this machine cannot ask.
 *
 * A run that times out is not retried, though it is transient: it has already spent the time left,
 * so a retry could only overrun the deadline. A stuck refresher fails the lease once, at the
 * deadline, and the caller's own retry decides what comes next.
 */
const leaseWithRetries = async (
  command: string,
  now: () => number,
  timeoutMs: number,
  delaysMs: ReadonlyArray<number>,
) => {
  const deadline = performance.now() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runTokenCommand(
        command,
        now,
        Math.max(1, deadline - performance.now()),
      );
    } catch (error) {
      const delay = delaysMs[attempt];
      if (!(error instanceof LeaseTemporaryFailure) || delay === undefined)
        throw error;
      const wait = delay * (0.5 + Math.random());
      if (wait + LEASE_RETRY_MIN_RUN_MS > deadline - performance.now())
        throw error;
      await Bun.sleep(wait);
    }
  }
};

const leases = new Map<
  string,
  Promise<{ readonly token: string; readonly expiresAt: number }>
>();

/**
 * A leased access token, held in this process's memory only: the last lease while it has more than
 * five minutes left, otherwise a new one. Calls that overlap share one lease, retries included.
 */
const leased = async (
  command: string,
  now: () => number,
  timeoutMs: number,
  delaysMs: ReadonlyArray<number>,
  rejected?: string,
) => {
  const cached = leases.get(command);
  if (cached !== undefined) {
    const lease = await cached.catch(() => undefined);
    if (
      lease !== undefined &&
      lease.token !== rejected &&
      lease.expiresAt - now() > REFRESH_MARGIN_MS
    )
      return lease;
    const current = leases.get(command);
    if (current !== undefined && current !== cached) return current;
  }
  const pending = leaseWithRetries(command, now, timeoutMs, delaysMs);
  leases.set(command, pending);
  pending.catch(() => {
    if (leases.get(command) === pending) leases.delete(command);
  });
  return pending;
};

/**
 * Forgets a leased token the provider refused (HTTP 401), so the next call asks the refresher again
 * rather than reusing a revoked token until it nears expiry. A token from the sign-in folder is
 * unaffected.
 */
export const rejectedToken = (token: string) => {
  for (const [command, pending] of leases)
    void pending.then(
      (lease) => {
        if (lease.token === token && leases.get(command) === pending)
          leases.delete(command);
      },
      () => undefined,
    );
};

const statusOf = (
  directory: string,
  auth: StoredAuth | undefined,
): AuthStatus => {
  const session = auth?.session;
  return {
    signedIn: session !== undefined,
    file: authFilePath(directory),
    email: auth?.registration?.email,
    name: auth?.registration?.name,
    clientRegistered: auth?.registration?.clientId !== undefined,
    planUsage: session?.scopes.includes(PLAN_SCOPE) === true,
    accessExpiresAt:
      session === undefined
        ? undefined
        : new Date(session.expiresAt).toISOString(),
    refreshExpiresBy:
      session === undefined || session.refreshToken === undefined
        ? undefined
        : new Date(
            Date.parse(session.refreshIssuedAt) + REFRESH_TOKEN_LIFETIME_MS,
          ).toISOString(),
    identityNotice:
      session?.identity === undefined
        ? undefined
        : `${session.identity.state}: ${session.identity.reason}`,
  };
};

/** The account and expiry on file. */
export const status = (options: AuthOptions = {}): AuthStatus => {
  const { directory } = resolve(options);
  return statusOf(directory, readAuth(directory));
};

/**
 * Signs out: revokes the refresh token at the issuer (one retry on a 5xx or network failure), then
 * clears the tokens. The registration and host ID stay, so a later sign-in reuses the client
 * (profiles-and-sessions: sign out). Returns whether the issuer confirmed the revocation.
 */
export const signOut = async (
  options: AuthOptions = {},
): Promise<{ readonly hadSession: boolean; readonly revoked: boolean }> => {
  const { directory, fetch: fetcher } = resolve(options);
  return withLock(directory, async () => {
    const stored = readAuth(directory);
    if (stored?.session === undefined)
      return { hadSession: false, revoked: false };
    const { session: _cleared, ...rest } = stored;
    const signedOut = authToWrite(directory, rest, true);
    let revoked = false;
    const clientId = stored.registration?.clientId;
    const token = stored.session.refreshToken;
    try {
      const discovery = await discover(stored.issuer, fetcher);
      if (
        discovery.revocation_endpoint !== undefined &&
        clientId !== undefined &&
        token !== undefined
      )
        for (let attempt = 0; attempt < 2 && !revoked; attempt += 1) {
          const response = await fetcher(discovery.revocation_endpoint, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(ISSUER_TIMEOUT_MS),
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token,
              token_type_hint: "refresh_token",
              client_id: clientId,
            }),
          }).catch(() => undefined);
          await response?.body?.cancel().catch(() => undefined);
          if (response?.status === 200) revoked = true;
          else if (response !== undefined && response.status < 500) break;
        }
    } catch {
      revoked = false;
    }
    persistAuth(directory, signedOut);
    return { hadSession: true, revoked };
  });
};
