# Record proof, and say what is hard

## What proof is

Proof is what you observed confirming that a unit's changed behaviour is correct: a test run, a type checker's or another declared analyser's output, logs, telemetry, a screenshot, a video. Each record answers one validation requirement, a statement of what must be observed, from the ticket or plan or implied by the change.

- **Kinds must agree.** For browser-facing work, logs, screenshots and video; for server-facing work, telemetry and logs. One kind alone is not enough, and every applicable kind must point to the same result.
- **A test run is one kind of proof, and a test is not proof by existing.** Record the run you observed, with its output.
- **A script written to check the change is not proof.** Record the real behaviour it would stand in for.
- **Never record more than you saw.** The claim says what the artefact shows, nothing more. Bogus or forged proof is a defect, and reviews look for it.

On the review, each requirement shows as a checkpoint with a proof state: Missing (no record serves it), Out of date (the code or source changed after the record), Conflicting (records disagree), Thin, or Proven (two or more kinds, every applicable kind, a current test run among them where the behaviour can be tested, all current and in agreement). Every run checks again whether its proof is still current.

## Record it

```sh
neuve proof record <base>..<head> --kind test-run --claim "<what the output shows>" --requirement "<what must be observed>" --file <path>
```

- For `neuve proof record`, `--kind` is one of `test-run`, `static-analysis`, `log`, `telemetry`, `screenshot`, `video`.
- The artefact of `neuve proof record` is `--file <path>` (inside the working tree, not ignored by Git, not under `.git` and not a `.env` file; or in a temporary folder), `--text <text>`, or `--stdin`.
- For `neuve proof record`, `--revision <commit>` names the commit the artefact observed (the range's head by default; it must be in the head's history), and `--path <owned path>`, repeated, names the files it covers.
- Credential shapes and email addresses in the text, claim and requirement are masked. The artefact is kept 30 days unless a published review cites it.
- The record is tied to your agent session, which Neuve learns from the agent hooks ([setup.md](setup.md)). Without them it exits 1 and records nothing. Say so to the person rather than working around it: don't pass `--session` to `neuve proof record` or set `NEUVE_SESSION` to name a session yourself.

`neuve proof list <base>..<head>` lists the range's records with kind, revision, recorder, requirement and claim; with `--path <owned path>` it says whether each is still current for a unit owning those files.

## The MCP tools

`neuve mcp` serves two tools over stdio, `record_proof` and `vent`, for the agent session that starts it. The person adds it to their agent as a stdio MCP server whose command is `neuve mcp`. Don't change their agent settings yourself unless they ask.

## Say what is hard

`neuve vent <text>` records, in your own words, what is making this session difficult: unclear scope, a flaky tool, missing access. It is optional, up to 2,000 characters, one per session (a second is answered and the first kept), and kept 30 days. `neuve vents` lists them for the person.

## Worked example

You fixed the cart total and ran its tests in the repository.

```sh
bun test cart.test.ts > /tmp/cart-test.txt 2>&1
neuve proof record main..HEAD --kind test-run --claim "cart.test.ts: 6 pass, 0 fail, including a negative quantity clamped to 0" --requirement "A negative quantity never lowers the order total" --file /tmp/cart-test.txt --path cart.ts
neuve proof list main..HEAD --path cart.ts
```

Then you tell the person that this is one kind of proof: the requirement is Thin until another kind agrees, such as a log or telemetry from the running checkout showing the same result.
