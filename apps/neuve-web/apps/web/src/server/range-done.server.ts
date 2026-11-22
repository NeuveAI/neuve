import { SharedWork } from "@neuve/records-core/shared-work"
import type { SharedOutcome } from "@neuve/records-core/shared-work"

import { git as run, spawnGit } from "./git.server"

/*
 * What git says of the reviewed ranges (NEU-433), read at page load as the
 * user's last fetch left the repository:
 * - which reviewed commits descend from which, for a later review whose
 *   range holds an earlier one;
 * - each range's commits by patch-id (`git patch-id --stable`, the rebase
 *   equivalence `git cherry` uses), for a rebased review a later review
 *   carries;
 * - whether a range is done against the repository's default branch
 *   (`origin/HEAD`, else the review's recorded base ref when it names a
 *   branch): landed, when its head is in the default branch or the diff of
 *   its head, or of a branch tip that holds it, from where that tip forks
 *   off the default branch has the patch-id of a first-parent commit of the
 *   default branch after that fork (a squash merge); gone, when its head is
 *   on no branch or tag, so its commits were rewritten or deleted.
 *
 * Only branches, remote branches and tags count as refs: Neuve's own refs
 * (`refs/neuve/reviews/<head>`, record 0015) and other tools' refs keep
 * commits from pruning, not a range open.
 *
 * A git failure (a repository git refuses, a broken object database, a git
 * past its deadline) is never an answer: every read throws, and the caller
 * treats git as silent.
 *
 * Each read runs once per key through records-core's shared work (record
 * 0016): concurrent loads join the run in flight, and an answer that commit
 * IDs alone decide is kept for the next load. Answers that hang on refs are
 * keyed by the refs they read: one listing of them per load.
 */

export type RangeEnd = "landed" | "gone"

const COUNTED_REFS = ["refs/heads", "refs/remotes", "refs/tags"]

/** A full commit ID; anything else from the store is never handed to git. */
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

/** Git exited with an error: it said nothing about the ranges. */
export class GitSilent extends Error {
  override readonly name = "GitSilent"
}

/** Stdout of a git command that must succeed. */
const must = async (
  at: string,
  args: ReadonlyArray<string>,
  input?: string | ReadableStream<Uint8Array>
) => {
  const { code, out } = await run(at, args, input)
  if (code !== 0) throw new GitSilent(`git ${args[0]} exited ${code}`)
  return out
}

/** Stdout of a git command whose exit 1 means "none" (a missing ref, no common ancestor); undefined then. */
const maybe = async (at: string, args: ReadonlyArray<string>) => {
  const { code, out } = await run(at, args)
  if (code === 1) return undefined
  if (code !== 0) throw new GitSilent(`git ${args[0]} exited ${code}`)
  return out
}

const lines = (text: string | undefined) =>
  (text ?? "").split("\n").filter((line) => line !== "")

/** Each change's patch-id in `git <args>`'s output, with the commit it names (none for a plain diff). */
const patchIds = async (at: string, args: ReadonlyArray<string>) => {
  const diff = spawnGit(at, args)
  const ids = await must(at, ["patch-id", "--stable"], diff.stdout)
  const code = await diff.exited
  if (code !== 0) throw new GitSilent(`git ${args[0]} exited ${code}`)
  return lines(ids).map((line) => {
    const [patch = "", commit = ""] = line.split(" ")
    return { patch, commit }
  })
}

const ok = <A>(value: A): SharedOutcome<A, never> => ({
  kind: "succeeded",
  value,
})

/**
 * One run per key in flight, and its answer kept in `memo`, which the
 * caller bounds. A failure is never kept.
 */
const once = async <A>(
  work: SharedWork<A>,
  scope: string,
  key: string,
  memo: Map<string, A>,
  compute: () => Promise<A>
): Promise<A> => {
  if (memo.has(key)) return memo.get(key) as A
  const result = await work.run({
    scope,
    key,
    run: async () => ok(await compute()),
  })
  if (result.outcome.kind !== "succeeded") throw result.outcome.error
  memo.set(key, result.outcome.value)
  return result.outcome.value
}

/** The commits among `oids` the repository holds (`cat-file --batch-check`). */
const present = async (at: string, oids: ReadonlyArray<string>) => {
  const asked = [...new Set(oids)].filter((oid) => OID.test(oid))
  if (asked.length === 0) return new Set<string>()
  const out = await must(
    at,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    `${asked.join("\n")}\n`
  )
  return new Set(
    lines(out)
      .map((line) => line.split(" "))
      .filter(([, type]) => type === "commit")
      .map(([oid = ""]) => oid)
  )
}

type Descends = (ancestor: string, descendant: string) => boolean

const ancestryWork = new SharedWork<Descends>()
let ancestryMemo = new Map<string, Descends>()

/**
 * Whether one of `oids` is an ancestor of, or equal to, another, from one
 * read of the history between them: the commits back to their common
 * ancestor (`merge-base --octopus`) with their parents. An oid the
 * repository doesn't hold descends from nothing and has no ancestor.
 */
export async function ancestryOf(
  at: string,
  oids: ReadonlyArray<string>
): Promise<Descends> {
  const held = [...(await present(at, oids))].sort()
  const key = `${at}\0${held.join(",")}`
  // Only the newest set is kept: the next load reads the same reviews.
  if (!ancestryMemo.has(key)) ancestryMemo = new Map()
  return once(
    ancestryWork,
    "web.range.ancestry",
    key,
    ancestryMemo,
    async () => {
      const holds = new Set(held)
      if (held.length === 0) return () => false
      const bound =
        held.length > 1
          ? lines(
              await maybe(at, [
                "merge-base",
                "--octopus",
                "--end-of-options",
                ...held,
              ])
            )[0]
          : undefined
      const out = await must(at, [
        "rev-list",
        "--parents",
        "--end-of-options",
        ...held,
        ...(bound ? [`^${bound}`] : []),
      ])
      const parents = new Map<string, ReadonlyArray<string>>()
      for (const line of lines(out)) {
        const [commit = "", ...rest] = line.split(" ")
        parents.set(commit, rest)
      }
      const reach = new Map<string, Set<string>>()
      const ancestors = (from: string) => {
        const known = reach.get(from)
        if (known) return known
        const seen = new Set<string>()
        const stack = [from]
        while (stack.length > 0) {
          const next = stack.pop() as string
          if (seen.has(next)) continue
          seen.add(next)
          stack.push(...(parents.get(next) ?? []))
        }
        reach.set(from, seen)
        return seen
      }
      return (ancestor, descendant) =>
        holds.has(ancestor) &&
        holds.has(descendant) &&
        ancestors(descendant).has(ancestor)
    }
  )
}

const rangePatchWork = new SharedWork<ReadonlyArray<string>>()
let rangePatchMemo = new Map<string, ReadonlyArray<string>>()

/**
 * Each range's commits by patch-id, merges left out, by `base..head`: the
 * changes a rebase carries under new hashes. Only ranges whose commits the
 * repository holds are read, and each on its own: a range git can't read is
 * absent (unknown, never "no commits"). Throws when git can't read the
 * repository at all.
 */
export async function rangePatchesOf(
  at: string,
  ranges: ReadonlyArray<{ readonly baseOid: string; readonly headOid: string }>
): Promise<ReadonlyMap<string, ReadonlyArray<string>>> {
  const held = await present(
    at,
    ranges.flatMap(({ baseOid, headOid }) => [baseOid, headOid])
  )
  const asked = [
    ...new Set(
      ranges
        .filter(
          ({ baseOid, headOid }) => held.has(baseOid) && held.has(headOid)
        )
        .map(({ baseOid, headOid }) => `${baseOid}..${headOid}`)
    ),
  ]
  // Only the ranges this load asks for keep their answers.
  const kept = new Map<string, ReadonlyArray<string>>()
  for (const range of asked) {
    const answer = rangePatchMemo.get(`${at}\0${range}`)
    if (answer) kept.set(`${at}\0${range}`, answer)
  }
  rangePatchMemo = kept
  const read = await Promise.allSettled(
    asked.map((range) =>
      once(
        rangePatchWork,
        "web.range.patches",
        `${at}\0${range}`,
        rangePatchMemo,
        async () =>
          (
            await patchIds(at, [
              "log",
              "-p",
              "--no-merges",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--format=commit %H",
              "--end-of-options",
              range,
            ])
          ).map(({ patch }) => patch)
      )
    )
  )
  const patches = new Map<string, ReadonlyArray<string>>()
  read.forEach((each, index) => {
    const range = asked[index]
    if (range === undefined) return
    if (each.status === "fulfilled") patches.set(range, each.value)
    else console.warn(`git could not read the commits of ${range}`, each.reason)
  })
  return patches
}

/** What each default branch tip answers, dropped once a load no longer reads that tip. */
interface TipMemo {
  /** The patch-ids of the tip's first-parent commits after a fork point, by fork point. */
  readonly firstParent: Map<string, ReadonlySet<string>>
  /** Whether a tip's change from its fork off this tip squash-landed on it. */
  readonly squashed: Map<string, boolean>
  /** How a head ended, by the head and the refs that hold it. */
  readonly ends: Map<string, RangeEnd | undefined>
}

const tips = new Map<string, TipMemo>()
const patchWork = new SharedWork<ReadonlySet<string>>()
const squashWork = new SharedWork<boolean>()
const endWork = new SharedWork<RangeEnd | undefined>()

const tipMemo = (tip: string) => {
  let memo = tips.get(tip)
  if (!memo)
    tips.set(
      tip,
      (memo = { firstParent: new Map(), squashed: new Map(), ends: new Map() })
    )
  return memo
}

/**
 * The patch-ids of `tip`'s first-parent commits after `fork`: only a commit
 * that landed after a branch forked can be that branch landing.
 */
const firstParentPatches = (at: string, tip: string, fork: string) =>
  once(
    patchWork,
    "web.range.first-parent",
    `${at}\0${tip}\0${fork}`,
    tipMemo(tip).firstParent,
    async () =>
      new Set(
        (
          await patchIds(at, [
            "log",
            "--first-parent",
            "-m",
            "-p",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--format=commit %H",
            "--end-of-options",
            `${fork}..${tip}`,
          ])
        ).map(({ patch }) => patch)
      )
  )

/** Whether `from`'s change since it forks off `tip` landed on `tip` as one first-parent commit. */
const squashLanded = (at: string, from: string, tip: string) =>
  once(
    squashWork,
    "web.range.squash",
    `${at}\0${from}\0${tip}`,
    tipMemo(tip).squashed,
    async () => {
      const fork = lines(
        await maybe(at, ["merge-base", "--end-of-options", from, tip])
      )[0]
      if (!fork) return false
      const [change] = await patchIds(at, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--end-of-options",
        fork,
        from,
      ])
      if (!change) return false
      return (await firstParentPatches(at, tip, fork)).has(change.patch)
    }
  )

/** A ref's commit, or undefined when there is no such ref. */
const commitOf = async (at: string, ref: string) =>
  lines(
    await maybe(at, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${ref}^{commit}`,
    ])
  )[0]

/** The default branch's tip: `origin/HEAD`, else `baseRef` when it names a branch. */
const defaultTipOf = async (
  at: string,
  baseRef: string,
  origin: string | undefined
) => {
  if (origin) return origin
  const name = lines(
    await maybe(at, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--symbolic-full-name",
      "--end-of-options",
      baseRef,
    ])
  )[0]
  if (!name?.startsWith("refs/heads/") && !name?.startsWith("refs/remotes/"))
    return undefined
  return commitOf(at, name)
}

const refsWork = new SharedWork<string>()
const holdWork = new SharedWork<ReadonlyArray<string>>()
let holding: { refs: string; memo: Map<string, ReadonlyArray<string>> } = {
  refs: "",
  memo: new Map(),
}

/** Every counted ref and its commit, once per load (concurrent loads share it). */
const countedRefs = async (at: string) => {
  const result = await refsWork.run({
    scope: "web.range.refs",
    key: at,
    run: async () =>
      ok(
        await must(at, [
          "for-each-ref",
          "--format=%(objectname) %(refname)",
          ...COUNTED_REFS,
        ])
      ),
  })
  if (result.outcome.kind !== "succeeded") throw result.outcome.error
  return result.outcome.value
}

/**
 * The tips of counted refs that hold `head`, peeled to commits: one read
 * per head while the refs don't change.
 */
const tipsHolding = (at: string, head: string, refs: string) => {
  if (holding.refs !== refs) holding = { refs, memo: new Map() }
  return once(
    holdWork,
    "web.range.holding",
    `${at}\0${head}\0${Bun.hash(refs)}`,
    holding.memo,
    async () =>
      [
        ...new Set(
          lines(
            await must(at, [
              "for-each-ref",
              "--contains",
              head,
              "--format=%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)",
              ...COUNTED_REFS,
            ])
          )
        ),
      ].sort()
  )
}

/**
 * How each range ended, by cycle; a range still open, or one with no
 * default branch to judge it by, is absent. Commits the repository no longer
 * holds are gone. Throws when git can't read the repository.
 */
export async function rangeEnds(
  at: string,
  ranges: ReadonlyArray<{
    readonly cycleId: string
    readonly baseRef: string
    readonly headOid: string
  }>
): Promise<ReadonlyMap<string, RangeEnd>> {
  const [origin, held, refs] = await Promise.all([
    commitOf(at, "refs/remotes/origin/HEAD"),
    present(
      at,
      ranges.map((range) => range.headOid)
    ),
    countedRefs(at),
  ])
  const placed = await Promise.all(
    ranges.map(async (range) => {
      if (!held.has(range.headOid)) return "gone" as const
      const [tip, holding] = await Promise.all([
        defaultTipOf(at, range.baseRef, origin),
        tipsHolding(at, range.headOid, refs),
      ])
      if (holding.length === 0) return "gone" as const
      if (tip === undefined) return undefined
      return { tip, holding }
    })
  )
  // Only the tips this load reads keep their answers.
  const read = new Set(
    placed.flatMap((each) => (typeof each === "object" ? [each.tip] : []))
  )
  for (const tip of tips.keys()) if (!read.has(tip)) tips.delete(tip)
  const ends = new Map<string, RangeEnd>()
  await Promise.all(
    ranges.map(async (range, index) => {
      const place = placed[index]
      if (place === "gone") return ends.set(range.cycleId, "gone")
      if (place === undefined) return
      const { tip, holding } = place
      const end = await once(
        endWork,
        "web.range.end",
        `${at}\0${range.headOid}\0${tip}\0${holding.join(",")}`,
        tipMemo(tip).ends,
        async () => {
          // A ref at the tip holds the head: it is in the default branch.
          if (holding.includes(tip)) return "landed"
          for (const from of [range.headOid, ...holding])
            if (await squashLanded(at, from, tip)) return "landed"
          return undefined
        }
      )
      if (end) ends.set(range.cycleId, end)
    })
  )
  return ends
}
