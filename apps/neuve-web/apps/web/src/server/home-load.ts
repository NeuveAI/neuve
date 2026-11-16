import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"
import type { HomeLoad } from "@workspace/ui/neuve/home/home-data"

import { homeLoad } from "./home.server"

/**
 * `/`: the home page's load, a page and a filter of the repository's
 * reviews, each with its batches and their digests (`homeLoad`).
 */
export const loadHome = createServerFn({ method: "GET" })
  .validator(
    z.strictObject({
      page: z.number().int().min(1).max(10_000),
      filter: z.enum(["all", "waiting"]),
    })
  )
  .handler(({ data }): Promise<HomeLoad> => homeLoad(data))
