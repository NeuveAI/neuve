/**
 * A stand-in for the app server, for the process service's test; it is never Codex. It speaks the
 * line protocol on standard input and output: it answers `initialize`, and `model/list` with the
 * methods it has read and its process id. `STUB_MODE` picks how it ends: `plain` exits when its
 * input ends, `linger` ignores that and the termination signal so only a kill ends it, and `die`
 * exits with code 3 on `model/list` after a line on standard error.
 */
const mode = process.env.STUB_MODE ?? "plain";
if (process.argv[2] !== "app-server") process.exit(64);
if (mode === "linger") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
const seen: Array<string> = [];
const reply = (id: unknown, result: unknown) =>
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
const handle = (message: { id?: unknown; method?: string }) => {
  seen.push(message.method ?? `answer:${String(message.id)}`);
  if (message.method === "initialize")
    reply(message.id, {
      userAgent: "stub/0.0.0 (test) stub",
      codexHome: "/stub-home",
      platformFamily: "unix",
      platformOs: "macos",
    });
  else if (message.method === "model/list") {
    if (mode === "die") {
      process.stderr.write("stub panicked\n");
      process.exit(3);
    }
    reply(message.id, { data: [], nextCursor: null, seen, pid: process.pid });
  }
};
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffered += chunk;
  for (
    let at = buffered.indexOf("\n");
    at !== -1;
    at = buffered.indexOf("\n")
  ) {
    handle(JSON.parse(buffered.slice(0, at)));
    buffered = buffered.slice(at + 1);
  }
});
process.stdin.on("end", () => {
  if (mode !== "linger") process.exit(0);
});
