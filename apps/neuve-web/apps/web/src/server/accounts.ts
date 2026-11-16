import { createServerFn } from "@tanstack/react-start"
import { currentAccounts } from "./accounts.server"

export const loadAccounts = createServerFn({ method: "GET" }).handler(() =>
  currentAccounts()
)
