const pages = new Set(["", "#dashboard", "#channels", "#issues", "#prs"])
const keys = new Set(["project", "channel", "chat", "repo", "pull", "issue"])

export function codingReturn(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192) return
  try {
    const url = new URL(value)
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      !pages.has(url.hash)
    )
      return
    for (const key of url.searchParams.keys()) {
      if (!keys.has(key) || url.searchParams.getAll(key).length !== 1) return
    }
    for (const [key, content] of url.searchParams) {
      if (!content || /[\u0000-\u001f\u007f]/.test(content)) return
      if (
        key === "project" &&
        (!content.startsWith("/") || content.length > 4096)
      )
        return
      if (key === "channel" && content.length > 512) return
      if (key === "repo" && !/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(content))
        return
      if (
        ["chat", "pull", "issue"].includes(key) &&
        (!/^\d+$/.test(content) ||
          !Number.isSafeInteger(Number(content)) ||
          Number(content) < (key === "chat" ? 0 : 1))
      )
        return
    }
    const has = (key: string) => url.searchParams.has(key)
    if (has("channel") !== has("chat")) return
    if (has("pull") && has("issue")) return
    if ((has("pull") || has("issue")) && !has("repo")) return
    if (has("channel") && (has("pull") || has("issue"))) return
    return url.href
  } catch {
    return
  }
}

export function codingReturnFrom(
  search: string,
  stored: unknown,
): string | undefined {
  const query = new URLSearchParams(search)
  if (!query.has("returnTo")) return codingReturn(stored)
  const supplied = query.getAll("returnTo")
  return supplied.length === 1 ? codingReturn(supplied[0]) : undefined
}
