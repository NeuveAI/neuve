import { createFileRoute, redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import { codingReturn } from "@/components/coding-return"

const WorkspaceSearch = z.object({
  session: z.string().min(1).max(512).optional().catch(undefined),
  chat: z.coerce.number().int().nonnegative().optional().catch(undefined),
})

const codingHome = createServerFn({ method: "GET" })
  .validator(WorkspaceSearch)
  .handler(({ data }) => {
    const home = codingReturn(process.env.NEUVE_CODING_URL)
    if (!home)
      throw new Error("Start Ace with bun workspace to open the coding home.")
    const url = new URL(home)
    if (data.session !== undefined) {
      url.searchParams.set("channel", data.session)
      url.searchParams.set("chat", String(data.chat ?? 1))
      url.hash = "channels"
    }
    return url.href
  })

export const Route = createFileRoute("/workspace")({
  validateSearch: WorkspaceSearch,
  beforeLoad: async ({ search }) => {
    throw redirect({ href: await codingHome({ data: search }) })
  },
})
