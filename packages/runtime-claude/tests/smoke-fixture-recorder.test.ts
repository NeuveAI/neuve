import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  readdir,
  mkdir,
  lstat,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixtureFlag,
  fixturePath,
  recordFixture,
  writeFixture,
} from "../src/smoke-fixture-recorder.ts";

let fakeHome = "";
let previousHome: string | undefined;
let previousConfig: string | undefined;
beforeEach(async () => {
  fakeHome = await mkdtemp(join(await realpath(tmpdir()), "fixture-home-"));
  previousHome = process.env.HOME;
  previousConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = fakeHome;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfig;
  await rm(fakeHome, { recursive: true, force: true });
});

const injected = "PRIVATE_ARRAY_INJECTION";
const hostileMap = <T>(values: T[], replacement: unknown[]) =>
  new Proxy(values, {
    get(target, key, receiver) {
      if (key === "map") return () => replacement;
      return Reflect.get(target, key, receiver);
    },
  });

// Reason: a proxy must not inject unredacted content through capture, schema parsing and writing.
test("array proxy cannot inject content into a written fixture", async () => {
  const content = hostileMap(
    [{ type: "text", text: injected, unknown: injected }],
    [{ type: "text", text: injected, unknown: injected }],
  );
  const fixture = recordFixture(
    [{ type: "assistant", message: { content } }],
    [],
  );
  const target = join(fakeHome, "fixture.json");
  await writeFixture({ root: fakeHome, name: "fixture.json" }, fixture);
  expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
    version: 1,
    sends: 0,
    frames: [
      { type: "assistant", message: { content: [{ type: "text", text: "" }] } },
    ],
  });
});

// Reason: an inherited method must never bypass the block constructors.
test("inherited array map cannot inject content", () => {
  const content = [{ type: "text", text: injected, unknown: injected }];
  Object.setPrototypeOf(content, {
    map: () => [{ type: "text", text: injected, unknown: injected }],
  });
  expect(
    recordFixture([{ type: "assistant", message: { content } }], []).frames,
  ).toEqual([
    { type: "assistant", message: { content: [{ type: "text", text: "" }] } },
  ]);
});

// Reason: the outer array must not insert frames that skip the frame constructor.
test("array proxy cannot inject frames", () => {
  const frames = hostileMap(
    [{ type: "system", subtype: "status", unknown: injected }],
    [{ type: "assistant", unknown: injected }],
  );
  expect(recordFixture(frames, []).frames).toEqual([
    { type: "system", subtype: "status" },
  ]);
});

// Reason: stamp lists must contain reconstructed placeholders only.
test("array proxy cannot inject stamps", () => {
  const stamps = hostileMap(["first", "foreign"], [injected]);
  expect(
    recordFixture([{ type: "system", user_message_uuids: stamps }], ["first"])
      .frames,
  ).toEqual([
    {
      type: "system",
      subtype: "other",
      user_message_uuids: ["send_1", "foreign_1"],
    },
  ]);
});

// Reason: send lookup must not call input-controlled indexOf or iteration hooks.
test("sent uuid array methods cannot forge send identities", () => {
  const sends = new Proxy(["first"], {
    get(target, key, receiver) {
      if (key === "indexOf") return () => injected;
      if (key === Symbol.iterator) throw new Error(injected);
      return Reflect.get(target, key, receiver);
    },
  });
  expect(
    recordFixture([{ type: "system", user_message_uuid: "first" }], sends),
  ).toEqual({
    version: 1,
    sends: 1,
    frames: [{ type: "system", subtype: "other", user_message_uuid: "send_1" }],
  });
});

// Reason: every consumed array length or indexed read must fail the whole capture closed.
test.each(["frames", "content", "stamps", "sends"])(
  "throwing %s array reads fail closed",
  (site) => {
    for (const field of ["length", "0"]) {
      const values = new Proxy(["first"], {
        get(target, key, receiver) {
          if (key === field) throw new Error(injected);
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor(target, key) {
          if (key === field) throw new Error(injected);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
      expect(() =>
        recordFixture(
          site === "frames"
            ? values
            : [
                {
                  type: "assistant",
                  user_message_uuids: site === "stamps" ? values : [],
                  message: { content: site === "content" ? values : [] },
                },
              ],
          site === "sends" ? values : [],
        ),
      ).toThrow("Fixture capture failed");
    }
  },
);

// Reason: forged lengths must be bounded before the recorder allocates or iterates.
test.each([-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1, 1_000_001])(
  "invalid array length %s fails closed",
  (length) => {
    const frames = new Proxy([], {
      get(target, key, receiver) {
        if (key === "length") return length;
        if (key === "map") return () => [];
        return Reflect.get(target, key, receiver);
      },
    });
    expect(() => recordFixture(frames, [])).toThrow("Fixture capture failed");
  },
);

// Reason: changing proxy lengths must not change send count or send bindings mid-capture.
test("recorder reads the send array length once", () => {
  let reads = 0;
  const sends = new Proxy(["first"], {
    get(target, key, receiver) {
      if (key === "length") reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  expect(
    recordFixture(
      [{ type: "system", user_message_uuids: ["first", "first"] }],
      sends,
    ).sends,
  ).toBe(1);
  expect(reads).toBe(1);
});

async function refuses(destination: Parameters<typeof fixturePath>[0]) {
  await expect(fixturePath(destination)).rejects.toThrow();
  await expect(
    writeFixture(destination, recordFixture([], [])),
  ).rejects.toThrow();
}

// Reason: dangling default and configured links must refuse before any destination can be created.
test.each(["default", "configured"])(
  "dangling %s config symlink refuses roots and parents",
  async (kind) => {
    const link = join(fakeHome, kind === "default" ? ".claude" : "configured");
    const missing = join(fakeHome, "missing");
    await symlink(missing, link);
    if (kind === "configured") process.env.CLAUDE_CONFIG_DIR = link;
    await refuses({ root: link, name: "fixture.json" });
    await refuses({
      root: fakeHome,
      name: `${kind === "default" ? ".claude" : "configured"}/fixture.json`,
    });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(lstat(missing)).rejects.toHaveProperty("code", "ENOENT");
    expect(await readdir(fakeHome)).toEqual([
      kind === "default" ? ".claude" : "configured",
    ]);
  },
);

// Reason: a root or any ancestor above it must not redirect the destination through a link.
test.each(["root", "ancestor", "before-dotdot"])(
  "symlinked %s refuses fixture writes",
  async (site) => {
    const backing = join(fakeHome, "backing");
    await mkdir(backing);
    await mkdir(join(backing, "nested"));
    const alias = join(fakeHome, "alias");
    await symlink(backing, alias);
    const root =
      site === "root"
        ? alias
        : site === "ancestor"
          ? join(alias, "nested")
          : `${alias}/../backing`;
    await refuses({ root, name: "fixture.json" });
    expect(await readdir(backing)).toEqual(["nested"]);
    expect(await readdir(join(backing, "nested"))).toEqual([]);
  },
);

// Reason: checking only the root or nearest parent would miss intermediate destination links.
test.each(["parent", "intermediate", "dangling"])(
  "symlinked %s beneath root refuses fixture writes",
  async (site) => {
    const backing = join(fakeHome, "backing");
    await mkdir(backing);
    await mkdir(join(backing, "nested"));
    await symlink(
      site === "dangling" ? join(fakeHome, "missing") : backing,
      join(fakeHome, "alias"),
    );
    await refuses({
      root: fakeHome,
      name:
        site === "intermediate"
          ? "alias/nested/fixture.json"
          : "alias/fixture.json",
    });
    expect(await readdir(backing)).toEqual(["nested"]);
    expect(await readdir(join(backing, "nested"))).toEqual([]);
    await expect(lstat(join(fakeHome, "missing"))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  },
);

const sentinel = "PRIVATE_SENTINEL_";
const secret = `${sentinel}${"x".repeat(20000)}`;
const message = {
  id: `${sentinel}message`,
  model: `${sentinel}model`,
  stop_reason: "tool_use",
  unknown: secret,
  content: [
    { type: "text", text: secret, citations: [{ private: secret }] },
    { type: "thinking", thinking: secret, signature: secret },
    {
      type: "tool_use",
      id: `${sentinel}call`,
      name: "mcp__neuve__note",
      input: { password: secret, apiKey: secret },
      unknown: secret,
    },
    {
      type: "tool_result",
      tool_use_id: `${sentinel}call`,
      content: [{ type: "text", text: secret, unknown: secret }],
      is_error: true,
    },
    { type: `${sentinel}block`, text: secret },
    {
      type: "tool_use",
      id: `${sentinel}foreign-tool`,
      name: `${sentinel}tool`,
      input: { secret },
    },
  ],
  usage: {
    input_tokens: 11,
    output_tokens: 9,
    cache_read_input_tokens: 3,
    cache_creation_input_tokens: 4,
    cache_creation: {
      ephemeral_5m_input_tokens: 1,
      ephemeral_1h_input_tokens: 3,
      unknown: secret,
    },
    output_tokens_details: { thinking_tokens: 2, unknown: secret },
    unknown: secret,
  },
};
const fields = {
  uuid: `${sentinel}uuid`,
  session_id: `${sentinel}session`,
  parent_tool_use_id: null,
  user_message_uuid: `${sentinel}send`,
  user_message_uuids: [
    `${sentinel}send`,
    `${sentinel}foreign`,
    `${sentinel}foreign`,
  ],
  unknown: secret,
};

// Reason: provider strings and unrecognized properties must never enter a reviewable fixture.
test("recorder sentinel scan removes hostile content, ids, tool inputs and unknown fields", () => {
  const fixture = recordFixture(
    [
      { type: "assistant", message, ...fields },
      {
        type: "stream_event",
        event: { type: "message_start", message },
        ...fields,
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 3,
          content_block: message.content[2],
        },
        ...fields,
      },
      ...[
        "text_delta",
        "thinking_delta",
        "signature_delta",
        "input_json_delta",
        `${sentinel}delta`,
      ].map((type) => ({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 3,
          delta: {
            type,
            text: secret,
            thinking: secret,
            signature: secret,
            partial_json: secret,
            unknown: secret,
          },
        },
        ...fields,
      })),
      {
        type: "stream_event",
        event: {
          type: "message_delta",
          delta: { stop_reason: "tool_use", unknown: secret },
          usage: message.usage,
          unknown: secret,
        },
        ...fields,
      },
      { type: "user", message: { content: secret }, ...fields },
      {
        type: "system",
        subtype: "init",
        message,
        cwd: secret,
        account: { secret },
        ...fields,
      },
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          secret,
          resetsAt: secret,
        },
        ...fields,
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 3,
        usage: message.usage,
        stop_reason: "end_turn",
        result: secret,
        errors: [secret],
        modelUsage: { [secret]: message.usage },
        ...fields,
      },
      { type: `${sentinel}type`, subtype: secret, unknown: secret },
      { type: "system", subtype: `${sentinel}subtype` },
      { type: "stream_event", event: { type: `${sentinel}event` } },
      {
        type: "assistant",
        message: {
          id: secret,
          model: "claude-sonnet-4-5-20250929",
          stop_reason: secret,
          content: [],
        },
        parent_tool_use_id: `${sentinel}call`,
      },
    ],
    [`${sentinel}send`],
  );
  expect(JSON.stringify(fixture)).not.toContain(sentinel);
  expect(fixture.frames[0]).toEqual({
    type: "assistant",
    uuid: "uuid_1",
    session_id: "session_1",
    parent_tool_use_id: null,
    user_message_uuid: "send_1",
    user_message_uuids: ["send_1", "foreign_1", "foreign_1"],
    message: {
      id: "msg_1",
      model: "other",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 11,
        output_tokens: 9,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
        cache_creation: {
          ephemeral_5m_input_tokens: 1,
          ephemeral_1h_input_tokens: 3,
        },
        output_tokens_details: { thinking_tokens: 2 },
      },
      content: [
        { type: "text", text: "" },
        { type: "thinking", thinking: "", signature: "" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "mcp__neuve__note",
          input: {},
        },
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: "" }],
          is_error: true,
        },
        { type: "other" },
        { type: "tool_use", id: "toolu_2", name: "other", input: {} },
      ],
    },
  });
  expect(fixture.frames[1]?.event).toMatchObject({
    message: fixture.frames[0]?.message,
  });
  expect(fixture.frames[10]).toEqual({
    type: "system",
    subtype: "init",
    uuid: "uuid_1",
    session_id: "session_1",
    user_message_uuid: "send_1",
    user_message_uuids: ["send_1", "foreign_1", "foreign_1"],
  });
  expect(fixture.frames[11]?.rate_limit_info).toEqual({
    status: "allowed_warning",
  });
  expect(Object.keys(fixture.frames[11] ?? {}).sort()).toEqual([
    "rate_limit_info",
    "type",
  ]);
  expect(Object.keys(fixture.frames[12] ?? {}).sort()).toEqual(
    [
      "type",
      "subtype",
      "is_error",
      "num_turns",
      "usage",
      "modelUsage",
      "stop_reason",
      "uuid",
      "session_id",
      "user_message_uuid",
      "user_message_uuids",
    ].sort(),
  );
  expect(fixture.frames[16]).toMatchObject({
    parent_tool_use_id: "toolu_1",
    message: { model: "claude-sonnet-4-5-20250929", stop_reason: "other" },
  });
});

// Reason: an unknown accessor is not read; a consumed accessor aborts the whole recording.
test("recorder ignores unknown throwing getters and fails closed on consumed getters", () => {
  const ignored = {
    type: "system",
    subtype: "status",
    get unknown() {
      throw new Error(secret);
    },
  };
  expect(recordFixture([ignored], []).frames).toEqual([
    { type: "system", subtype: "status" },
  ]);
  for (const frame of [
    {
      get type() {
        throw new Error(secret);
      },
    },
    {
      type: "assistant",
      get message() {
        throw new Error(secret);
      },
    },
    {
      type: "assistant",
      message: {
        get model() {
          throw new Error(secret);
        },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "message_delta",
        usage: {
          get input_tokens() {
            throw new Error(secret);
          },
        },
      },
    },
  ])
    expect(() => recordFixture([ignored, frame], [])).toThrow(
      "Fixture capture failed",
    );
});

// Reason: stamps and native identities must preserve equality without revealing their values.
test("recorder placeholders preserve repeated ids, null parents and send order", () => {
  const frames = ["second", "first", "foreign", "foreign"].map((stamp) => ({
    type: "assistant",
    uuid: "u",
    session_id: "s",
    parent_tool_use_id: "call",
    user_message_uuid: stamp,
    message: {
      id: "m",
      content: [
        { type: "tool_use", id: "call", name: "mcp__neuve__finish", input: {} },
      ],
    },
  }));
  expect(
    recordFixture(frames, ["first", "second"]).frames.map(
      (frame) => frame.user_message_uuid,
    ),
  ).toEqual(["send_2", "send_1", "foreign_1", "foreign_1"]);
  expect(
    recordFixture(frames, []).frames.every(
      (frame) =>
        frame.uuid === "uuid_1" &&
        frame.session_id === "session_1" &&
        frame.parent_tool_use_id === "toolu_1",
    ),
  ).toBe(true);
});

// Reason: invalid combinations must fail before a child or destination file is opened.
test("record flag refuses missing combinations, missing paths, relative roots and duplicates", () => {
  for (const mode of ["--diagnose-tools", "--diagnose-tools-multi-round"])
    expect(
      fixtureFlag([
        mode,
        "--record-fixture-root",
        fakeHome,
        "--record-fixture",
        "fixture.json",
      ]),
    ).toEqual({ root: fakeHome, name: "fixture.json" });
  expect(fixtureFlag(["--diagnose"])).toBeUndefined();
  for (const args of [
    ["--record-fixture", "x"],
    ["--diagnose", "--record-fixture-root", fakeHome, "--record-fixture", "x"],
    ["--diagnose-tools", "--record-fixture"],
    ["--diagnose-tools", "--record-fixture", "/tmp/fixture.json"],
    ["--diagnose-tools", "--record-fixture-root", fakeHome],
    ["--diagnose-tools", "--record-fixture-root", fakeHome, "--record-fixture"],
    [
      "--diagnose-tools",
      "--record-fixture-root",
      "relative",
      "--record-fixture",
      "x",
    ],
    [
      "--diagnose-tools",
      "--record-fixture-root",
      fakeHome,
      "--record-fixture",
      "x",
      "--record-fixture",
      "y",
    ],
    [
      "--diagnose-tools",
      "--record-fixture-root",
      fakeHome,
      "--record-fixture-root",
      fakeHome,
      "--record-fixture",
      "x",
    ],
  ])
    expect(() => fixtureFlag(args)).toThrow();
});

// Reason: plain roots and existing subfolders must permit private, complete fixture files.
test.each(["fixture.json", "nested/fixture.json"])(
  "fixture writer writes %s at 0600",
  async (name) => {
    await mkdir(join(fakeHome, "nested"));
    const target = join(fakeHome, name);
    const fixture = recordFixture([{ type: "system", subtype: "status" }], []);
    await writeFixture({ root: fakeHome, name }, fixture);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(fixture);
  },
);

// Reason: a rejected existing destination must retain its contents and permissions.
test("existing destination refuses fixture writes without changing it", async () => {
  const target = join(fakeHome, "fixture.json");
  await writeFile(target, "kept", { mode: 0o640 });
  await refuses({ root: fakeHome, name: "fixture.json" });
  expect(await readFile(target, "utf8")).toBe("kept");
  expect((await stat(target)).mode & 0o777).toBe(0o640);
  expect(await readdir(fakeHome)).toEqual(["fixture.json"]);
});

// Reason: exclusive creation must let only one writer win when both validate a missing destination.
test("concurrent fixture writes create exactly one complete file", async () => {
  const destination = { root: fakeHome, name: "fixture.json" };
  const fixture = recordFixture([], []);
  const results = await Promise.allSettled([
    writeFixture(destination, fixture),
    writeFixture(destination, fixture),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(
    JSON.parse(await readFile(join(fakeHome, "fixture.json"), "utf8")),
  ).toEqual(fixture);
  expect(await readdir(fakeHome)).toEqual(["fixture.json"]);
});

// Reason: destination links, including dangling links, must survive rejection without touching their target.
test.each(["existing", "dangling"])(
  "%s symlink at destination refuses fixture writes",
  async (kind) => {
    const target = join(fakeHome, "target");
    if (kind === "existing") await writeFile(target, "kept");
    const link = join(fakeHome, "fixture.json");
    await symlink(target, link);
    await refuses({ root: fakeHome, name: "fixture.json" });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    if (kind === "existing")
      expect(await readFile(target, "utf8")).toBe("kept");
    else await expect(lstat(target)).rejects.toHaveProperty("code", "ENOENT");
    expect((await readdir(fakeHome)).sort()).toEqual(
      kind === "existing" ? ["fixture.json", "target"] : ["fixture.json"],
    );
  },
);

// Reason: relative paths must never escape or be normalized into a different accepted destination.
test.each([
  "../outside.json",
  "nested/../outside.json",
  "",
  "nested//fixture.json",
  "nested/",
  ".",
  "./fixture.json",
  "nested/./fixture.json",
  "/absolute.json",
])("invalid relative name %j refuses flags and writing", async (name) => {
  expect(() =>
    fixtureFlag([
      "--diagnose-tools",
      "--record-fixture-root",
      fakeHome,
      "--record-fixture",
      name,
    ]),
  ).toThrow();
  await refuses({ root: fakeHome, name });
  expect(await readdir(fakeHome)).toEqual([]);
});

// Reason: absolute names aimed at a disposable sibling must not bypass the explicit root.
test("absolute destination outside root writes nothing", async () => {
  await mkdir(join(fakeHome, "root"));
  await refuses({
    root: join(fakeHome, "root"),
    name: join(fakeHome, "outside.json"),
  });
  expect(await readdir(fakeHome)).toEqual(["root"]);
  expect(await readdir(join(fakeHome, "root"))).toEqual([]);
});

// Reason: traversal to a disposable sibling must refuse before creating any file outside the root.
test("dotdot destination outside root writes nothing", async () => {
  await mkdir(join(fakeHome, "root"));
  await refuses({ root: join(fakeHome, "root"), name: "../outside.json" });
  expect(await readdir(fakeHome)).toEqual(["root"]);
  expect(await readdir(join(fakeHome, "root"))).toEqual([]);
});

// Reason: the root and every destination parent must already exist as directories.
test.each([
  "relative-root",
  "missing-root",
  "file-root",
  "missing-parent",
  "file-parent",
  "directory-destination",
])("%s refuses fixture writes", async (kind) => {
  await writeFile(join(fakeHome, "file"), "kept");
  await mkdir(join(fakeHome, "directory"));
  const root =
    kind === "relative-root"
      ? "relative"
      : kind === "missing-root"
        ? join(fakeHome, "missing")
        : kind === "file-root"
          ? join(fakeHome, "file")
          : fakeHome;
  const name =
    kind === "missing-parent"
      ? "missing/fixture.json"
      : kind === "file-parent"
        ? "file/fixture.json"
        : kind === "directory-destination"
          ? "directory"
          : "fixture.json";
  await refuses({ root, name });
  expect(await readFile(join(fakeHome, "file"), "utf8")).toBe("kept");
  expect((await readdir(fakeHome)).sort()).toEqual(["directory", "file"]);
  expect(await readdir(join(fakeHome, "directory"))).toEqual([]);
});

// Reason: serialization or capture errors must leave no partial destination.
test("fixture writer leaves no file on capture, serialization or path failure", async () => {
  const destination = { root: fakeHome, name: "fixture.json" };
  const fixture = recordFixture([], []);
  Object.defineProperty(fixture, "frames", {
    get() {
      throw new Error(secret);
    },
  });
  await expect(writeFixture(destination, fixture)).rejects.toThrow();
  await expect(
    writeFixture(
      { root: fakeHome, name: "absent/fixture" },
      recordFixture([], []),
    ),
  ).rejects.toThrow();
  expect(await readdir(fakeHome)).toEqual([]);
});

// Reason: hidden model labels must not leak or lose counters when they share the other bucket.
test("recorder merges unrecognized model counters and drops non-counter ledger fields", () => {
  const fixture = recordFixture(
    [
      {
        type: "result",
        modelUsage: {
          [`${sentinel}first`]: {
            inputTokens: 10,
            outputTokens: 2,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 4,
            thinkingTokens: 1,
            costUSD: 123,
            contextWindow: 200000,
          },
          [`${sentinel}second`]: {
            inputTokens: 20,
            outputTokens: 3,
            cacheReadInputTokens: 5,
            cacheCreationInputTokens: 6,
            cacheCreationEphemeral1hInputTokens: 2,
            private: secret,
          },
        },
      },
    ],
    [],
  );
  expect(fixture.frames[0]?.modelUsage).toEqual({
    other: {
      inputTokens: 30,
      outputTokens: 5,
      cacheReadInputTokens: 8,
      cacheCreationInputTokens: 10,
      cacheCreationEphemeral1hInputTokens: 2,
      thinkingTokens: 1,
    },
  });
  expect(JSON.stringify(fixture)).not.toContain(sentinel);
  expect(JSON.stringify(fixture)).not.toContain("costUSD");
  expect(JSON.stringify(fixture)).not.toContain("contextWindow");
});
