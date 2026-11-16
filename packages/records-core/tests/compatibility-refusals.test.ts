import { expect, test, spyOn } from "bun:test";
import { z } from "zod";
import {
  preserveUnknown,
  registerCompatibilityRefusals,
  safeRead,
} from "@neuve/records-schema";

// The owner's refusal boundary preserves the strict result and never repairs known corruption.
test("F31 diverging aliased union occurrences refuse with their schema location", () => {
  const union = z.union([
    z.strictObject({ a: z.number() }),
    z.strictObject({ b: z.number() }),
  ]);
  const schema = z.intersection(
    z
      .strictObject({ x: union, y: union })
      .refine((value) => "a" in value.x && "b" in value.y),
    z.unknown(),
  );
  const shared = { a: 1, b: 2, future: true };
  const input = { x: shared, y: shared };
  const strict = schema.safeParse(input);
  expect(strict.success).toBe(false);
  const read = safeRead(schema, input);
  expect(read).toMatchObject({
    success: false,
    refusals: [
      { kind: "diverging-alias", path: "x" },
      { kind: "diverging-alias", path: "y" },
    ],
  });
  if (read.success || strict.success) throw new Error("Expected refusal");
  expect(read.error.issues.slice(0, strict.error.issues.length)).toEqual(
    strict.error.issues,
  );
  expect(() =>
    preserveUnknown(schema, input, { x: { a: 2 }, y: { b: 3 } }),
  ).toThrow();
  expect(safeRead(schema, { x: { ...shared }, y: { ...shared } }).success).toBe(
    true,
  );
  expect(schema.safeParse({ x: { a: 1 }, y: { b: 2 } }).success).toBe(true);
});

test("diverging aliases in array and record entries refuse with redacted paths", () => {
  const union = z.union([
    z.strictObject({ a: z.number() }),
    z.strictObject({ b: z.number() }),
  ]);
  const shared = { a: 1, b: 2, future: true };
  const arrays = z
    .array(union)
    .refine(
      (value) => value.length === 2 && "a" in value[0]! && "b" in value[1]!,
    );
  const records = z
    .record(z.string(), union)
    .refine(
      (value) => "a" in value["secret-one"]! && "b" in value["secret-two"]!,
    );
  expect(safeRead(arrays, [shared, shared])).toMatchObject({
    success: false,
    refusals: [{ kind: "diverging-alias", path: "[]" }],
  });
  expect(
    safeRead(records, { "secret-one": shared, "secret-two": shared }),
  ).toMatchObject({
    success: false,
    refusals: [{ kind: "diverging-alias", path: "[entry]" }],
  });
});

test("F32 codec and F30 transforming pipe refuse only additive retry and keep corruption corrupt", () => {
  const swap = (value: { left: unknown; right: unknown }) => ({
    left: value.right,
    right: value.left,
  });
  const codec = z.codec(
    z.object({ left: z.unknown(), right: z.unknown() }),
    z.strictObject({
      left: z.strictObject({ used: z.number() }),
      right: z.strictObject({ used: z.number(), known: z.number().optional() }),
    }),
    {
      decode: (value) =>
        z
          .looseObject({
            left: z.looseObject({ used: z.number() }),
            right: z.looseObject({ used: z.number() }),
          })
          .parse(swap(value)),
      encode: swap,
    },
  );
  const corrupt = {
    left: { used: 1, known: "private-value" },
    right: { used: 2, future: true },
  };
  const read = safeRead(codec, corrupt);
  expect(read).toMatchObject({
    success: false,
    refusals: [{ kind: "codec", path: "$" }],
  });
  expect(codec.safeParse(corrupt).success).toBe(false);
  expect(() =>
    preserveUnknown(codec, corrupt, { left: { used: 1 }, right: { used: 2 } }),
  ).toThrow();
  const valid = { left: { used: 1, known: 2 }, right: { used: 2 } };
  expect(safeRead(codec, valid)).toMatchObject({
    success: true,
    data: codec.parse(valid),
  });
  const transform = z
    .looseObject({ used: z.number(), known: z.number().optional() })
    .transform(({ used }): { used: number; future?: boolean } => ({
      used,
      future: true,
    }))
    .pipe(z.strictObject({ used: z.number() }));
  expect(safeRead(transform, { used: 1, known: 2 })).toMatchObject({
    success: false,
    refusals: [{ kind: "transforming-pipe" }],
  });
  expect(
    safeRead(transform, { used: 1, known: "bad", future: true }).success,
  ).toBe(false);
});

// F33 is newer data loss even when Zod reconciles a strict rejection into success.
test("F33 strict intersection and nested strip reads report and preserve every newer key", () => {
  const strict = z.strictObject({ used: z.number() });
  const schemas = [
    z.intersection(strict, z.object({})),
    z.object({ used: z.number() }),
  ];
  const stop = registerCompatibilityRefusals(() => {
    throw new Error("No shape is refused");
  });
  try {
    for (const leaf of schemas) {
      const schema = z.strictObject({ child: leaf });
      const stored = { child: { used: 1, future: "private-payload" } };
      expect(schema.safeParse(stored).success).toBe(true);
      expect(safeRead(schema, stored)).toMatchObject({
        success: true,
        data: { child: { used: 1 } },
        droppedKeys: ["child.future"],
        droppedPaths: [["child", "future"]],
      });
      expect(preserveUnknown(schema, stored, { child: { used: 2 } })).toEqual({
        child: { used: 2, future: "private-payload" },
      });
      expect(stored.child.used).toBe(1);
    }
  } finally {
    stop();
  }
});

test("outside a run each refusal key emits metadata on stderr once and redacts record keys", () => {
  const lines: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((line) => {
    lines.push(String(line));
    return true;
  });
  const codec = z.codec(z.unknown(), z.strictObject({ used: z.number() }), {
    decode: (value) => z.looseObject({ used: z.number() }).parse(value),
    encode: (value) => value,
  });
  const schema = z.record(z.string(), codec);
  const options = {
    source: "/scratch/outside-records.json",
    readingBuild: "reader-14",
    writingBuild: "writer-15",
  };
  try {
    safeRead(
      schema,
      { "secret-entry-key": { used: 1, future: "private-payload" } },
      options,
    );
    safeRead(
      schema,
      { "secret-entry-key": { used: 1, future: "private-payload" } },
      options,
    );
  } finally {
    stderr.mockRestore();
  }
  expect(lines).toHaveLength(1);
  const line = lines[0]!;
  expect(line).toContain('"type":"compatibility.refused"');
  expect(line).toContain('"source":"/scratch/outside-records.json"');
  expect(line).toContain('"path":"[entry]"');
  expect(line).toContain('"kind":"codec"');
  expect(line).toContain('"readingBuild":"reader-14"');
  expect(line).toContain('"writingBuild":"writer-15"');
  expect(line).not.toContain("secret-entry-key");
  expect(line).not.toContain("private-payload");
});

test("F33 compatibility notice names the nested strip path without values in a fresh process", () => {
  const helper = new URL(
    "../../records-schema/src/compatible-read.ts",
    import.meta.url,
  ).href;
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      `
    import {z} from "zod";
    import {safeRead} from ${JSON.stringify(helper)};
    safeRead(z.strictObject({child:z.object({used:z.number()})}), {child:{used:1,future:"private-payload"}});
  `,
    ],
    { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode).toBe(0);
  const line = child.stderr.toString();
  expect(line.split("\n").filter(Boolean)).toHaveLength(1);
  expect(line).toContain("child.future");
  expect(line).not.toContain("private-payload");
});

// F34: Map's object-key issue wrappers must not hide any additive refusal or its capture.
for (const kind of ["codec", "transforming-pipe"] as const)
  for (const side of ["key", "value"] as const)
    for (const nested of [false, true])
      test(`F34 ${kind} Map ${side}, lazy parent ${nested}, captures exactly once`, () => {
        const leaf = z.strictObject({ used: z.number() });
        const output: z.ZodType =
          side === "key" ? z.map(leaf, z.unknown()) : z.map(z.unknown(), leaf);
        const shape =
          kind === "codec"
            ? z.codec(z.unknown(), output, {
                decode: (value) => value,
                encode: (value) => value,
              })
            : z
                .unknown()
                .transform((value) => value)
                .pipe(output);
        const schema: z.ZodType = nested
          ? z.strictObject({ child: z.lazy(() => shape) })
          : shape;
        const wrap = (value: unknown) => (nested ? { child: value } : value);
        const baseline =
          side === "key"
            ? new Map([[{ used: 1 }, 0]])
            : new Map([[{}, { used: 1 }]]);
        const added =
          side === "key"
            ? new Map([[{ used: 1, future: "private-payload" }, 0]])
            : new Map([[{}, { used: 1, future: "private-payload" }]]);
        expect(schema.safeParse(wrap(baseline)).success).toBe(true);
        const captures: unknown[] = [];
        const stop = registerCompatibilityRefusals((shape, context) => {
          captures.push({ shape, context });
          return true;
        });
        try {
          const strict = schema.safeParse(wrap(added));
          const read = safeRead(schema, wrap(added), {
            notice: false,
            source: "map-fixture",
          });
          expect(read).toMatchObject({
            success: false,
            refusals: [{ kind, path: nested ? "child" : "$" }],
          });
          expect(captures).toHaveLength(1);
          expect(captures[0]).toMatchObject({
            shape: { kind, path: nested ? "child" : "$" },
            context: { source: "map-fixture" },
          });
          expect(JSON.stringify(captures)).not.toContain("private-payload");
          if (read.success || strict.success)
            throw new Error("Expected strict failure");
          expect(
            read.error.issues.slice(0, strict.error.issues.length),
          ).toEqual(strict.error.issues);
        } finally {
          stop();
        }
      });

// F36: a sibling may not delete through a refused shape at any ancestor occurrence.
for (const kind of ["codec", "transforming-pipe"] as const)
  for (const depth of [1, 2, 3])
    test(`F36 ${kind} sibling refuses a drop ${depth} containers below it`, () => {
      let strict: z.ZodType = z.strictObject({ used: z.number() });
      let loose: z.ZodType = z.object({ used: z.number() });
      let input: unknown = { used: 1, future: "private-payload" };
      for (let index = 0; index < depth; index++) {
        strict = z.strictObject({ child: strict });
        loose = z.object({ child: loose });
        input = { child: input };
      }
      const shape =
        kind === "codec"
          ? z.codec(z.unknown(), loose, {
              decode: (value) => value,
              encode: (value) => value,
            })
          : z
              .unknown()
              .transform((value) => value)
              .pipe(loose);
      const schema = z.intersection(strict, shape);
      expect(shape.safeParse(input).success).toBe(true);
      expect(schema.safeParse(input).success).toBe(false);
      const captures: unknown[] = [];
      const stop = registerCompatibilityRefusals((shape) => {
        captures.push(shape);
        return true;
      });
      try {
        expect(safeRead(schema, input, { notice: false })).toMatchObject({
          success: false,
          refusals: [{ kind, path: "$" }],
        });
        expect(captures).toEqual([{ kind, path: "$" }]);
      } finally {
        stop();
      }
    });

test("identity pipes and plain intersections still read additive keys without refusals", () => {
  const leaf = z.strictObject({ used: z.number() });
  const captures: unknown[] = [];
  const stop = registerCompatibilityRefusals((shape) => {
    captures.push(shape);
    return true;
  });
  try {
    for (const schema of [
      z.unknown().pipe(leaf),
      z.intersection(leaf, z.object({})),
    ])
      expect(
        safeRead(schema, { used: 1, future: true }, { notice: false }),
      ).toMatchObject({
        success: true,
        data: { used: 1 },
        droppedKeys: ["future"],
      });
    expect(captures).toEqual([]);
  } finally {
    stop();
  }
});
