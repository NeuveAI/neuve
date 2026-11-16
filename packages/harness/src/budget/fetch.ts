import type { Budget } from "./scheduler.ts";

/** The owner of an HTTP response reports its throttle once. Observations cannot refuse a response. */
export const budgetFetch = (
  fetch: typeof globalThis.fetch,
  budget: Budget,
  account: string,
): typeof globalThis.fetch =>
  Object.assign(
    async (...args: Parameters<typeof globalThis.fetch>) => {
      const response = await fetch(...args);
      if (response.status === 429 || response.headers.has("retry-after"))
        await budget
          .throttle(
            account,
            response.headers.has("retry-after"),
            response.status === 429,
          )
          .catch(() => {});
      return response;
    },
    { preconnect: fetch.preconnect },
  );
