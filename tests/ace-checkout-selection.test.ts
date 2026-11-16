import { expect, test } from "bun:test";

import { initialProject } from "../apps/app/src/initial-selection";
import {
  githubReturnQuery,
  githubReturnTarget,
} from "../apps/app/src/github-return";
import { projects } from "../apps/app/src/projects";

const host = "local-host";
const primary = "/work/ace";
const secondary = "/work/ace-review";

test("an explicit secondary checkout selects its actual grouped project instead of the other project", () => {
  const available = projects(
    [
      { path: "/work/other", name: "other", repo: "owner/other" },
      { path: primary, name: "ace", repo: "githubnext/ace" },
      { path: secondary, name: "ace-review", repo: "githubnext/ace" },
    ],
    [],
    host,
  );

  expect(available).toHaveLength(2);
  expect(available[1]?.path).toBe(primary);
  expect(initialProject(available, host, secondary)?.id).toBe(
    "github:githubnext/ace",
  );
  expect(initialProject(available, host, primary)?.id).toBe(
    "github:githubnext/ace",
  );
  expect(initialProject(available, host, "/work/other")?.id).toBe(
    "github:owner/other",
  );
  expect(initialProject(available, "another-host", secondary)).toBeUndefined();
  expect(initialProject(available, host, "/work/unrelated")).toBeUndefined();
  expect(initialProject(available, host, null)).toBeUndefined();
});

test("a review return to a known secondary checkout keeps its source path for review history", () => {
  const available = projects(
    [
      { path: "/work/other", name: "other", repo: "owner/other" },
      { path: primary, name: "ace", repo: "githubnext/ace" },
      { path: secondary, name: "ace-review", repo: "githubnext/ace" },
    ],
    [],
    host,
  );
  const url = new URL("http://localhost/?repo=githubnext%2Face&pull=711#prs");
  url.searchParams.set("project", secondary);
  const target = githubReturnTarget(url);
  const selected = initialProject(
    available,
    host,
    url.searchParams.get("project"),
  );
  if (!target || !selected) throw new Error("Missing return selection");

  expect(githubReturnQuery(target, selected, "githubnext/ace", host)).toEqual({
    project: secondary,
    request: {
      op: "github-detail",
      repo: "githubnext/ace",
      kind: "prs",
      number: 711,
    },
  });
  for (const path of ["/work/unrelated", "/work/other"]) {
    url.searchParams.set("project", path);
    const unrelated = githubReturnTarget(url);
    if (!unrelated) throw new Error("Missing unrelated return target");
    expect(
      githubReturnQuery(unrelated, selected, "githubnext/ace", host),
    ).toEqual({
      error: "The GitHub return link does not name the selected project.",
    });
  }
  expect(
    githubReturnQuery(target, selected, "githubnext/ace", "another-host"),
  ).toEqual({
    error: "The GitHub return link does not name the selected project.",
  });
});
