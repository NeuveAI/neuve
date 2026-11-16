import { expect, test } from "bun:test";
import type { GithubDetail } from "@ace/channel/protocol";

import {
  githubReturnList,
  githubReturnQuery,
  githubReturnTarget,
} from "../apps/app/src/github-return";

import { projects } from "../apps/app/src/projects";

const localHost = "local-host";
const project = "/work/ace";
const selectedProject = projects(
  [{ path: project, name: "ace", repo: "githubnext/ace" }],
  [],
  localHost,
)[0];
if (!selectedProject) throw new Error("Missing project");
const unrelatedProject = projects(
  [{ path: "/other/project", name: "other", repo: "githubnext/ace" }],
  [],
  localHost,
)[0];
if (!unrelatedProject) throw new Error("Missing unrelated project");
const address = new URL("http://127.0.0.1:4141/");
address.searchParams.set("project", project);
address.searchParams.set("repo", "GitHubNext/Ace");
address.searchParams.set("pull", "711");
address.hash = "prs";

const detail: GithubDetail = {
  kind: "prs",
  number: 711,
  title: "feat(host): add ace demo with scripted teammates and mocked data",
  url: "https://github.com/githubnext/ace/pull/711",
  state: "open",
  author: "agorischek",
  created: "2026-10-27T22:43:31Z",
  updated: "2026-10-27T22:55:55Z",
  labels: [],
  body: "",
  comments: [],
};

test("a review return reads the exact source item through the exact github-detail request", () => {
  const target = githubReturnTarget(address);
  expect(target).toBeDefined();
  if (!target) throw new Error("Missing return target");
  const selected = githubReturnQuery(
    target,
    selectedProject,
    "githubnext/ace",
    localHost,
  );
  expect(selected).toEqual({
    project,
    request: {
      op: "github-detail",
      repo: "githubnext/ace",
      kind: "prs",
      number: 711,
    },
  });
  if (!selected.request) throw new Error("Missing exact item request");
  expect(githubReturnList(selected.request, detail)).toEqual({
    items: [detail],
    more: false,
  });
});

test("normal issue and PR addresses keep the filtered list journey", () => {
  expect(
    githubReturnTarget(new URL("http://localhost/?project=ace#prs")),
  ).toBeUndefined();
  expect(
    githubReturnTarget(new URL("http://localhost/?project=ace#issues")),
  ).toBeUndefined();
});

test("parsed absent GitHub optionals stay absent in the native list item", () => {
  const result = githubReturnList(
    { op: "github-detail", repo: "githubnext/ace", kind: "prs", number: 711 },
    { ...detail, head: undefined, fork: undefined },
  );
  expect(result).toEqual({ items: [detail], more: false });
  expect(Object.hasOwn(result.items[0]!, "head")).toBe(false);
  expect(Object.hasOwn(result.items[0]!, "fork")).toBe(false);
});

test("issue returns retain the issue kind and positive item number", () => {
  const url = new URL(address);
  url.searchParams.delete("pull");
  url.searchParams.set("issue", "42");
  url.hash = "issues";
  const target = githubReturnTarget(url);
  expect(target).toEqual({
    status: "item",
    project,
    repo: "githubnext/ace",
    kind: "issues",
    number: 42,
  });
});

test("issue and PR returns survive Ace consuming the startup action and reopening the current URL", () => {
  for (const kind of ["issues", "prs"] as const) {
    const before = new URL(address);
    before.searchParams.delete("pull");
    before.searchParams.set(kind === "prs" ? "pull" : "issue", "711");
    before.hash = kind;
    const expected = {
      status: "item",
      project,
      repo: "githubnext/ace",
      kind,
      number: 711,
    } satisfies ReturnType<typeof githubReturnTarget>;
    expect(githubReturnTarget(before)).toEqual(expected);
    const consumed = new URL(before.pathname + before.search, before);
    expect(consumed.hash).toBe("");
    expect(githubReturnTarget(new URL(consumed.href))).toEqual(expected);
  }
});

test("consumed return URLs still reject mismatched hashes, ambiguous items, and unsafe numbers", () => {
  for (const hash of ["", "#prs", "#issues", "#dashboard"]) {
    for (const query of [
      "repo=githubnext/ace&pull=711&issue=42",
      "repo=githubnext/ace&pull=711&pull=712",
      "repo=githubnext/ace&issue=42&issue=43",
      "repo=githubnext/ace&pull=9007199254740992",
      "repo=githubnext/ace&issue=9007199254740992",
      "repo=githubnext/ace&repo=other/repo&pull=711",
      "repo=githubnext/ace&pull=711&project=/other",
    ]) {
      const url = new URL(
        `http://localhost/?project=${encodeURIComponent(project)}&${query}${hash}`,
      );
      expect(githubReturnTarget(url)?.status).toBe("invalid");
    }
  }
  for (const [field, hash] of [
    ["issue", "#prs"],
    ["pull", "#issues"],
    ["pull", "#dashboard"],
  ]) {
    expect(
      githubReturnTarget(
        new URL(
          `http://localhost/?project=/repo&repo=githubnext/ace&${field}=711${hash}`,
        ),
      )?.status,
    ).toBe("invalid");
  }
});

test("malformed or ambiguous return links never become a list query", () => {
  for (const [field, value] of [
    ["pull", "0"],
    ["pull", "-1"],
    ["pull", "1e3"],
    ["pull", "01"],
    ["pull", "9007199254740992"],
    ["repo", "githubnext/ace/other"],
    ["project", ""],
  ] as const) {
    const url = new URL(address);
    url.searchParams.set(field, value);
    expect(githubReturnTarget(url)?.status).toBe("invalid");
  }
  for (const change of [
    "missing-repo",
    "duplicate-number",
    "both-kinds",
    "wrong-page",
  ]) {
    const url = new URL(address);
    if (change === "missing-repo") url.searchParams.delete("repo");
    if (change === "duplicate-number") url.searchParams.append("pull", "712");
    if (change === "both-kinds") url.searchParams.set("issue", "711");
    if (change === "wrong-page") url.hash = "issues";
    expect(githubReturnTarget(url)?.status).toBe("invalid");
  }
});

test("the actual selected project and its resolved repository must match before an exact read", () => {
  const target = githubReturnTarget(address);
  if (!target) throw new Error("Missing return target");
  expect(
    githubReturnQuery(target, selectedProject, undefined, localHost),
  ).toEqual({});
  for (const selected of [
    githubReturnQuery(target, unrelatedProject, "githubnext/ace", localHost),
    githubReturnQuery(target, selectedProject, "other/repo", localHost),
    githubReturnQuery(target, selectedProject, null, localHost),
  ]) {
    expect(selected.request).toBeUndefined();
    expect(selected.error).toBeString();
  }
});

test("a missing, malformed, foreign, or different-kind detail cannot show an unrelated item", () => {
  const request = {
    op: "github-detail",
    repo: "githubnext/ace",
    kind: "prs",
    number: 711,
  } as const;
  for (const value of [
    null,
    { ...detail, number: 712 },
    { ...detail, kind: "issues" },
    { ...detail, url: "https://github.com/other/repo/pull/711" },
  ]) {
    expect(() => githubReturnList(request, value)).toThrow();
  }
});
