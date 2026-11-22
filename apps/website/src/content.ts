/**
 * Every string on the landing page, in one place, so a copy round changes
 * one file. The wording follows oss-copy's round-6 launch copy
 * (handoffs/oss-copy-6.md, over rounds 4 and 5 and decisions 13.9 to 13.13):
 * the hero and the closing lines are the owner's own, word for word; there
 * is no "agents never approve"; "review units" stays off the page, where
 * the owner's word is "parts"; body claims stay true of main, describe
 * today's runs, and show the review lanes only under "Where it's heading";
 * no lines from the owner's article and no benchmark numbers.
 */

/** The site's address. It is used for the canonical link, social cards and
 * the install command. This is the only place that spells the domain
 * (neuve.ai, decided in 13.6). */
export const SITE_URL = "https://neuve.ai";
export const REPO_URL = "https://github.com/NeuveAI/neuve";

/** The owner's lines (round 6). */
const HEADLINE = "Understand and validate change with a clear mind";
const SUBLINE =
  "Validate changes without breaking your flow or overwhelming humans with context they don't need to see.";

export const META = {
  title: `Neuve: ${HEADLINE.toLowerCase()}`,
  description: `Open-source code review for agent-written code. ${SUBLINE}`,
  ogImage: `${SITE_URL}/og-image.png`,
  // The launch image's own lines (round 6): headline, lead, small line.
  ogImageAlt:
    "Large code changes never felt so small. Focus only on parts that require human attention or approval, with the certainty your codebase deserves. Neuve: open source, MIT, early.",
};

const INSTALL_SH = `curl -fsSL ${SITE_URL}/install.sh | sh`;

export const INSTALL = {
  // Not true today: the installer ships with the first release (oss-frontdoor, decision 13.5).
  label: "Coming with the first release",
  lines: [INSTALL_SH, "neuve setup"],
  // What a person hands their coding agent (the owner, NEU-457). Without a terminal,
  // `neuve setup` prints plain lines and names anything left as an exact command.
  prompt: `Install Neuve with \`${INSTALL_SH}\`, then run \`neuve setup\` in this repository and tell me the commands it leaves for me.`,
  versions: { label: "Install for", human: "Human", agent: "Agent" },
  // No "Build from source" link: the owner removed it (11 November).
};

export const NAV = [
  { label: "How it works", href: "#how" },
  { label: "Review desk", href: "#desk" },
  { label: "Agents and the CLI", href: "#agents" },
  { label: "Where it's heading", href: "#heading" },
];

export const HERO = {
  // No eyebrow: the owner removed it (11 November).
  // The owner: only "clear mind" is highlighted (11 November).
  headlineLead: "Understand and validate change with a ",
  headlineMark: "clear mind",
  subline: SUBLINE,
  primary: { label: "View on GitHub", href: REPO_URL },
  // No line under the buttons: the owner removed "Early. MIT-licensed. Runs on…".
};

/** The sample batch the hero runs. Its numbers are a sample, labelled as such. */
export const BATCH = {
  title: "Revoked share links stop working",
  meta: "shr-212-revoke-links · 37 commits · sample batch",
  commits: 37,
  units: 26,
  lines: 248,
  summary:
    "A sample review of 37 commits: 248 changed lines split into 26 parts, with none left out. Nine findings were verified in a fresh context and reach you.",
};

export type FinderKey = "scope" | "corr" | "risk" | "tests";

/** Each agent keeps at most five findings; `kept` marks which were verified. */
export const FINDERS: ReadonlyArray<{
  key: FinderKey;
  name: string;
  kept: ReadonlyArray<boolean>;
}> = [
  { key: "scope", name: "Scope fit", kept: [true, false, false] },
  { key: "corr", name: "Correctness", kept: [true, true, true, false, false] },
  { key: "risk", name: "Risky edges", kept: [true, true, false, false] },
  { key: "tests", name: "Tests", kept: [true, true, true, false] },
];

export type FindingKind = "defect" | "question";

export const FINDINGS: ReadonlyArray<{
  finder: FinderKey;
  kind: FindingKind;
  title: string;
  unit: string;
  why: string;
  cite: string;
}> = [
  {
    finder: "corr",
    kind: "defect",
    title: "The wait ignores cancellation",
    unit: "Index writes retry when the database is busy",
    why: "Correctness · request for changes",
    cite: "internal/index/writer.go:29-37",
  },
  {
    finder: "risk",
    kind: "defect",
    title: "A session opened before revoke keeps reading",
    unit: "Revoke cuts off open sessions",
    why: "Risky edges · request for changes",
    cite: "internal/share/session.go:118",
  },
  {
    finder: "tests",
    kind: "defect",
    title: "No test forces the busy path",
    unit: "Index writes retry when the database is busy",
    why: "Tests · request for changes",
    cite: "internal/index/writer_test.go",
  },
  {
    finder: "scope",
    kind: "question",
    title: "Admins can revoke links outside their workspace",
    unit: "Workspace admins may revoke any link",
    why: "Scope fit · question",
    cite: "internal/share/admin.go:41 · SHR-212",
  },
];

/** The stage's own words. The owner (11 November): its counters and
 * footnotes go, and each column is named by its step, so some things stay
 * implicit. */
export const STAGE = {
  findings: "verified findings",
  checkedAgain: "Checked again in a fresh context",
  cites: "Cites",
  replay: "Replay",
};

/** "How it works" in three steps, one under each column of the stage: the
 * owner asked to consolidate the five round-6 steps, merging their text
 * without adding any. */
export const STEPS = [
  {
    title: "Frame and split",
    body: "Run neuve setup in your repository first. Then run neuve review there with a commit range. Neuve states the change's goal and what done means, from the ticket or plan it can fetch, and says when there isn't one. Then it splits the change into batches, and each batch into smaller parts. No changed line is left out.",
  },
  {
    title: "Find and check",
    body: "Four agents look at scope fit, correctness, risky edges and tests. Each finding is checked again in a fresh context, and one that can't be checked never becomes a comment.",
  },
  {
    title: "Validate and decide",
    body: "Each batch's summary says why the batch exists and links findings to the parts that hold them. Verified defects arrive as requests for changes, pinned to their lines. Risks and questions arrive as comments. Read as much of the code as you want, then record your review in the review desk.",
  },
];
// No fine print: the owner removed the pipeline limits (no internal numbers, 13.12).

export const DESK = {
  title: "From the overview to the line",
  /** Round 6.1, in common terms. Each callout's name is a link to its
   * number on the capture, the way briefings cite code (the owner, 11 November). */
  body: [
    {
      text: "From the overview of a batch, open one of its parts to review it. ",
    },
    { text: "The facts", n: 1 },
    { text: " say what changed. " },
    { text: "The diff", n: 2 },
    { text: " shows the code, as much of it as you want to read. " },
    { text: "Findings sit beside the lines", n: 3 },
    {
      text: " they're about, each citing the code it rests on. Then record your review in ",
    },
    { text: "the decision dock", n: 4 },
    { text: "." },
  ] as ReadonlyArray<{ text: string; n?: number }>,
  alt: "A sample capture of the review desk on the part “Index writes retry when the database is busy”: its facts written as four claims, the diff of internal/index/writer.go, and pins in the margin",
  // The capture is a design sample (the owner's, from the article); today a part's facts are a line count per file.
  caption:
    "Sample capture. Today a part's facts are a line count for each file. The linked claims, the review lane labels and groups, and the part names shown here are where the desk is heading.",
  altDark: "The review desk in the dark theme, on the same part",
  dock: {
    covers: "Covers 1 hunk",
    request: "Request changes",
    approve: "Approve",
  },
  close: "Close",
  callouts: [
    {
      n: 1,
      title: "The facts",
      short: "What changed, citing its hunks.",
      text: "What changed, citing its hunks. Today that's a line count for each file. In this sample it's written as claims linked to their lines: “retries up to three times” lands on lines 29 to 37.",
      land: true,
    },
    {
      n: 2,
      title: "The diff",
      short: "The code, whenever you want it.",
      text: "The lines this part holds. No changed line is left out of a part.",
      land: false,
    },
    {
      n: 3,
      title: "Findings beside their lines",
      short: "Each one cites its source.",
      text: "Verified findings arrive pinned to the lines they're about, each citing its source. The Gap, Doc and Graph pins in this sample are context Neuve is designed to add.",
      land: false,
    },
    {
      n: 4,
      title: "The decision dock",
      short: "Your call, recorded.",
      text: "Record your review. Today that's requesting changes, or approving to overrule an agent's request.",
      land: false,
    },
  ],
  mini: {
    label: "Sample part",
    title: "Index writes retry when the database is busy",
    claims: [
      { text: "Commit used to fail on the first lock clash.", linked: "" },
      {
        text: "It now ",
        linked: "retries up to three times with growing waits",
        after: ", then returns ErrIndexBusy.",
      },
      {
        text: "",
        linked: "The wait ignores cancellation",
        after: ", so a cancelled request still sleeps.",
      },
      { text: "", linked: "No test forces the busy path.", after: "" },
    ],
    finding: "Correctness: the wait ignores cancellation",
    cite: "writer.go:29-37",
  },
};

export const AGENTS = {
  title: "Built for two readers",
  body: "People review in the desk. Agents read the same review through the neuve CLI, from the same record you decided on.",
  readers: [
    {
      who: "You, in the review desk",
      what: "Request changes on writer.go, pinned to lines 29 to 37.",
    },
    {
      who: "Your coding agent, in the CLI",
      what: "Reads that request from the same record you decided on.",
    },
    {
      who: "Hooks, as you work",
      what: "Record your Claude Code and Codex sessions, link commits to the agent session that made them where it can be identified, and count each turn's tokens. They never reject a prompt or a commit.",
    },
  ],
  terminalLabel: "Terminal: neuve review commands",
  terminalSummary:
    "Three commands. neuve setup runs first, in your repository. neuve review main..shr-212-revoke-links reviews a commit range in this repository. neuve review show with a run id and --json reads a finished review: what your agent gets.",
  path: "~/acme/docs-app",
  shell: "zsh",
  commands: [
    { cmd: "neuve setup", note: "# first, in your repository" },
    {
      cmd: "neuve review main..shr-212-revoke-links",
      note: "# review a commit range in this repository",
    },
    {
      cmd: "neuve review show --run r_7f3a --json",
      pipe: "| your-agent",
      note: "# read a finished review: what your agent gets",
    },
  ],
  json: [
    ["unit", "Index writes retry when the database is busy"],
    ["review", "request changes"],
    ["finding", "The wait ignores cancellation"],
    ["checked", "fresh context"],
    ["cites", "internal/index/writer.go:29-37"],
  ] as ReadonlyArray<readonly [string, string]>,
  illustrative: "Output shape illustrative",
};

export type LaneKey =
  "human-required" | "human-suggested" | "agentic-review" | "static-automation";
export type QuadKey = "le" | "lh" | "he" | "hh";

export const HEADING = {
  eyebrow: "Where it's heading",
  title: "The right reviewer for each part of a change",
  body: "Some parts of a change matter more than others. Neuve puts each part in one of four review lanes: static automation, agentic review, human-suggested review and human-required review. Its complexity and how easy it is to validate set the lane. Agents decide agentic work. On human-suggested work, a decision the agents have made stands unless a person steps in. Human-required work waits for a person.",
  axes: {
    easy: "Easy to validate",
    hard: "Hard to validate",
    low: "Low complexity",
    high: "High complexity",
  },
  quads: [
    {
      key: "le",
      lane: "static-automation",
      label: "Static automation or agentic review",
      axes: "Low complexity · easy to validate",
    },
    {
      key: "lh",
      lane: "human-suggested",
      label: "Human-suggested review",
      axes: "Low complexity · hard to validate",
    },
    {
      key: "he",
      lane: "agentic-review",
      label: "Agentic or human-suggested review",
      axes: "High complexity · easy to validate",
    },
    {
      key: "hh",
      lane: "human-required",
      label: "Human-required review",
      axes: "High complexity · hard to validate",
    },
  ] as ReadonlyArray<{
    key: QuadKey;
    lane: LaneKey;
    label: string;
    axes: string;
  }>,
  today: "Today",
  todayText:
    "Agents approve agentic parts or request changes on them. A part no agent could judge comes to you, with a note saying so.",
  ledgerLabel: "Why this review lane",
  rows: {
    cx: "Complexity",
    v: "Validation",
    h: "History",
    br: "Blast radius",
    lane: "Review lane",
  },
  replay: "Replay",
};

export type MatrixUnit = {
  id: string;
  q: QuadKey;
  lane: LaneKey;
  title: string;
  cx: string;
  v: string;
  h: string;
  br: string;
  laneName: string;
  tag?: string;
  after?: { q: QuadKey; lane: LaneKey; v: string; h: string; laneName: string };
};

export const MATRIX_UNITS: ReadonlyArray<MatrixUnit> = [
  {
    id: "rename",
    q: "le",
    // Agentic review, not static automation: the checks-only lane may be
    // empty at launch, so no sample shows it working (oss-copy, NEU-148).
    lane: "agentic-review",
    title: "Rename ShareLink to SharedLink",
    cx: "Low",
    v: "Easy: types and tests pass",
    h: "None",
    br: "14 call sites, all checked by the compiler",
    laneName: "Agentic review",
  },
  {
    id: "copy",
    q: "lh",
    lane: "human-suggested",
    title: "Copy for the expired-link page",
    cx: "Low",
    v: "Hard: no check can judge wording",
    h: "None",
    br: "One page",
    laneName: "Human-suggested review",
  },
  {
    id: "flush",
    q: "he",
    lane: "agentic-review",
    title: "Batch writer flushes on shutdown",
    cx: "High",
    v: "Easy: a test covers every exit path",
    h: "None",
    br: "2 callers",
    laneName: "Agentic review",
  },
  {
    id: "retry",
    q: "he",
    lane: "agentic-review",
    title: "Index writes retry when the database is busy",
    cx: "High",
    v: "Easy in principle: a test could force the busy path",
    h: "None",
    br: "3 callers in the graph",
    laneName: "Agentic review",
    tag: "past outage",
    after: {
      q: "hh",
      lane: "human-required",
      v: "Hard: no test forces the busy path",
      h: "A past outage in writer.go",
      laneName: "Human-required review",
    },
  },
  {
    id: "revoke",
    q: "hh",
    lane: "human-required",
    title: "Revoke cuts off open sessions",
    cx: "High",
    v: "Hard: needs a session that was already open",
    h: "Reverses an earlier decision",
    br: "Every open share link",
    laneName: "Human-required review",
  },
];

export const OPEN = {
  // No eyebrow: it would repeat the title.
  title: "Open source",
  // Round 6.1: no claim about a hosted service or an account (the owner, 11 November).
  body: "Neuve is MIT-licensed, and we use Neuve to review Neuve. Today, reviews run on your machine, with the model provider you set up.",
  credits: [
    {
      text: "Neuve's host and channel packages are adapted from GitHub Next's ",
    },
    { text: "Ace", href: "https://github.com/githubnext/ace" },
    { text: ", and its graph engine is a fork of " },
    { text: "Entire Graph", href: "https://github.com/entireio/entire-graph" },
    {
      text: ", both MIT-licensed. Diffs render with a modified copy of Pierre's ",
    },
    {
      text: "@pierre/diffs",
      href: "https://github.com/pierrecomputer/pierre",
      mono: true,
    },
    { text: " (Apache-2.0)." },
  ] as ReadonlyArray<{ text: string; href?: string; mono?: boolean }>,
};

export const CLOSE = {
  // The owner's one-liner (round 6).
  title: "Large code changes never felt so small",
  source: { label: "Read the source", href: REPO_URL },
};

export const FOOTER = {
  tagline: `${HEADLINE}.`,
  line: "Copyright (c) 2026 Neuve AI · MIT License",
  markLabel: "The Neuve mark, drawn in diff glyphs",
  links: [
    { label: "GitHub", href: REPO_URL },
    { label: "Docs", href: `${REPO_URL}#readme` },
    { label: "Security", href: `${REPO_URL}/blob/main/SECURITY.md` },
    { label: "Licence", href: `${REPO_URL}/blob/main/LICENSE` },
  ],
};

export const UI = {
  skip: "Skip to content",
  home: "Neuve home",
  github: "GitHub",
  githubLabel: "Neuve on GitHub",
  docs: "Docs",
  sections: "Sections",
  footer: "Footer",
  themeToDark: "Switch to dark theme",
  themeToLight: "Switch to light theme",
  copy: "Copy",
  copied: "Copied",
  selected: "Selected",
  copyLabel: "Copy the selected install",
  copiedLive: "Copied",
  selectedLive: "Selected. Press Command-C or Control-C to copy.",
};
