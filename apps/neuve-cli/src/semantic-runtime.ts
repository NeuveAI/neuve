import { inspectBaseRuntime } from "@neuve/semantic-client/runtime-inspection";

export const inspectSemanticRuntime = async (
  input: Parameters<typeof inspectBaseRuntime>[0],
) => {
  const observed = await inspectBaseRuntime(input);
  const reported: Awaited<ReturnType<typeof inspectBaseRuntime>> & {
    kind: "cli-reported";
    variant: "BASE";
  } = { ...observed, kind: "cli-reported", variant: "BASE" };
  return reported;
};
