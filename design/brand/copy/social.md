# Launch posts and image text

Status: round 6, in the owner's voice, on the owner's rejection of round 5. The posts and images use the owner's own pair, word for word: "Large code changes never felt so small" and "Focus only on parts that require human attention or approval, with the certainty your codebase deserves." The posts add only plain facts about what Neuve does, each true of `main`. They don't say "agents never approve", because agents and people review together, and they don't say "review units", a term readers don't know. They take no lines from the owner's article, present Neuve's review only (decision 13.9) and quote no internal numbers (13.12, 13.24). Nothing gets posted without the owner's explicit yes. Links point at https://neuve.ai. **Open:** the launch post's own URL, the public repository URL and the handles. The MIT strings wait on the `LICENSE` file landing on `main`, and the platform line waits on `oss-dist`'s release builds (13.13).

## X

The launch post, attached to the hero image. It's 233 characters, counting the link as 23.

> I've been building Neuve for almost a year. Large code changes never felt so small. Focus only on parts that require human attention or approval, with the certainty your codebase deserves. MIT-licensed, early. https://neuve.ai

**Follow-up reply (262 characters):** How a review runs: give it a commit range. It states the goal and splits the change into batches and smaller parts. Four agents look at scope fit, correctness, risky edges and tests. Each finding is checked again before you see it. You review in the review desk.

## Bluesky

Under 300 characters (262).

> I've spent almost a year building Neuve, open-source code review for agent-written code. Large code changes never felt so small. Focus only on parts that require human attention or approval, with the certainty your codebase deserves. MIT, early. https://neuve.ai

## LinkedIn

About 210 words.

> Large code changes never felt so small. That's what I want from code review now that agents write so much of our code: not to be overwhelmed by a large change, or afraid of it.
>
> Today I'm open-sourcing Neuve, which I've been building for almost a year. Set it up in a repository, then give it a commit range. It states the change's goal and what done means, then splits the change into batches and smaller parts. Four agents look for problems: scope fit, correctness, risky edges and tests. Each finding is checked again in a fresh context before you see it, and each one you see cites the code it rests on. Each batch's summary links findings to the parts that hold them. You record your review in the review desk, with the code there whenever you want to read it.
>
> The point is agents and people working together, with people focusing only on the important parts. Agents decide the parts that don't need a person, and the parts that do come to one, with the agents' verified findings attached.
>
> It's early and MIT-licensed. It runs on macOS and Linux, and on Windows through WSL. Today, reviews run on your machine, with your own Anthropic or ChatGPT account. I'm curious to hear where code review hurts for you.
>
> https://neuve.ai

## Show HN

- **Title (55 characters):** Show HN: Neuve – Large code changes never felt so small
- **Alternative (63 characters):** Show HN: Neuve – open-source code review for agent-written code

**Text:**

> I've been building Neuve for almost a year. I started out building agents for QA, and found that code review, not QA, was where teams were stuck. What I want is for large code changes to feel small: to focus only on the parts that need a person's attention or approval, with the right information attached where it's relevant.
>
> You run `neuve setup` in a repository, then give `neuve review` a commit range. One step states the change's goal and what done means, from the ticket or plan if it can fetch one, and says so when it can't. The change is split into batches and smaller parts, and no changed line is left out. Four independent agents look for problems (scope fit, correctness, risky edges, tests). Each finding is re-checked in a fresh context, against evidence Neuve gathers up front, with no lookup tools. Findings that couldn't be checked are counted, not shown. Each batch's summary says why the batch exists and links verified findings to the parts that hold them. Verified defects become requests for changes pinned to their lines. You record your review in a local web review desk, with each part's diff beside its findings, and agents read the same review through a CLI.
>
> Records are an append-only SQLite log in the repo's shared Git directory. Model calls go to your Anthropic API key or ChatGPT subscription. Neuve is MIT-licensed. Its host and channel packages are adapted from GitHub Next's Ace, and its graph engine is a fork of Entire Graph, both MIT-licensed too.
>
> How the work is shared: each part goes to one of four review lanes, set by its complexity and how easy it is to validate. Agents decide agentic work. On human-suggested work, a decision the agents have made stands unless a person steps in, and human-required work waits for a person. Anything no agent could judge goes to a person, with a note saying so.
>
> It's early. It runs on macOS and Linux, and on Windows through WSL, and review quality is still being tuned. We use Neuve to review Neuve. I'd most like to hear where it missed something you'd have caught, or flagged something that didn't matter.

## Banner and OG image text

For `oss-brand`'s `Launch / Title` component. Character counts include spaces and punctuation.

| Use | String | Characters |
| --- | --- | --- |
| OG image and article hero, headline | Large code changes never felt so small | 38 |
| OG image and article hero, lead | Focus only on parts that require human attention or approval, with the certainty your codebase deserves. | 104 |
| OG image, small line | Open source · MIT · Early | 25 |
| X and LinkedIn banner, headline and lead | The same headline and lead | — |
| X header, lead (short form) | Focus only on parts that require human attention or approval. | 61 |
| GitHub social preview | The image layout: the Neuve logo, the headline and the lead | — |
| Repository description (for `oss-frontdoor`) | Large code changes never felt so small. Focus only on parts that require human attention or approval, with the certainty your codebase deserves. | 144 |

The lead is longer than round 5's (74 characters), so `oss-brand` has to recheck the line breaks in every image. The X header used a short lead in round 5 because the profile picture covers the corner where the full lead ends (`oss-brand`, 11 November). The short form here is the owner's lead cut at its first clause, not a new line. `oss-brand` found the full lead runs into that corner, which needs about 60 characters or fewer (11 November). Use the short form if it fits, and the owner sees it before it ships. If it doesn't fit, the X header carries the headline only: a shorter cut would drop "or approval" and change the owner's line. The small line waits on the `LICENSE` file landing on `main`.
