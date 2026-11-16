import { signedIn, type AuthOptions } from "./openai-auth.ts";
import type { AnyRouteConfig } from "./route.ts";

/** The public sign-in owner and catalogue probe used by the auth command. */
export * as OpenAiAuth from "./openai-auth.ts";
export * as OpenAiProvider from "./openai-route.ts";

/** The OpenAI route's API base (sign-in guide: the public Responses API, never `backend-api`). */
export { OPENAI_BASE_URL } from "./provider-urls.ts";

/**
 * Whether this process can use the route: the key variable is set, or the OpenAI sign-in is on
 * file with plan usage allowed. No credential value is read into the answer.
 */
export const credentialPresent = (
  route: AnyRouteConfig,
  auth: AuthOptions = {},
) => {
  if (route.provider === "openai") return signedIn(auth);
  const value = process.env[route.credentialVariable];
  return value !== undefined && value.trim() !== "";
};
