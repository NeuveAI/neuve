# Neuve on cloud Linux machines

This is maintainers' tooling, not part of a release. Release users install Neuve on Linux with the [README's one-line install](../../../README.md#quick-start).

The pull-request replays ran on Modal, one machine per pull request ([decision 10.129](../../../process/decisions.md)), until Modal was retired on 12 November 2026 ([decision 14.10](../../../process/decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)). The image and the shared sign-in below are still in the code. This folder builds the Linux image those machines started from. It also sets how they share one ChatGPT sign-in without signing each other out.

## The image

[`Dockerfile`](Dockerfile) (the build itself) runs [`scripts/install-linux.ts`](../scripts/install-linux.ts) (the Linux install). That install puts the same files `bun run install:cli` installs into `/opt/neuve`: the CLI, Neuve Graph and the parser's glibc binding. It leaves out the semantic workers, since the replays use `--leads bm25`. `/opt/neuve/lib/neuve/install.json` records each file's SHA-256, the Records versions, the commit the CLI came from and the Graph submodule's commit. The build command is at the top of the Dockerfile. Only linux-x64 is built: Graph needs cgo, and an arm64 build needs an arm64 builder.

The image holds no sign-in.

## One sign-in, one refresher

Each ChatGPT refresh replaces the refresh token. If eight machines each held the sign-in, the first refresh would spend the token the other seven hold. Neuve's lock serialises refreshes within one filesystem only, and a Modal volume shared between containers is not such a filesystem. So exactly one process holds the sign-in and runs every refresh. The review machines hold only access tokens, which last an hour.

| Part | Runs | Holds |
| --- | --- | --- |
| Refresher | One Modal function with `max_containers=1`, taking one call at a time. The sign-in folder is on a Modal volume. `NEUVE_OPENAI_AUTH_DIR` names a dedicated subfolder of that volume, such as `/auth/openai`, never the volume's root: Neuve sets the folder to 0700 and keeps its lock file there. Each call does `volume.reload()`, then runs `neuve auth lease openai`, then `volume.commit()`, and returns the command's output | The sign-in: refresh token, ID token, registration |
| Review machine | `neuve review …` with `NEUVE_OPENAI_TOKEN_COMMAND` set to the absolute path of a small program that calls the refresher and prints what it returns. `NEUVE_OPENAI_AUTH_DIR` must not be set there: Neuve refuses a process that sets both | An access token, in Neuve's memory only |

`neuve auth lease openai` prints `{"access_token": "…", "expires_at": <epoch ms>}` to a pipe and refuses a terminal. It refreshes first when the token has under five minutes left, and writes the rotated tokens back to the folder before it prints. On SIGTERM, a lease still waiting (for the lock or the issuer's discovery) stops at once and spends nothing. A refresh already sent finishes writing back its replacement, in under 20 s, then the command exits 143 without printing. A review machine runs its program again once its token has under five minutes left. The program's contract:

- On success, exit 0 and print exactly that JSON.
- When a later attempt can succeed (the refresher is busy or the network failed), exit 75.
- When the sign-in is gone, exit any other non-zero status.
- Its standard error is discarded, and Neuve never quotes its output.

Where this can still fail:

- A refresher stopped after OpenAI rotated the token but before `volume.commit()` loses the new token, and the owner must sign in again. Commit straight after each lease.
- Redeploying the app can briefly run an old and a new refresher together. Don't redeploy during a run, or guard the call with a `modal.Dict` lock.
- The access token travels as a Modal function result, so it may sit in Modal's call records for up to an hour. The refresh token never leaves the refresher.
- A Modal secret cannot take the rotated tokens back from inside a container. It can only seed the volume once; after the first refresh, the volume holds the sign-in.

## Making the cloud's sign-in

The owner chose OpenAI's documented way for remote machines ([decision 10.131](../../../process/decisions.md), which amends 10.129's sign-in by code). Neuve's route has no sign-in by code. Codex's device endpoint refuses Neuve's registration client (`invalid_client`). It also carries no resource, scope or host ID.

A person runs these steps; agents never handle the credential files:

1. On the Mac, sign in once into a fresh, empty folder. The sign-in registers its own client and host ID, separate from the everyday sign-in, which is never copied:

   ```sh
   NEUVE_OPENAI_AUTH_DIR=<new empty folder> neuve auth login openai
   ```

2. Move that folder to the refresher's volume once, as in [OpenAI's self-hosted VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) (complete the sign-in locally, move the file over a secure channel, let the VM own its refreshes). Use `modal volume put <volume> <folder> /openai`, then delete the folder from the Mac. The Mac must never use that folder again: its next refresh would spend the refresher's token.
3. A volume may not keep file modes. Neuve refuses a sign-in file anyone else could read, so the refresher sets the folder to 0700 and `openai-auth.json` to 0600 before its first lease.
