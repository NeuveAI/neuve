/** Technical detail of a route error, for the collapsed "Details". */
export function errorDetail(error: unknown): string | undefined {
  if (error instanceof Error)
    return error.name && error.name !== "Error"
      ? `${error.name}: ${error.message}`
      : error.message || undefined
  if (typeof error === "string") return error || undefined
  return undefined
}
