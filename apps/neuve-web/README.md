# Neuve web app

The web app holds the batch overview and the review desk for people. Install dependencies from the monorepo root with `bun install` and use Bun for JavaScript commands.

| Path             | Holds                                               |
| ---------------- | --------------------------------------------------- |
| `apps/web`       | The TanStack Start app and its BFF (`src/server`)   |
| `packages/ui`    | Screens, components, Storybook stories and fixtures |
| `packages/diffs` | Diff rendering                                      |

Start it from the monorepo root:

```sh
bun run dev
```

`bun run dev` ([`scripts/dev.ts`](../../scripts/dev.ts), its one configuration) starts the web BFF under Vite on `127.0.0.1:3000`; set `NEUVE_BFF_PORT` to use another port. There is no Records server: Records is a library ([decision 8.3](../../process/decisions.md)), and the on-demand worker arrives in M2 S4. Before starting, the command:

1. reads `neuve/dev/run.json`, where each run records the boot, its launcher and the web process group with their start times. A file from an earlier boot is discarded. It refuses to start while the recorded launcher is alive. When that launcher is gone, it stops only the recorded groups whose leader is alive with the recorded start time, naming each one. A recorded group that has lost its leader but still has members cannot be proven to be Neuve's, so it is reported, left running, and the command refuses until you have checked it and removed the file;
2. refuses to start when the port is busy, naming the process (PID and command) that holds it. It never stops a process it did not record.

Ctrl-C, SIGTERM or SIGHUP stops the process group it started.

`bun workspace` and `neuve workspace` build the review app for production when a project first needs it. [The build cache](../neuve-cli/src/workspace-review-build.ts) keys the output by project base path, source contents, lockfile, installed dependency manifests and Bun version. It follows installed dependency resolution from the web app and its build tools to include workspace packages and their manifests. Concurrent opens share the build, including across launchers; a completed build is published by directory rename and reused after restart. The holder's socket proves its claim is live; a waiting launcher takes over if that holder stops. Stopping the workspace cancels its build, and a compiler exits if its launcher dies. Each project keeps its current build and builds still held for running servers, and removes dead attempts. A build stays pinned from acquisition until the server exits. TanStack Start compiles router and server-function prefixes into the client, so each project's `/review/<key>/` prefix needs its own build. Vite's [relative asset base](https://vite.dev/guide/build#relative-base) does not make those prefixes runtime settings.

[The local Bun server](apps/web/serve.ts) follows Start's [custom Bun hosting contract](https://tanstack.com/start/latest/docs/framework/react/guide/hosting#production-server-with-bun): it serves the built server's `fetch` and client files, binds loopback port zero, and announces its address to the launcher over IPC. Startup sends no health requests and does not poll. Competing build launchers wait on a local socket notification. Each project retains its own process for `NEUVE_REPOSITORY`. Runtime workspace packages stay external so the harness finds its parser and semantic worker beside its own sources. Both the dev and built servers refuse foreign Host headers. This launcher is local only; hosted deployment remains open.

## What the pages show

The BFF reads Records through `@neuve/records-core` (M5 S3). `/` opens the newest cycle's standing packet at its first batch, `/batch/<id>` any batch of it, and `/review/<unit>` a unit, its diff read from git objects at the range (tracked work only). The decision dock, its undo and line comments record the person git names in the repository (`user.email`, `user.name`) through Records' human commands, never an agent session; server functions take only same-origin calls (`src/start.ts`) and both local servers answer only to their loopback names. The BFF reads the repository it starts in; set `NEUVE_REPOSITORY` to read another (`bun run dev` passes it through). The lineage page stays empty. With no batch, the overview shows the checked-out branch against its base and "Start a review" requests it as the git person (M5 S4); the BFF never starts a worker, so start one from a shell that has the route's sign-in (`neuve worker start`), and the running state says when none runs or the running one lacks the sign-in. Each tab follows Records through one server-sent event stream (`/api/events`) and reloads its data when Records moves; the header's live indicator shows when it is reconnecting. The `/mock` routes render the same screens from the fixtures in `packages/ui`.

With the Feedback setting on (Settings, off by default and kept in this browser), the desk takes the owner's feedback (10.100): a call on the unit beside its lane label, a grade on each context card, a judgement on each agent finding and a rubric under each digest. Each answer is recorded in Records as the person git names, through `HumanCommands.recordFeedback`; a correction supersedes the earlier answer, and `neuve records feedback` exports them. Feedback changes nothing in the review.

Storybook's "Screens/Real packet" stories show a real review through the same projection. Regenerate their fixture from a repository that holds one with `bun run --cwd apps/neuve-web/apps/web fixture:real-packet -- --repo <path>`.

The former `apps/neuve-web/neuve/` directory and the files under `validation/` are local history from the standalone repository and the removed review stack. They are evidence, not inputs, and nothing reads them.
