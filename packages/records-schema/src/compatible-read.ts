import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { captureRefusal, type RefusedShape } from "./compatibility-refusals.ts";
import { schemaEdges, transformingInput } from "./reader-shapes.ts";

/** Shared by synchronous readers and Effect's store notices. No payload values enter a notice. */
const said = new Set<string>();
export const sayOnce = <A>(
  key: string,
  line: string,
  emit: (line: string) => A,
) => {
  if (said.has(key)) return undefined;
  said.add(key);
  return emit(line);
};

type Path = ReadonlyArray<unknown>;
type Drops = ReadonlyArray<Path>;

const sameStep = (left: unknown, right: unknown) =>
  left === right || (Number.isNaN(left) && Number.isNaN(right));

type Step =
  | {
      readonly role: "field" | "index" | "entry";
      readonly key: string | number | symbol;
    }
  | { readonly role: "map-key" | "map-value"; readonly key: unknown }
  | { readonly role: "set"; readonly key: number };
type Drop = { readonly steps: ReadonlyArray<Step>; readonly notice: string };
type Branch =
  | {
      readonly kind: "union";
      readonly path: string;
      readonly steps: ReadonlyArray<Step>;
      readonly union: z.ZodUnion;
      readonly input: unknown;
      readonly schema: z.core.$ZodType;
      readonly value: unknown;
    }
  | {
      readonly kind: "pipe";
      readonly schema: z.ZodPipe;
      readonly input: unknown;
      readonly value: unknown;
    };
type Copy = {
  readonly value: unknown;
  readonly drops: ReadonlyArray<Drop>;
  readonly branches?: ReadonlyArray<Branch>;
};
type Ancestor = {
  readonly schema: z.core.$ZodType;
  readonly input: unknown;
  readonly copy: unknown;
};
type Child = {
  readonly schema: z.core.$ZodType;
  readonly input: unknown;
  readonly step: Step;
  readonly publicStep: string;
  readonly put: (value: unknown) => void;
};

const fieldPath = (path: Path) =>
  path
    .map((key) =>
      typeof key === "string" && /^[a-zA-Z_$][\w$]*$/.test(key)
        ? key
        : `[${JSON.stringify(String(key))}]`,
    )
    .join(".");

const ownEntries = (object: Record<PropertyKey, unknown>) =>
  Reflect.ownKeys(object)
    .filter((key) => Object.prototype.propertyIsEnumerable.call(object, key))
    .map((key): [string | symbol, unknown] => [key, object[key]]);
const shapeField = (schema: z.ZodObject, key: PropertyKey) => {
  const field: unknown = Reflect.get(schema.shape, key);
  return field instanceof z.core.$ZodType ? field : undefined;
};

// Transparent wrappers around unknown/any still impose no value constraint on a catchall key.
const unconstrained = (
  schema: z.core.$ZodType,
  seen: ReadonlySet<z.core.$ZodType> = new Set(),
): boolean => {
  if (seen.has(schema) || schema._zod.def.checks?.length) return false;
  const visited = new Set(seen).add(schema);
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) return true;
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodLazy
  )
    return unconstrained(schema.unwrap(), visited);
  if (schema instanceof z.ZodUnion)
    return schema.options.some((option) => unconstrained(option, visited));
  if (schema instanceof z.ZodIntersection)
    return (
      unconstrained(schema.def.left, visited) &&
      unconstrained(schema.def.right, visited)
    );
  if (schema instanceof z.ZodPipe)
    return (
      unconstrained(schema.in, visited) && unconstrained(schema.out, visited)
    );
  return false;
};

const selectedBranch = (
  schema: z.ZodUnion,
  input: unknown,
  branches: ReadonlyArray<Branch>,
) => {
  const choices = new Set(
    branches
      .filter(
        (branch) =>
          branch.kind === "union" &&
          branch.union === schema &&
          branch.input === input,
      )
      .map((branch) => branch.schema),
  );
  return choices.size > 1
    ? undefined
    : ([...choices][0] ??
        schema.options.find(
          (option) => z.core.safeParse(option, input).success,
        ));
};

type Ownership = "declared" | "rejected" | "neutral" | "undecidable";
const combineOwnership = (left: Ownership, right: Ownership): Ownership =>
  left === "declared" || right === "declared"
    ? "declared"
    : left === "undecidable" || right === "undecidable"
      ? "undecidable"
      : left === "rejected" || right === "rejected"
        ? "rejected"
        : "neutral";

// Only a rejection with no declaration at this occurrence authorizes a drop.
const ownership = (
  schema: z.core.$ZodType,
  input: unknown,
  path: ReadonlyArray<Step>,
  branches: ReadonlyArray<Branch>,
  seen: ReadonlySet<z.core.$ZodType> = new Set(),
): Ownership => {
  const [step, ...rest] = path;
  if (!step || seen.has(schema)) return "undecidable";
  const visited = new Set(seen).add(schema);
  const inspect = (nested: z.core.$ZodType) =>
    ownership(nested, input, path, branches, visited);
  if (schema instanceof z.ZodIntersection)
    return combineOwnership(
      inspect(schema.def.left),
      inspect(schema.def.right),
    );
  if (schema instanceof z.ZodPipe) {
    const output = branches.find(
      (branch) =>
        branch.kind === "pipe" &&
        branch.schema === schema &&
        branch.input === input,
    );
    return combineOwnership(
      inspect(schema.in),
      ownership(
        schema.out,
        output ? output.value : input,
        path,
        branches,
        visited,
      ),
    );
  }
  if (schema instanceof z.ZodUnion) {
    const option = selectedBranch(schema, input, branches);
    return option ? inspect(option) : "undecidable";
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodNonOptional ||
    schema instanceof z.ZodLazy
  ) {
    // Only actual short circuits make the inner declarations inactive.
    if (
      (input === undefined &&
        (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)) ||
      (input === null && schema instanceof z.ZodNullable) ||
      (schema instanceof z.ZodCatch &&
        !z.core.safeParse(schema.unwrap(), input).success)
    )
      return "neutral";
    return inspect(schema.unwrap());
  }
  let nested: z.core.$ZodType | undefined;
  let item: unknown;
  if (
    schema instanceof z.ZodObject &&
    (typeof step.key === "string" ||
      typeof step.key === "number" ||
      typeof step.key === "symbol")
  ) {
    const known = Object.hasOwn(schema.shape, step.key);
    nested = known ? shapeField(schema, step.key) : schema.def.catchall;
    if (!known && typeof step.key === "symbol") return "neutral";
    if (!rest.length) {
      if (known) return "declared";
      if (nested instanceof z.ZodNever) return "rejected";
      return !nested || unconstrained(nested) ? "neutral" : "declared";
    }
    // Rejecting a parent does not describe any of its descendants.
    if (!nested || nested instanceof z.ZodNever) return "neutral";
    item = objectEntries(input)?.[step.key];
  } else if (
    schema instanceof z.ZodRecord &&
    (typeof step.key === "string" ||
      typeof step.key === "number" ||
      typeof step.key === "symbol")
  ) {
    const accepts = recordKeyAccepts(schema, step.key);
    if (!rest.length)
      return accepts
        ? "declared"
        : recordRejects(schema, input, step.key)
          ? "rejected"
          : "neutral";
    if (!accepts) return "neutral";
    nested = schema.valueType;
    item = objectEntries(input)?.[step.key];
  } else if (
    (schema instanceof z.ZodArray || schema instanceof z.ZodTuple) &&
    step.role === "index" &&
    typeof step.key === "number" &&
    Array.isArray(input)
  ) {
    nested =
      schema instanceof z.ZodArray
        ? schema.element
        : (schema.def.items[step.key] ?? schema.def.rest ?? undefined);
    item = input[step.key];
  } else if (schema instanceof z.ZodMap && input instanceof Map) {
    nested = step.role === "map-key" ? schema.keyType : schema.valueType;
    item = step.role === "map-key" ? step.key : input.get(step.key);
  } else if (
    schema instanceof z.ZodSet &&
    input instanceof Set &&
    step.role === "set"
  ) {
    nested = schema.def.valueType;
    item = [...input][step.key];
  } else return "neutral";
  return nested && rest.length
    ? ownership(nested, item, rest, branches)
    : "neutral";
};

const recordRejects = (schema: z.ZodRecord, input: unknown, key: PropertyKey) =>
  rootRejections(schema, input).has(key);
const recordKeyAccepts = (schema: z.ZodRecord, key: PropertyKey) => {
  const finite = schema.keyType._zod.values;
  if (finite && !schema.def.partial)
    return [...finite].some(
      (value) =>
        (typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "symbol") &&
        (typeof value === "number" ? String(value) : value) === key &&
        z.core.safeParse(schema.keyType, value).success,
    );
  return (
    z.core.safeParse(schema.keyType, key).success ||
    (typeof key === "string" &&
      z.regexes.number.test(key) &&
      z.core.safeParse(schema.keyType, Number(key)).success)
  );
};

// Avoid unnecessary root drops after Zod reconciles an intersection's selected operands.
// This selects the repair candidate; ownership still decides whether each deletion is allowed.
const rootRejections = (
  schema: z.core.$ZodType,
  input: unknown,
  branches: ReadonlyArray<Branch> = [],
  seen: ReadonlySet<z.core.$ZodType> = new Set(),
): ReadonlySet<unknown> => {
  if (seen.has(schema)) return new Set();
  const visited = new Set(seen).add(schema);
  const inspect = (nested: z.core.$ZodType, value = input) =>
    rootRejections(nested, value, branches, visited);
  if (schema instanceof z.ZodUnion) {
    const option = selectedBranch(schema, input, branches);
    return option ? inspect(option) : new Set();
  }
  if (schema instanceof z.ZodIntersection) {
    const left = inspect(schema.def.left),
      right = inspect(schema.def.right);
    return new Set([...left].filter((key) => right.has(key)));
  }
  if (schema instanceof z.ZodPipe) {
    const output = branches.find(
      (branch) =>
        branch.kind === "pipe" &&
        branch.schema === schema &&
        branch.input === input,
    );
    return new Set([
      ...inspect(schema.in),
      ...inspect(schema.out, output ? output.value : input),
    ]);
  }
  const parsed = z.core.safeParse(schema, input);
  if (parsed.success) return new Set();
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodNonOptional ||
    schema instanceof z.ZodLazy
  )
    return inspect(schema.unwrap());
  return new Set(
    parsed.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys" && !issue.path.length
        ? issue.keys
        : issue.code === "invalid_key" &&
            issue.origin === "record" &&
            issue.path.length === 1
          ? [issue.path[0]]
          : [],
    ),
  );
};

// Apply agreed deletions to the unpruned occurrence. Never merge parsed/transformed outputs.
const prune = (
  input: unknown,
  paths: ReadonlyArray<ReadonlyArray<Step>>,
  ancestors: ReadonlyMap<unknown, unknown> = new Map(),
): unknown => {
  if (ancestors.has(input)) return ancestors.get(input);
  if (!paths.length) return input;
  const nested = (role: Step["role"], key: unknown) =>
    paths
      .filter((path) => path[0]?.role === role && sameStep(path[0].key, key))
      .map((path) => path.slice(1));
  if (input instanceof Map) {
    const output = new Map<unknown, unknown>();
    const active = new Map(ancestors).set(input, output);
    for (const [key, item] of input)
      output.set(
        prune(key, nested("map-key", key), active),
        prune(item, nested("map-value", key), active),
      );
    return output;
  }
  if (input instanceof Set) {
    const output = new Set<unknown>();
    const active = new Map(ancestors).set(input, output);
    [...input].forEach((item, index) =>
      output.add(prune(item, nested("set", index), active)),
    );
    return output;
  }
  if (Array.isArray(input)) {
    const output: unknown[] = [];
    const active = new Map(ancestors).set(input, output);
    input.forEach(
      (item, index) =>
        (output[index] = prune(item, nested("index", index), active)),
    );
    return output;
  }
  const object = objectEntries(input);
  if (!object) return input;
  const output: Record<PropertyKey, unknown> = {};
  const active = new Map(ancestors).set(input, output);
  for (const key of Reflect.ownKeys(object)) {
    const item = object[key];
    const selected = [...nested("field", key), ...nested("entry", key)];
    if (selected.some((path) => !path.length)) continue;
    Object.defineProperty(output, key, {
      value: prune(item, selected, active),
      enumerable: Object.prototype.propertyIsEnumerable.call(object, key),
      writable: true,
      configurable: true,
    });
  }
  return output;
};

// Each descent owns a copy. Only a back-edge to an active schema/input pair shares it.
// Candidate generators keep each union branch's drops separate all the way to the root parse.
function* copies(
  schema: z.core.$ZodType,
  input: unknown,
  steps: ReadonlyArray<Step> = [],
  publicPath: ReadonlyArray<string> = [],
  ancestors: ReadonlyArray<Ancestor> = [],
  aliases: ReadonlyArray<z.core.$ZodType> = [],
  inspectDrops: (
    drops: ReadonlyArray<Drop>,
    branches: ReadonlyArray<Branch>,
  ) => ReadonlyArray<RefusedShape> = () => [],
): Generator<Copy> {
  const active = ancestors.find(
    (item) => item.schema === schema && item.input === input,
  );
  if (active) {
    yield { value: active.copy, drops: [] };
    return;
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodNonOptional ||
    schema instanceof z.ZodLazy
  ) {
    // A modifier may accept without entering its child (null, undefined or a catch fallback).
    // Such an input must not acquire constraints from an inactive union branch.
    if (z.core.safeParse(schema, input).success) {
      yield { value: input, drops: [] };
      return;
    }
    yield* copies(
      schema.unwrap(),
      input,
      steps,
      publicPath,
      ancestors,
      [...aliases, schema],
      inspectDrops,
    );
    return;
  }
  if (schema instanceof z.ZodUnion) {
    if (z.core.safeParse(schema, input).success) {
      yield { value: input, drops: [] };
      return;
    }
    for (const option of schema.options)
      for (const copy of copies(
        option,
        input,
        steps,
        publicPath,
        ancestors,
        [...aliases, schema],
        inspectDrops,
      ))
        yield {
          ...copy,
          branches: [
            ...(copy.branches ?? []),
            {
              kind: "union",
              path: publicPath.join(".") || "$",
              steps,
              union: schema,
              input,
              schema: option,
              value: copy.value,
            },
          ],
        };
    return;
  }
  if (
    schema instanceof z.ZodPipe &&
    (schema instanceof z.ZodCodec || transformingInput(schema.in))
  ) {
    // Explore both schema sides only to locate proposed drops. The root walk below
    // refuses every such path before a candidate can authorize a retry.
    yield { value: input, drops: [] };
    yield* copies(
      schema.in,
      input,
      steps,
      publicPath,
      ancestors,
      aliases,
      inspectDrops,
    );
    yield* copies(
      schema.out,
      input,
      steps,
      publicPath,
      ancestors,
      aliases,
      inspectDrops,
    );
    const parsed = z.core.safeParse(schema.in, input);
    if (parsed.success) {
      const output =
        schema instanceof z.ZodCodec
          ? schema.def.transform(parsed.data, {
              value: parsed.data,
              issues: [],
            })
          : parsed.data;
      if (!(output instanceof Promise) && output !== input)
        yield* copies(
          schema.out,
          output,
          steps,
          publicPath,
          ancestors,
          aliases,
          inspectDrops,
        );
    }
    return;
  }
  if (schema instanceof z.ZodPipe || schema instanceof z.ZodIntersection) {
    const leftSchema =
      schema instanceof z.ZodPipe ? schema.in : schema.def.left;
    const rightSchema =
      schema instanceof z.ZodPipe ? schema.out : schema.def.right;
    const combine = (left: Copy, right: Copy): Copy => {
      const branches = [...(left.branches ?? []), ...(right.branches ?? [])];
      inspectDrops([...left.drops, ...right.drops], branches);
      const rejected =
        schema instanceof z.ZodIntersection
          ? rootRejections(schema, input, branches)
          : undefined;
      const drops = [...left.drops, ...right.drops].filter((drop) => {
        const path = drop.steps.slice(steps.length);
        return (
          (path.length !== 1 || !rejected || rejected.has(path[0]?.key)) &&
          ownership(schema, input, path, branches) === "rejected"
        );
      });
      return {
        value: prune(
          input,
          drops.map((drop) => drop.steps.slice(steps.length)),
        ),
        drops,
        branches,
      };
    };
    for (const left of copies(
      leftSchema,
      input,
      steps,
      publicPath,
      ancestors,
      [],
      inspectDrops,
    )) {
      if (schema instanceof z.ZodPipe) {
        const parsed = z.core.safeParse(leftSchema, left.value);
        const pipeBranch: ReadonlyArray<Branch> = parsed.success
          ? [{ kind: "pipe", schema, input, value: parsed.data }]
          : [];
        const candidate = {
          ...left,
          branches: [...(left.branches ?? []), ...pipeBranch],
        };
        yield combine(candidate, { value: input, drops: [] });
        if (!parsed.success) continue;
        for (const right of copies(
          rightSchema,
          parsed.data,
          steps,
          publicPath,
          ancestors,
          [],
          inspectDrops,
        )) {
          if (!right.drops.length) continue;
          yield combine(candidate, right);
        }
      } else {
        for (const right of copies(
          rightSchema,
          input,
          steps,
          publicPath,
          ancestors,
          [],
          inspectDrops,
        ))
          yield combine(left, right);
      }
    }
    return;
  }
  let value: unknown = input;
  const drops: Drop[] = [];
  const children: Child[] = [];
  let finish = () => {};
  const child = (
    nested: z.core.$ZodType,
    item: unknown,
    step: Step,
    publicStep: string,
    put: Child["put"],
  ) => children.push({ schema: nested, input: item, step, publicStep, put });
  if (schema instanceof z.ZodObject && objectEntries(input)) {
    const object = objectEntries(input)!;
    const output: Record<PropertyKey, unknown> = {};
    value = output;
    const entries = new Map(ownEntries(object));
    for (const key of Reflect.ownKeys(schema.shape))
      if (Object.hasOwn(object, key)) entries.set(key, object[key]);
    for (const [key, item] of entries) {
      const known = Object.hasOwn(schema.shape, key);
      const nested = known
        ? shapeField(schema, key)
        : typeof key === "symbol"
          ? undefined
          : schema.def.catchall;
      if (!known && nested instanceof z.ZodNever) {
        drops.push({
          steps: [...steps, { role: "field", key }],
          notice: [
            ...publicPath,
            typeof key === "symbol" ? "[field]" : fieldPath([key]),
          ].join("."),
        });
      } else {
        Object.defineProperty(output, key, {
          value: item,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        if (nested)
          child(
            nested,
            item,
            { role: known ? "field" : "entry", key },
            known
              ? typeof key === "symbol"
                ? "[field]"
                : fieldPath([key])
              : "[entry]",
            (copy) => {
              output[key] = copy;
            },
          );
      }
    }
  } else if (
    (schema instanceof z.ZodArray || schema instanceof z.ZodTuple) &&
    Array.isArray(input)
  ) {
    const output = [...input];
    value = output;
    input.forEach((item, index) => {
      const nested =
        schema instanceof z.ZodArray
          ? schema.element
          : (schema.def.items[index] ?? schema.def.rest);
      if (nested)
        child(nested, item, { role: "index", key: index }, "[]", (copy) => {
          output[index] = copy;
        });
    });
  } else if (schema instanceof z.ZodRecord && objectEntries(input)) {
    const output = objectEntries(input)!;
    value = output;
    const parsed = schema.safeParse(input);
    const rejected = new Set<PropertyKey>(
      parsed.success
        ? []
        : parsed.error.issues.flatMap((issue) =>
            issue.code === "unrecognized_keys" && issue.path.length === 0
              ? issue.keys
              : [],
          ),
    );
    const entries = new Map(ownEntries(output));
    if (schema.keyType._zod.values && !schema.def.partial)
      for (const key of Reflect.ownKeys(output))
        if (recordKeyAccepts(schema, key)) entries.set(key, output[key]);
    for (const [key, item] of entries) {
      if (rejected.has(key)) {
        delete output[key];
        drops.push({
          steps: [...steps, { role: "entry", key }],
          notice: [...publicPath, "[entry]"].join("."),
        });
      } else if (recordKeyAccepts(schema, key))
        child(
          schema.valueType,
          item,
          { role: "entry", key },
          "[entry]",
          (copy) => {
            output[key] = copy;
          },
        );
    }
    // Record keys are kept verbatim. The root parse retains finite-key and key-refinement checks.
  } else if (schema instanceof z.ZodMap && input instanceof Map) {
    const output = new Map<unknown, unknown>();
    value = output;
    const entries = [...input].map(([key, item]) => ({ key, item }));
    [...input].forEach(([key, item], index) => {
      const entry = entries[index]!;
      child(
        schema.keyType,
        key,
        { role: "map-key", key },
        "[entry]",
        (copy) => {
          entry.key = copy;
        },
      );
      child(
        schema.valueType,
        item,
        { role: "map-value", key },
        "[entry]",
        (copy) => {
          entry.item = copy;
        },
      );
    });
    finish = () => {
      output.clear();
      for (const entry of entries) output.set(entry.key, entry.item);
    };
  } else if (schema instanceof z.ZodSet && input instanceof Set) {
    const output = new Set<unknown>();
    const items = [...input];
    value = output;
    items.forEach((item, index) =>
      child(
        schema.def.valueType,
        item,
        { role: "set", key: index },
        "[entry]",
        (copy) => {
          items[index] = copy;
        },
      ),
    );
    finish = () => {
      output.clear();
      for (const item of items) output.add(item);
    };
  }
  const nestedAncestors =
    value === input
      ? ancestors
      : [
          ...ancestors,
          ...[schema, ...aliases].map((owner) => ({
            schema: owner,
            input,
            copy: value,
          })),
        ];
  // Iterative backtracking keeps wide snapshots and arrays off the JavaScript call stack.
  if (children.length === 0) {
    finish();
    yield { value, drops };
    return;
  }
  const iterators: Array<Generator<Copy>> = [];
  const collected: Array<ReadonlyArray<Drop>> = [drops];
  const branches: Array<ReadonlyArray<Branch>> = [[]];
  let index = 0;
  try {
    while (index >= 0) {
      const next = children[index]!;
      const iterator = (iterators[index] ??= copies(
        next.schema,
        next.input,
        [...steps, next.step],
        [...publicPath, next.publicStep],
        nestedAncestors,
        [],
        inspectDrops,
      ));
      const item = iterator.next();
      if (item.done) {
        iterators.pop();
        index--;
        continue;
      }
      next.put(item.value.value);
      const previous = collected[index]!;
      collected[index + 1] = item.value.drops.length
        ? [...previous, ...item.value.drops]
        : previous;
      const priorBranches = branches[index]!;
      branches[index + 1] = item.value.branches?.length
        ? [...priorBranches, ...item.value.branches]
        : priorBranches;
      if (index === children.length - 1) {
        finish();
        yield {
          value,
          drops: collected[index + 1]!,
          branches: branches[index + 1]!,
        };
      } else index++;
    }
  } finally {
    for (const iterator of iterators) iterator.return(undefined);
  }
}

export const compatibilityNotice = (paths: ReadonlyArray<string>) => {
  const shown = paths
    .slice(0, 8)
    .map((path) => (path.length > 100 ? `${path.slice(0, 100)}...` : path));
  return `neuve: compatibility mode; this build read fields a newer build added (${shown.join(", ")}${paths.length > 8 ? ", ..." : ""}) and left them to that build; projection rebuilds requiring those fields are left to that build`;
};

// Compare object declarations with the final parsed view, including successful strip parses.
// Public paths use schema roles, so record, Map and Set keys never enter diagnostics.
const strippedKeys = (
  schema: z.core.$ZodType,
  input: unknown,
  output: unknown,
  steps: ReadonlyArray<Step> = [],
  publicPath: ReadonlyArray<string> = [],
  active: ReadonlyArray<{ schema: z.core.$ZodType; input: unknown }> = [],
): ReadonlyArray<Drop> => {
  if (active.some((item) => item.schema === schema && item.input === input))
    return [];
  const ancestors = [...active, { schema, input }];
  const walk = (
    child: z.core.$ZodType,
    raw = input,
    parsed = output,
    step?: Step,
    name?: string,
  ) =>
    strippedKeys(
      child,
      raw,
      parsed,
      step ? [...steps, step] : steps,
      name ? [...publicPath, name] : publicPath,
      ancestors,
    );
  if (schema instanceof z.ZodIntersection) {
    const drops = [...walk(schema.def.left), ...walk(schema.def.right)];
    return drops.filter(
      (drop) =>
        ownership(schema, input, drop.steps.slice(steps.length), []) !==
        "declared",
    );
  }
  if (schema instanceof z.ZodUnion) {
    const selected = schema.options.find(
      (option) => z.core.safeParse(option, input).success,
    );
    return selected ? walk(selected) : [];
  }
  if (schema instanceof z.ZodTransform) return [];
  if (schema instanceof z.ZodCodec) {
    const parsed = z.core.safeParse(schema.in, input);
    return parsed.success ? walk(schema.in, input, parsed.data) : [];
  }
  if (schema instanceof z.ZodPipe) {
    const parsed = z.core.safeParse(schema.in, input);
    return parsed.success
      ? [
          ...walk(schema.in, input, parsed.data),
          ...(transformingInput(schema.in)
            ? []
            : walk(schema.out, parsed.data, output)),
        ]
      : [];
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodNonOptional ||
    schema instanceof z.ZodLazy
  ) {
    if (
      (input === undefined &&
        (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault)) ||
      (input === null && schema instanceof z.ZodNullable) ||
      (schema instanceof z.ZodCatch &&
        !z.core.safeParse(schema.unwrap(), input).success)
    )
      return [];
    return walk(schema.unwrap());
  }
  const raw = objectEntries(input),
    parsed = objectEntries(output);
  if (schema instanceof z.ZodObject && raw && parsed) {
    return ownEntries(raw).flatMap(([key, value]) => {
      const known = Object.hasOwn(schema.shape, key);
      const name = known
        ? typeof key === "symbol"
          ? "[field]"
          : fieldPath([key])
        : "[entry]";
      if (
        !known &&
        typeof key === "string" &&
        (!schema.def.catchall || schema.def.catchall instanceof z.ZodNever) &&
        !Object.hasOwn(parsed, key)
      )
        return [
          {
            steps: [...steps, { role: "field" as const, key }],
            notice: [...publicPath, fieldPath([key])].join("."),
          },
        ];
      const nested = known ? shapeField(schema, key) : schema.def.catchall;
      return nested && Object.hasOwn(parsed, key)
        ? walk(
            nested,
            value,
            parsed[key],
            { role: known ? "field" : "entry", key },
            name,
          )
        : [];
    });
  }
  if (
    (schema instanceof z.ZodArray || schema instanceof z.ZodTuple) &&
    Array.isArray(input) &&
    Array.isArray(output)
  )
    return input.flatMap((value, key) => {
      const nested =
        schema instanceof z.ZodArray
          ? schema.element
          : (schema.def.items[key] ?? schema.def.rest);
      return nested && key in output
        ? walk(nested, value, output[key], { role: "index", key }, "[]")
        : [];
    });
  if (schema instanceof z.ZodRecord && raw && parsed)
    return ownEntries(raw).flatMap(([key, value]) =>
      recordKeyAccepts(schema, key) && Object.hasOwn(parsed, key)
        ? walk(
            schema.valueType,
            value,
            parsed[key],
            { role: "entry", key },
            "[entry]",
          )
        : [],
    );
  if (
    schema instanceof z.ZodMap &&
    input instanceof Map &&
    output instanceof Map
  ) {
    const entries = [...output];
    return [...input].flatMap(([key, value], index) => {
      const parsed = entries[index];
      return parsed
        ? [
            ...walk(
              schema.keyType,
              key,
              parsed[0],
              { role: "map-key", key },
              "[entry]",
            ),
            ...walk(
              schema.valueType,
              value,
              parsed[1],
              { role: "map-value", key },
              "[entry]",
            ),
          ]
        : [];
    });
  }
  if (
    schema instanceof z.ZodSet &&
    input instanceof Set &&
    output instanceof Set
  ) {
    const items = [...output];
    return [...input].flatMap((value, key) =>
      walk(
        schema.def.valueType,
        value,
        items[key],
        { role: "set", key },
        "[entry]",
      ),
    );
  }
  return [];
};

const directParses = new WeakMap<z.core.$ZodType, boolean>();
const parsesDirectly = (root: z.core.$ZodType): boolean => {
  const cached = directParses.get(root);
  if (cached !== undefined) return cached;
  const seen = new Set<z.core.$ZodType>();
  const visit = (schema: z.core.$ZodType): boolean => {
    if (seen.has(schema)) return true;
    seen.add(schema);
    return schema._zod.def.type !== "pipe" && schemaEdges(schema).every(visit);
  };
  let direct = false;
  try {
    direct = visit(root);
  } catch {
    // Unclassified schemas keep the schema walk.
  }
  directParses.set(root, direct);
  return direct;
};

const keysSurvive = (input: unknown, output: unknown, depth = 0): boolean => {
  if (input === null || typeof input !== "object")
    return typeof input !== "function" && Object.is(input, output);
  if (depth === 64 || output === null || typeof output !== "object")
    return false;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.getPrototypeOf(output)) return false;
  if (Array.isArray(input) || Array.isArray(output)) {
    if (
      prototype !== Array.prototype ||
      !Array.isArray(input) ||
      !Array.isArray(output)
    )
      return false;
  } else if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(input).every((key) => {
    const before = Object.getOwnPropertyDescriptor(input, key);
    const after = Object.getOwnPropertyDescriptor(output, key);
    return (
      before !== undefined &&
      "value" in before &&
      after !== undefined &&
      "value" in after &&
      keysSurvive(before.value, after.value, depth + 1)
    );
  });
};

const noteDivergence = (
  branches: ReadonlyArray<Branch>,
  refusals: RefusedShape[],
) => {
  for (const branch of branches) {
    if (
      branch.kind !== "union" ||
      typeof branch.input !== "object" ||
      branch.input === null
    )
      continue;
    if (
      branches.some(
        (other) =>
          other.kind === "union" &&
          other.union === branch.union &&
          other.input === branch.input &&
          (other.steps.length !== branch.steps.length ||
            other.steps.some(
              (step, index) =>
                step.role !== branch.steps[index]?.role ||
                !sameStep(step.key, branch.steps[index]?.key),
            )) &&
          other.schema !== branch.schema,
      )
    )
      refusals.push({ kind: "diverging-alias", path: branch.path });
  }
};

// Check the copy walk's occurrence path against every schema that applies there.
// Siblings can propose a drop even when a refused shape parsed successfully by itself.
const refusalsAt = (
  schema: z.core.$ZodType,
  input: unknown,
  path: ReadonlyArray<Step>,
  branches: ReadonlyArray<Branch>,
  publicPath: ReadonlyArray<string> = [],
  seen: ReadonlySet<z.core.$ZodType> = new Set(),
): ReadonlyArray<RefusedShape> => {
  if (seen.has(schema)) return [];
  const visited = new Set(seen).add(schema);
  const inspect = (child: z.core.$ZodType) =>
    refusalsAt(child, input, path, branches, publicPath, visited);
  if (
    schema instanceof z.ZodPipe &&
    (schema instanceof z.ZodCodec || transformingInput(schema.in))
  )
    return [
      {
        kind: schema instanceof z.ZodCodec ? "codec" : "transforming-pipe",
        path: publicPath.join(".") || "$",
      },
    ];
  if (schema instanceof z.ZodIntersection)
    return [...inspect(schema.def.left), ...inspect(schema.def.right)];
  if (schema instanceof z.ZodPipe)
    return [...inspect(schema.in), ...inspect(schema.out)];
  if (schema instanceof z.ZodUnion) {
    const conflicts: RefusedShape[] = [];
    noteDivergence(
      branches.filter(
        (branch) =>
          branch.kind === "union" &&
          branch.union === schema &&
          branch.input === input,
      ),
      conflicts,
    );
    if (conflicts.length) return conflicts;
    const option = selectedBranch(schema, input, branches);
    return option ? inspect(option) : [];
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodNonOptional ||
    schema instanceof z.ZodLazy
  )
    return inspect(schema.unwrap());
  const [step, ...rest] = path;
  if (!step) return [];
  let child: z.core.$ZodType | undefined;
  let value: unknown;
  let name: string;
  if (
    schema instanceof z.ZodObject &&
    (typeof step.key === "string" ||
      typeof step.key === "number" ||
      typeof step.key === "symbol")
  ) {
    const known = Object.hasOwn(schema.shape, step.key);
    child = known ? shapeField(schema, step.key) : schema.def.catchall;
    value = objectEntries(input)?.[step.key];
    name = known
      ? typeof step.key === "symbol"
        ? "[field]"
        : fieldPath([step.key])
      : "[entry]";
  } else if (
    schema instanceof z.ZodRecord &&
    (typeof step.key === "string" ||
      typeof step.key === "number" ||
      typeof step.key === "symbol")
  ) {
    child = recordKeyAccepts(schema, step.key) ? schema.valueType : undefined;
    value = objectEntries(input)?.[step.key];
    name = "[entry]";
  } else if (
    (schema instanceof z.ZodArray || schema instanceof z.ZodTuple) &&
    step.role === "index" &&
    typeof step.key === "number" &&
    Array.isArray(input)
  ) {
    child =
      schema instanceof z.ZodArray
        ? schema.element
        : (schema.def.items[step.key] ?? schema.def.rest ?? undefined);
    value = input[step.key];
    name = "[]";
  } else if (
    schema instanceof z.ZodMap &&
    input instanceof Map &&
    (step.role === "map-key" || step.role === "map-value")
  ) {
    child = step.role === "map-key" ? schema.keyType : schema.valueType;
    value = step.role === "map-key" ? step.key : input.get(step.key);
    name = "[entry]";
  } else if (
    schema instanceof z.ZodSet &&
    input instanceof Set &&
    step.role === "set"
  ) {
    child = schema.def.valueType;
    value = [...input][step.key];
    name = "[entry]";
  } else return [];
  return child
    ? refusalsAt(child, value, rest, branches, [...publicPath, name])
    : [];
};

/** Strict input schemas stay strict. Only unknown keys in a successful branch may be discarded. */
const readCompatible = <T>(
  schema: z.ZodType<T>,
  input: unknown,
  options: ReadOptions = {},
) => {
  const strict = schema.safeParse(input);
  const result = (
    parsed: { success: true; data: T },
    drops: ReadonlyArray<Drop>,
  ) => {
    drops = drops.filter(
      (drop, index) =>
        !drops
          .slice(0, index)
          .some(
            (previous) =>
              previous.steps.length === drop.steps.length &&
              previous.steps.every(
                (step, at) =>
                  step.role === drop.steps[at]?.role &&
                  sameStep(step.key, drop.steps[at]?.key),
              ),
          ),
    );
    const droppedKeys = [...new Set(drops.map((drop) => drop.notice))];
    if (droppedKeys.length && options.notice !== false)
      sayOnce("compatible-read", compatibilityNotice(droppedKeys), (line) =>
        process.stderr.write(`${line}\n`),
      );
    return {
      ...parsed,
      droppedKeys,
      droppedPaths: drops.map((drop) => drop.steps.map((step) => step.key)),
      occurrences: drops,
    };
  };
  if (strict.success)
    return result(
      strict,
      // A surviving key cannot be a drop. Pipes and codecs can restore a key lost in an inner parse.
      parsesDirectly(schema) && keysSurvive(input, strict.data)
        ? []
        : strippedKeys(schema, input, strict.data),
    );
  const refusals: RefusedShape[] = [];
  const inspectDrops = (
    drops: ReadonlyArray<Drop>,
    branches: ReadonlyArray<Branch>,
  ) => {
    const conflicts = drops.flatMap((drop) =>
      refusalsAt(schema, input, drop.steps, branches),
    );
    refusals.push(...conflicts);
    return conflicts;
  };
  for (const copy of copies(schema, input, [], [], [], [], inspectDrops)) {
    if (copy.drops.length === 0) continue;
    if (inspectDrops(copy.drops, copy.branches ?? []).length) continue;
    const parsed = schema.safeParse(copy.value);
    if (
      !parsed.success ||
      copy.branches?.some(
        (branch) =>
          branch.kind === "union" &&
          !z.core.safeParse(branch.schema, branch.value).success,
      )
    )
      continue;
    return result(parsed, [
      ...copy.drops,
      ...strippedKeys(schema, copy.value, parsed.data),
    ]);
  }
  const unique = [
    ...new Map(
      refusals.map((refusal) => [`${refusal.kind}:${refusal.path}`, refusal]),
    ).values(),
  ];
  for (const refusal of unique) captureRefusal(refusal, options);
  return unique.length
    ? {
        ...strict,
        refusals: unique,
        error: new z.ZodError([
          ...strict.error.issues,
          ...unique.map((refusal) => ({
            code: "custom" as const,
            path: [],
            message: `Corrupt record: additive retry refused ${refusal.kind} at ${refusal.path}`,
          })),
        ]),
      }
    : strict;
};

export interface ReadOptions {
  readonly notice?: boolean;
  readonly source?: string;
  readonly readingBuild?: string;
  readonly writingBuild?: string;
}

export const safeRead = <T>(
  schema: z.ZodType<T>,
  input: unknown,
  options: ReadOptions = {},
) => {
  const read = readCompatible(schema, input, options);
  if (!read.success) return read;
  const { occurrences: _, ...result } = read;
  return result;
};

/** Refuse a destructive update without exposing any stored values. */
const cannotPreserve = (): never => {
  sayOnce(
    "compatible-read",
    "neuve: compatibility mode; leaving this update to a newer build because it cannot preserve that build's fields",
    (line) => process.stderr.write(`${line}\n`),
  );
  throw new Error(
    "This update cannot preserve newer fields; leave it to a newer build",
  );
};

const objectEntries = (
  value: unknown,
): Record<PropertyKey, unknown> | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    return undefined;
  const output: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(value))
    Object.defineProperty(output, key, {
      value: Reflect.get(value, key),
      enumerable: Object.prototype.propertyIsEnumerable.call(value, key),
      writable: true,
      configurable: true,
    });
  return output;
};

type PreservationOptions = ReadOptions & {
  /** Stable domain keys for arrays whose entries this operation updates or reorders. */
  readonly arrayKeys?: Readonly<Record<string, ReadonlyArray<string>>>;
};

const same = isDeepStrictEqual;

/** Restore only the reported unknown paths, never stale known fields. */
const restore = (
  stored: unknown,
  before: unknown,
  next: unknown,
  paths: Drops,
  options: PreservationOptions,
  location: Path = [],
  ancestors: ReadonlyMap<unknown, unknown> = new Map(),
): unknown => {
  if (ancestors.has(next)) return ancestors.get(next);
  if (paths.some((path) => path.length === 0)) return structuredClone(stored);
  if (paths.length === 0) return next;
  if (stored instanceof Map) {
    if (!(before instanceof Map) || !(next instanceof Map))
      return cannotPreserve();
    const result = new Map(next);
    const nestedAncestors = new Map(ancestors).set(next, result);
    for (const [key, item] of stored) {
      const nested = paths
        .filter((path) => sameStep(path[0], key))
        .map((path) => path.slice(1));
      if (nested.length === 0) continue;
      if (!before.has(key) || !next.has(key)) return cannotPreserve();
      result.set(
        key,
        restore(
          item,
          before.get(key),
          next.get(key),
          nested,
          options,
          [...location, key],
          nestedAncestors,
        ),
      );
    }
    return result;
  }
  // Sets have no stable entry identity after parsing or updates. Refuse before publication.
  if (stored instanceof Set) return cannotPreserve();
  if (Array.isArray(stored)) {
    if (!Array.isArray(next) || !Array.isArray(before)) return cannotPreserve();
    const result: unknown[] = [...next];
    const nestedAncestors = new Map(ancestors).set(next, result);
    const keys = options.arrayKeys?.[fieldPath(location)];
    const identity = (item: unknown) => {
      const object = objectEntries(item);
      if (
        object === undefined ||
        keys === undefined ||
        keys.some((key) => object[key] === undefined)
      )
        return cannotPreserve();
      return keys.map((key) => object[key]);
    };
    const used = new Set<number>();
    for (let index = 0; index < stored.length; index++) {
      const nested = paths
        .filter((path) => sameStep(path[0], index))
        .map((path) => path.slice(1));
      if (nested.length === 0) continue;
      const matches = next.flatMap((item, at) =>
        (
          keys === undefined
            ? same(before[index], item)
            : same(identity(before[index]), identity(item))
        )
          ? [at]
          : [],
      );
      const at =
        keys === undefined && same(before[index], next[index])
          ? index
          : matches.length === 1
            ? matches[0]
            : undefined;
      if (at === undefined || used.has(at)) return cannotPreserve();
      used.add(at);
      result[at] = restore(
        stored[index],
        before[index],
        next[at],
        nested,
        options,
        [...location, at],
        nestedAncestors,
      );
    }
    return result;
  }
  const oldObject = objectEntries(stored);
  const beforeObject = objectEntries(before);
  const newObject = objectEntries(next);
  if (
    oldObject === undefined ||
    beforeObject === undefined ||
    newObject === undefined
  )
    return cannotPreserve();
  const keys = new Set([
    ...Reflect.ownKeys(newObject),
    ...paths.map((path) =>
      typeof path[0] === "symbol" ? path[0] : String(path[0]),
    ),
  ]);
  const result: Record<string, unknown> = {};
  const nestedAncestors = new Map(ancestors).set(next, result);
  for (const key of keys)
    Object.defineProperty(result, key, {
      value: restore(
        oldObject[key],
        beforeObject[key],
        newObject[key],
        paths
          .filter((path) => sameStep(path[0], key))
          .map((path) => path.slice(1)),
        options,
        [...location, key],
        nestedAncestors,
      ),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return result;
};

/** Strictly validate this build's update, then put back the stored keys the read dropped. */
export const preserveUnknown = <T>(
  schema: z.ZodType<T>,
  stored: unknown,
  next: unknown,
  options: PreservationOptions = {},
): unknown => {
  const read = readCompatible(schema, stored, options);
  if (!read.success) throw read.error;
  const known = schema.parse(next);
  if (
    read.occurrences.some((drop) =>
      drop.steps.some((step) => step.role === "map-key"),
    )
  )
    return cannotPreserve();
  const merged = restore(
    stored,
    read.data,
    known,
    read.occurrences.map((drop) => drop.steps.map((step) => step.key)),
    options,
  );
  // A union branch change may make an old unknown key meaningful to this build. Never let it
  // override a known change or silently become a different kind of stored value.
  const checked = safeRead(schema, merged, { notice: false });
  if (!checked.success || !same(checked.data, known)) return cannotPreserve();
  return merged;
};
