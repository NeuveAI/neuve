import { createServerFn } from "@tanstack/react-start"
import { Ulid } from "@neuve/records-schema"
import { z } from "zod"
import type { HomeLoad } from "@workspace/ui/neuve/home/home-data"

import { clearList, homeLoad } from "./home.server"

/**
 * `/`: the home page's load, a page and a filter of the repository's
 * reviews, each with its batches and their digests (`homeLoad`); with a
 * cycle, that one review (`/cycles/<cycle>`, `/?cycle=<cycle>`).
 */
export const loadHome = createServerFn({ method: "GET" })
  .validator(
    z.strictObject({
      page: z.number().int().min(1).max(10_000),
      filter: z.enum(["all", "waiting"]),
      cycle: Ulid.optional(),
    })
  )
  .handler(({ data }): Promise<HomeLoad> => homeLoad(data))

/**
 * "Clear" on the default list, or its undo: a POST behind the CSRF
 * middleware in src/start.ts (ID2).
 */
export const requestClear = createServerFn({ method: "POST" })
  .validator(z.strictObject({ restore: z.boolean() }))
  .handler(({ data }): Promise<void> => clearList(data.restore))
