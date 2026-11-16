// The few pieces of Ruby that Linguist's rules lean on, ported by behaviour, not by spelling.
//
// Two string models, because Linguist reads two kinds of string:
// - A path is a UTF-8 Ruby string. Its JavaScript counterpart is a well-formed string, and its
//   regular expressions are compiled with the `u` flag so that `.` and negated classes step over
//   one code point, as Ruby steps over one character.
// - A blob's data is, when Linguist reads a Git repository, the byte string Rugged returns
//   (ASCII-8BIT). Its counterpart is a "binary string": one JavaScript character per byte, values
//   0 to 255, and regular expressions compiled without `u`, so each step is one byte. In that model
//   `length` counts bytes, invalid UTF-8 cannot raise, and case rules touch ASCII letters only, as
//   they do for an ASCII-8BIT string in Ruby. Linguist's file reader reads the file with
//   `:encoding => "ASCII-8BIT"` (`file_blob.rb` at v9.7.0, read but not carried here). For the Git
//   reader it is what Rugged returns for a blob; Rugged itself was not read.

// Ruby's `\s`: space, tab, line feed, vertical tab, form feed, carriage return. JavaScript's `\s`
// also takes U+00A0, U+FEFF, U+2028 and the other Unicode spaces, so it is never carried as is.
const RUBY_SPACE_CLASS_BODY = String.raw`\t\n\v\f\r `;
export const RUBY_SPACE = `[${RUBY_SPACE_CLASS_BODY}]`;

// Ruby's `^` matches at the start of the string and after every line feed that is not the last
// character of the string (Onigmo's begin-line refuses the very end). JavaScript's `^` without the
// `m` flag matches only at the start, and with `m` it also matches after `\r`, U+2028 and U+2029.
export const RUBY_LINE_START = String.raw`(?:(?<![\s\S])|(?<=\n)(?=[\s\S]))`;
// Ruby's `$` matches at the end of the string and before every line feed.
export const RUBY_LINE_END = String.raw`(?![^\n])`;
// Ruby's `.` matches anything but a line feed; JavaScript's `.` also refuses `\r`, U+2028, U+2029.
const RUBY_DOT = String.raw`[^\n]`;
// `\A`, `\z` and `\Z`: start of string, end of string, end of string or before a final line feed.
const RUBY_STRING_START = String.raw`(?<![\s\S])`;
const RUBY_STRING_END = String.raw`(?![\s\S])`;
const RUBY_STRING_END_OR_FINAL_NEWLINE = String.raw`(?=\n?(?![\s\S]))`;

export type RubyRegexpMode = "text" | "binary";

export type RubyRegexpOptions = {
  readonly mode: RubyRegexpMode;
  readonly ignoreCase?: boolean;
  readonly extended?: boolean;
};

// Characters that keep their backslash in JavaScript, in or out of a class, with or without `u`.
const SYNTAX = new Set([..."^$\\.*+?()[]{}|/"]);
const isAlphanumeric = (c: string) => /^[A-Za-z0-9]$/.test(c);

// Translate the source of a Ruby (Onigmo) regular expression into a JavaScript source with the
// same matches, for the constructs Linguist's rules use. Anything else throws, naming the place:
// backreferences, named groups, inline flags, atomic groups, possessive quantifiers, `\h`, POSIX
// brackets, nested classes and class intersection, `{,n}`, and any escape not listed below. With
// `ignoreCase` on a text pattern it also refuses classes, `\w`, `\b` and letter pairs that Unicode
// folds from one character (Ruby folds `ß` to `ss`; JavaScript does not), because JavaScript's
// `iu` folding and Onigmo's differ there. Compile the result with `u` for text and without `u`
// for binary, plus `i` when the Ruby literal has `/i`.
export function translateRubyRegexp(
  source: string,
  options: RubyRegexpOptions,
): string {
  const { mode, ignoreCase = false, extended = false } = options;
  let i = 0;
  let out = "";
  let afterQuantifier: "none" | "simple" | "interval" | "lazy" = "none";
  const fail: (why: string) => never = (why) => {
    throw new Error(
      `cannot translate the Ruby regexp ${JSON.stringify(source)} at ${i}: ${why}`,
    );
  };
  if (ignoreCase && mode === "text") {
    const lower = source.toLowerCase();
    for (const pair of ["ss", "st", "ff", "fi", "fl"])
      if (lower.includes(pair))
        fail(`"${pair}" under /i folds from one character in Ruby only`);
  }
  while (i < source.length) {
    const c = source[i]!;
    if (c.charCodeAt(0) > 0x7f) fail("a non-ASCII character");
    if (extended && /[ \t\n\v\f\r]/.test(c)) {
      i++;
      continue;
    }
    if (extended && c === "#") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "*" || c === "+" || c === "?") {
      if (afterQuantifier === "none") {
        out += c;
        afterQuantifier = "simple";
      } else if (c === "?" && afterQuantifier !== "lazy") {
        out += c;
        afterQuantifier = "lazy";
      } else fail("a possessive or stacked quantifier");
      i++;
      continue;
    }
    if (c === "{") {
      const interval = /^\{(\d+)(,\d*)?\}/.exec(source.slice(i));
      if (interval) {
        if (afterQuantifier !== "none") fail("a stacked quantifier");
        out += interval[0];
        i += interval[0].length;
        afterQuantifier = "interval";
        continue;
      }
      if (/^\{,\d+\}/.test(source.slice(i))) fail("{,n}");
      out += "\\{";
      i++;
      afterQuantifier = "none";
      continue;
    }
    afterQuantifier = "none";
    if (c === "\\") {
      const n = source[i + 1];
      if (n === undefined) fail("a trailing backslash");
      i += 2;
      switch (n) {
        case "s":
          out += RUBY_SPACE;
          continue;
        case "S":
          out += `[^${RUBY_SPACE_CLASS_BODY}]`;
          continue;
        case "d":
        case "D":
          out += `\\${n}`;
          continue;
        case "w":
        case "W":
        case "b":
        case "B":
          if (ignoreCase && mode === "text")
            fail(`\\${n} under /i on text folds differently`);
          out += `\\${n}`;
          continue;
        case "A":
          out += RUBY_STRING_START;
          continue;
        case "z":
          out += RUBY_STRING_END;
          continue;
        case "Z":
          out += RUBY_STRING_END_OR_FINAL_NEWLINE;
          continue;
      }
      if (n.charCodeAt(0) > 0x7f || isAlphanumeric(n))
        fail(`the escape \\${n}`);
      out += SYNTAX.has(n) ? `\\${n}` : n;
      continue;
    }
    if (c === "[") {
      if (ignoreCase && mode === "text")
        fail("a class under /i on text folds differently");
      i++;
      out += "[";
      if (source[i] === "^") {
        out += "^";
        i++;
      }
      if (source[i] === "]") fail("a leading ] in a class");
      for (;;) {
        const k = source[i];
        if (k === undefined) fail("an unterminated class");
        if (k === "]") break;
        if (k.charCodeAt(0) > 0x7f) fail("a non-ASCII character");
        if (k === "[") fail("a nested class or POSIX bracket");
        if (k === "&" && source[i + 1] === "&") fail("class intersection");
        if (k === "\\") {
          const n = source[i + 1];
          if (n === undefined) fail("a trailing backslash");
          i += 2;
          if (n === "s") out += RUBY_SPACE_CLASS_BODY;
          else if (n === "d" || n === "D" || n === "w" || n === "W")
            out += `\\${n}`;
          else if (n === "-") out += "\\-";
          else if (n.charCodeAt(0) > 0x7f || isAlphanumeric(n))
            fail(`the class escape \\${n}`);
          else out += SYNTAX.has(n) ? `\\${n}` : n;
          continue;
        }
        out += k;
        i++;
      }
      out += "]";
      i++;
      continue;
    }
    if (c === "(") {
      if (source[i + 1] === "?") {
        const head = source.slice(i, i + 4);
        const group =
          ["(?<=", "(?<!"].find((g) => head.startsWith(g)) ??
          ["(?:", "(?=", "(?!"].find((g) => head.startsWith(g));
        if (!group) fail("a group kind JavaScript reads otherwise");
        out += group;
        i += group!.length;
        continue;
      }
      out += "(";
      i++;
      continue;
    }
    if (c === "^") out += RUBY_LINE_START;
    else if (c === "$") out += RUBY_LINE_END;
    else if (c === ".") out += RUBY_DOT;
    else if (c === "}") out += "\\}";
    else out += c;
    i++;
  }
  return out;
}

// Ruby's `File.extname`, as Ruby 2.7 and later run it on a non-Windows host. The basename is what
// follows the last run of slashes that is not at the end; its leading dots never start an
// extension; the extension runs from the last dot to the end of the basename (a trailing slash
// ends it); a basename ending in a dot gives "." (Ruby 2.6 gave ""; no Linguist rule compares
// against either). Ruby refuses a path holding a NUL byte, so this throws on one.
export function rubyExtname(path: string): string {
  if (path.includes("\0"))
    throw new Error("Ruby's File.extname refuses a path with a NUL byte");
  const end = path.length;
  let last = -1;
  for (let i = 0; i < end;) {
    if (path[i] === "/") {
      const at = i++;
      while (i < end && path[i] === "/") i++;
      if (i >= end) break;
      last = at;
    } else i++;
  }
  let p = 0;
  if (last !== -1) {
    p = last;
    do p++;
    while (path[p] === "/");
  }
  const name = p;
  while (p < end && path[p] === ".") p++;
  let dot = -1;
  while (p < end) {
    if (path[p] === ".") dot = p;
    else if (path[p] === "/") break;
    p++;
  }
  if (dot === -1 || dot === name) return "";
  if (dot + 1 === p) return ".";
  return path.slice(dot, p);
}

// The bytes as a binary string: one character per byte, never a text decoding (the WHATWG
// "latin1" decoder is windows-1252 and would move bytes 0x80 to 0x9F).
export function binaryString(bytes: Uint8Array): string {
  let out = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    out += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return out;
}

// `data.split("\n", -1)`: the limit -1 keeps trailing empty fields, which JavaScript's `split`
// also keeps; but Ruby splits the empty string into no fields at all, where JavaScript gives [""].
export function rubyLines(data: string): string[] {
  return data.length === 0 ? [] : data.split("\n");
}

// `downcase` on an ASCII-8BIT string folds A to Z only; `toLowerCase` would also fold the bytes
// 0xC0 to 0xDE.
export function asciiDowncase(text: string): string {
  return text.replace(/[A-Z]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) | 0x20),
  );
}

// `String#strip`. Both ends drop tab, line feed, vertical tab, form feed, carriage return and
// space, and the end also drops NUL. Whether the start drops NUL depends on the Ruby version
// Linguist runs on: Ruby 2.6 keeps a leading NUL (checked), later Rubies drop it (not checked
// here). The caller asks for both readings when it matters.
export type RubyStrip = "leading-nul-kept" | "leading-nul-dropped";
export function rubyStrip(text: string, variant: RubyStrip): string {
  const lead =
    variant === "leading-nul-kept" ? /^[\t\n\v\f\r ]+/ : /^[\0\t\n\v\f\r ]+/;
  return text.replace(lead, "").replace(/[\0\t\n\v\f\r ]+$/, "");
}
