# Set Neuve up in a repository

Neuve works one Git repository at a time. Setup runs once in each, by the person or by you when they ask.

## Check what is missing

`neuve doctor` reports, each with its fix: whether setup ran in this repository, the model sign-in, the background worker, Git and the Xcode command-line tools, the Graph engine and desk beside the CLI, which `neuve` is first on PATH, the agent programs Claude Code and Codex, and whether the installed Neuve skill is older than this neuve. It changes nothing; to report the agent programs it asks the `claude` on PATH and the Codex the `codex` account runs for their versions. Run it first, and again when something doesn't work.

## Set up

1. `neuve setup` in the repository (or `neuve setup --repo <path>`). It records this neuve and its Graph engine and checks that the engine can work on the repository. It keeps its state with the repository's Records, in `<git common directory>/neuve/setup/`, and writes nothing in the working tree. It prints a JSON record of what it did. A review refuses to start in a repository where setup hasn't run. `neuve setup --route` chooses the sign-in (below); without it, setup asks at a terminal when no route is set yet. It then looks for the agent programs on this machine, Claude Code and Codex, says what it found and how, and keeps the Codex it finds as the `codex` account's program. For one it doesn't find, it offers the npm package at a terminal (default no), once per machine (`neuve setup --ask-install-again` asks again), and otherwise only prints the command; never answer that offer for the person. At a terminal it then offers the Neuve skill once per repository, for the programs it found. When you run setup for the person, ask which sign-in they want and pass it with `--route`, and pass `--no-skills`. Run it without a terminal, as an agent's commands usually are: there setup asks nothing and prints the install command instead of the install question.
2. Optional, and only with the person's yes: `neuve setup hooks --dry-run` lists the files it would change, for the agent programs it finds (`--agents claude-code,codex` names them instead), the Git hooks of this repository and the person's own agent configuration (`~/.claude/settings.json`, `~/.codex/hooks.json`). Show them the list. If they agree, run it again without `--dry-run`; every file it changes is backed up first. The hooks let Neuve tie commits, proof and vents to agent sessions, so `neuve proof record` and `neuve vent` need them.
3. Unless given `--no-stack`, `neuve setup hooks` also runs `neuve setup stack`: a read-only copy of the dependency sources the lockfiles pin, fetched in the background (see [stack.md](stack.md)). `neuve setup stack --dry-run` shows what it would fetch.

On a repository on an external disk, `neuve query --refresh-cache` keeps its temporary view of a revision on that disk: in the temporary folder when that is on the same disk, and, only when nothing nearer works, in a small hidden folder, `.neuve-<uid>`, at the disk's top. The folder is removed when it is empty.

## The model sign-in

A review runs on a model the person signs in to; Neuve keeps no credential of its own. There are three routes:

- **If the person has ChatGPT:** `neuve setup --route openai` chooses the OpenAI route for reviews (it is kept in the person's Neuve settings), then the person runs `neuve auth login openai`, a sign-in with ChatGPT in the browser. `neuve auth status` shows the account. A single review can name its route with `neuve review <base>..<head> --route openai`.
- **If the person has a Claude subscription:** `neuve setup --route claude` chooses it. Reviews run through the person's installed Claude Code and its own sign-in, which Neuve never reads. The person installs Claude Code and signs in with `claude auth login` first; setup then checks that sign-in without spending usage. A `neuve` older than this route refuses a settings file that names `claude`: if `neuve setup --help` doesn't list `claude`, tell the person to update it first with `neuve upgrade`, or with the one-line install again if their `neuve` has no `upgrade`.
- **Otherwise:** `neuve setup --route anthropic`, then an Anthropic API key in `ANTHROPIC_API_KEY`, set in the shell that starts the background worker. It must be an API key from the Anthropic Console; a Claude subscription token must not go there.

`neuve doctor` shows which route a review will use and whether its credential is present.

Never sign in on the person's behalf. Don't ask for, type, copy or store a credential, and don't run `neuve auth login openai` or `claude auth login` for them. When one is missing, say which route needs what, give the command, and let the person run it.

## Worked example

The person asks you to get Neuve going in their repository, and says they have ChatGPT.

```sh
neuve doctor
neuve setup --route openai --no-skills
neuve setup hooks --agents claude-code,codex --dry-run
```

`neuve setup` prints a record like this one, and exits 0 when the Graph engine's check passes:

```json
{
  "installation": {
    "schemaVersion": 4,
    "repository": "/Users/sam/code/shop",
    "cliBinary": "/Users/sam/.neuve/bin/neuve",
    "graphBinary": "/Users/sam/.neuve/lib/neuve/entire-graph"
  },
  "revision": "b7fb34a5b548ea53e4997699bd382f3f4bf99d25",
  "workingTreeDirty": false,
  "indexedSource": "nothing: the engine is checked, and reviews index what they read",
  "initialIndexStatus": "ok",
  "observation": "/Users/sam/code/shop/.git/neuve/setup/initial-index.json"
}
```

You show the person the dry run's list of files and ask whether to add the hooks. `neuve doctor` said the review's credential is missing, so you tell them: "Reviews need you to sign in with ChatGPT: run `neuve auth login openai`." Had they no ChatGPT, you would have run `neuve setup --route anthropic` instead and asked them to set `ANTHROPIC_API_KEY` to an Anthropic API key (not a Claude subscription token) in their shell, then restart the worker from it (`neuve worker stop`, then `neuve worker start`). You don't sign in or touch a key yourself.
