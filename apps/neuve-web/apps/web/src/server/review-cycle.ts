import { createServerFn } from "@tanstack/react-start"
import { Ulid } from "@neuve/records-schema"
import { z } from "zod"

import { cycleEntry } from "./reviews.server"

/** The unit a cycle's desk address opens on, across all its batches (`cycleEntry`). */
export const loadCycleEntry = createServerFn({ method: "GET" })
  .validator(z.strictObject({ cycle: Ulid }))
  .handler(({ data }) => cycleEntry(data.cycle))
