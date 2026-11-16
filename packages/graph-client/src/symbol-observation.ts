import { z } from "zod";
import type { GraphOutlineNode } from "./symbols.ts";

const strings = z.array(z.string()).readonly();
const relations = z.record(z.string(), strings);
const flags = z.record(z.string(), z.boolean());
const Provider = z.strictObject({
  name: z.literal("entire-graph"),
  version: z.string(),
  identityRevision: z.string(),
  executable: z.strictObject({
    sha256: z.string(),
    buildIdentity: z.enum(["verified", "unreported"]),
  }),
  capabilities: z.strictObject({
    schemaVersion: z.string(),
    supportedFileExtensions: strings,
    supportedLanguages: strings,
    semanticLanguages: strings,
    inventoryOnlyLanguages: strings,
    supportedRelationTypes: strings,
    relationSelectionModes: z.array(z.enum(["exact", "family"])).readonly(),
    relationFamilies: relations,
    relationSupportByLanguage: relations,
    relationSupportByProfile: relations,
    heuristicRelationTypes: strings,
    parserVersions: z.record(z.string(), z.string()),
    unsupportedButDetectedLanguageHints: strings,
    optionalLocalOnlyFeatures: flags,
    featuresRequiringNetworkAccess: flags,
  }),
});
const position = z.int().positive();
const count = z.int().nonnegative();
/** A tokens value as `tokens.ts` normalizes it; rows stay positional. */
const Tokens = z.union([
  z
    .strictObject({
      status: z.literal("available"),
      hasErrors: z.boolean(),
      identifierNames: strings,
      leafTypes: strings,
      ancestors: strings,
      leaves: z
        .array(
          z
            .tuple([
              count,
              count,
              count,
              position,
              position,
              count,
              count,
              count,
            ])
            .readonly(),
        )
        .readonly(),
      unknownFlagBits: count,
      directivesFlagged: z.boolean(),
      indentationSignificant: z.boolean().nullable(),
      imports: z.union([
        z.strictObject({
          status: z.literal("extracted"),
          statements: z
            .array(
              z.strictObject({
                startLine: position,
                endLine: position,
                startByte: count,
                endByte: count,
                specifier: z.string(),
                bindings: z
                  .array(
                    z.strictObject({
                      imported: z.string(),
                      local: z.string(),
                      typeOnly: z.boolean(),
                      localInferred: z.boolean(),
                    }),
                  )
                  .readonly(),
                sideEffectOnly: z.boolean(),
                namesUnknown: z.boolean(),
              }),
            )
            .readonly(),
        }),
        z.strictObject({ status: z.literal("not-extracted") }),
      ]),
    })
    .refine(
      (tokens) => {
        let previousEnd = 0;
        for (const [
          type,
          start,
          end,
          startLine,
          endLine,
          ,
          ancestors,
        ] of tokens.leaves) {
          if (
            type >= tokens.leafTypes.length ||
            ancestors >= tokens.ancestors.length ||
            start > end ||
            start < previousEnd ||
            endLine < startLine
          )
            return false;
          previousEnd = end;
        }
        return true;
      },
      { message: "A leaf lies outside its tables or out of order." },
    ),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum([
      "tokens-size-limit",
      "unsupported-language",
      "parse-error",
      "source-not-parsed",
      "outline-unavailable",
      "partial-failure",
    ]),
    retryable: z.boolean(),
    codes: strings,
  }),
]);
const node = (depth: number): z.ZodType<GraphOutlineNode> =>
  z.strictObject({
    startLine: position,
    endLine: position,
    type: z.string(),
    imports: z.boolean(),
    children: z.array(depth < 16 ? node(depth + 1) : z.never()).optional(),
  });
export const SymbolObservation = z.strictObject({
  provider: Provider,
  outlinesAvailable: z.boolean(),
  files: z
    .map(
      z.string(),
      z.strictObject({
        language: z.string().nullable(),
        symbols: z
          .array(
            z.strictObject({
              id: z.string(),
              kind: z.string(),
              name: z.string(),
              qualifiedName: z.string(),
              signature: z.string().optional(),
              startLine: position,
              endLine: position,
              containerId: z.string().nullable(),
            }),
          )
          .readonly(),
        outline: z
          .strictObject({
            topLevel: z.array(node(0)).readonly(),
            identifiers: z
              .array(z.tuple([position], z.string()).readonly())
              .readonly(),
          })
          .nullable(),
        partialFailure: z.string().nullable(),
        partialFailures: z.array(z.string()).readonly().optional(),
        tokens: Tokens.optional(),
      }),
    )
    .readonly(),
  batchOutputBytes: z.array(z.int().nonnegative()).readonly().optional(),
  tokenCoverage: z
    .strictObject({
      languages: strings,
      importBindingLanguages: strings,
      directiveLanguages: strings,
      indentationSignificantLanguages: strings.nullable(),
    })
    .optional(),
});
