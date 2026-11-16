import { z } from "zod";
import { Effect } from "effect";
import {
  GitHubExternalRefSchema,
  type ExternalReviewSource,
  type GitHubExternalRef,
} from "@neuve/records-schema";

const Body = z.object({
  title: z.string(),
  body: z.string().nullable(),
  updated_at: z.iso.datetime(),
  html_url: z.url(),
  number: z.int().positive(),
});

export const externalScopeText = (
  source: Pick<ExternalReviewSource, "title" | "text">,
) => `# ${source.title}\n\n${source.text}`;

export const parseGitHubSource = (
  item: GitHubExternalRef,
  response: unknown,
  fetchedAt: string,
): ExternalReviewSource => {
  const body = Body.parse(response);
  const observed = GitHubExternalRefSchema.parse({
    ...item,
    number: body.number,
    url: body.html_url,
  });
  if (
    observed.number !== item.number ||
    observed.url.toLowerCase() !== item.url.toLowerCase()
  )
    throw new Error("GitHub returned a different item");
  return {
    item,
    title: body.title,
    text: body.body ?? "",
    version: body.updated_at,
    fetchedAt,
    complete: true,
  };
};

/** Reads only the explicitly selected body's provider, without exposing credentials in its result. */
export const readGitHubSource = (item: GitHubExternalRef) =>
  Effect.tryPromise({
    try: async (signal) => {
      const path = `repos/${item.repo}/${item.kind === "issue" ? "issues" : "pulls"}/${item.number}`;
      const child = Bun.spawn(["gh", "api", "--hostname", "github.com", path], {
        env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30000,
        signal,
      });
      const [output, _error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0)
        throw new Error(`GitHub source read failed with exit ${code}`);
      return parseGitHubSource(
        item,
        JSON.parse(output),
        new Date().toISOString(),
      );
    },
    catch: (cause) =>
      new Error(
        cause instanceof z.ZodError
          ? "GitHub source response did not match its contract"
          : cause instanceof Error
            ? cause.message
            : "GitHub source could not be checked",
      ),
  });
