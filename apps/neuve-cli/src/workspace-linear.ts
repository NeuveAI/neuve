import type { Planning, PlanningConnections } from "@ace/channel/planning";
import { linearPlanningSource } from "@ace/host/linear-plugin";
import { createPlanning, type PlanningCall } from "@ace/host/planning";
import { IntegrationFile, linearMcpSession, type LinearMcpCall } from "@neuve/harness/linear-planning";

const unavailable = "No Linear read operations are configured on this host.";

export async function planningConnections(source = linearPlanningSource()): Promise<PlanningConnections> {
  return await source.available()
    ? { connections: [{ id: source.id, label: source.label }], status: "configured", message: null }
    : { connections: [], status: "unavailable", message: unavailable };
}

export function workspaceLinearPlanning(options: {
  captureMcp?(call: LinearMcpCall): void;
  capturePlanning?(call: PlanningCall): void;
  source?: ReturnType<typeof linearPlanningSource>;
}) {
  const source = options.source ?? linearPlanningSource();
  const definition = IntegrationFile.parse({
    version: 1,
    servers: { [source.id]: source.definition },
  });
  const client = linearMcpSession(definition, {
    http: source.http,
    ...(options.captureMcp ? { capture: options.captureMcp } : {}),
  });
  const mapping = definition.servers[source.id]?.planning;
  if (!mapping) throw new Error("The Linear plugin has no planning mapping");
  const planning = createPlanning({
    client,
    mappings: { [source.id]: mapping },
    ...(options.capturePlanning ? { capture: options.capturePlanning } : {}),
  });
  const read: Planning = async (request, context) =>
    await source.available()
      ? planning(request, context)
      : { kind: "failure", reason: "unavailable", message: unavailable };
  return { client, read };
}
