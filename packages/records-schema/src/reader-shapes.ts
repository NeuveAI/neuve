import { z } from "zod";

/** The pinned schema graph, shared by refusal detection and the production-root audit. */
export const schemaEdges = (
  schema: z.core.$ZodType,
): ReadonlyArray<z.core.$ZodType> => {
  if (schema instanceof z.ZodObject)
    return [
      ...Object.values(schema.shape),
      ...(schema.def.catchall ? [schema.def.catchall] : []),
    ];
  if (schema instanceof z.ZodUnion) return schema.options;
  if (schema instanceof z.ZodIntersection)
    return [schema.def.left, schema.def.right];
  if (schema instanceof z.ZodPipe) return [schema.in, schema.out];
  if (schema instanceof z.ZodArray) return [schema.element];
  if (schema instanceof z.ZodTuple)
    return [...schema.def.items, ...(schema.def.rest ? [schema.def.rest] : [])];
  if (schema instanceof z.ZodRecord || schema instanceof z.ZodMap)
    return [schema.keyType, schema.valueType];
  if (schema instanceof z.ZodSet) return [schema.def.valueType];
  if ("unwrap" in schema && typeof schema.unwrap === "function")
    return [schema.unwrap()];
  if (
    [
      "string",
      "number",
      "boolean",
      "bigint",
      "symbol",
      "undefined",
      "null",
      "any",
      "unknown",
      "never",
      "void",
      "date",
      "nan",
      "literal",
      "enum",
      "custom",
      "transform",
      "file",
    ].includes(schema._zod.def.type)
  )
    return [];
  throw new Error(`Unclassified reader schema: ${schema._zod.def.type}`);
};

/** Parsing may clone containers, but it must keep every surviving input location unchanged. */
export const transformingInput = (
  schema: z.core.$ZodType,
  seen = new Set<z.core.$ZodType>(),
): boolean => {
  if (seen.has(schema)) return false;
  seen.add(schema);
  if (
    schema instanceof z.ZodTransform ||
    schema instanceof z.ZodCodec ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    ("coerce" in schema._zod.def && schema._zod.def.coerce === true) ||
    schema._zod.def.checks?.some(
      (check) => check._zod.def.check === "overwrite",
    )
  )
    return true;
  return schemaEdges(schema).some((child) => transformingInput(child, seen));
};
