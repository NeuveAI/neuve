/** Metadata only. Records-schema has no Effect, storage or telemetry dependency. */
export interface RefusedShape {
  readonly kind: "codec" | "transforming-pipe" | "diverging-alias";
  readonly path: string;
}
export interface CompatibilityRefusal extends RefusedShape {
  readonly type: "compatibility.refused";
  readonly source: string;
  readonly readingBuild: string;
  readonly writingBuild: string;
}
export interface CompatibilityContext {
  readonly source: string;
  readonly readingBuild: string;
  readonly writingBuild?: string;
}

type Sink = (
  shape: RefusedShape,
  context: Partial<CompatibilityContext>,
) => boolean;
const sinks = new Set<Sink>();
/** Sinks return true only when the active reader context captured the record. */
export const registerCompatibilityRefusals = (sink: Sink) => {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
};

const said = new Set<string>();
export const captureRefusal = (
  shape: RefusedShape,
  context: Partial<CompatibilityContext>,
) => {
  for (const sink of [...sinks].reverse()) if (sink(shape, context)) return;
  const record = refusalRecord(shape, context);
  const key = JSON.stringify(record);
  if (said.has(key)) return;
  said.add(key);
  process.stderr.write(
    `neuve: compatibility mode; ${JSON.stringify(record)}; record is corrupt to this build\n`,
  );
};
export const refusalRecord = (
  shape: RefusedShape,
  context: Partial<CompatibilityContext>,
): CompatibilityRefusal => ({
  type: "compatibility.refused",
  kind: shape.kind,
  path: shape.path,
  source: context.source ?? "unknown",
  readingBuild: context.readingBuild ?? "unknown",
  writingBuild: context.writingBuild ?? "unknown",
});
