// Every rule of the `generated?` chain in Linguist's `lib/linguist/generated.rb` (v9.7.0, carried
// beside this file), in Linguist's order and under Linguist's own method names. Each rule is a row:
// the extensions, names, markers, line numbers and thresholds it reads, and a `kind` that picks
// the small matcher below. Rules that share a shape (an extension test, a line count, then a
// marker on some lines) share the `lines` kind; the rules with a shape of their own get a kind
// named after them.
//
// What a rule reads, as Linguist's `Generated` class gives it:
// - `name` is the blob's path. `extname` is Ruby's `File.extname(name)` (`rubyExtname`).
// - `data` is the blob's bytes and `lines` is `data.split("\n", -1)`. Both come from the caller;
//   when the caller gives no contents, a rule that would read them (its path and extension tests
//   having passed) is reported as not evaluated, never as false.
// - Data is modelled as Linguist's Git reader hands it, a byte string (see `./ruby.ts`): line
//   lengths are byte counts, regular expressions step byte by byte, and case rules touch ASCII
//   letters only.
//
// Where Ruby and JavaScript differ, and what this port does:
// - `^`, `$`, `.`, `\s`, `\A`, `\Z`: translated by `translateRubyRegexp` (`./ruby.ts`). Each
//   regexp row keeps Linguist's literal in `ruby` and the translation in `js`.
// - `lines[i]` past the end is nil in Ruby. `nil =~ re` is nil (false), but `nil.include?`,
//   `nil.start_with?`, `nil.match` and `nil.match?` raise NoMethodError, which ends `generated?`
//   with no answer. The `lines` kind models both: an `=~` test on a missing line is false, any
//   other test on a missing line "raises". Only `generated_mysql_view_definition_format?` can
//   reach a missing line (an empty `.frm` file); there the chain stops and the rule is reported
//   as not evaluated.
// - `lines[-2]` counts from the end (`Array#at`); `lines.first(n)` and `lines[0..n]` are slices.
// - `"".split("\n", -1)` is `[]` in Ruby (`rubyLines`).
// - `extname.downcase` folds a UTF-8 path by Unicode rules, `toLowerCase` likewise; only U+212A
//   (Kelvin) lowers to an ASCII letter and both languages do it, so comparing against Linguist's
//   ASCII extensions gives the same answer.
// - `/i` on a path: JavaScript's `iu` folds one character to one, Onigmo also folds `ß` and `ẞ`
//   to `ss` (checked on Ruby 2.6). Only `source_map?` has such a pair (`.css`); its translation is
//   by hand and says so.
// - `[^>]++` (possessive) in `generated_html?`: JavaScript has none. The class cannot match the
//   `>` that follows, so giving characters back never helps a match, and greedy `[^>]+` finds the
//   same matches. Translated by hand and marked.
// - `String#strip` in `extract_html_meta`: whether a leading NUL is dropped depends on the Ruby
//   version (Ruby 2.6 keeps it). `generated_html?` reads the meta tags both ways and, when the two
//   readings disagree, reports the rule as not evaluated.
// - `generated_html?`'s `return true if x.any? do ... end` and `return x.any? do ... end`: the
//   `do` block binds to `any?` (checked on Ruby 2.6), so each is ported as a predicate.
//
// Rules left out: none. Every rule reads only the path and the bytes. `LEFT_OUT` stays as the
// place to name one, with its reason, if a later Linguist version adds a rule that cannot be
// ported.
import {
  asciiDowncase,
  RUBY_LINE_START as LINE_START,
  RUBY_SPACE as SPACE,
  rubyStrip,
  type RubyStrip,
} from "./ruby.ts";

export const LEFT_OUT: readonly {
  readonly rule: string;
  readonly reason: string;
}[] = [];

export type RubyRegexp = {
  // The literal exactly as `generated.rb` writes it.
  readonly ruby: string;
  // The JavaScript source and flags with the same matches.
  readonly js: string;
  readonly flags: string;
  // Why the translation is by hand, when `translateRubyRegexp` refuses the literal.
  readonly hand?: string;
  readonly regexp: RegExp;
  readonly all: RegExp;
};

// A path regexp: a UTF-8 string in Ruby, so `u`.
const path = (ruby: string, js: string, hand?: string): RubyRegexp =>
  regexp(ruby, js, ruby.endsWith("/i") ? "iu" : "u", hand);
// A data regexp: a byte string in Ruby, so no `u`.
const data = (ruby: string, js: string, hand?: string): RubyRegexp =>
  regexp(ruby, js, /\/[a-z]*i[a-z]*$/.test(ruby) ? "i" : "", hand);
const regexp = (
  ruby: string,
  js: string,
  flags: string,
  hand: string | undefined,
): RubyRegexp => ({
  ruby,
  js,
  flags,
  ...(hand === undefined ? {} : { hand }),
  regexp: new RegExp(js, flags),
  all: new RegExp(js, `${flags}g`),
});

// `[...].include?(extname)`, or `extname.downcase` when `downcase` is set.
export type ExtensionTest = {
  readonly extensions: readonly string[];
  readonly downcase: boolean;
};
const exact = (...extensions: string[]): ExtensionTest => ({
  extensions,
  downcase: false,
});
const folded = (...extensions: string[]): ExtensionTest => ({
  extensions,
  downcase: true,
});

export type LineTest =
  | { readonly op: "include?"; readonly text: string }
  | { readonly op: "start_with?"; readonly text: string }
  // `String#match` and `String#match?`: raise on a missing line.
  | { readonly op: "match"; readonly regexp: RubyRegexp }
  // `=~`: false on a missing line.
  | { readonly op: "=~"; readonly regexp: RubyRegexp };

export type LineCheck =
  // `lines[line]`, negative from the end.
  | { readonly line: number; readonly test: LineTest }
  // `lines.first(anyOfFirst).any? { |l| every test on l }`, on `l.downcase` when set.
  | {
      readonly anyOfFirst: number;
      readonly downcase?: true;
      readonly tests: readonly LineTest[];
    }
  | { readonly all: readonly LineCheck[] }
  | { readonly any: readonly LineCheck[] };

// `lines.count > n` or `lines.count >= n`.
export type LineCount = { readonly op: ">" | ">="; readonly n: number };

type Rule<Name extends string, Kind extends string, Fields> = {
  readonly name: Name;
  readonly kind: Kind;
} & Fields;

export type GeneratedRule =
  | Rule<string, "extension", { readonly extension: ExtensionTest }>
  | Rule<string, "path", { readonly any: readonly RubyRegexp[] }>
  | Rule<
      string,
      "lines",
      {
        readonly extension?: ExtensionTest;
        readonly path?: RubyRegexp;
        readonly lineCount?: LineCount;
        readonly check: LineCheck;
      }
    >
  | Rule<
      string,
      "minified_files",
      { readonly extension: ExtensionTest; readonly averageAbove: number }
    >
  | Rule<
      string,
      "has_source_map",
      {
        readonly extension: ExtensionTest;
        readonly lastLines: number;
        readonly marker: RubyRegexp;
      }
    >
  | Rule<
      string,
      "source_map",
      {
        readonly extension: ExtensionTest;
        readonly path: RubyRegexp;
        readonly firstLine: readonly RubyRegexp[];
      }
    >
  | Rule<
      string,
      "compiled_coffeescript",
      {
        readonly extension: ExtensionTest;
        readonly header: RubyRegexp;
        readonly opening: string;
        readonly closing: string;
        readonly varLine: RubyRegexp;
        readonly weighted: readonly {
          readonly weight: number;
          readonly marker: RubyRegexp;
        }[];
        readonly minScore: number;
      }
    >
  | Rule<
      string,
      "generated_parser",
      {
        readonly extension: ExtensionTest;
        readonly firstLines: number;
        readonly marker: RubyRegexp;
      }
    >
  | Rule<
      string,
      "generated_postscript",
      {
        readonly extension: ExtensionTest;
        readonly fontStream: RubyRegexp;
        readonly creatorLines: number;
        readonly creator: RubyRegexp;
        readonly creatorMarks: readonly RubyRegexp[];
        readonly eagle: string;
        readonly titleLines: number;
        readonly title: RubyRegexp;
      }
    >
  | Rule<
      string,
      "generated_gamemakerstudio",
      {
        readonly extension: ExtensionTest;
        readonly lineCount: LineCount;
        readonly joinedLines: number;
        readonly joined: RubyRegexp;
        readonly firstLine: RubyRegexp;
      }
    >
  | Rule<
      string,
      "generated_html",
      {
        readonly extension: ExtensionTest;
        readonly lineCount: LineCount;
        readonly pkgdownLines: number;
        readonly pkgdown: RubyRegexp;
        readonly mandocLine: number;
        readonly mandoc: string;
        readonly headLines: number;
        readonly doxygen: RubyRegexp;
        readonly meta: RubyRegexp;
        readonly trailingSlash: RubyRegexp;
        readonly attribute: RubyRegexp;
        readonly quotes: RubyRegexp;
        readonly generatorName: string;
        readonly generator: RubyRegexp;
      }
    >;

const include = (text: string): LineTest => ({ op: "include?", text });
const startWith = (text: string): LineTest => ({ op: "start_with?", text });
const match = (regexp: RubyRegexp): LineTest => ({ op: "match", regexp });
const matchOp = (regexp: RubyRegexp): LineTest => ({ op: "=~", regexp });
const more = (n: number): LineCount => ({ op: ">", n });

const MAYBE_MINIFIED = folded(".js", ".css"); // maybe_minified?
const PROTOBUF_EXTENSIONS = exact(
  ".py",
  ".java",
  ".h",
  ".cc",
  ".cpp",
  ".m",
  ".rb",
  ".php",
);
const APACHE_THRIFT_EXTENSIONS = exact(
  ".rb",
  ".py",
  ".go",
  ".js",
  ".m",
  ".java",
  ".h",
  ".cc",
  ".cpp",
  ".php",
);
const HAXE_EXTENSIONS = exact(
  ".js",
  ".py",
  ".lua",
  ".cpp",
  ".h",
  ".java",
  ".cs",
  ".php",
);

export const GENERATED_RULES = [
  {
    name: "xcode_file?",
    kind: "extension",
    extension: exact(".nib", ".xcworkspacedata", ".xcuserstate"),
  },
  {
    name: "intellij_file?",
    kind: "path",
    any: [
      path(
        String.raw`/(?:^|\/)\.idea\//`,
        String.raw`(?:${LINE_START}|\/)\.idea\/`,
      ),
    ],
  },
  {
    name: "cocoapods?",
    kind: "path",
    any: [
      path(
        String.raw`/(^Pods|\/Pods)\//`,
        String.raw`(${LINE_START}Pods|\/Pods)\/`,
      ),
    ],
  },
  {
    name: "carthage_build?",
    kind: "path",
    any: [
      path(
        String.raw`/(^|\/)Carthage\/Build\//`,
        String.raw`(${LINE_START}|\/)Carthage\/Build\/`,
      ),
    ],
  },
  {
    name: "generated_graphql_relay?",
    kind: "path",
    any: [path(String.raw`/__generated__\//`, String.raw`__generated__\/`)],
  },
  {
    name: "generated_net_designer_file?",
    kind: "path",
    any: [
      path(
        String.raw`/\.designer\.(cs|vb)$/i`,
        String.raw`\.designer\.(cs|vb)(?![^\n])`,
      ),
    ],
  },
  {
    name: "generated_net_specflow_feature_file?",
    kind: "path",
    any: [
      path(String.raw`/\.feature\.cs$/i`, String.raw`\.feature\.cs(?![^\n])`),
    ],
  },
  {
    name: "composer_lock?",
    kind: "path",
    any: [path(String.raw`/composer\.lock/`, String.raw`composer\.lock`)],
  },
  {
    name: "cargo_lock?",
    kind: "path",
    any: [path(String.raw`/Cargo\.lock/`, String.raw`Cargo\.lock`)],
  },
  {
    name: "cargo_orig?",
    kind: "path",
    any: [path(String.raw`/Cargo\.toml\.orig/`, String.raw`Cargo\.toml\.orig`)],
  },
  {
    name: "deno_lock?",
    kind: "path",
    any: [path(String.raw`/deno\.lock/`, String.raw`deno\.lock`)],
  },
  {
    name: "flake_lock?",
    kind: "path",
    any: [
      path(
        String.raw`/(^|\/)flake\.lock$/`,
        String.raw`(${LINE_START}|\/)flake\.lock(?![^\n])`,
      ),
    ],
  },
  {
    name: "bazel_lock?",
    kind: "path",
    any: [
      path(
        String.raw`/(^|\/)MODULE\.bazel\.lock$/`,
        String.raw`(${LINE_START}|\/)MODULE\.bazel\.lock(?![^\n])`,
      ),
    ],
  },
  {
    name: "node_modules?",
    kind: "path",
    any: [path(String.raw`/node_modules\//`, String.raw`node_modules\/`)],
  },
  {
    name: "go_vendor?",
    kind: "path",
    any: [
      path(
        String.raw`/vendor\/((?!-)[-0-9A-Za-z]+(?<!-)\.)+(com|edu|gov|in|me|net|org|fm|io)/`,
        String.raw`vendor\/((?!-)[-0-9A-Za-z]+(?<!-)\.)+(com|edu|gov|in|me|net|org|fm|io)`,
      ),
    ],
  },
  {
    name: "go_lock?",
    kind: "path",
    any: [
      path(String.raw`/(Gopkg|glide)\.lock/`, String.raw`(Gopkg|glide)\.lock`),
    ],
  },
  {
    name: "package_resolved?",
    kind: "path",
    any: [path(String.raw`/Package\.resolved/`, String.raw`Package\.resolved`)],
  },
  {
    name: "poetry_lock?",
    kind: "path",
    any: [path(String.raw`/poetry\.lock/`, String.raw`poetry\.lock`)],
  },
  {
    name: "pdm_lock?",
    kind: "path",
    any: [path(String.raw`/pdm\.lock/`, String.raw`pdm\.lock`)],
  },
  {
    name: "uv_lock?",
    kind: "path",
    any: [path(String.raw`/uv\.lock/`, String.raw`uv\.lock`)],
  },
  {
    name: "pixi_lock?",
    kind: "path",
    any: [path(String.raw`/pixi\.lock/`, String.raw`pixi\.lock`)],
  },
  {
    name: "esy_lock?",
    kind: "path",
    any: [
      path(
        String.raw`/(^|\/)(\w+\.)?esy.lock$/`,
        String.raw`(${LINE_START}|\/)(\w+\.)?esy[^\n]lock(?![^\n])`,
      ),
    ],
  },
  {
    name: "npm_shrinkwrap_or_package_lock?",
    kind: "path",
    any: [
      path(
        String.raw`/npm-shrinkwrap\.json/`,
        String.raw`npm-shrinkwrap\.json`,
      ),
      path(String.raw`/package-lock\.json/`, String.raw`package-lock\.json`),
    ],
  },
  {
    name: "pnpm_lock?",
    kind: "path",
    any: [path(String.raw`/pnpm-lock\.yaml/`, String.raw`pnpm-lock\.yaml`)],
  },
  {
    name: "bun_lock?",
    kind: "path",
    any: [
      path(
        String.raw`/(?:^|\/)bun\.lockb?$/`,
        String.raw`(?:${LINE_START}|\/)bun\.lockb?(?![^\n])`,
      ),
    ],
  },
  {
    name: "terraform_lock?",
    kind: "path",
    any: [
      path(
        String.raw`/(?:^|\/)\.terraform\.lock\.hcl$/`,
        String.raw`(?:${LINE_START}|\/)\.terraform\.lock\.hcl(?![^\n])`,
      ),
    ],
  },
  {
    name: "generated_yarn_plugnplay?",
    kind: "path",
    any: [
      path(
        String.raw`/(^|\/)\.pnp\..*$/`,
        String.raw`(${LINE_START}|\/)\.pnp\.[^\n]*(?![^\n])`,
      ),
    ],
  },
  {
    name: "godeps?",
    kind: "path",
    any: [path(String.raw`/Godeps\//`, String.raw`Godeps\/`)],
  },
  {
    name: "generated_by_zephir?",
    kind: "path",
    any: [
      path(
        String.raw`/.\.zep\.(?:c|h|php)$/`,
        String.raw`[^\n]\.zep\.(?:c|h|php)(?![^\n])`,
      ),
    ],
  },
  {
    name: "htmlcov?",
    kind: "path",
    any: [
      path(
        String.raw`/(?:^|\/)htmlcov\//`,
        String.raw`(?:${LINE_START}|\/)htmlcov\/`,
      ),
    ],
  },
  // `(lines.inject(0) { |n, l| n += l.length } / lines.length) > 110`: integer division of the
  // byte total by the line count.
  {
    name: "minified_files?",
    kind: "minified_files",
    extension: MAYBE_MINIFIED,
    averageAbove: 110,
  },
  {
    name: "has_source_map?",
    kind: "has_source_map",
    extension: MAYBE_MINIFIED,
    lastLines: 2,
    marker: data(
      String.raw`/^\/[*\/][\#@] source(?:Mapping)?URL|sourceURL=/`,
      String.raw`${LINE_START}\/[*\/][#@] source(?:Mapping)?URL|sourceURL=`,
    ),
  },
  {
    name: "source_map?",
    kind: "source_map",
    extension: folded(".map"),
    path: path(
      String.raw`/(\.css|\.js)\.map$/i`,
      String.raw`(\.c(?:ss|ß)|\.js)\.map(?![^\n])`,
      "Onigmo folds ß and ẞ to ss under /i; JavaScript's iu folds one character to one, so ss also takes ß (ẞ folds to ß)",
    ),
    firstLine: [
      data(
        String.raw`/^{"version":\d+,/`,
        String.raw`${LINE_START}\{"version":\d+,`,
      ),
      data(
        String.raw`/^\/\*\* Begin line maps\. \*\*\/{/`,
        String.raw`${LINE_START}\/\*\* Begin line maps\. \*\*\/\{`,
      ),
    ],
  },
  {
    name: "compiled_coffeescript?",
    kind: "compiled_coffeescript",
    extension: exact(".js"),
    header: data(
      String.raw`/^\/\/ Generated by /`,
      String.raw`${LINE_START}\/\/ Generated by `,
    ),
    opening: "(function() {",
    closing: "}).call(this);",
    varLine: data(String.raw`/var /`, String.raw`var `),
    // `score += weight * line.gsub(marker).count`: the number of successive matches.
    weighted: [
      {
        weight: 1,
        marker: data(
          String.raw`/(_fn|_i|_len|_ref|_results)/`,
          String.raw`(_fn|_i|_len|_ref|_results)`,
        ),
      },
      {
        weight: 3,
        marker: data(
          String.raw`/(__bind|__extends|__hasProp|__indexOf|__slice)/`,
          String.raw`(__bind|__extends|__hasProp|__indexOf|__slice)`,
        ),
      },
    ],
    minScore: 3,
  },
  {
    name: "generated_parser?",
    kind: "generated_parser",
    extension: exact(".js"),
    // `lines[0..4].join('')`
    firstLines: 5,
    marker: data(
      String.raw`/^(?:[^\/]|\/[^\*])*\/\*(?:[^\*]|\*[^\/])*Generated by PEG.js/`,
      String.raw`${LINE_START}(?:[^\/]|\/[^\*])*\/\*(?:[^\*]|\*[^\/])*Generated by PEG[^\n]js`,
    ),
  },
  {
    name: "generated_net_docfile?",
    kind: "lines",
    extension: folded(".xml"),
    lineCount: more(3),
    check: {
      all: [
        { line: 1, test: include("<doc>") },
        { line: 2, test: include("<assembly>") },
        { line: -2, test: include("</doc>") },
      ],
    },
  },
  {
    name: "generated_postscript?",
    kind: "generated_postscript",
    extension: exact(".ps", ".eps", ".pfa"),
    // Matched against the whole data, so `^` and `\s` cross lines.
    fontStream: data(
      String.raw`/^\s*(?:currentfile eexec\s+|\/sfnts\s+\[\s<)/`,
      String.raw`${LINE_START}${SPACE}*(?:currentfile eexec${SPACE}+|\/sfnts${SPACE}+\[${SPACE}<)`,
    ),
    // `lines[0..9].find`
    creatorLines: 10,
    creator: data(
      String.raw`/^%%Creator: /`,
      String.raw`${LINE_START}%%Creator: `,
    ),
    creatorMarks: [
      data(
        String.raw`/[0-9]|draw|mpage|ImageMagick|inkscape|MATLAB/`,
        String.raw`[0-9]|draw|mpage|ImageMagick|inkscape|MATLAB`,
      ),
      data(
        String.raw`/PCBNEW|pnmtops|\(Unknown\)|Serif Affinity|Filterimage -tops/`,
        String.raw`PCBNEW|pnmtops|\(Unknown\)|Serif Affinity|Filterimage -tops`,
      ),
    ],
    eagle: "EAGLE",
    // `lines[0..4].find`
    titleLines: 5,
    title: data(
      String.raw`/^%%Title: EAGLE Drawing /`,
      String.raw`${LINE_START}%%Title: EAGLE Drawing `,
    ),
  },
  {
    name: "compiled_cython_file?",
    kind: "lines",
    extension: exact(".c", ".cpp"),
    lineCount: more(1),
    check: { line: 0, test: include("Generated by Cython") },
  },
  {
    name: "pipenv_lock?",
    kind: "path",
    any: [path(String.raw`/Pipfile\.lock/`, String.raw`Pipfile\.lock`)],
  },
  {
    name: "gradle_wrapper?",
    kind: "path",
    any: [
      path(
        String.raw`/(?:^|\/)gradlew(?:\.bat)?$/i`,
        String.raw`(?:${LINE_START}|\/)gradlew(?:\.bat)?(?![^\n])`,
      ),
    ],
  },
  {
    name: "maven_wrapper?",
    kind: "path",
    any: [
      path(
        String.raw`/(?:^|\/)mvnw(?:\.cmd)?$/i`,
        String.raw`(?:${LINE_START}|\/)mvnw(?:\.cmd)?(?![^\n])`,
      ),
    ],
  },
  {
    name: "mise_lock?",
    kind: "path",
    any: [
      path(
        String.raw`/(?:^|\/)mise(?:\.[^\/]+)?\.lock$/`,
        String.raw`(?:${LINE_START}|\/)mise(?:\.[^\/]+)?\.lock(?![^\n])`,
      ),
    ],
  },
  {
    name: "secrets_baseline?",
    kind: "path",
    any: [
      path(
        String.raw`/(?:^|\/)\.secrets\.baseline$/`,
        String.raw`(?:${LINE_START}|\/)\.secrets\.baseline(?![^\n])`,
      ),
    ],
  },
  {
    name: "julia_manifest?",
    kind: "path",
    any: [
      path(
        String.raw`/(?:^|\/)(Julia)?Manifest(-v\d+\.\d+)?\.toml$/`,
        String.raw`(?:${LINE_START}|\/)(Julia)?Manifest(-v\d+\.\d+)?\.toml(?![^\n])`,
      ),
    ],
  },
  {
    name: "generated_go?",
    kind: "lines",
    extension: exact(".go"),
    lineCount: more(1),
    check: {
      anyOfFirst: 40,
      tests: [
        matchOp(
          data(
            String.raw`%r{^// Code generated .*}`,
            String.raw`${LINE_START}// Code generated [^\n]*`,
          ),
        ),
      ],
    },
  },
  {
    name: "generated_protocol_buffer_from_go?",
    kind: "lines",
    extension: exact(".proto"),
    lineCount: more(1),
    check: {
      anyOfFirst: 20,
      tests: [include("This file was autogenerated by go-to-protobuf")],
    },
  },
  {
    name: "generated_protocol_buffer?",
    kind: "lines",
    extension: PROTOBUF_EXTENSIONS,
    lineCount: more(1),
    check: {
      anyOfFirst: 3,
      tests: [
        include("Generated by the protocol buffer compiler.  DO NOT EDIT!"),
      ],
    },
  },
  {
    name: "generated_javascript_protocol_buffer?",
    kind: "lines",
    extension: exact(".js"),
    lineCount: more(6),
    check: { line: 5, test: include("GENERATED CODE -- DO NOT EDIT!") },
  },
  {
    name: "generated_typescript_protocol_buffer?",
    kind: "lines",
    extension: exact(".ts"),
    lineCount: more(4),
    check: {
      line: 0,
      test: include("Code generated by protoc-gen-ts_proto. DO NOT EDIT."),
    },
  },
  {
    name: "generated_twirp_ruby?",
    kind: "lines",
    extension: exact(".rb"),
    lineCount: more(1),
    check: {
      anyOfFirst: 3,
      tests: [
        include("Code generated by protoc-gen-twirp_ruby"),
        include("DO NOT EDIT."),
      ],
    },
  },
  {
    name: "generated_apache_thrift?",
    kind: "lines",
    extension: APACHE_THRIFT_EXTENSIONS,
    check: {
      anyOfFirst: 6,
      tests: [include("Autogenerated by Thrift Compiler")],
    },
  },
  {
    name: "generated_jni_header?",
    kind: "lines",
    extension: exact(".h"),
    lineCount: more(2),
    check: {
      all: [
        {
          line: 0,
          test: include(
            "/* DO NOT EDIT THIS FILE - it is machine generated */",
          ),
        },
        { line: 1, test: include("#include <jni.h>") },
      ],
    },
  },
  {
    name: "vcr_cassette?",
    kind: "lines",
    extension: exact(".yml"),
    lineCount: more(2),
    check: { line: -2, test: include("recorded_with: VCR") },
  },
  {
    name: "generated_antlr?",
    kind: "lines",
    extension: exact(".g"),
    lineCount: more(2),
    check: { line: 1, test: include("generated by Xtest") },
  },
  {
    name: "generated_module?",
    kind: "lines",
    extension: exact(".mod"),
    lineCount: more(1),
    check: {
      any: [
        { line: 0, test: include("PCBNEW-LibModule-V") },
        { line: 0, test: include("GFORTRAN module version '") },
      ],
    },
  },
  {
    name: "generated_unity3d_meta?",
    kind: "lines",
    extension: exact(".meta"),
    lineCount: more(1),
    check: { line: 0, test: include("fileFormatVersion: ") },
  },
  {
    name: "generated_racc?",
    kind: "lines",
    extension: exact(".rb"),
    lineCount: more(2),
    check: {
      line: 2,
      test: startWith("# This file is automatically generated by Racc"),
    },
  },
  {
    name: "generated_jflex?",
    kind: "lines",
    extension: exact(".java"),
    lineCount: more(1),
    check: {
      line: 0,
      test: startWith("/* The following code was generated by JFlex "),
    },
  },
  {
    name: "generated_grammarkit?",
    kind: "lines",
    extension: exact(".java"),
    lineCount: more(1),
    check: {
      line: 0,
      test: startWith(
        "// This is a generated file. Not intended for manual editing.",
      ),
    },
  },
  {
    name: "generated_roxygen2?",
    kind: "lines",
    extension: exact(".Rd"),
    lineCount: more(1),
    check: {
      line: 0,
      test: include("% Generated by roxygen2: do not edit by hand"),
    },
  },
  {
    name: "generated_html?",
    kind: "generated_html",
    extension: folded(".html", ".htm", ".xhtml"),
    lineCount: more(1),
    // `lines[0..1].any?`
    pkgdownLines: 2,
    pkgdown: data(
      String.raw`/<!-- Generated by pkgdown: do not edit by hand -->/`,
      String.raw`<!-- Generated by pkgdown: do not edit by hand -->`,
    ),
    // `lines.count > 2 && lines[2].start_with?`
    mandocLine: 2,
    mandoc: "<!-- This is an automatically generated file.",
    // `lines[0..30]`
    headLines: 31,
    doxygen: data(
      String.raw`/<!--\s+Generated by Doxygen\s+[.0-9]+\s*-->/i`,
      String.raw`<!--${SPACE}+Generated by Doxygen${SPACE}+[.0-9]+${SPACE}*-->`,
    ),
    // `lines[0..30].join(' ').scan(...)`
    meta: data(
      String.raw`/<meta(\s+[^>]++)>/i`,
      String.raw`<meta(${SPACE}+[^>]+)>`,
      "possessive [^>]++ before >: the class cannot match the > that follows, so greedy [^>]+ finds the same matches",
    ),
    // extract_html_meta: `.sub(/\/\Z/, "")`, then `.strip`, then `.scan(...)`, then each value's
    // `.gsub(/\A["']|["']\Z/, '')`; a later attribute of the same name wins (`to_h`).
    trailingSlash: data(String.raw`/\/\Z/`, String.raw`\/(?=\n?(?![\s\S]))`),
    attribute: data(
      String.raw`/
        (?<=^|\s)              # Check for preceding whitespace
        (name|content|value)   # Attribute names we're interested in
        \s* = \s*              # Key-value separator

        # Attribute value
        ( "[^"]+"        # name="value"
        | '[^']+'        # name='value'
        |  [^\s"']+      # name=value
        )
      /ix`,
      String.raw`(?<=${LINE_START}|${SPACE})(name|content|value)${SPACE}*=${SPACE}*("[^"]+"|'[^']+'|[^\t\n\v\f\r "']+)`,
    ),
    quotes: data(
      String.raw`/\A["']|["']\Z/`,
      String.raw`(?<![\s\S])["']|["'](?=\n?(?![\s\S]))`,
    ),
    generatorName: "generator",
    generator: data(
      String.raw`/^
            ( org \s+ mode
            | j?latex2html
            | groff
            | makeinfo
            | texi2html
            | ronn
            ) \b
          /ix`,
      String.raw`${LINE_START}(org${SPACE}+mode|j?latex2html|groff|makeinfo|texi2html|ronn)\b`,
    ),
  },
  {
    name: "generated_jison?",
    kind: "lines",
    extension: exact(".js"),
    lineCount: more(1),
    check: {
      any: [
        { line: 0, test: startWith("/* parser generated by jison ") },
        { line: 0, test: startWith("/* generated by jison-lex ") },
      ],
    },
  },
  {
    name: "generated_grpc_cpp?",
    kind: "lines",
    extension: exact(".cpp", ".hpp", ".h", ".cc"),
    lineCount: more(1),
    check: { line: 0, test: startWith("// Generated by the gRPC") },
  },
  {
    name: "generated_dart?",
    kind: "lines",
    extension: exact(".dart"),
    lineCount: more(1),
    check: {
      anyOfFirst: 3,
      downcase: true,
      tests: [
        match(
          data(
            String.raw`/generated code\W{2,3}do not modify/`,
            String.raw`generated code\W{2,3}do not modify`,
          ),
        ),
      ],
    },
  },
  {
    name: "generated_perl_ppport_header?",
    kind: "lines",
    path: path(String.raw`/ppport\.h$/`, String.raw`ppport\.h(?![^\n])`),
    lineCount: more(10),
    check: { line: 8, test: include("Automatically created by Devel::PPPort") },
  },
  {
    name: "generated_gamemakerstudio?",
    kind: "generated_gamemakerstudio",
    extension: exact(".yy", ".yyp"),
    lineCount: more(3),
    // `lines.first(3).join('').match?(...) || lines[0] =~ ...`
    joinedLines: 3,
    joined: data(
      String.raw`/^\s*[\{\[]/`,
      String.raw`${LINE_START}${SPACE}*[\{\[]`,
    ),
    firstLine: data(
      String.raw`/^\d\.\d\.\d.+\|\{/`,
      String.raw`${LINE_START}\d\.\d\.\d[^\n]+\|\{`,
    ),
  },
  {
    name: "generated_gimp?",
    kind: "lines",
    extension: exact(".c", ".h"),
    lineCount: more(0),
    check: {
      any: [
        {
          line: 0,
          test: match(
            data(
              String.raw`/^\/\* GIMP [a-zA-Z0-9\- ]+ C\-Source image dump \(.+?\.c\) \*\//`,
              String.raw`${LINE_START}\/\* GIMP [a-zA-Z0-9\- ]+ C-Source image dump \([^\n]+?\.c\) \*\/`,
            ),
          ),
        },
        {
          line: 0,
          test: match(
            data(
              String.raw`/^\/\*  GIMP header image file format \([a-zA-Z0-9\- ]+\)\: .+?\.h  \*\//`,
              String.raw`${LINE_START}\/\*  GIMP header image file format \([a-zA-Z0-9\- ]+\): [^\n]+?\.h  \*\/`,
            ),
          ),
        },
      ],
    },
  },
  {
    name: "generated_visualstudio6?",
    kind: "lines",
    extension: folded(".dsp"),
    check: {
      anyOfFirst: 3,
      tests: [include("# Microsoft Developer Studio Generated Build File")],
    },
  },
  {
    name: "generated_haxe?",
    kind: "lines",
    extension: HAXE_EXTENSIONS,
    check: { anyOfFirst: 3, tests: [include("Generated by Haxe")] },
  },
  {
    name: "generated_jooq?",
    kind: "lines",
    extension: folded(".java"),
    check: {
      anyOfFirst: 2,
      tests: [include("This file is generated by jOOQ.")],
    },
  },
  {
    name: "generated_pascal_tlb?",
    kind: "path",
    any: [path(String.raw`/_tlb\.pas$/i`, String.raw`_tlb\.pas(?![^\n])`)],
  },
  {
    name: "generated_sorbet_rbi?",
    kind: "lines",
    extension: folded(".rbi"),
    lineCount: { op: ">=", n: 5 },
    check: {
      all: [
        {
          line: 0,
          test: match(
            data(String.raw`/^# typed:/`, String.raw`${LINE_START}# typed:`),
          ),
        },
        { line: 2, test: include("DO NOT EDIT MANUALLY") },
        {
          line: 4,
          test: match(
            data(
              String.raw`/^# Please (run|instead update this file by running) ${"`"}bin\/tapioca/`,
              String.raw`${LINE_START}# Please (run|instead update this file by running) ${"`"}bin\/tapioca`,
            ),
          ),
        },
      ],
    },
  },
  {
    name: "generated_mysql_view_definition_format?",
    kind: "lines",
    extension: folded(".frm"),
    // No line count first: an empty file leaves `lines[0]` nil and Ruby raises.
    check: { line: 0, test: include("TYPE=VIEW") },
  },
  {
    name: "generated_sqlx_query?",
    kind: "path",
    any: [
      path(
        String.raw`/(?:^|\/)\.sqlx\/query-[a-f\d]{64}\.json$/`,
        String.raw`(?:${LINE_START}|\/)\.sqlx\/query-[a-f\d]{64}\.json(?![^\n])`,
      ),
    ],
  },
] as const satisfies readonly GeneratedRule[];

export type GeneratedRuleName = (typeof GENERATED_RULES)[number]["name"];

// What a rule gives: true or false as Linguist would, "no-contents" when it needs bytes the
// caller did not give, "both-ways" when the answer depends on the Ruby version Linguist runs on,
// and "raises" when Linguist itself raises (and `generated?` gives no answer at all).
export type RuleOutcome = boolean | "no-contents" | "both-ways" | "raises";

export type BlobView = {
  readonly name: string;
  readonly extname: string;
  // Absent when the caller gave no contents. `data` is the binary string, `lines` its Ruby lines.
  readonly contents?: {
    readonly data: () => string;
    readonly lines: () => string[];
  };
};

const extensionMatches = (test: ExtensionTest, blob: BlobView) =>
  test.extensions.includes(
    test.downcase ? blob.extname.toLowerCase() : blob.extname,
  );

function lineTest(
  test: LineTest,
  line: string | undefined,
): boolean | "raises" {
  if (line === undefined) return test.op === "=~" ? false : "raises";
  switch (test.op) {
    case "include?":
      return line.includes(test.text);
    case "start_with?":
      return line.startsWith(test.text);
    case "match":
    case "=~":
      return test.regexp.regexp.test(line);
  }
}

function lineCheck(
  check: LineCheck,
  lines: readonly string[],
): boolean | "raises" {
  if ("line" in check) return lineTest(check.test, lines.at(check.line));
  if ("anyOfFirst" in check)
    return lines.slice(0, check.anyOfFirst).some((line) => {
      const subject = check.downcase ? asciiDowncase(line) : line;
      return check.tests.every((test) => lineTest(test, subject) === true);
    });
  // `a && b` and `a || b`: stop at the first answer, as Ruby does, so a later raise is not reached.
  if ("all" in check) {
    for (const part of check.all) {
      const outcome = lineCheck(part, lines);
      if (outcome !== true) return outcome;
    }
    return true;
  }
  for (const part of check.any) {
    const outcome = lineCheck(part, lines);
    if (outcome !== false) return outcome;
  }
  return false;
}

const lineCountHolds = (count: LineCount, lines: readonly string[]) =>
  count.op === ">" ? lines.length > count.n : lines.length >= count.n;

export function evaluateGeneratedRule(
  rule: GeneratedRule,
  blob: BlobView,
): RuleOutcome {
  switch (rule.kind) {
    case "extension":
      return extensionMatches(rule.extension, blob);
    case "path":
      return rule.any.some((pattern) => pattern.regexp.test(blob.name));
    case "lines": {
      if (rule.extension && !extensionMatches(rule.extension, blob))
        return false;
      if (rule.path && !rule.path.regexp.test(blob.name)) return false;
      if (!blob.contents) return "no-contents";
      const lines = blob.contents.lines();
      if (rule.lineCount && !lineCountHolds(rule.lineCount, lines))
        return false;
      return lineCheck(rule.check, lines);
    }
    case "minified_files": {
      if (!extensionMatches(rule.extension, blob)) return false;
      if (!blob.contents) return "no-contents";
      const lines = blob.contents.lines();
      if (lines.length === 0) return false;
      const total = lines.reduce((sum, line) => sum + line.length, 0);
      return Math.floor(total / lines.length) > rule.averageAbove;
    }
    case "has_source_map": {
      if (!extensionMatches(rule.extension, blob)) return false;
      if (!blob.contents) return "no-contents";
      return blob.contents
        .lines()
        .slice(-rule.lastLines)
        .some((line) => rule.marker.regexp.test(line));
    }
    case "source_map": {
      if (!extensionMatches(rule.extension, blob)) return false;
      if (rule.path.regexp.test(blob.name)) return true;
      if (!blob.contents) return "no-contents";
      const first = blob.contents.lines()[0];
      return (
        first !== undefined &&
        rule.firstLine.some((marker) => marker.regexp.test(first))
      );
    }
    case "compiled_coffeescript": {
      if (!extensionMatches(rule.extension, blob)) return false;
      if (!blob.contents) return "no-contents";
      const lines = blob.contents.lines();
      const first = lines[0];
      if (first !== undefined && rule.header.regexp.test(first)) return true;
      if (!(
        first === rule.opening &&
        lines.at(-2) === rule.closing &&
        lines.at(-1) === ""
      ))
        return false;
      let score = 0;
      for (const line of lines)
        if (rule.varLine.regexp.test(line))
          for (const { weight, marker } of rule.weighted)
            score += weight * [...line.matchAll(marker.all)].length;
      return score >= rule.minScore;
    }
    case "generated_parser": {
      if (!extensionMatches(rule.extension, blob)) return false;
      if (!blob.contents) return "no-contents";
      return rule.marker.regexp.test(
        blob.contents.lines().slice(0, rule.firstLines).join(""),
      );
    }
    case "generated_postscript": {
      if (!extensionMatches(rule.extension, blob)) return false;
      if (!blob.contents) return "no-contents";
      if (rule.fontStream.regexp.test(blob.contents.data())) return true;
      const lines = blob.contents.lines();
      const creator = lines
        .slice(0, rule.creatorLines)
        .find((line) => rule.creator.regexp.test(line));
      if (creator === undefined) return false;
      if (rule.creatorMarks.some((marker) => marker.regexp.test(creator)))
        return true;
      return (
        creator.includes(rule.eagle) &&
        lines
          .slice(0, rule.titleLines)
          .some((line) => rule.title.regexp.test(line))
      );
    }
    case "generated_gamemakerstudio": {
      if (!extensionMatches(rule.extension, blob)) return false;
      if (!blob.contents) return "no-contents";
      const lines = blob.contents.lines();
      if (!lineCountHolds(rule.lineCount, lines)) return false;
      if (rule.joined.regexp.test(lines.slice(0, rule.joinedLines).join("")))
        return true;
      return lineTest({ op: "=~", regexp: rule.firstLine }, lines[0]) === true;
    }
    case "generated_html":
      return generatedHtml(rule, blob);
  }
}

type HtmlRule = Extract<GeneratedRule, { kind: "generated_html" }>;

function generatedHtml(rule: HtmlRule, blob: BlobView): RuleOutcome {
  if (!extensionMatches(rule.extension, blob)) return false;
  if (!blob.contents) return "no-contents";
  const lines = blob.contents.lines();
  if (!lineCountHolds(rule.lineCount, lines)) return false;
  if (
    lines
      .slice(0, rule.pkgdownLines)
      .some((line) => rule.pkgdown.regexp.test(line))
  )
    return true;
  const mandoc = lines[rule.mandocLine];
  if (mandoc !== undefined && mandoc.startsWith(rule.mandoc)) return true;
  const head = lines.slice(0, rule.headLines);
  if (head.some((line) => rule.doxygen.regexp.test(line))) return true;
  const tags = [...head.join(" ").matchAll(rule.meta.all)].map(
    (found) => found[1]!,
  );
  if (tags.length === 0) return false;
  const reading = (strip: RubyStrip) =>
    tags.some((tag) => {
      const attributes = extractHtmlMeta(rule, tag, strip);
      return (
        asciiDowncase(attributes.get("name") ?? "") === rule.generatorName &&
        [attributes.get("content"), attributes.get("value")].some(
          (value) => value !== undefined && rule.generator.regexp.test(value),
        )
      );
    });
  const kept = reading("leading-nul-kept");
  return kept === reading("leading-nul-dropped") ? kept : "both-ways";
}

// `extract_html_meta`: `match.last` is the one group of the `<meta` scan.
function extractHtmlMeta(
  rule: HtmlRule,
  tag: string,
  strip: RubyStrip,
): Map<string, string> {
  const text = rubyStrip(tag.replace(rule.trailingSlash.regexp, ""), strip);
  const attributes = new Map<string, string>();
  for (const found of text.matchAll(rule.attribute.all))
    attributes.set(
      asciiDowncase(found[1]!),
      found[2]!.replace(rule.quotes.all, ""),
    );
  return attributes;
}
