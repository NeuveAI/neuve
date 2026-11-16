import { parseArgs } from "node:util";
import type { Project } from "@ace/host/protocol";
import { codingReturnUrl } from "./workspace-review-links.ts";

export const parseWorkspaceOptions = (args: readonly string[]) =>
  parseArgs({
    args: [...args],
    strict: true,
    allowPositionals: false,
    options: {
      profile: { type: "string" },
      repo: { type: "string" },
      port: { type: "string" },
      "web-port": { type: "string" },
      user: { type: "string" },
      loopback: { type: "boolean" },
      help: { type: "boolean" },
    },
  }).values;

export function workspaceReady({
  project,
  repo,
  ...ready
}: {
  url: string;
  tokenFile: string;
  web: string;
  repository: string;
  pid: number;
  project: Project;
  repo: string | undefined;
}) {
  return {
    "neuve-host": "ready",
    ...ready,
    web:
      repo === undefined ? ready.web : codingReturnUrl(ready.web, project.path),
  };
}
