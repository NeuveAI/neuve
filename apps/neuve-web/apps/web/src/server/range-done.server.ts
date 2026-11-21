import { SharedWork } from "@neuve/records-core/shared-work"
import type { SharedOutcome } from "@neuve/records-core/shared-work"

/*
 * What git says of the reviewed ranges (NEU-433), read at page load as the
 * user's last fetch left the repository:
 * - which reviewed commits descend from which, for a later review whose
 *   range holds an earlier one;
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
 * Each read runs once per key through records-core's shared work (record
 * 0016): concurrent loads join the run in flight, and an answer that commit
 * IDs alone decide is kept for the next load. Answers that hang on refs are
 * keyed by the refs they read, which each load reads afresh.
 */

export type RangeEnd = "landed" | "gone"

const COUNTED_REFS = ["refs/heads", "refs/remotes", "refs/tags"]

/** Runs `git -C at …`, with `input` on its stdin; its stdout, or undefined when it fails. */
const git = async (
  at: string,
  args: ReadonlyArray<string>,
  input?: string | ReadableStream<Uint8Array>
): Promise<string | undefined> => {
  const child = Bun.spawn(["git", "-C", at, ...args], {
    stdin:
      input === undefined
        ? "ignore"
        : typeof input === "string"
          ? new Blob([input])
          : input,
    stdout: "pipe",
    stderr: "ignore",
  })
  const [out, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ])
  return code === 0 ? out : undefined
}

const lines = (text: string | undefined) =>
  (text ?? "").split("\n").filter((line) => line !== "")

/** The patch-id of `git <args>`'s diff output, or undefined for an empty diff. */
const patchIds = async (at: string, args: ReadonlyArray<string>) => {
  const diff = Bun.spawn(["git", "-C", at, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  })
  const ids = await git(at, ["patch-id", "--stable"], diff.stdout)
  await diff.exited
  // Each line is `<patch-id> <commit>`; a plain diff names no commit.
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
 * caller bounds: commit IDs alone decide what each memo here holds.
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
  if (oids.length === 0) return new Set<string>()
  const out = await git(
    at,
    ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
    `${oids.join("\n")}\n`
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
  const held = [...(await present(at, [...new Set(oids)]))].sort()
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
          ? lines(await git(at, ["merge-base", "--octopus", ...held]))[0]
          : undefined
      const out = await git(at, [
        "rev-list",
        "--parents",
        ...held,
        ...(bound ? [`^${bound}`] : []),
      ])
      if (out === undefined)
        throw new Error("git could not list the reviewed history")
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

/** What each default branch tip answers, dropped once a load no longer reads that tip. */
interface TipMemo {
  /** The patch-id of each first-parent commit's change, read once per tip. */
  readonly firstParent: Map<string, ReadonlyMap<string, string>>
  /** Whether a tip's change from its fork off this tip squash-landed on it. */
  readonly squashed: Map<string, boolean>
  /** How a head ended, by the head and the refs that hold it. */
  readonly ends: Map<string, RangeEnd | undefined>
}

const tips = new Map<string, TipMemo>()
const patchWork = new SharedWork<ReadonlyMap<string, string>>()
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

/** Each first-parent commit of `tip` by the patch-id of its change. */
const firstParentPatches = (at: string, tip: string) =>
  once(
    patchWork,
    "web.range.first-parent",
    `${at}\0${tip}`,
    tipMemo(tip).firstParent,
    async () => {
      const ids = await patchIds(at, [
        "log",
        "--first-parent",
        "-m",
        "-p",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--format=commit %H",
        tip,
      ])
      return new Map(ids.map(({ patch, commit }) => [patch, commit]))
    }
  )

/** Whether `from`'s change since it forks off `tip` landed on `tip` as one first-parent commit. */
const squashLanded = (at: string, from: string, tip: string) =>
  once(
    squashWork,
    "web.range.squash",
    `${at}\0${from}\0${tip}`,
    tipMemo(tip).squashed,
    async () => {
      const fork = lines(await git(at, ["merge-base", from, tip]))[0]
      if (!fork) return false
      const [change] = await patchIds(at, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        fork,
        from,
      ])
      if (!change) return false
      const landed = (await firstParentPatches(at, tip)).get(change.patch)
      // A first-parent commit before the fork was already in it.
      return (
        landed !== undefined &&
        (await git(at, ["merge-base", "--is-ancestor", landed, fork])) ===
          undefined
      )
    }
  )

/** The default branch's tip: `origin/HEAD`, else `baseRef` when it names a branch. */
const defaultTipOf = async (
  at: string,
  baseRef: string,
  origin: string | undefined
) => {
  if (origin) return origin
  const name = lines(
    await git(at, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--symbolic-full-name",
      baseRef,
    ])
  )[0]
  if (!name?.startsWith("refs/heads/") && !name?.startsWith("refs/remotes/"))
    return undefined
  return lines(
    await git(at, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`])
  )[0]
}

/** The tips of counted refs that hold `head`, peeled to commits; undefined when git can't say. */
const tipsHolding = async (at: string, head: string) => {
  const out = await git(at, [
    "for-each-ref",
    "--contains",
    head,
    "--format=%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)",
    ...COUNTED_REFS,
  ])
  return out === undefined ? undefined : [...new Set(lines(out))].sort()
}

/**
 * How each range ended, by cycle; a range git can't place, or one still
 * open, is absent. Commits the repository no longer holds are gone.
 */
export async function rangeEnds(
  at: string,
  ranges: ReadonlyArray<{
    readonly cycleId: string
    readonly baseRef: string
    readonly headOid: string
  }>
): Promise<ReadonlyMap<string, RangeEnd>> {
  const origin = lines(
    await git(at, [
      "rev-parse",
      "--verify",
      "--quiet",
      "refs/remotes/origin/HEAD^{commit}",
    ])
  )[0]
  const held = await present(
    at,
    ranges.map((range) => range.headOid)
  )
  const placed = await Promise.all(
    ranges.map(async (range) => {
      if (!held.has(range.headOid)) return "gone" as const
      const [tip, holding] = await Promise.all([
        defaultTipOf(at, range.baseRef, origin),
        tipsHolding(at, range.headOid),
      ])
      if (holding === undefined) return undefined
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
