/*
 * Tuned timing values, kept for this tab's session in `vite dev` only.
 * entry-client calls loadTuning() before any part starts, under
 * import.meta.env.DEV, so the built site never reads it.
 */
const KEY = "neuve-website-tuning";

type Tables = Record<string, Record<string, number>>;

const read = (): Tables => {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "{}") as Tables;
  } catch {
    return {};
  }
};

export function saveTuning(part: string, table: Record<string, number>) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...read(), [part]: table }));
  } catch {
    // Storage can be unavailable; tuning then lasts until reload.
  }
}

/** Copies saved values into the named tables, before the motion starts. */
export function loadTuning(tables: Record<string, Record<string, number>>) {
  const saved = read();
  for (const [part, table] of Object.entries(tables))
    for (const [key, value] of Object.entries(saved[part] ?? {}))
      if (key in table && typeof value === "number") table[key] = value;
}
