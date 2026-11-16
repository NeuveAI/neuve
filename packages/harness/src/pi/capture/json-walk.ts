import type { Json } from "./types.ts";

export const isJsonObject = (
  value: Json,
): value is { readonly [key: string]: Json } =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Own keys only; rebuilding must not interpret an input `__proto__` as a setter. */
export const jsonObjectFrom = (entries: Iterable<readonly [string, Json]>) =>
  Object.fromEntries<Json>(entries);

const EMPTY_CHILDREN: ReadonlyArray<never> = Object.freeze([]);
const noChildren = () => EMPTY_CHILDREN;

/**
 * A lazy fold of validated JSON. The domain chooses each child's context and may stop or prune
 * by not consuming children. Serialized JSON strings remain leaves for the domain to interpret.
 */
export const foldJson = <State, Result>(
  value: Json,
  state: State,
  reduce: (
    value: Json,
    state: State,
    children: (
      context: (key: string, child: Json) => State,
    ) => Iterable<readonly [string, Result]>,
  ) => Result,
): Result => {
  if (value === null || typeof value !== "object")
    return reduce(value, state, noChildren);
  return reduce(value, state, function* children(context) {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) continue;
        const key = String(index);
        const child: Json = value[index]!;
        yield [key, foldJson(child, context(key, child), reduce)] as const;
      }
    } else if (isJsonObject(value)) {
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const child = value[key]!;
        yield [key, foldJson(child, context(key, child), reduce)] as const;
      }
    }
  });
};

/** Rebuilds a fully consumed transform in input order, preserving scalar values. */
export const rebuildJson = (
  value: Json,
  children: Iterable<readonly [string, Json]>,
): Json => {
  if (!Array.isArray(value))
    return isJsonObject(value) ? jsonObjectFrom(children) : value;
  const array: Array<Json> = [];
  for (const [, child] of children) array.push(child);
  return array;
};
