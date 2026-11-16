// GitHub Linguist's generated and vendored rules, pinned to v9.7.0 and carried as data: given a
// path and, when the caller read it, the blob's bytes, which Linguist rule marks the file. This
// is the standard alone. The repository's own declarations (`.gitattributes`), the record of the
// judgement and anything that decides a lane are not here.
//
// Linguist treats every path alike and so does this: no language, folder or file is special
// beyond what a Linguist rule itself reads. The tables are `./generated-rules.ts` and
// `./vendor-patterns.ts`; the Ruby behaviour they lean on is `./ruby.ts`.
//
// Two readers. Linguist runs the same `generated.rb` behind two readers. The Git reader
// (`LazyBlob`) loads a blob with `MAX_SIZE = 128 * 1024`, so it hands the rules at most the first
// 131,072 bytes; the file reader (`FileBlob`) reads the whole file. Both hand over a byte string
// (ASCII-8BIT), so both count a line's length in bytes. That is read from `lib/linguist/
// lazy_blob.rb` and `lib/linguist/file_blob.rb` at v9.7.0, which are not carried here. So that a
// mark never rests on which reader Linguist happens to use, a rule that reads the bytes of a blob
// longer than the cap is evaluated on both views, the first 131,072 bytes and all of them: it
// fires when both say yes, it is no when both say no, and when they disagree it is not evaluated.
// Every mark is then one both readers give. At or under the cap the two views are the same bytes
// and each rule runs once. Both views keep the byte model.
import {
  evaluateGeneratedRule,
  GENERATED_RULES,
  type BlobView,
  type GeneratedRuleName,
  type RuleOutcome,
} from "./generated-rules.ts";
import { LINGUIST_RECIPE } from "./recipe.ts";
import { binaryString, rubyExtname, rubyLines } from "./ruby.ts";
import { VENDOR_REGEXPS } from "./vendor-patterns.ts";

export {
  GENERATED_RULES,
  LEFT_OUT,
  type GeneratedRuleName,
} from "./generated-rules.ts";
export { VENDOR_PATTERNS } from "./vendor-patterns.ts";

// `LazyBlob::MAX_SIZE` in `lib/linguist/lazy_blob.rb` at v9.7.0.
export const LAZY_BLOB_MAX_SIZE = 128 * 1024;

export const LINGUIST_STANDARD = Object.freeze({
  name: "github-linguist",
  version: "v9.7.0",
  commit: "e0c78d62c42abae6122235d8e68a7aa43eef89da",
  files: Object.freeze({
    "lib/linguist/vendor.yml":
      "1ae9980298c7c4b89fa663f1efbab3c977818a0fcb59ddc869f2b8060a7ad345",
    "lib/linguist/generated.rb":
      "e5d73b4b0835d6b3c48fed9c056e21599284879063027fc561c1a62dd7b246c7",
  }),
  // How a mark is reached over Linguist's two readers (see above).
  reader: `both views agree above ${LAZY_BLOB_MAX_SIZE} bytes`,
  // Changes whenever a table, a matcher or a carried file in this folder changes.
  recipe: LINGUIST_RECIPE,
});

export type LinguistMark = {
  readonly standard: typeof LINGUIST_STANDARD;
  // The first rule of `generated?` that fires, in Linguist's order. When `notEvaluated` names a
  // rule that comes before it, that earlier rule might have fired instead and be the one Linguist
  // reports; and where the earlier rule is one at which Linguist can raise
  // (`generated_mysql_view_definition_format?`, on an empty file whose path a later rule matches,
  // for instance one holding a line feed), Linguist might give no answer at all.
  readonly generated: { readonly rule: GeneratedRuleName } | null;
  // The first pattern of `vendor.yml` that matches the path, as Linguist wrote it.
  readonly vendored: { readonly pattern: string } | null;
  // The rules, in order, that this mark could not answer: they need the bytes and none were
  // given; or the blob is longer than the Git reader's cap and the two views disagree; or the
  // answer depends on the Ruby version Linguist runs on (`generated_html?` on a
  // meta tag with a NUL byte); or Linguist itself raises there (`lines[0]` of an empty `.frm`
  // file), which ends `generated?` without an answer, so no later rule is tried. Only rules
  // Linguist would reach are listed: none after the rule in `generated`.
  readonly notEvaluated: readonly GeneratedRuleName[];
};

// Pure and synchronous: no I/O, no clock, no environment; the same input gives the same output.
// Throws on a path Ruby itself refuses: one holding a NUL byte (`File.extname` raises) or one that
// is not well-formed UTF-16 (a lone surrogate has no UTF-8 form, and Ruby raises on a path that is
// not valid UTF-8 at the first regexp).
export function linguistMark(
  path: string,
  contents?: Uint8Array,
): LinguistMark {
  if (/[\uD800-\uDFFF]/u.test(path))
    throw new Error("linguistMark: the path is not well-formed UTF-16");
  const extname = rubyExtname(path);
  const full = blobView(path, extname, contents);
  // The Git reader's view, only when it differs from the whole file.
  const head =
    contents !== undefined && contents.length > LAZY_BLOB_MAX_SIZE
      ? blobView(path, extname, contents.subarray(0, LAZY_BLOB_MAX_SIZE))
      : undefined;
  let generated: LinguistMark["generated"] = null;
  const notEvaluated: GeneratedRuleName[] = [];
  for (const rule of GENERATED_RULES) {
    let outcome: RuleOutcome | "readers-disagree" = evaluateGeneratedRule(
      rule,
      full,
    );
    // Path-only rules read no bytes, so both views give them the same answer.
    if (head && rule.kind !== "path" && rule.kind !== "extension") {
      const headOutcome = evaluateGeneratedRule(rule, head);
      if (headOutcome !== outcome) outcome = "readers-disagree";
    }
    if (outcome === true) {
      generated = { rule: rule.name };
      break;
    }
    if (outcome === false) continue;
    notEvaluated.push(rule.name);
    if (outcome === "raises") break;
  }
  const vendor = VENDOR_REGEXPS.find(({ regexp }) => regexp.test(path));
  return {
    standard: LINGUIST_STANDARD,
    generated,
    vendored: vendor ? { pattern: vendor.pattern } : null,
    notEvaluated,
  };
}

// One view of the blob: its bytes, decoded into Ruby's byte string and lines only when a rule
// first reads them.
function blobView(
  path: string,
  extname: string,
  contents: Uint8Array | undefined,
): BlobView {
  if (contents === undefined) return { name: path, extname };
  let data: string | undefined;
  let lines: string[] | undefined;
  return {
    name: path,
    extname,
    contents: {
      data: () => (data ??= binaryString(contents)),
      lines: () => (lines ??= rubyLines((data ??= binaryString(contents)))),
    },
  };
}
