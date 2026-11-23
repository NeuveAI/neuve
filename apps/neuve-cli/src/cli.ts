#!/usr/bin/env bun

import { publicCloseReason } from "../../../packages/harness/src/pi/capture/close-diagnostic.ts";
import { runAuthCli } from "./auth-cli.ts";
import { parseQueryInvocation } from "./boundary.ts";
import { collectPublicQueryResult, runQueryGraph } from "./graph-query.ts";
import type { PublicQueryEvent } from "./domain.ts";
import { runRecordsCli } from "./records-cli.ts";
import { runRelationsCli } from "./relations-cli.ts";
import { runReviewCli, PublicReviewError } from "./review-cli.ts";
import { runMcp } from "./mcp.ts";
import { runProofCli } from "./proof-cli.ts";
import { runSemanticCli } from "./semantic-cli.ts";
import { runHybridCli } from "./hybrid-cli.ts";
import { runVentCli, runVentsCli } from "./vent-cli.ts";
import { runJobsCli, runWorkerCli } from "./worker-cli.ts";
import { runAgentsCli } from "./capture/agents-cli.ts";
import { runHook } from "./capture/hook-cli.ts";
import { runSetupHooks } from "./capture/setup-hooks.ts";
import { runSetupStack, runStackCli } from "./stack-cli.ts";

import { REVIEW_DESK_COMMAND } from "./review-desk-config.ts";
import { runSetup, runSetupUpgrade } from "./setup.ts";
import { runSkillsCli } from "./skills-cli.ts";
import { CLI_VERSION, RELEASE_BUILD } from "./cli-version.ts";

/**
 * The CLI's version (cli-version.ts: a release build's NEUVE_BUILD_VERSION, else the package's),
 * which the review desk built beside it and the Neuve skill record too.
 */
const VERSION = `neuve ${CLI_VERSION}`;

// The workspace isn't part of a release yet, so a release build's help leaves it out.
const WORKSPACE_HELP = RELEASE_BUILD
  ? ""
  : `
  workspace [--profile <pi-transition|local|profile.json>] [--repo <path>] [--port <n>] [--web-port <n>] [--loopback]
              Start Neuve with its configured team connections and a loopback coding web app.`;

const HELP = `Usage:
  neuve query --repo <absolute-path> --revision <commit> --question <text> \\
    --max-results <count> --max-context-bytes <bytes> \\
    --relationship-plan <json-array> [--scope <path>]... [--branch <name>] [--stream] [--refresh-cache | --prepared-only] [--profile full|syntax-only]

Commands:
  upgrade [--version vX.Y.Z]
              Upgrade to the latest release, or the --version tag, through its checksum-checked install script.
  setup [--repo <path>] [--route openai|anthropic|claude] [--agents claude-code,codex|none]
    [--ask-install-again] [--graph-binary <path>] [--cli-binary <path>] [--no-skills] [--json]
              Set Neuve up in a repository: record this neuve and its Graph engine, check that
              the engine can work there, and choose how reviews sign in (ChatGPT, an Anthropic
              API key, or a Claude subscription through Claude Code). Run it once before neuve
              review. It then looks for the agent programs here, says what it found, and offers
              the npm package of one it doesn't find (default no). At a terminal it then offers
              the Neuve skill once per repository; --no-skills skips the offer.
  setup upgrade
              Run the setup steps a newly installed version adds, and undo those it drops, on
              this machine and in each repository set up here. The install script runs it.
  setup hooks [--repo <path>] [--agents claude-code,codex|none] [--dry-run]
              Capture commits and agent sessions in this repository. Run
              neuve setup hooks --help for the files it changes.
  setup stack [--repo <path>] [--off] [--dry-run]
              Fetch, in the background, a read-only copy of the framework and dependency
              sources this repository's lockfiles pin. setup hooks runs it unless --no-stack.
  stack list [--revision <commit>] [--json] [--repo <path>]
              List the stack sources a revision pins, with their read-only folders and gaps.
  skills list|install|uninstall [--agents claude-code,codex] [--scope user|repo] [--dry-run]
              Install the Neuve skill, which teaches Claude Code and Codex to use Neuve. Run
              neuve skills --help for the folders it writes.
  agents [current] [--json] [--repo <path>]
              List agent and human actors with aliases, models, turns and commits.
  records history|get|rebuild|fsck|stats|migrate|ingest|prune|feedback [--repo <path>]
              Read and maintain the Records store in <git common directory>/neuve/.
              Run neuve records --help for each command's options.
  worker run|start|status|stop|sweep|install-agent|uninstall-agent [--repo <path>]
              Run or inspect the repository's single background worker.
  jobs [list|inspect|drop|enqueue] [--json] [--repo <path>]
              List, inspect, drop or enqueue background jobs.
  auth list|status|add|login|logout|remove|lease [<account>]
              Sign in and manage the accounts reviews run on: ChatGPT (openai), your Claude
              subscription (claude) and accounts added with auth add. Run neuve auth --help for
              the options.
  doctor [--repo <path>] [--json]
              Check this machine and repository for what a review needs, and say how to fix
              what is missing. It only reads.${WORKSPACE_HELP}
  review <base>..<head> [--route <name>] [--detach] [--repo <path>]
              Request a review of a commit range and follow its run in the background worker.
              Run neuve setup in the repository first.
  review ${REVIEW_DESK_COMMAND} [--repo <path>] [--port <n>]
              Open the batch overview and the review desk for the repository.
  review show [<base>..<head> | --run <id>] [--json] [--repo <path>]
              Print a run's receipt. Run neuve review --help for the options.
  review export-dump --run <id> --root <dir> [--redaction restricted|portable] [--repo <path>]
              File a run's latest session-dump snapshot for a dataset and print it as JSON.
  relations prepare <base>..<head> [--json] [--timeout <seconds>] [--repo <path>]
              Store the Graph relations of a range's head and merge base before its review.
              Run neuve relations --help for the output and exit codes.
  vent <text> [--reconciliation-id <id>] [--session <harness>:<session id>] [--repo <path>]
              Optional: say what is making this agent session difficult. One per session, or
              per review cycle with --reconciliation-id.
  vents [--since 7d] [--agent <alias>] [--run <id>] [--json] [--repo <path>]
              List agents' vents.
  proof record|list|reader|stats <base>..<head> [--repo <path>]
              Record observed proof for a range (test runs, type checks, logs, telemetry,
              screenshots, video) and list it with each record's currency. Run neuve proof
              --help for the options.
  mcp [--repo <path>]
              Serve the vent and record_proof tools over MCP on stdio, for the agent session
              that starts it.
  semantic --input <json> --python <absolute-path> --snapshot <absolute-path>
    --worker <absolute-path> --variant BASE|TUNED [--artifact-reference <ref>]
              Encode supplied text and optionally score a supplied pool locally.
              Input is version 1 with inputs [{id,role,text,title?}] and optional
              pool {queryId,candidateIds,limit}. Source qualification is not established.
              TUNED refuses until its artifact is qualified; it never falls back to BASE.
  hybrid prepare --rev <revision> [--repo <path>]
              Hybrid leads' first pass: encode a tree's chunks on this machine. Heavy; run it
              only in a measured slot. Run neuve hybrid --help for more.
  query       Return revision-bound retrieval and requested relationships.

Options:
  Relationship plan entries may opt into summary "frontier".
  --branch <name>  Use this local branch for the review cycle, defaulting to the checked-out branch.
  --scope <path>   Name a local scope file. Repeat for more files. Relative paths start at --repo.
  --max-context-bytes <bytes>  Set the code context allowance. Scope text gets a separate allowance of the same size.
  --stream    Write ordered query events as NDJSON.
  --refresh-cache  Rebuild the committed snapshot before retrieval.
  --prepared-only Query the exact prepared revision without indexing or structural rebuilding.
                  Requires exact-commit prepared-read support; no source worktree or fallback.
  --profile   Full by default. Syntax-only requires prepared-only and declares only syntax relations.
  --version   Print the binary version.
  --help      Print this help text.`;

const runQuery = async (args: readonly string[]): Promise<number> => {
  const invocation = parseQueryInvocation(args);
  const events: PublicQueryEvent[] = [];
  const controller = new AbortController();
  let interrupted: Readonly<{ name: string; exitCode: number }> | undefined;
  const interrupt = (name: string, exitCode: number): void => {
    interrupted ??= { name, exitCode };
    controller.abort();
  };
  const onInterrupt = (): void => interrupt("SIGINT", 130);
  const onTerminate = (): void => interrupt("SIGTERM", 143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    await runQueryGraph(invocation.request, {
      signal: controller.signal,
      emit: async (event) => {
        if (invocation.output === "ndjson") {
          await Bun.write(Bun.stdout, `${JSON.stringify(event)}\n`);
        } else {
          events.push(event);
        }
      },
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === "AbortError" &&
      interrupted !== undefined
    ) {
      await Bun.write(
        Bun.stderr,
        `neuve: interrupted by ${interrupted.name}\n`,
      );
      return interrupted.exitCode;
    }
    throw error;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
  if (invocation.output === "json") {
    await Bun.write(
      Bun.stdout,
      `${JSON.stringify(collectPublicQueryResult(events), null, 2)}\n`,
    );
  }
  return 0;
};

const main = async (args: readonly string[]): Promise<number> => {
  const command = args[0];
  if (command === "--version" || command === "version") {
    await Bun.write(Bun.stdout, `${VERSION}\n`);
    return 0;
  }
  if (command === "--help" || command === "help" || command === undefined) {
    await Bun.write(Bun.stdout, `${HELP}\n`);
    return 0;
  }
  if (command === "hook") return runHook(args.slice(1));
  if (command === "upgrade")
    return (await import("./upgrade-cli.ts")).runUpgradeCli(args.slice(1));
  if (command === "setup" && args[1] === "hooks")
    return runSetupHooks(args.slice(2));
  if (command === "setup" && args[1] === "stack")
    return runSetupStack(args.slice(2));
  if (command === "setup" && args[1] === "upgrade")
    return runSetupUpgrade(args.slice(2));
  if (command === "stack") return runStackCli(args.slice(1));
  if (command === "skills") return runSkillsCli(args.slice(1));
  if (command === "agents") return runAgentsCli(args.slice(1));
  if (command === "setup") return runSetup(args.slice(1));
  if (command === "records") return runRecordsCli(args.slice(1));
  if (command === "worker") return runWorkerCli(args.slice(1));
  if (command === "jobs") return runJobsCli(args.slice(1));
  if (command === "auth") return runAuthCli(args.slice(1));
  if (command === "doctor") {
    const { runDoctor } = await import("./doctor.ts");
    return runDoctor(args.slice(1), CLI_VERSION);
  }
  if (command === "workspace") {
    if (RELEASE_BUILD)
      throw new Error("neuve workspace isn't part of this release.");
    const { runWorkspaceCli } = await import("./workspace-cli.ts");
    return runWorkspaceCli(args.slice(1));
  }
  if (command === "review" && args[1] === REVIEW_DESK_COMMAND) {
    const { runReviewDesk } = await import("./review-desk.ts");
    return runReviewDesk(args.slice(2), CLI_VERSION);
  }
  if (command === "review") return runReviewCli(args.slice(1));
  if (command === "relations") return runRelationsCli(args.slice(1));
  if (command === "vent") return runVentCli(args.slice(1));
  if (command === "vents") return runVentsCli(args.slice(1));
  if (command === "proof") return runProofCli(args.slice(1));
  if (command === "mcp") return runMcp(args.slice(1));
  if (command === "semantic") return runSemanticCli(args.slice(1));
  if (command === "hybrid") return runHybridCli(args.slice(1));
  if (command !== "query") {
    throw new Error(`Unknown command: ${command}. Run neuve --help for usage.`);
  }
  return runQuery(args.slice(1));
};

try {
  process.exitCode = await main(Bun.argv.slice(2));
} catch (error) {
  const captureCommand =
    Bun.argv[2] === "review" &&
    [
      "audit",
      "capture-status",
      "capture-ceiling",
      "dead-letter",
      "export-dump",
    ].includes(Bun.argv[3] ?? "");
  const message = captureCommand
    ? error instanceof PublicReviewError
      ? error.message
      : publicCloseReason(error)
    : error instanceof Error
      ? error.message
      : String(error);
  await Bun.write(Bun.stderr, `neuve: ${message}\n`);
  process.exitCode = 2;
}
