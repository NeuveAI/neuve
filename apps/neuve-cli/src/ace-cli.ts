#!/usr/bin/env bun
import { configureRuntime } from "@ace/host/runtime-hooks";
import { runAceReviewCommand } from "./ace-review-command.ts";
import {
  configureWorkspaceCli,
  useWorkspaceProject,
} from "./workspace-runtime.ts";

const args = process.argv.slice(2);
if (
  args[0] !== "review" &&
  args.length &&
  !args.some((arg) => ["--help", "-h", "--version"].includes(arg))
)
  await configureWorkspaceCli(args);
useWorkspaceProject();
configureRuntime({ command: runAceReviewCommand });
if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
  console.log(
    "  ace review <base>..<head> [--repo <path>]   request a Neuve review in Records",
  );
}
await import("@ace/host/cli");
