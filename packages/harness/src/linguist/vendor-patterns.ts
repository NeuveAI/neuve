// The patterns of Linguist's `lib/linguist/vendor.yml` (v9.7.0), carried beside it in this folder,
// in the file's order. `pattern` is the line exactly as Linguist wrote it; `line` is where it sits
// in `vendor.yml`.
//
// How Linguist uses them: `BlobHelper#vendored?` joins every pattern with `|` into one Ruby regexp
// and matches it against the blob's path (`path =~ VendoredRegexp`). No pattern has a
// backreference or an unbalanced group, so the join matches exactly when one of the patterns
// matches on its own; this port tries them one by one, in order, and reports the first. The
// regexp has no flags, so every pattern is case-sensitive.
//
// Where a pattern means the same in JavaScript (compiled with the `u` flag, so `.` and negated
// classes step over one code point as Ruby does over one UTF-8 character) it is carried unchanged
// and the row has no `js`. Where it does not, the row carries `js`, the JavaScript translation
// from `translateRubyRegexp` in `./ruby.ts`, and `why`, the constructs that differ:
// - `^`: Ruby matches at the start and after every line feed but the last character; JavaScript
//   only at the start. Translated to `(?:(?<![\s\S])|(?<=\n)(?=[\s\S]))`.
// - `$`: Ruby matches at the end and before every line feed; JavaScript only at the end.
//   Translated to `(?![^\n])`.
// - `.`: Ruby refuses only a line feed; JavaScript also refuses `\r`, U+2028 and U+2029.
//   Translated to `[^\n]`.
// - `\s`: Ruby's is the six ASCII spaces; JavaScript's adds U+00A0, U+FEFF and the Unicode spaces.
//   Translated to the six characters.
// - `\-` outside a class: Ruby reads a hyphen; JavaScript with `u` refuses the escape. Translated
//   to `-`.
// A path rarely holds a line feed, but Git allows one, so the anchors are translated rather than
// assumed. The translated rows are every row with `js` (165 of the 168); the three carried
// unchanged are lines 109, 262 and 263. No pattern uses `\A`, `\z`, `\Z`, `\h`, a possessive
// quantifier or an inline flag.

export type VendorPattern = {
  readonly line: number;
  readonly pattern: string;
  readonly js?: string;
  readonly why?: readonly ("^" | "$" | "." | "\\s" | "\\-")[];
};

export const VENDOR_PATTERNS: readonly VendorPattern[] = [
  {
    line: 13,
    pattern: String.raw`(^|/)cache/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)cache/`,
    why: ["^"],
  },
  {
    line: 16,
    pattern: String.raw`^[Dd]ependencies/`,
    js: String.raw`(?:(?<![\s\S])|(?<=\n)(?=[\s\S]))[Dd]ependencies/`,
    why: ["^"],
  },
  {
    line: 19,
    pattern: String.raw`(^|/)dist/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)dist/`,
    why: ["^"],
  },
  {
    line: 22,
    pattern: String.raw`^deps/`,
    js: String.raw`(?:(?<![\s\S])|(?<=\n)(?=[\s\S]))deps/`,
    why: ["^"],
  },
  {
    line: 23,
    pattern: String.raw`(^|/)configure$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)configure(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 24,
    pattern: String.raw`(^|/)config\.guess$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)config\.guess(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 25,
    pattern: String.raw`(^|/)config\.sub$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)config\.sub(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 28,
    pattern: String.raw`(^|/)aclocal\.m4`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)aclocal\.m4`,
    why: ["^"],
  },
  {
    line: 29,
    pattern: String.raw`(^|/)libtool\.m4`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)libtool\.m4`,
    why: ["^"],
  },
  {
    line: 30,
    pattern: String.raw`(^|/)ltoptions\.m4`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)ltoptions\.m4`,
    why: ["^"],
  },
  {
    line: 31,
    pattern: String.raw`(^|/)ltsugar\.m4`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)ltsugar\.m4`,
    why: ["^"],
  },
  {
    line: 32,
    pattern: String.raw`(^|/)ltversion\.m4`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)ltversion\.m4`,
    why: ["^"],
  },
  {
    line: 33,
    pattern: String.raw`(^|/)lt~obsolete\.m4`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)lt~obsolete\.m4`,
    why: ["^"],
  },
  {
    line: 36,
    pattern: String.raw`(^|/)dotnet-install\.(ps1|sh)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)dotnet-install\.(ps1|sh)(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 39,
    pattern: String.raw`(^|/)cpplint\.py`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)cpplint\.py`,
    why: ["^"],
  },
  {
    line: 42,
    pattern: String.raw`(^|/)node_modules/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)node_modules/`,
    why: ["^"],
  },
  {
    line: 45,
    pattern: String.raw`(^|/)\.yarn/releases/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.yarn/releases/`,
    why: ["^"],
  },
  {
    line: 46,
    pattern: String.raw`(^|/)\.yarn/plugins/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.yarn/plugins/`,
    why: ["^"],
  },
  {
    line: 47,
    pattern: String.raw`(^|/)\.yarn/sdks/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.yarn/sdks/`,
    why: ["^"],
  },
  {
    line: 48,
    pattern: String.raw`(^|/)\.yarn/versions/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.yarn/versions/`,
    why: ["^"],
  },
  {
    line: 49,
    pattern: String.raw`(^|/)\.yarn/unplugged/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.yarn/unplugged/`,
    why: ["^"],
  },
  {
    line: 52,
    pattern: String.raw`(^|/)_esy$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)_esy(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 55,
    pattern: String.raw`(^|/)bower_components/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)bower_components/`,
    why: ["^"],
  },
  {
    line: 58,
    pattern: String.raw`^rebar$`,
    js: String.raw`(?:(?<![\s\S])|(?<=\n)(?=[\s\S]))rebar(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 59,
    pattern: String.raw`(^|/)erlang\.mk`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)erlang\.mk`,
    why: ["^"],
  },
  {
    line: 62,
    pattern: String.raw`(^|/)Godeps/_workspace/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)Godeps/_workspace/`,
    why: ["^"],
  },
  {
    line: 65,
    pattern: String.raw`(^|/)testdata/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)testdata/`,
    why: ["^"],
  },
  {
    line: 68,
    pattern: String.raw`(^|/)\.indent\.pro`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.indent\.pro`,
    why: ["^"],
  },
  {
    line: 71,
    pattern: String.raw`(\.|-)min\.(js|css)$`,
    js: String.raw`(\.|-)min\.(js|css)(?![^\n])`,
    why: ["$"],
  },
  {
    line: 74,
    pattern: String.raw`([^\s]*)import\.(css|less|scss|styl)$`,
    js: String.raw`([^\t\n\v\f\r ]*)import\.(css|less|scss|styl)(?![^\n])`,
    why: ["\\s", "$"],
  },
  {
    line: 77,
    pattern: String.raw`(^|/)bootstrap([^/.]*)(\..*)?\.(js|css|less|scss|styl)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)bootstrap([^/.]*)(\.[^\n]*)?\.(js|css|less|scss|styl)(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 78,
    pattern: String.raw`(^|/)custom\.bootstrap([^\s]*)(js|css|less|scss|styl)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)custom\.bootstrap([^\t\n\v\f\r ]*)(js|css|less|scss|styl)(?![^\n])`,
    why: ["^", "\\s", "$"],
  },
  {
    line: 81,
    pattern: String.raw`(^|/)font-?awesome\.(css|less|scss|styl)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)font-?awesome\.(css|less|scss|styl)(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 82,
    pattern: String.raw`(^|/)font-?awesome/.*\.(css|less|scss|styl)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)font-?awesome/[^\n]*\.(css|less|scss|styl)(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 85,
    pattern: String.raw`(^|/)foundation\.(css|less|scss|styl)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)foundation\.(css|less|scss|styl)(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 88,
    pattern: String.raw`(^|/)normalize\.(css|less|scss|styl)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)normalize\.(css|less|scss|styl)(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 91,
    pattern: String.raw`(^|/)skeleton\.(css|less|scss|styl)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)skeleton\.(css|less|scss|styl)(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 94,
    pattern: String.raw`(^|/)[Bb]ourbon/.*\.(css|less|scss|styl)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)[Bb]ourbon/[^\n]*\.(css|less|scss|styl)(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 97,
    pattern: String.raw`(^|/)animate\.(css|less|scss|styl)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)animate\.(css|less|scss|styl)(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 100,
    pattern: String.raw`(^|/)materialize\.(css|less|scss|styl|js)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)materialize\.(css|less|scss|styl|js)(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 103,
    pattern: String.raw`(^|/)select2/.*\.(css|scss|js)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)select2/[^\n]*\.(css|scss|js)(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 106,
    pattern: String.raw`(^|/)bulma\.(css|sass|scss)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)bulma\.(css|sass|scss)(?![^\n])`,
    why: ["^", "$"],
  },
  { line: 109, pattern: String.raw`(3rd|[Tt]hird)[-_]?[Pp]arty/` },
  {
    line: 110,
    pattern: String.raw`(^|/)vendors?/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)vendors?/`,
    why: ["^"],
  },
  {
    line: 111,
    pattern: String.raw`(^|/)[Ee]xtern(als?)?/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)[Ee]xtern(als?)?/`,
    why: ["^"],
  },
  {
    line: 112,
    pattern: String.raw`(^|/)[Vv]+endor/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)[Vv]+endor/`,
    why: ["^"],
  },
  {
    line: 115,
    pattern: String.raw`^debian/`,
    js: String.raw`(?:(?<![\s\S])|(?<=\n)(?=[\s\S]))debian/`,
    why: ["^"],
  },
  {
    line: 118,
    pattern: String.raw`(^|/)run\.n$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)run\.n(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 121,
    pattern: String.raw`(^|/)bootstrap-datepicker/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)bootstrap-datepicker/`,
    why: ["^"],
  },
  {
    line: 126,
    pattern: String.raw`(^|/)jquery([^.]*)\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)jquery([^.]*)\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 127,
    pattern: String.raw`(^|/)jquery\-\d\.\d+(\.\d+)?\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)jquery-\d\.\d+(\.\d+)?\.js(?![^\n])`,
    why: ["^", "\\-", "$"],
  },
  {
    line: 130,
    pattern: String.raw`(^|/)jquery\-ui(\-\d\.\d+(\.\d+)?)?(\.\w+)?\.(js|css)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)jquery-ui(-\d\.\d+(\.\d+)?)?(\.\w+)?\.(js|css)(?![^\n])`,
    why: ["^", "\\-", "$"],
  },
  {
    line: 131,
    pattern: String.raw`(^|/)jquery\.(ui|effects)\.([^.]*)\.(js|css)$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)jquery\.(ui|effects)\.([^.]*)\.(js|css)(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 134,
    pattern: String.raw`(^|/)jquery\.fn\.gantt\.js`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)jquery\.fn\.gantt\.js`,
    why: ["^"],
  },
  {
    line: 137,
    pattern: String.raw`(^|/)jquery\.fancybox\.(js|css)`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)jquery\.fancybox\.(js|css)`,
    why: ["^"],
  },
  {
    line: 140,
    pattern: String.raw`(^|/)fuelux\.js`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)fuelux\.js`,
    why: ["^"],
  },
  {
    line: 143,
    pattern: String.raw`(^|/)jquery\.fileupload(-\w+)?\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)jquery\.fileupload(-\w+)?\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 146,
    pattern: String.raw`(^|/)jquery\.dataTables\.js`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)jquery\.dataTables\.js`,
    why: ["^"],
  },
  {
    line: 149,
    pattern: String.raw`(^|/)bootbox\.js`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)bootbox\.js`,
    why: ["^"],
  },
  {
    line: 152,
    pattern: String.raw`(^|/)pdf\.worker\.js`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)pdf\.worker\.js`,
    why: ["^"],
  },
  {
    line: 155,
    pattern: String.raw`(^|/)slick\.\w+.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)slick\.\w+[^\n]js(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 158,
    pattern: String.raw`(^|/)Leaflet\.Coordinates-\d+\.\d+\.\d+\.src\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)Leaflet\.Coordinates-\d+\.\d+\.\d+\.src\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 159,
    pattern: String.raw`(^|/)leaflet\.draw-src\.js`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)leaflet\.draw-src\.js`,
    why: ["^"],
  },
  {
    line: 160,
    pattern: String.raw`(^|/)leaflet\.draw\.css`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)leaflet\.draw\.css`,
    why: ["^"],
  },
  {
    line: 161,
    pattern: String.raw`(^|/)Control\.FullScreen\.css`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)Control\.FullScreen\.css`,
    why: ["^"],
  },
  {
    line: 162,
    pattern: String.raw`(^|/)Control\.FullScreen\.js`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)Control\.FullScreen\.js`,
    why: ["^"],
  },
  {
    line: 163,
    pattern: String.raw`(^|/)leaflet\.spin\.js`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)leaflet\.spin\.js`,
    why: ["^"],
  },
  {
    line: 164,
    pattern: String.raw`(^|/)wicket-leaflet\.js`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)wicket-leaflet\.js`,
    why: ["^"],
  },
  {
    line: 167,
    pattern: String.raw`(^|/)\.sublime-project`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.sublime-project`,
    why: ["^"],
  },
  {
    line: 168,
    pattern: String.raw`(^|/)\.sublime-workspace`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.sublime-workspace`,
    why: ["^"],
  },
  {
    line: 171,
    pattern: String.raw`(^|/)\.vscode/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.vscode/`,
    why: ["^"],
  },
  {
    line: 174,
    pattern: String.raw`(^|/)prototype(.*)\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)prototype([^\n]*)\.js(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 175,
    pattern: String.raw`(^|/)effects\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)effects\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 176,
    pattern: String.raw`(^|/)controls\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)controls\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 177,
    pattern: String.raw`(^|/)dragdrop\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)dragdrop\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 180,
    pattern: String.raw`(.*?)\.d\.ts$`,
    js: String.raw`([^\n]*?)\.d\.ts(?![^\n])`,
    why: [".", "$"],
  },
  {
    line: 183,
    pattern: String.raw`(^|/)mootools([^.]*)\d+\.\d+.\d+([^.]*)\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)mootools([^.]*)\d+\.\d+[^\n]\d+([^.]*)\.js(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 186,
    pattern: String.raw`(^|/)dojo\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)dojo\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 189,
    pattern: String.raw`(^|/)MochiKit\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)MochiKit\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 192,
    pattern: String.raw`(^|/)yahoo-([^.]*)\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)yahoo-([^.]*)\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 193,
    pattern: String.raw`(^|/)yui([^.]*)\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)yui([^.]*)\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 196,
    pattern: String.raw`(^|/)ckeditor\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)ckeditor\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 197,
    pattern: String.raw`(^|/)tiny_mce([^.]*)\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)tiny_mce([^.]*)\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 198,
    pattern: String.raw`(^|/)tiny_mce/(langs|plugins|themes|utils)`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)tiny_mce/(langs|plugins|themes|utils)`,
    why: ["^"],
  },
  {
    line: 201,
    pattern: String.raw`(^|/)ace-builds/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)ace-builds/`,
    why: ["^"],
  },
  {
    line: 204,
    pattern: String.raw`(^|/)fontello(.*?)\.css$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)fontello([^\n]*?)\.css(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 207,
    pattern: String.raw`(^|/)MathJax/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)MathJax/`,
    why: ["^"],
  },
  {
    line: 210,
    pattern: String.raw`(^|/)Chart\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)Chart\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 213,
    pattern: String.raw`(^|/)[Cc]ode[Mm]irror/(\d+\.\d+/)?(lib|mode|theme|addon|keymap|demo)`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)[Cc]ode[Mm]irror/(\d+\.\d+/)?(lib|mode|theme|addon|keymap|demo)`,
    why: ["^"],
  },
  {
    line: 216,
    pattern: String.raw`(^|/)shBrush([^.]*)\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)shBrush([^.]*)\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 217,
    pattern: String.raw`(^|/)shCore\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)shCore\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 218,
    pattern: String.raw`(^|/)shLegacy\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)shLegacy\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 221,
    pattern: String.raw`(^|/)angular([^.]*)\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)angular([^.]*)\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 224,
    pattern: String.raw`(^|\/)d3(\.v\d+)?([^.]*)\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|\/)d3(\.v\d+)?([^.]*)\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 227,
    pattern: String.raw`(^|/)react(-[^.]*)?\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)react(-[^.]*)?\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 230,
    pattern: String.raw`(^|/)flow-typed/.*\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)flow-typed/[^\n]*\.js(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 233,
    pattern: String.raw`(^|/)modernizr\-\d\.\d+(\.\d+)?\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)modernizr-\d\.\d+(\.\d+)?\.js(?![^\n])`,
    why: ["^", "\\-", "$"],
  },
  {
    line: 234,
    pattern: String.raw`(^|/)modernizr\.custom\.\d+\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)modernizr\.custom\.\d+\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 237,
    pattern: String.raw`(^|/)knockout-(\d+\.){3}(debug\.)?js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)knockout-(\d+\.){3}(debug\.)?js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 242,
    pattern: String.raw`(^|/)docs?/_?(build|themes?|templates?|static)/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)docs?/_?(build|themes?|templates?|static)/`,
    why: ["^"],
  },
  {
    line: 245,
    pattern: String.raw`(^|/)admin_media/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)admin_media/`,
    why: ["^"],
  },
  {
    line: 246,
    pattern: String.raw`(^|/)env/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)env/`,
    why: ["^"],
  },
  {
    line: 249,
    pattern: String.raw`(^|/)fabfile\.py$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)fabfile\.py(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 252,
    pattern: String.raw`(^|/)waf$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)waf(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 255,
    pattern: String.raw`(^|/)\.osx$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.osx(?![^\n])`,
    why: ["^", "$"],
  },
  { line: 262, pattern: String.raw`\.xctemplate/` },
  { line: 263, pattern: String.raw`\.imageset/` },
  {
    line: 266,
    pattern: String.raw`(^|/)Carthage/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)Carthage/`,
    why: ["^"],
  },
  {
    line: 269,
    pattern: String.raw`(^|/)Sparkle/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)Sparkle/`,
    why: ["^"],
  },
  {
    line: 272,
    pattern: String.raw`(^|/)Crashlytics\.framework/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)Crashlytics\.framework/`,
    why: ["^"],
  },
  {
    line: 275,
    pattern: String.raw`(^|/)Fabric\.framework/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)Fabric\.framework/`,
    why: ["^"],
  },
  {
    line: 278,
    pattern: String.raw`(^|/)BuddyBuildSDK\.framework/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)BuddyBuildSDK\.framework/`,
    why: ["^"],
  },
  {
    line: 281,
    pattern: String.raw`(^|/)Realm\.framework`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)Realm\.framework`,
    why: ["^"],
  },
  {
    line: 284,
    pattern: String.raw`(^|/)RealmSwift\.framework`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)RealmSwift\.framework`,
    why: ["^"],
  },
  {
    line: 287,
    pattern: String.raw`(^|/)\.gitattributes$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.gitattributes(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 288,
    pattern: String.raw`(^|/)\.gitignore$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.gitignore(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 289,
    pattern: String.raw`(^|/)\.gitmodules$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.gitmodules(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 294,
    pattern: String.raw`(^|/)gradlew$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)gradlew(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 295,
    pattern: String.raw`(^|/)gradlew\.bat$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)gradlew\.bat(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 296,
    pattern: String.raw`(^|/)gradle/wrapper/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)gradle/wrapper/`,
    why: ["^"],
  },
  {
    line: 301,
    pattern: String.raw`(^|/)mvnw$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)mvnw(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 302,
    pattern: String.raw`(^|/)mvnw\.cmd$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)mvnw\.cmd(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 303,
    pattern: String.raw`(^|/)\.mvn/wrapper/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.mvn/wrapper/`,
    why: ["^"],
  },
  {
    line: 308,
    pattern: String.raw`-vsdoc\.js$`,
    js: String.raw`-vsdoc\.js(?![^\n])`,
    why: ["$"],
  },
  {
    line: 309,
    pattern: String.raw`\.intellisense\.js$`,
    js: String.raw`\.intellisense\.js(?![^\n])`,
    why: ["$"],
  },
  {
    line: 312,
    pattern: String.raw`(^|/)jquery([^.]*)\.validate(\.unobtrusive)?\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)jquery([^.]*)\.validate(\.unobtrusive)?\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 313,
    pattern: String.raw`(^|/)jquery([^.]*)\.unobtrusive\-ajax\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)jquery([^.]*)\.unobtrusive-ajax\.js(?![^\n])`,
    why: ["^", "\\-", "$"],
  },
  {
    line: 316,
    pattern: String.raw`(^|/)[Mm]icrosoft([Mm]vc)?([Aa]jax|[Vv]alidation)(\.debug)?\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)[Mm]icrosoft([Mm]vc)?([Aa]jax|[Vv]alidation)(\.debug)?\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 319,
    pattern: String.raw`(^|/)[Pp]ackages\/.+\.\d+\/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)[Pp]ackages\/[^\n]+\.\d+\/`,
    why: ["^", "."],
  },
  {
    line: 322,
    pattern: String.raw`(^|/)extjs/.*?\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/[^\n]*?\.js(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 323,
    pattern: String.raw`(^|/)extjs/.*?\.xml$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/[^\n]*?\.xml(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 324,
    pattern: String.raw`(^|/)extjs/.*?\.txt$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/[^\n]*?\.txt(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 325,
    pattern: String.raw`(^|/)extjs/.*?\.html$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/[^\n]*?\.html(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 326,
    pattern: String.raw`(^|/)extjs/.*?\.properties$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/[^\n]*?\.properties(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 327,
    pattern: String.raw`(^|/)extjs/\.sencha/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/\.sencha/`,
    why: ["^"],
  },
  {
    line: 328,
    pattern: String.raw`(^|/)extjs/docs/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/docs/`,
    why: ["^"],
  },
  {
    line: 329,
    pattern: String.raw`(^|/)extjs/builds/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/builds/`,
    why: ["^"],
  },
  {
    line: 330,
    pattern: String.raw`(^|/)extjs/cmd/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/cmd/`,
    why: ["^"],
  },
  {
    line: 331,
    pattern: String.raw`(^|/)extjs/examples/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/examples/`,
    why: ["^"],
  },
  {
    line: 332,
    pattern: String.raw`(^|/)extjs/locale/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/locale/`,
    why: ["^"],
  },
  {
    line: 333,
    pattern: String.raw`(^|/)extjs/packages/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/packages/`,
    why: ["^"],
  },
  {
    line: 334,
    pattern: String.raw`(^|/)extjs/plugins/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/plugins/`,
    why: ["^"],
  },
  {
    line: 335,
    pattern: String.raw`(^|/)extjs/resources/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/resources/`,
    why: ["^"],
  },
  {
    line: 336,
    pattern: String.raw`(^|/)extjs/src/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/src/`,
    why: ["^"],
  },
  {
    line: 337,
    pattern: String.raw`(^|/)extjs/welcome/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)extjs/welcome/`,
    why: ["^"],
  },
  {
    line: 340,
    pattern: String.raw`(^|/)html5shiv\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)html5shiv\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 343,
    pattern: String.raw`(^|/)[Tt]ests?/fixtures/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)[Tt]ests?/fixtures/`,
    why: ["^"],
  },
  {
    line: 344,
    pattern: String.raw`(^|/)[Ss]pecs?/fixtures/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)[Ss]pecs?/fixtures/`,
    why: ["^"],
  },
  {
    line: 347,
    pattern: String.raw`(^|/)cordova([^.]*)\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)cordova([^.]*)\.js(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 348,
    pattern: String.raw`(^|/)cordova\-\d\.\d(\.\d)?\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)cordova-\d\.\d(\.\d)?\.js(?![^\n])`,
    why: ["^", "\\-", "$"],
  },
  {
    line: 351,
    pattern: String.raw`(^|/)foundation(\..*)?\.js$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)foundation(\.[^\n]*)?\.js(?![^\n])`,
    why: ["^", ".", "$"],
  },
  {
    line: 354,
    pattern: String.raw`(^|/)Vagrantfile$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)Vagrantfile(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 357,
    pattern: String.raw`(^|/)\.[Dd][Ss]_[Ss]tore$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.[Dd][Ss]_[Ss]tore(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 360,
    pattern: String.raw`(^|/)inst/extdata/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)inst/extdata/`,
    why: ["^"],
  },
  {
    line: 363,
    pattern: String.raw`(^|/)octicons\.css`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)octicons\.css`,
    why: ["^"],
  },
  {
    line: 364,
    pattern: String.raw`(^|/)sprockets-octicons\.scss`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)sprockets-octicons\.scss`,
    why: ["^"],
  },
  {
    line: 367,
    pattern: String.raw`(^|/)activator$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)activator(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 368,
    pattern: String.raw`(^|/)activator\.bat$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)activator\.bat(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 371,
    pattern: String.raw`(^|/)proguard\.pro$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)proguard\.pro(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 372,
    pattern: String.raw`(^|/)proguard-rules\.pro$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)proguard-rules\.pro(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 375,
    pattern: String.raw`(^|/)puphpet/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)puphpet/`,
    why: ["^"],
  },
  {
    line: 378,
    pattern: String.raw`(^|/)\.google_apis/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.google_apis/`,
    why: ["^"],
  },
  {
    line: 381,
    pattern: String.raw`(^|/)Jenkinsfile$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)Jenkinsfile(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 384,
    pattern: String.raw`(^|/)\.gitpod\.Dockerfile$`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.gitpod\.Dockerfile(?![^\n])`,
    why: ["^", "$"],
  },
  {
    line: 387,
    pattern: String.raw`(^|/)\.github/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.github/`,
    why: ["^"],
  },
  {
    line: 390,
    pattern: String.raw`(^|/)\.obsidian/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.obsidian/`,
    why: ["^"],
  },
  {
    line: 393,
    pattern: String.raw`(^|/)\.teamcity/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)\.teamcity/`,
    why: ["^"],
  },
  {
    line: 396,
    pattern: String.raw`(^|/)xvba_modules/`,
    js: String.raw`((?:(?<![\s\S])|(?<=\n)(?=[\s\S]))|/)xvba_modules/`,
    why: ["^"],
  },
];

export const VENDOR_REGEXPS: readonly {
  readonly pattern: string;
  readonly regexp: RegExp;
}[] = VENDOR_PATTERNS.map((row) => ({
  pattern: row.pattern,
  regexp: new RegExp(row.js ?? row.pattern, "u"),
}));
