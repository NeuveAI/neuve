import "./compatibility-capture.ts";
import { safeRead, type ReadOptions } from "@neuve/records-schema";
import type { z } from "zod";
import { CorruptRecord } from "./errors.ts";

/** Throwing adapter for storage readers whose surrounding boundary catches failures. */
export const readData = <T>(
  schema: z.ZodType<T>,
  input: unknown,
  options: ReadOptions = {},
): T => {
  const read = safeRead(schema, input, options);
  if (!read.success) throw new CorruptRecord({ message: read.error.message });
  return read.data;
};
