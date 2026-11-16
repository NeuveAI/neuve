import type {
  AccountStatus,
  LimitWindow,
  SignInState,
} from "@neuve/runtime/status"

export const accountsCopy = {
  title: "Accounts",
  loading: "Loading…",
  empty: "No accounts",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Couldn't copy the command",
  settings: "Add a key in Settings → Providers in the coding app",
  checked: "Checked",
  resets: "resets",
  reached: "reached",
  used: "used",
  providers: {
    "claude-subscription": "Claude",
    "chatgpt-subscription": "ChatGPT",
    "anthropic-api-key": "Anthropic",
    "openai-api-key": "OpenAI",
  },
  runtime: {
    "not-installed": "Claude Code isn't installed",
    "not-registered": "Claude Code isn't set up for Neuve",
    "unsupported-version": "Claude Code needs a newer version",
    "start-failed": "Claude Code couldn't start",
  },
  windows: {
    "five-hour": "5-hour limit",
    weekly: "Weekly limit",
    "weekly-model": "Weekly limit",
    overage: "Extra usage",
    other: "Limit",
  },
}

export function accountLabel(account: Pick<AccountStatus, "name" | "kind">) {
  return `${accountsCopy.providers[account.kind]} · ${account.name}`
}

export function accountDescription(
  kind: AccountStatus["kind"],
  signIn: SignInState
): string {
  switch (signIn.state) {
    case "signed-in":
      if (signIn.sourceMatchesAccount === false)
        return "Signed in through a credential from the environment, not this account"
      return [
        signIn.email ? `Signed in as ${signIn.email}` : "Signed in",
        signIn.plan,
      ]
        .filter(Boolean)
        .join(" · ")
    case "not-signed-in":
      return "Not signed in"
    case "credential-rejected":
      return `${accountsCopy.providers[kind]} rejected this sign-in`
    case "runtime-unavailable":
      return accountsCopy.runtime[signIn.reason]
    case "unknown":
      return signIn.reason === "not-checked"
        ? "Not checked yet"
        : "Couldn't check this account"
  }
}

export function limitDescription(window: LimitWindow) {
  const label =
    accountsCopy.windows[window.window] +
    (window.window === "weekly-model" && window.model
      ? ` (${window.model})`
      : "")
  if (window.status === "rejected") return `${label} ${accountsCopy.reached}`
  return window.utilization === undefined
    ? label
    : `${label}: ${Math.round(window.utilization * 100)}% ${accountsCopy.used}`
}

export function accountHint(signIn: SignInState) {
  return "hint" in signIn ? signIn.hint : undefined
}

export function accountTime(value: string) {
  const date = new Date(value)
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(Math.abs(date.getTime() - Date.now()) >= 86_400_000
      ? { weekday: "short" }
      : {}),
  })
}
