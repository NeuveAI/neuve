/**
 * `bun run dev`: the one local-development command (decision 6.5,
 * architecture 0010). This file is its configuration: the services, their
 * ports, their environment and the build outputs they need.
 *
 * Preflight, before anything starts:
 * 1. Ownership is proven, never guessed. Each run records its launcher and the
 *    process group of every service it starts, with their start times, in
 *    `neuve/dev/run.json`. A recorded launcher that is still alive makes this
 *    run refuse. When it is gone, the recorded groups it left behind are
 *    stopped, and only if their start times still match.
 * 2. Every port must be free. Anything holding one is reported with its PID
 *    and command and is never stopped; the command refuses to start.
 *
 * The web BFF runs under Vite. There is no Records server: Records is a
 * library (decision 8.3), and the on-demand worker that processes queued jobs
 * arrives in M2 S4. The installed `~/.local` copies are never used. Each service runs in its own process group, and
 * Ctrl-C, SIGTERM or SIGHUP stops every group it started.
 */
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, relative, resolve } from "node:path";
import { Console, Data, Effect, Schedule, Schema } from "effect";
import { webCommand } from "./web-command.ts";

class DevError extends Data.TaggedError("DevError")<{
  readonly message: string;
}> {}
class NotReady extends Data.TaggedError("NotReady") {}

const root = await realpath(resolve(import.meta.dir, ".."));
const inRoot = (path: string) => resolve(root, path);
// Under the repository's ignored neuve/ directory.
const runStatePath = inRoot("neuve/dev/run.json");

const services = {
  web: { label: "web BFF", portVariable: "NEUVE_BFF_PORT", port: 3000 },
} as const;
type ServiceName = keyof typeof services;
type Environment = Record<string, string | undefined>;

const say = (message: string) => Console.log(`[dev] ${message}`);
const warn = (message: string) => Console.error(`[dev] warning: ${message}`);
const show = (path: string) => relative(root, path) || ".";

const capture = (command: readonly string[]) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([...command], {
        cwd: root,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
    catch: () =>
      new DevError({
        message: `Could not run ${command[0]}, which bun run dev needs for its preflight.`,
      }),
  });

const configure = Effect.gen(function* () {
  // Settings from the shell or the root .env files Bun loads.
  const base: Environment = { ...process.env };
  const ports = {} as Record<ServiceName, number>;
  for (const name of Object.keys(services) as ServiceName[]) {
    const { portVariable, port } = services[name];
    const value = base[portVariable] ?? String(port);
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
      return yield* new DevError({
        message: `${portVariable}=${value} is not a port between 1 and 65535.`,
      });
    ports[name] = Number(value);
  }

  // Every child runs with --no-env-file and receives only its allowlist.
  const launch: Record<
    ServiceName,
    {
      readonly command: string[];
      readonly cwd: string;
      readonly env: Environment;
    }
  > = {
    web: webCommand({ root, port: ports.web, environment: base }),
  };
  return { ports, launch };
});
type Configuration = Effect.Success<typeof configure>;

/**
 * A process is identified by its PID and its start time, because a PID alone
 * can be reused once the process exits.
 */
const startTime = (pid: number) =>
  Effect.gen(function* () {
    const result = yield* capture(["ps", "-o", "lstart=", "-p", String(pid)]);
    const started = result.stdout.trim();
    if (result.exitCode === 0 && started) return started;
    // ps exits 1 with no output when the process does not exist.
    if (result.exitCode === 1 && !started && !result.stderr.trim())
      return undefined;
    return yield* new DevError({
      message: `ps failed (exit ${result.exitCode}) while checking PID ${pid}: ${result.stderr.trim()}`,
    });
  });

/**
 * Identifies this boot of the machine. Process start times only mean something
 * within one boot, so a run state from an earlier boot is discarded.
 */
const bootIdentity = Effect.gen(function* () {
  const sysctl = yield* capture(["sysctl", "-n", "kern.boottime"]).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  const seconds = sysctl?.exitCode === 0 && /sec = (\d+)/.exec(sysctl.stdout);
  if (seconds) return `boottime:${seconds[1]}`;
  // Linux has no kern.boottime; it names each boot instead.
  const bootId = yield* Effect.promise(() =>
    Bun.file("/proc/sys/kernel/random/boot_id")
      .text()
      .catch(() => undefined),
  );
  if (bootId?.trim()) return `boot_id:${bootId.trim()}`;
  return yield* new DevError({
    message:
      "Could not read the boot time (sysctl -n kern.boottime), which bun run dev needs to trust its run state.",
  });
});

const RecordedProcess = Schema.Struct({
  pid: Schema.Number,
  started: Schema.String,
});
const RunState = Schema.Struct({
  boot: Schema.String,
  launcher: RecordedProcess,
  services: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      // A service is its own process-group leader, so its PID is the group.
      group: RecordedProcess,
    }),
  ),
});
type RunState = typeof RunState.Type;

const decodeRunState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RunState),
);

const readRunState = Effect.gen(function* () {
  const file = Bun.file(runStatePath);
  if (!(yield* Effect.promise(() => file.exists()))) return undefined;
  const text = yield* Effect.promise(() => file.text());
  return yield* decodeRunState(text).pipe(
    Effect.mapError(
      () =>
        new DevError({
          message: `${show(runStatePath)} is unreadable, so bun run dev cannot tell what an earlier run left behind. Check for its services yourself, then remove the file.`,
        }),
    ),
  );
});

/** Creates the run state; fails if another launcher created one first. */
const createRunState = (state: RunState) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(runStatePath), { recursive: true });
      await writeFile(runStatePath, JSON.stringify(state, null, 2) + "\n", {
        flag: "wx",
      });
    },
    catch: () =>
      new DevError({
        message: `Could not create ${show(runStatePath)}; another bun run dev may have just started.`,
      }),
  });

const updateRunState = (state: RunState) =>
  Effect.tryPromise({
    try: async () => {
      const temporary = `${runStatePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2) + "\n");
      await rename(temporary, runStatePath);
    },
    catch: () =>
      new DevError({ message: `Could not update ${show(runStatePath)}.` }),
  });

/** Removes the run state only while it still names the given launcher. */
const removeRunState = (launcher: RunState["launcher"]) =>
  readRunState.pipe(
    Effect.flatMap((state) =>
      state?.launcher.pid === launcher.pid &&
      state.launcher.started === launcher.started
        ? Effect.promise(() => rm(runStatePath, { force: true }))
        : Effect.void,
    ),
    Effect.orElseSucceed(() => undefined),
  );

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
  } catch {
    /* It already exited. */
  }
};

const groupAlive = (group: number) => alive(-group);

/** SIGTERM to the group, five seconds' grace, then SIGKILL. */
const stopGroup = (group: number) =>
  Effect.promise(async () => {
    signal(-group, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (groupAlive(group) && Date.now() < deadline) await Bun.sleep(100);
    if (!groupAlive(group)) return false;
    signal(-group, "SIGKILL");
    const reaped = Date.now() + 2000;
    while (groupAlive(group) && Date.now() < reaped) await Bun.sleep(50);
    return true;
  });

/**
 * Stops what an earlier run recorded and left behind. A group is signalled
 * only when its leader is alive with the recorded start time in this boot. A
 * group whose leader is gone cannot be told apart from an unrelated group that
 * later took the same ID, so it is reported and the command refuses.
 */
const stopEarlierRun = Effect.gen(function* () {
  const state = yield* readRunState;
  if (state === undefined) return;
  if (state.boot !== (yield* bootIdentity)) {
    yield* say(
      `Discarding ${show(runStatePath)} from before the last restart; nothing it lists is running.`,
    );
    yield* Effect.promise(() => rm(runStatePath, { force: true }));
    return;
  }
  const { launcher } = state;
  if ((yield* startTime(launcher.pid)) === launcher.started)
    return yield* new DevError({
      message: `bun run dev is already running in this workspace (launcher PID ${launcher.pid}, started ${launcher.started}). Stop it first, for example with kill -TERM ${launcher.pid}.`,
    });
  const unproven: string[] = [];
  for (const service of state.services) {
    const { pid, started } = service.group;
    const leader = yield* startTime(pid);
    if (leader !== started) {
      if (leader === undefined && groupAlive(pid))
        unproven.push(
          `  process group ${pid} (recorded for ${service.name}) has lost its leader but still has members`,
        );
      continue;
    }
    yield* say(
      `Stopping ${service.name} (process group ${pid}, started ${started}) left by an earlier run whose launcher (PID ${launcher.pid}) is gone.`,
    );
    const killed = yield* stopGroup(pid);
    yield* say(
      killed
        ? `Process group ${pid} ignored SIGTERM for 5 s and was killed.`
        : `Stopped process group ${pid}.`,
    );
  }
  // The state stays while it may still describe something left running.
  if (unproven.length > 0)
    return yield* new DevError({
      message: `Not starting. An earlier run's launcher (PID ${launcher.pid}) is gone, and bun run dev cannot prove these are still its processes, so it left them running:\n${unproven.join("\n")}\nInspect them (ps -o pid,command -g <group>), stop them if they are Neuve services, then remove ${show(runStatePath)}.`,
    });
  yield* Effect.promise(() => rm(runStatePath, { force: true }));
});

const describeProcess = (pid: number) =>
  Effect.gen(function* () {
    const result = yield* capture(["ps", "-o", "command=", "-p", String(pid)]);
    const command = result.stdout.trim();
    if (result.exitCode === 0 && command) return `PID ${pid}: ${command}`;
    if (result.exitCode === 1 && !command && !result.stderr.trim())
      return `PID ${pid}: (already exited)`;
    return yield* new DevError({
      message: `ps failed (exit ${result.exitCode}) while describing PID ${pid}: ${result.stderr.trim()}`,
    });
  });

/** Reports every busy port. Nothing found here is ever stopped. */
const checkPorts = (configuration: Configuration) =>
  Effect.gen(function* () {
    const problems: string[] = [];
    for (const name of Object.keys(services) as ServiceName[]) {
      const port = configuration.ports[name];
      const { label } = services[name];
      const listing = yield* capture([
        "lsof",
        "-nP",
        `-iTCP:${port}`,
        "-sTCP:LISTEN",
        "-Fp",
      ]);
      // lsof exits 1 with no output when nothing matches.
      if (
        listing.exitCode !== 0 &&
        !(listing.exitCode === 1 && !listing.stdout.trim())
      )
        return yield* new DevError({
          message: `lsof failed (exit ${listing.exitCode}) while checking port ${port}: ${listing.stderr.trim()}`,
        });
      const owners = [
        ...new Set(
          listing.stdout
            .split("\n")
            .filter((line) => line.startsWith("p"))
            .map((line) => Number(line.slice(1))),
        ),
      ];
      for (const pid of owners)
        problems.push(
          `Port ${port} (${label}) is held by ${yield* describeProcess(pid)}`,
        );
      if (owners.length > 0) continue;
      // lsof sees only this user's processes; binding catches the rest.
      const bindError = yield* Effect.sync(() => {
        try {
          Bun.listen({
            hostname: "127.0.0.1",
            port,
            socket: { data() {} },
          }).stop(true);
          return undefined;
        } catch (error) {
          return error instanceof Error && "code" in error
            ? String(error.code)
            : String(error);
        }
      });
      if (bindError === "EADDRINUSE")
        problems.push(
          `Port ${port} (${label}) is in use by a process lsof cannot see, such as another user's`,
        );
      else if (bindError !== undefined)
        return yield* new DevError({
          message: `Could not test port ${port} (${label}) on 127.0.0.1: ${bindError}.`,
        });
    }
    if (problems.length > 0)
      return yield* new DevError({
        message: `Not starting, because ports are busy. These processes are not recorded by bun run dev, so they are left running:\n${problems.map((line) => `  ${line}`).join("\n")}\nStop them or choose another port (NEUVE_BFF_PORT).`,
      });
  });

/** Copies a child's output to ours, one prefixed line at a time. */
const relay = async (
  stream: ReadableStream<Uint8Array>,
  prefix: string,
  target: NodeJS.WriteStream,
) => {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) target.write(`${prefix} ${line}\n`);
  }
  if (pending) target.write(`${prefix} ${pending}\n`);
};

type Service = {
  readonly name: ServiceName;
  readonly label: string;
  readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">;
};

/** The run state of this launcher, rewritten as each service starts. */
type Run = { state: RunState };

/**
 * Starts a service as the leader of its own process group and records the
 * group before anything else can happen.
 */
const start = (configuration: Configuration, run: Run, name: ServiceName) =>
  Effect.acquireRelease(
    Effect.try({
      try: (): Service => {
        const { command, cwd, env } = configuration.launch[name];
        const child = Bun.spawn(command, {
          cwd,
          env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
        });
        const prefix = `[${name}]`;
        void relay(child.stdout, prefix, process.stdout).catch(() => {});
        void relay(child.stderr, prefix, process.stderr).catch(() => {});
        return { name, label: services[name].label, child };
      },
      catch: () =>
        new DevError({ message: `Could not start ${services[name].label}.` }),
    }),
    (service) => stop(service),
  ).pipe(
    Effect.tap((service) =>
      Effect.gen(function* () {
        const started = yield* startTime(service.child.pid);
        if (started === undefined) return;
        run.state = {
          ...run.state,
          services: [
            ...run.state.services,
            { name, group: { pid: service.child.pid, started } },
          ],
        };
        yield* updateRunState(run.state);
      }),
    ),
  );

const stop = ({ label, child }: Service) =>
  Effect.gen(function* () {
    // The group outlives its leader while any member still runs.
    const group = child.pid;
    if (!groupAlive(group)) return;
    yield* say(`Stopping ${label} (process group ${group}).`);
    if (yield* stopGroup(group))
      yield* warn(
        `${label} ignored SIGTERM for 5 s; its process group was killed.`,
      );
  });

const exitOf = ({ label, child }: Service) =>
  Effect.promise(() => child.exited).pipe(
    Effect.flatMap((code) =>
      Effect.fail(
        new DevError({
          message: `${label} exited with code ${code ?? child.signalCode}. Its output is above, prefixed with its name.`,
        }),
      ),
    ),
  );

const listening = (port: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => connect({ host: "127.0.0.1", port })),
        (socket) => Effect.sync(() => socket.destroy()),
      );
      yield* Effect.callback<void, NotReady>((resume) => {
        socket.once("connect", () => resume(Effect.void));
        socket.once("error", () => resume(Effect.fail(new NotReady())));
      });
    }),
  );

const awaitReady = (
  configuration: Configuration,
  service: Service,
  ready: Effect.Effect<void, NotReady | DevError>,
) =>
  Effect.raceFirst(
    ready.pipe(
      Effect.retry({
        while: (error) => error._tag === "NotReady",
        schedule: Schedule.spaced("250 millis"),
        times: 480,
      }),
      Effect.catchTag("NotReady", () =>
        Effect.fail(
          new DevError({
            message: `${service.label} did not accept connections on port ${configuration.ports[service.name]} within two minutes.`,
          }),
        ),
      ),
    ),
    exitOf(service),
  );

const runStack = (configuration: Configuration) =>
  Effect.scoped(
    Effect.gen(function* () {
      const launcherStarted = yield* startTime(process.pid);
      if (launcherStarted === undefined)
        return yield* new DevError({
          message: "Could not read this launcher's start time.",
        });
      const run: Run = {
        state: {
          boot: yield* bootIdentity,
          launcher: { pid: process.pid, started: launcherStarted },
          services: [],
        },
      };
      // Registered first, so it is removed last, after every service stopped.
      yield* Effect.acquireRelease(createRunState(run.state), () =>
        removeRunState(run.state.launcher),
      );
      const web = yield* start(configuration, run, "web");
      yield* awaitReady(configuration, web, listening(configuration.ports.web));
      yield* say(
        `Neuve web app is running at http://127.0.0.1:${configuration.ports.web}. Press Ctrl-C to stop it.`,
      );
      // The service stopping on its own stops the launcher.
      return yield* exitOf(web);
    }),
  );

const program = Effect.gen(function* () {
  const configuration = yield* configure;
  yield* stopEarlierRun;
  yield* checkPorts(configuration);
  yield* runStack(configuration);
});

const shutdown = new AbortController();
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(name, () => {
    if (!shutdown.signal.aborted)
      process.stderr.write(`[dev] ${name} received; stopping the stack.\n`);
    shutdown.abort();
  });
try {
  await Effect.runPromise(program, { signal: shutdown.signal });
} catch (error) {
  if (!shutdown.signal.aborted) {
    process.stderr.write(
      `[dev] ${error instanceof DevError ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
if (shutdown.signal.aborted) process.stderr.write("[dev] Stopped.\n");
