// @ts-check
/**
 * Neuve React rules, shared by every package in this monorepo.
 *
 * 1. useState is banned: all state lives in jotai atoms.
 * 2. Every useEffect / useLayoutEffect needs a one-line justification comment
 *    directly above it, starting with "Effect:", that cites why React's
 *    "You Might Not Need an Effect" guidance allows it (for example,
 *    subscribing to an external system).
 * 3. Story-only code (DialKit, the story kit) never reaches product code
 *    (`neuveImportGuards`); packages/ui re-allows it in stories
 *    (`neuveStoryAllowances`).
 */

const STATE_MESSAGE =
  "useState is banned in Neuve: keep state in jotai atoms (see packages/ui/src/neuve/*/atoms.ts)."

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect"])

/** @param {import("estree").CallExpression} node */
function effectName(node) {
  const callee = node.callee
  if (callee.type === "Identifier" && EFFECT_HOOKS.has(callee.name))
    return callee.name
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    EFFECT_HOOKS.has(callee.property.name)
  )
    return callee.property.name
  return null
}

/** @type {import("eslint").Rule.RuleModule} */
const effectJustification = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require an `// Effect: <why>` comment above every useEffect/useLayoutEffect.",
    },
    schema: [],
    messages: {
      missing:
        '{{name}} needs a one-line `// Effect: …` comment directly above it citing why "You Might Not Need an Effect" allows it.',
    },
  },
  create(context) {
    const source = context.sourceCode
    return {
      CallExpression(node) {
        const name = effectName(node)
        if (!name) return
        /** @type {import("estree").Node} */
        let statement = node
        // Walk up to the enclosing statement so the comment can sit above it.
        // @ts-expect-error parent is added by ESLint
        while (
          statement.parent &&
          statement.parent.type !== "BlockStatement" &&
          statement.parent.type !== "Program"
        ) {
          // @ts-expect-error parent is added by ESLint
          statement = statement.parent
        }
        const comments = source.getCommentsBefore(statement)
        const last = comments.at(-1)
        const justified =
          last !== undefined &&
          /^\s*Effect:\s*\S/.test(last.value) &&
          last.loc !== undefined &&
          last.loc !== null &&
          statement.loc !== undefined &&
          statement.loc !== null &&
          statement.loc.start.line - last.loc.end.line <= 1
        if (!justified)
          context.report({ node, messageId: "missing", data: { name } })
      },
    }
  },
}

const DIALKIT_MESSAGE = "DialKit is for story jigs only."
const STORY_KIT_MESSAGE =
  "The story kit is for stories only; product code must not import it."

/**
 * Import guards: story-only code never reaches product code, in any package
 * that uses these rules. DialKit (motion tuning in story jigs) and the story
 * kit (packages/ui/src/neuve/story-kit, also reachable from apps through the
 * package's `./neuve/*` export) are banned in every `src` file. A package
 * with stories re-allows them for its story files with `neuveStoryAllowances`.
 *
 * Two rule keys, not one: in flat config a second `no-restricted-imports` on
 * the same files replaces the first one's options instead of adding to them.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const neuveImportGuards = [
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "dialkit", message: DIALKIT_MESSAGE }],
          patterns: [{ group: ["dialkit/*"], message: DIALKIT_MESSAGE }],
        },
      ],
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/story-kit", "**/story-kit/*"],
              message: STORY_KIT_MESSAGE,
            },
          ],
        },
      ],
    },
  },
]

/**
 * packages/ui only, after `neuveReactRules`: stories may use DialKit and the
 * story kit; the kit itself and its two story-state shims may use the kit
 * (never DialKit). Apps have no stories and allow neither.
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const neuveStoryAllowances = [
  {
    files: ["src/**/*.stories.tsx"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": "off",
    },
  },
  {
    files: ["src/neuve/story-kit/**", "src/neuve/**/story-state.tsx"],
    rules: { "@typescript-eslint/no-restricted-imports": "off" },
  },
]

/** @type {import("eslint").Linter.Config[]} */
export const neuveReactRules = [
  {
    plugins: {
      neuve: { rules: { "effect-justification": effectJustification } },
    },
    rules: {
      "neuve/effect-justification": "error",
      // Selectors (not no-restricted-imports) so `import * as React` stays legal.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ImportDeclaration[source.value='react'] > ImportSpecifier[imported.name='useState']",
          message: STATE_MESSAGE,
        },
        {
          selector:
            "MemberExpression[object.name='React'][property.name='useState']",
          message: STATE_MESSAGE,
        },
      ],
    },
  },
  ...neuveImportGuards,
]

export default neuveReactRules
