import { useSyncExternalStore } from "react"
import { useAtomValue, useSetAtom } from "jotai"
import type { AccountStatus } from "@neuve/runtime/status"
import { signInCommand } from "@neuve/runtime/sign-in-command"
import { CSS_TRANSITION } from "@workspace/ui/lib/motion"
import { cn } from "@workspace/ui/lib/utils"
import {
  accountCopyConfirmationAtom,
  copyAccountCommandAtom,
} from "./accounts-atoms"
import {
  accountDescription,
  accountHint,
  accountLabel,
  accountsCopy,
  accountTime,
  limitDescription,
} from "./accounts-copy"

const subscribeHydration = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false
function AccountTime({ value }: { value: string }) {
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientSnapshot,
    serverSnapshot
  )
  return <time dateTime={value}>{hydrated ? accountTime(value) : ""}</time>
}

export function AccountsSection({
  accounts,
}: {
  accounts: readonly AccountStatus[]
}) {
  const copied = useAtomValue(accountCopyConfirmationAtom)
  const copy = useSetAtom(copyAccountCommandAtom)
  return (
    <section
      id="accounts"
      aria-labelledby="accounts-title"
      className="flex max-w-[640px] scroll-mt-6 flex-col gap-5"
    >
      <h2
        id="accounts-title"
        className="m-0 text-[32px] leading-[38px] font-semibold tracking-[-0.025em]"
      >
        {accountsCopy.title}
      </h2>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {accounts.map((account) => {
          const hint = accountHint(account.signIn)
          const subscription =
            account.kind === "claude-subscription" ||
            account.kind === "chatgpt-subscription"
          const command = subscription && hint ? signInCommand(hint) : undefined
          return (
            <li
              key={`${account.kind}:${account.name}`}
              className="flex min-w-0 flex-col gap-2 rounded-xl bg-surface px-4 py-3.5 shadow-[0_0_0_1px_var(--nv-line)]"
            >
              <div>
                <h3 className="m-0 text-sm font-normal text-ink">
                  {accountLabel(account)}
                </h3>
                <p className="m-0 text-[13px] leading-[19px] break-words text-ink-muted">
                  {accountDescription(account.kind, account.signIn)}
                </p>
              </div>
              {account.limits.map((window, index) => (
                <p
                  key={index}
                  className={cn(
                    "m-0 text-[13px] leading-[19px]",
                    window.status === "rejected"
                      ? "text-destructive"
                      : window.status === "warning"
                        ? "text-ink"
                        : "text-ink-muted"
                  )}
                >
                  {limitDescription(window)}
                  {window.resetsAt && (
                    <>
                      {" "}
                      · {accountsCopy.resets}{" "}
                      <AccountTime value={window.resetsAt} />
                    </>
                  )}
                </p>
              ))}
              {(account.signIn.state === "unknown" ||
                account.signIn.state === "credential-rejected") && (
                <p className="m-0 text-[13px] text-ink-muted">
                  {accountsCopy.checked}{" "}
                  <AccountTime value={account.checkedAt} />
                </p>
              )}
              {hint?.kind === "settings" && (
                <p className="m-0 text-[13px] text-ink-muted">
                  {accountsCopy.settings}
                </p>
              )}
              {command && (
                <div className="flex min-w-0 items-start gap-3">
                  <code
                    translate="no"
                    className="min-w-0 flex-1 rounded-md bg-raised px-2 py-1.5 text-xs leading-5 break-all text-ink"
                  >
                    {command}
                  </code>
                  <button
                    type="button"
                    aria-label={`${accountsCopy.copy} ${accountLabel(account)}`}
                    className={cn(
                      "shrink-0 rounded-md px-3 py-1.5 text-[13px] text-ink shadow-[0_0_0_1px_var(--nv-line)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid pointer-coarse:min-h-11 pointer-fine:hover:bg-raised-2",
                      CSS_TRANSITION.tone
                    )}
                    onClick={() => void copy(command)}
                  >
                    {accountsCopy.copy}
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {!accounts.length && (
        <p className="m-0 text-[13px] text-ink-muted">{accountsCopy.empty}</p>
      )}
      <p
        role="status"
        aria-live="polite"
        className="m-0 min-h-5 text-[13px] text-ink-muted"
      >
        {copied}
      </p>
    </section>
  )
}
