import { expect, test } from "bun:test";
import type { Project } from "@ace/host/protocol";
import {
  parseWorkspaceOptions,
  workspaceReady,
} from "../src/workspace-launch.ts";

const ready = {
  url: "ws://127.0.0.1:49122/",
  tokenFile: "/state/host.token",
  web: "http://127.0.0.1:49123/",
  repository: "/projects/B",
  pid: 42,
};
const project: Project = { path: "/projects/B", name: "B" };

for (const args of [["--repo", "/projects/B"], ["--repo=/projects/B"]]) {
  test(`explicit ${args.join(" ")} emits B as the coding landing selection`, () => {
    const options = parseWorkspaceOptions(args);
    expect(
      JSON.parse(
        JSON.stringify(
          workspaceReady({ ...ready, project, repo: options.repo }),
        ),
      ),
    ).toEqual({
      "neuve-host": "ready",
      ...ready,
      web: "http://127.0.0.1:49123/?project=%2Fprojects%2FB#dashboard",
    });
  });
}

test("the emitted landing selects the normalized project returned for a worktree input", () => {
  const options = parseWorkspaceOptions(["--repo", "/worktrees/B/fix"]);
  expect(
    workspaceReady({
      ...ready,
      repository: "/worktrees/B/fix",
      project,
      repo: options.repo,
    }).web,
  ).toBe("http://127.0.0.1:49123/?project=%2Fprojects%2FB#dashboard");
});

test("the default home emits no project override even after opening the current directory", () => {
  const options = parseWorkspaceOptions([]);
  expect(workspaceReady({ ...ready, project, repo: options.repo })).toEqual({
    "neuve-host": "ready",
    ...ready,
  });
});
