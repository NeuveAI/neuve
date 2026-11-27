import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import {
  configure,
  ROOT_CONVERSATION_ID,
  type Harness,
} from "@earendil-works/pi-durable";
import { Fixture, git, MODEL, OWNER } from "./helpers";

let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.dispose();
  fixture = undefined;
});

async function setup(useLane = true) {
  let harness!: Harness;
  const channel = await Fixture.create({
    ...(useLane ? {} : { lane: undefined }),
    extension: {
      extensions: [],
      attach(value) {
        harness = value;
      },
    },
  });
  fixture = channel;
  const hooks = join(channel.root, "hooks");
  await mkdir(hooks);
  git(channel.project, "config", "core.hooksPath", hooks);
  git(channel.project, "config", "user.name", "Neuve Test");
  git(channel.project, "config", "user.email", "test@neuve.invalid");
  return { channel, harness, hooks, path: channel.lane.path };
}

async function commit(channel: Fixture, message: string, mode?: "plan") {
  channel.script(({ messages }) => {
    const tools = getCurrentTools(messages).map((tool) => tool.name);
    expect(tools.includes("neuve_commit")).toBe(mode !== "plan");
    return fauxAssistantMessage(
      fauxToolCall("neuve_commit", { message }, { id: "commit" }),
      { stopReason: "toolUse" },
    );
  }, fauxAssistantMessage("Done"));
  const watch = await channel.watch();
  try {
    const { submission } = await channel.request<{ submission: number }>({
      op: "ask",
      author: OWNER,
      text: "Commit it",
      model: MODEL,
      ...(mode ? { mode } : {}),
    });
    expect(await channel.request({ op: "wait", submission })).toBe("done");
    return await watch.until("result", (event) => event.call === "commit");
  } finally {
    await watch.stop();
  }
}

test("the commit tool stages all changes and commits on the work lane's current branch", async () => {
  const { channel, path } = await setup();
  git(path, "switch", "-c", "one/renamed");
  const base = git(channel.project, "rev-parse", "HEAD");
  await rm(join(path, "README.md"));
  await writeFile(join(path, "staged.txt"), "staged\n");
  git(path, "add", "staged.txt");
  await writeFile(join(path, "new.txt"), "new\n");

  const result = await commit(
    channel,
    "Capture the lane's $changes\n\nKeep the body.",
  );

  expect(result.error).toBeFalsy();
  expect(result.text).toBe(
    `Committed ${git(path, "rev-parse", "--short", "HEAD").trim()} on one/renamed\nCapture the lane's $changes`,
  );
  expect(git(path, "log", "-1", "--format=%B")).toBe(
    "Capture the lane's $changes\n\nKeep the body.\n\n",
  );
  expect(
    git(path, "diff", "--name-status", "--no-renames", "HEAD^", "HEAD"),
  ).toBe("D\tREADME.md\nA\tnew.txt\nA\tstaged.txt\n");
  expect(git(path, "status", "--porcelain")).toBe("");
  expect(git(channel.project, "rev-parse", "HEAD")).toBe(base);
});

test("the commit tool refuses from the project checkout", async () => {
  const { channel } = await setup(false);
  await writeFile(join(channel.project, "new.txt"), "new\n");
  expect(await commit(channel, "Commit outside a lane")).toMatchObject({
    error: true,
    text: "This chat is outside its recorded work lane.",
  });
  expect(git(channel.project, "status", "--porcelain")).toBe("?? new.txt\n");
});

test("the commit tool refuses from a Git worktree the channel has not recorded", async () => {
  const { channel, harness, path } = await setup(false);
  await harness.commit(
    (tx) => configure(tx, ROOT_CONVERSATION_ID, { cwd: path }),
    BACKGROUND_CONTEXT,
  );
  await writeFile(join(path, "new.txt"), "new\n");

  expect(await commit(channel, "Commit outside a recorded lane")).toMatchObject(
    {
      error: true,
      text: "This chat is outside its recorded work lane.",
    },
  );
  expect(git(path, "status", "--porcelain")).toBe("?? new.txt\n");
});

test("the commit tool refuses a call during a read-only Plan turn", async () => {
  const { channel, path } = await setup();
  await writeFile(join(path, "new.txt"), "new\n");
  expect(await commit(channel, "Commit while planning", "plan")).toMatchObject({
    error: true,
    text: "Plan mode is read-only. The neuve_commit tool is unavailable in plan mode.",
  });
  expect(git(path, "status", "--porcelain")).toBe("?? new.txt\n");
});

test("the commit tool refuses when the work lane has no changes", async () => {
  const { channel, path } = await setup();
  expect(await commit(channel, "Empty commit")).toMatchObject({
    error: true,
    text: "There is nothing to commit.",
  });
  expect(git(path, "log", "-1", "--format=%s")).toBe("first\n");
});

test("the commit tool returns a Git hook's rejection", async () => {
  const { channel, hooks, path } = await setup();
  await writeFile(join(path, "new.txt"), "new\n");
  await writeFile(
    join(hooks, "commit-msg"),
    "#!/bin/sh\necho 'Use a ticket in the subject.' >&2\nexit 1\n",
    { mode: 0o755 },
  );

  expect(await commit(channel, "Missing ticket")).toMatchObject({
    error: true,
    text: "Use a ticket in the subject.",
  });
  expect(git(path, "log", "-1", "--format=%s")).toBe("first\n");
});
