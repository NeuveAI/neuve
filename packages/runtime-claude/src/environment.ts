import type { Account, SignInHint } from "@neuve/runtime";

export type ClaudeAccount = Extract<Account, { kind: "claude-subscription" }>;
export const CLIENT_APP = "neuve/0.1.0";
/** sdk.mjs:150 host-auth lists IYe, $Ut, Hx, jp, zx and HUt; sdk.mjs:152 OAuth switches.
 * sdk.mjs:27 also exports CLOUDSDK_AUTH_ACCESS_TOKEN and ENVIRONMENT_SERVICE_KEY.
 * Names are filtered before accessing values. Claude Code alone handles credentials.
 */
export const REMOVED_ENVIRONMENT = [
  "USE_LOCAL_OAUTH",
  "USE_STAGING_OAUTH",
  "ELECTRON_RUN_AS_NODE",
  "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
  "CCR_AGENT_PROXY_TOKEN_FILE_DESCRIPTOR",
  "AGENT_PROXY_AUTH_TOKEN",
  "ENVIRONMENT_SERVICE_KEY",
  "CLOUDSDK_AUTH_ACCESS_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "GCE_METADATA_HOST",
  "GCE_METADATA_ROOT",
  "GCE_METADATA_IP",
  "METADATA_SERVER_DETECTION",
  "CLOUD_ML_REGION",
  "DISABLE_GROWTHBOOK",
  // Existing cloud credential exclusions, documented by the provider authentication guides.
  "AZURE_CLIENT_SECRET",
  "AZURE_CLIENT_ID",
  "AZURE_TENANT_ID",
] as const;
export const REMOVED_PREFIXES = [
  "CLAUDE",
  "ANTHROPIC_",
  "MCP_",
  "AWS_BEARER",
] as const;
const removed = new Set<string>(REMOVED_ENVIRONMENT);
export function childEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  account: ClaudeAccount,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of Object.keys(parent)) {
    if (
      !removed.has(name) &&
      !REMOVED_PREFIXES.some((prefix) => name.startsWith(prefix))
    )
      env[name] = parent[name];
  }
  if (account.credential.folder !== undefined)
    env.CLAUDE_CONFIG_DIR = account.credential.folder;
  return {
    ...env,
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: "0",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP,
  };
}
export function signInHint(account: ClaudeAccount): SignInHint {
  return {
    kind: "command",
    command: "claude auth login",
    ...(account.credential.folder === undefined
      ? {}
      : { environment: { CLAUDE_CONFIG_DIR: account.credential.folder } }),
  };
}
