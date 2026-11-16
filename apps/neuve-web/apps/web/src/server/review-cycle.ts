import { createServerFn } from "@tanstack/react-start"
import { Ulid } from "@neuve/records-schema"
import { z } from "zod"
import { reviewCycle } from "./review-cycle.server"
export const loadReviewCycle = createServerFn({ method: "GET" })
  .validator(z.strictObject({ cycle: Ulid }))
  .handler(({ data }) => reviewCycle(data.cycle))
