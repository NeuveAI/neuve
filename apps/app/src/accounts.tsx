import { useSyncExternalStore } from "react";
import { Button } from "@ace/ui";
import { signInCommand } from "@neuve/runtime/sign-in-command";
import type { AccountStatus } from "@neuve/runtime/status";
import type { GatewayClient } from "@ace/host/gateway-client";
import { Group, Row, Status } from "./settings-layout";
import {
  accountDescription,
  accountHint,
  accountLabel,
  accountsCopy,
  accountTime,
  currentLimits,
  limitDescription,
  showsCheckTime,
} from "./accounts-copy";

const copyListeners = new Set<() => void>();
let confirmation = "";
let clear: ReturnType<typeof setTimeout> | undefined;
const copySnapshot = () => confirmation;
function subscribeCopy(listener: () => void) {
  copyListeners.add(listener);
  return () => {
    copyListeners.delete(listener);
    if (copyListeners.size) return;
    clearTimeout(clear);
    confirmation = "";
  };
}
async function copy(command: string) {
  try {
    await navigator.clipboard.writeText(command);
    confirmation = accountsCopy.copied;
  } catch {
    confirmation = accountsCopy.copyFailed;
  }
  clearTimeout(clear);
  for (const listener of copyListeners) listener();
  clear = setTimeout(() => {
    confirmation = "";
    for (const listener of copyListeners) listener();
  }, 2_000);
}

const email = ({ signIn }: AccountStatus) =>
  signIn.state === "signed-in" ? signIn.email : undefined;

/**
 * One row per sign-in. Accounts of one kind are the same sign-in reached through different
 * runtimes unless they are signed in as different people; a row shows its signed-in account, with
 * the limits whichever signed-in account reports.
 */
function signIns(accounts: readonly AccountStatus[]) {
  const groups: AccountStatus[][] = [];
  for (const account of accounts) {
    const group = groups.find(
      (members) =>
        members[0]!.kind === account.kind &&
        members.every(
          (member) =>
            !email(member) || !email(account) || email(member) === email(account),
        ),
    );
    if (group) group.push(account);
    else groups.push([account]);
  }
  return groups.map((members) => {
    const signedIn = members.filter((member) => member.signIn.state === "signed-in");
    const shown = signedIn[0] ?? members[0]!;
    return { ...shown, limits: (signedIn.find((member) => member.limits.length) ?? shown).limits };
  });
}

/** The real Settings group also used by the dev-only fixture page. */
export function Accounts({
  accounts,
  loading = false,
}: {
  accounts: readonly AccountStatus[] | undefined;
  loading?: boolean;
}) {
  const copied = useSyncExternalStore(subscribeCopy, copySnapshot);
  const subscriptions =
    accounts &&
    signIns(
      accounts.filter(
        (account) =>
          account.kind === "claude-subscription" ||
          account.kind === "chatgpt-subscription",
      ),
    );
  if (!loading && !subscriptions?.length) return null;
  return (
    <Group title={accountsCopy.title}>
      {loading && accounts === undefined ? (
        <p className="text-xs/relaxed text-muted-foreground">
          {accountsCopy.loading}
        </p>
      ) : (
        subscriptions?.map((account) => {
          const hint = accountHint(account.signIn);
          const command = hint && signInCommand(hint);
          // An account's name is shown only to tell two sign-ins of one provider apart.
          const label =
            subscriptions.filter(({ kind }) => kind === account.kind).length > 1
              ? accountLabel(account)
              : accountsCopy.providers[account.kind];
          return (
            <Row
              key={`${account.kind}:${account.name}`}
              label={label}
              description={accountDescription(account.kind, account.signIn)}
              footer={
                <div className="flex min-w-0 flex-col gap-2">
                  {currentLimits(account.limits).map((window, index) => {
                    return (
                      <p
                        key={index}
                        className={
                          window.status === "rejected"
                            ? "text-xs/relaxed break-words text-destructive"
                            : "text-xs/relaxed text-muted-foreground"
                        }
                      >
                        {limitDescription(window)}
                        {window.resetsAt && (
                          <>
                            {" "}
                            · {accountsCopy.resets}{" "}
                            <time dateTime={window.resetsAt}>
                              {accountTime(window.resetsAt)}
                            </time>
                          </>
                        )}
                      </p>
                    );
                  })}
                  {showsCheckTime(account.signIn) && (
                    <p className="text-xs text-muted-foreground">
                      {accountsCopy.checked}{" "}
                      <time dateTime={account.checkedAt}>
                        {accountTime(account.checkedAt)}
                      </time>
                    </p>
                  )}
                  {hint?.kind === "settings" && (
                    <p className="text-xs text-muted-foreground">
                      {accountsCopy.settings}
                    </p>
                  )}
                  {command && (
                    <div className="flex min-w-0 items-start gap-3">
                      <code
                        translate="no"
                        className="min-w-0 flex-1 break-all rounded-md bg-muted/50 p-2 text-xs"
                      >
                        {command}
                      </code>
                      <Button
                        variant="outline"
                        aria-label={`${accountsCopy.copy} ${label}`}
                        onClick={() => void copy(command)}
                      >
                        {accountsCopy.copy}
                      </Button>
                    </div>
                  )}
                </div>
              }
            />
          );
        })
      )}
      <Status>{copied}</Status>
    </Group>
  );
}

export function HostAccounts({ host }: { host: GatewayClient }) {
  const accounts = useSyncExternalStore(host.subscribe, () => host.accounts);
  const open = useSyncExternalStore(
    host.subscribe,
    () => host.status === "open",
  );
  return (
    <Accounts accounts={accounts} loading={accounts === undefined && open} />
  );
}
