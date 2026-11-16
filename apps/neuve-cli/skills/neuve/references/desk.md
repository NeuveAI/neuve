# Send a person to the review desk

People decide their units in the web app: the batch overview and the review desk, served on this machine. You tell them where to look. You don't drive the desk, and you never record a disposition there.

## Open it

`neuve review desk` serves the batch overview and review desk for the repository and prints its address, `Review desk: http://127.0.0.1:<port>/`. It listens on this machine only (port 4141 unless that is taken; `--port <n>` picks one, and `--repo <path>` another repository). It runs until Ctrl-C, and there is one desk per repository: running it again prints the live desk's address.

It runs in the foreground, so the person usually starts it in their own terminal. If they ask you to, start it in the background and give them the address. While a desk is live, `neuve review` prints the review cycle's link on it; otherwise it says to run `neuve review desk`.

## What the person sees

- **Batch overview**, one per batch: the batch digest, the lane bar (how many units are in each lane), the units that need their judgment, and verification. It starts review but records no disposition.
- **Review desk**, one unit at a time: the unit rail (the batch's units by lane, with a meter of those still needing a decision), the unit's digest, the diff of its owned ranges, the context margin beside it, and the decision dock at the foot. Units waiting on them say "Needs your decision".

## The decision dock, per lane

| Lane | What the person can record |
| --- | --- |
| Human-required | Approve, or request changes |
| Human-suggested | Request changes; and agree when the agent approved, or approve when the agent requested changes. A decision that differs from the agent's overrides it. Before the agent decides, only request changes is offered |
| Agentic review, static automation | Comment only |

Digests, context and marker pins on the desk are advisory. None of them is a disposition or approves anything.

## Worked example

The person asked you to review `main..HEAD` and fix what it found. The review left one human-required unit open. You tell the person:

> The review of `main..HEAD` is published. One unit needs your decision: "Charge the card once per order" (human-required). The other two units were decided by the agent: one approved, one with a request for changes, which I've fixed and committed as you asked. To decide yours, run `neuve review desk` in a terminal and open the address it prints; the unit is under "Needs your decision".

You don't open the desk's decision dock yourself, and you don't call the unit approved until the person has recorded a disposition.
