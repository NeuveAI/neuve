import { atom } from "jotai"
import type { AccountStatus } from "@neuve/runtime/status"
import { accountsCopy } from "./accounts-copy"

/** Undefined until the stream has spoken. An empty set is an authoritative update. */
export const accountsAtom = atom<readonly AccountStatus[] | undefined>(
  undefined
)

const confirmationAtom = atom("")
export const accountCopyConfirmationAtom = atom((get) => get(confirmationAtom))
const timerAtom = atom<ReturnType<typeof setTimeout> | undefined>(undefined)
export const copyAccountCommandAtom = atom(
  null,
  async (get, set, command: string) => {
    try {
      await navigator.clipboard.writeText(command)
      set(confirmationAtom, accountsCopy.copied)
    } catch {
      set(confirmationAtom, accountsCopy.copyFailed)
    }
    clearTimeout(get(timerAtom))
    set(
      timerAtom,
      setTimeout(() => set(confirmationAtom, ""), 2_000)
    )
  }
)
