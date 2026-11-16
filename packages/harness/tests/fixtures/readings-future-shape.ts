import { SITE_SHOWS, type RelationsIndex } from "../../src/relations.ts";

/**
 * The call-lines shape: every site with a line in its caller's file shows the call (`call`).
 *
 * Every relations index the readings' tests build by hand passes through here, so one place says
 * which shape they are. The hand-built indexes declare no call-line languages, so the graph lane's
 * builder marks every site `caller`; here each site that has a line in its caller's own file is
 * marked `call` instead, as an engine that declares `call_site_lines` marks a call it placed. A site
 * with no line, or in another file, stays `caller`, so the index still satisfies its schema. A test
 * that wants a `reference` or a `caller` row marks it (`withShows`). What the real engine gives is
 * tested over the shared real-engine fixture (`readings-call-lines.test.ts`).
 */
export const futureShape = <I extends RelationsIndex>(index: I): I => ({
  ...index,
  edges: {
    ...index.edges,
    siteShows: index.edges.siteShows.map((shows, at) =>
      (index.edges.siteLine[at] ?? 0) > 0 &&
      index.edges.sitePath[at] === index.edges.sourcePath[at]
        ? SITE_SHOWS.indexOf("call")
        : shows,
    ),
  },
});

/**
 * An index with what the site of each chosen edge shows set by hand: `pick` gives, per edge (its
 * position in the stored edges, and its site's line), the mark to set, or undefined to keep it. A
 * `call` or `reference` mark is set only where the site has a line in its caller's file, as the
 * index's schema requires.
 */
export const withShows = <I extends RelationsIndex>(
  index: I,
  pick: (edge: {
    readonly at: number;
    readonly line: number;
  }) => (typeof SITE_SHOWS)[number] | undefined,
): I => ({
  ...index,
  edges: {
    ...index.edges,
    siteShows: index.edges.siteShows.map((shows, at) => {
      const line = index.edges.siteLine[at] ?? 0;
      const chosen = pick({ at, line });
      if (chosen === undefined) return shows;
      if (
        chosen !== "caller" &&
        (line === 0 || index.edges.sitePath[at] !== index.edges.sourcePath[at])
      )
        throw new Error("a place needs a line in the caller's file");
      return SITE_SHOWS.indexOf(chosen);
    }),
  },
});
