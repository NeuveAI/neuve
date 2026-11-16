/** Manual entrypoint. Tests spawn it with a preloaded fake; they never import it. */
import { toolsDiagnosis } from "./smoke-tools-diagnose.ts";
import {
  fixtureFlag,
  fixturePath,
  writeFixture,
} from "./smoke-fixture-recorder.ts";
import { fullSmokeState } from "./smoke-full.ts";
import { Account } from "@neuve/runtime";
import { Effect, Logger, type Cause } from "effect";
import { smokeRuntime } from "./smoke-runtime.ts";
import {
  checkProbe,
  checkNormalAndFinal,
  checkRequestPlan,
} from "./smoke-checks.ts";
import { checkPersistence } from "./smoke-resume.ts";
import { checkTools } from "./smoke-tools.ts";
import {
  diagnoseObservation,
  diagnoseRunState,
  diagnoseSmoke,
} from "./smoke-diagnose.ts";

if (import.meta.main) {
  const cwd = Bun.argv[3];
  if (Bun.argv[2] !== "--live" || cwd === undefined || !cwd.startsWith("/"))
    throw new Error(
      "Use --live followed by an existing absolute Neuve state directory.",
    );
  const started = Date.now();
  const recordDestination = fixtureFlag(Bun.argv.slice(4));
  if (recordDestination !== undefined) await fixturePath(recordDestination);
  const diagnose = Bun.argv[4] === "--diagnose";
  const diagnoseTools =
    Bun.argv[4] === "--diagnose-tools" ||
    Bun.argv[4] === "--diagnose-tools-multi-round"
      ? toolsDiagnosis({
          multiRound: Bun.argv[4] === "--diagnose-tools-multi-round",
          record: recordDestination !== undefined,
        })
      : undefined;
  const fullState = fullSmokeState();
  const diagnosis = diagnose
    ? { observation: diagnoseObservation(), state: diagnoseRunState() }
    : undefined;
  let failureCause: Cause.Cause<unknown> | undefined;
  const program = Effect.scoped(
    Effect.gen(function* () {
      const observation =
        diagnoseTools?.observation ??
        diagnosis?.observation ??
        fullState.observation;
      const baseRuntime = yield* smokeRuntime({ cwd }, observation);
      const runtime =
        diagnose || diagnoseTools !== undefined
          ? baseRuntime
          : fullState.observe(baseRuntime);
      const account = Account.parse({
        name: "default",
        kind: "claude-subscription",
        runtime: "claude-code",
        credential: { kind: "claude-config-folder" },
      });
      if (diagnoseTools !== undefined)
        return yield* diagnoseTools.run(runtime, account);
      if ("event" in observation)
        return yield* diagnoseSmoke(
          runtime,
          account,
          observation,
          diagnosis?.state,
        );
      fullState.step("probe");
      const probe = yield* checkProbe(runtime, account);
      fullState.step("normalTurn");
      const turns = yield* checkNormalAndFinal(
        runtime,
        account,
        probe.resolvedModel,
      );
      fullState.step("persistence");
      const { inputs, fork } = yield* checkPersistence(runtime, account);
      fullState.step("tools");
      const tools = yield* checkTools(runtime, account, observation);
      const steps = { probe: probe.counts, turns, inputs, fork, tools };
      const plan = checkRequestPlan(steps);
      const checks = [
        plan.withinPlan,
        ...Object.values(steps).flatMap((step) =>
          Object.entries(step).flatMap(([key, value]) =>
            typeof value === "boolean"
              ? [key === "protocolError" ? !value : value]
              : [],
          ),
        ),
      ];
      return {
        probeModelsPresent: probe.counts.modelsPresent,
        defaultFirst: probe.counts.defaultFirst,
        resolvedModelPresent: probe.counts.resolvedModelPresent,
        probeRows: probe.counts.rows,
        probeRequests: probe.counts.requests,
        probeWithinPlan: probe.counts.withinPlan,
        turnsWithinPlan: turns.withinPlan,
        inputsWithinPlan: inputs.withinPlan,
        forkWithinPlan: fork.withinPlan,
        toolsWithinPlan: tools.withinPlan,
        normalCompleted: turns.normalCompleted,
        finalCompleted: turns.finalCompleted && turns.structuredOutputParsed,
        structuredOutputParsed: turns.structuredOutputParsed,
        defaultModelMatches: turns.defaultModelMatches,
        distinctModels: turns.distinctModels,
        modelsAgree: turns.modelsAgree,
        contextWindowPositive: turns.contextWindowPositive,
        maxOutputTokensPositive: turns.maxOutputTokensPositive,
        turnsProtocolError: turns.protocolError,
        normalFinalRequests: turns.requests,
        inputCompleted: inputs.inputCompleted,
        resumeCompleted: inputs.resumeCompleted,
        messageTokenFound: inputs.messageTokenFound,
        steerTokenFound: inputs.steerTokenFound,
        completedInputsRequests: inputs.requests,
        inputsProtocolError: inputs.protocolError,
        forkCompleted: fork.forkCompleted,
        forkMessageTokenFound: fork.messageTokenFound,
        forkSteerTokenFound: fork.steerTokenFound,
        forkNativeSessionIdDiffers: fork.nativeSessionIdDiffers,
        forkRequests: fork.requests,
        forkProtocolError: fork.protocolError,
        toolsCompleted: tools.toolsCompleted,
        carrierPresent: tools.carrierPresent,
        noteCalledOnce: tools.noteCalledOnce,
        finishCalledOnce: tools.finishCalledOnce,
        steerAccepted: tools.steerAccepted,
        finishReceivedSteerToken: tools.finishReceivedSteerToken,
        discardedSteerAccepted: tools.discardedSteerAccepted,
        discardedSteerAbsent: tools.discardedSteerAbsent,
        discardedSteerNotOffered: tools.discardedSteerNotOffered,
        discardedSteers: tools.discardedSteers,
        oneDiscardedSteer: tools.oneDiscardedSteer,
        twoToolMessages: tools.twoMessages,
        noRequestAfterFinish: tools.noRequestAfterFinish,
        balancedTools: tools.balancedTools,
        toolsProtocolError: tools.protocolError,
        protocolError:
          turns.protocolError ||
          inputs.protocolError ||
          fork.protocolError ||
          tools.protocolError,
        toolsRequests: tools.requests,
        events: turns.events + inputs.events + fork.events + tools.events,
        completed:
          Number(turns.normalCompleted) +
          Number(turns.finalCompleted && turns.structuredOutputParsed) +
          Number(inputs.inputCompleted) +
          Number(inputs.resumeCompleted),
        failed:
          4 -
          Number(turns.normalCompleted) -
          Number(turns.finalCompleted && turns.structuredOutputParsed) -
          Number(inputs.inputCompleted) -
          Number(inputs.resumeCompleted),
        ...plan,
        successes: checks.filter(Boolean).length,
        failures: checks.filter((check) => !check).length,
        ...fullState.counts(),
      };
    }),
  ).pipe(
    Effect.timeout("5 minutes"),
    Effect.provide(
      Logger.layer([
        Logger.make((options) => {
          process.stderr.write(
            `${options.date.toISOString()} ${options.logLevel.toUpperCase()} ${String(options.message)}\n`,
          );
        }),
      ]),
    ),
  );
  try {
    const counts = await Effect.runPromise(
      program.pipe(
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            failureCause = cause;
          }),
        ),
      ),
    );
    if (recordDestination !== undefined && diagnoseTools !== undefined) {
      if (!counts.withinPlan) throw new Error("Fixture request cap exceeded");
      await writeFixture(recordDestination, diagnoseTools.fixture());
    }
    console.log(JSON.stringify({ ...counts, wallMs: Date.now() - started }));
    if ("mode" in counts ? !counts.withinPlan : counts.failures > 0)
      process.exitCode = 1;
  } catch {
    if (diagnoseTools !== undefined && failureCause !== undefined) {
      console.log(
        JSON.stringify({
          ...diagnoseTools.failure(failureCause),
          wallMs: Date.now() - started,
        }),
      );
      process.exitCode = 1;
    } else if (diagnosis !== undefined && failureCause !== undefined) {
      console.log(
        JSON.stringify({
          ...diagnosis.state.failure(
            failureCause,
            diagnosis.observation.totalRequestsStarted,
            diagnosis.observation.totalRequestsCompleted,
          ),
          wallMs: Date.now() - started,
        }),
      );
      process.exitCode = 1;
    } else {
      console.log(
        JSON.stringify({
          ...(failureCause === undefined
            ? {
                outcome: "failed",
                step: "probe",
                causeKind: "interrupt",
                expectedRequests: 8,
                ...fullState.counts(),
              }
            : fullState.failure(failureCause)),
          wallMs: Date.now() - started,
        }),
      );
      process.exitCode = 1;
    }
  }
}
