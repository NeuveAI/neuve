import { readFileSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { budgetDirectory } from "../packages/harness/src/budget/local.ts";

// Claude Code only honors this socket setting from user or managed settings.
// https://code.claude.com/docs/en/settings-reference#sandbox-network-allowunixsockets
const Settings = z.looseObject({
  sandbox: z
    .looseObject({
      network: z
        .looseObject({ allowUnixSockets: z.array(z.string()).optional() })
        .optional(),
    })
    .optional(),
});
export const allowBudgetSocket = (input: unknown, socket: string) => {
  const settings = Settings.parse(input);
  const allowed = settings.sandbox?.network?.allowUnixSockets ?? [];
  return {
    ...settings,
    sandbox: {
      ...settings.sandbox,
      network: {
        ...settings.sandbox?.network,
        allowUnixSockets: [...new Set([...allowed, socket])],
      },
    },
  };
};
if (import.meta.main) {
  const file = realpathSync(
    Bun.argv[2] ?? join(homedir(), ".claude", "settings.json"),
  );
  const socket = join(budgetDirectory(), "budget.sock");
  const settings = allowBudgetSocket(
    JSON.parse(readFileSync(file, "utf8")),
    socket,
  );
  const temporary = `${file}.budget-${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, file);
  process.stdout.write(`Allowed the budget socket: ${socket}\n`);
}
