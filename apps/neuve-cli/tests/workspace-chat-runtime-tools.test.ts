import { mkdir, mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Socket } from "node:net";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  fixture,
  context,
  until,
} from "../../../packages/harness/tests/chat-runtime/fixture.ts";
import { CapturedStorage } from "../../../packages/harness/tests/chat-runtime/captured-storage.ts";
import { expect, test } from "bun:test";
import { Channel } from "@ace/channel";
import { unavailablePlanning } from "@ace/channel/planning";
import { channelOperations } from "@ace/channel/operations";
import {
  MemoryStorage,
  type ToolRegistration,
  type EntryRecord,
  ROOT_CONVERSATION_ID,
  type Harness,
} from "@earendil-works/pi-durable";
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import { Effect } from "effect";
import {
  definitions,
  STOP_ENTRY_KIND,
  RECOVERY_ALLOW_TOOLS,
  chatRuntimeExtension,
} from "@neuve/harness/chat-runtime";

test("8: every channel tool description fits the upfront limit and pi owns validation, so tools cannot bypass the record", async () => {
  const tools: ToolRegistration[] = [];
  const committed: EntryRecord[] = [];
  const started = Promise.withResolvers<void>();
  const response =
    Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>();
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "coder", contextWindow: 200_000 }],
  });
  faux.setResponses([
    (_context, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error("The test stream needs an abort signal");
      const finish = () => response.resolve(fauxAssistantMessage("Stopped"));
      if (signal.aborted) finish();
      else signal.addEventListener("abort", finish, { once: true });
      started.resolve();
      return response.promise;
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  let unsubscribe: (() => void) | undefined;
  const operations = channelOperations({
    planning: async () => unavailablePlanning(),
  });
  const disabled = async () => ({ text: "Disabled" });
  const channel = await Channel.open({
    id: "chat-runtime-tools",
    name: "tools",
    owner: "test",
    project: tmpdir(),
    models,
    storage: new MemoryStorage(),
    env: () => {
      throw new Error("No execution in description test");
    },
    directory: {
      self: { id: "chat-runtime-tools", name: "tools" },
      list: async () => [],
      deliver: async () => {},
    },
    desktop: disabled,
    browser: disabled,
    images: async () => ({
      text: "Disabled",
      image: { mimeType: "image/png", data: "AA==" },
    }),
    tabs: {
      list: async () => [],
      rename: async () => ({ id: "none", tabs: [] }),
      live: async () => ({ id: "none", tabs: [] }),
    },
    log: () => {},
    extension: {
      ...operations.extension,
      attach: async (harness, admission) => {
        await operations.extension.attach?.(harness, admission);
        unsubscribe = harness.subscribeCommits(({ changes }) => {
          for (const change of changes)
            if (change.type === "entry") committed.push(change.value);
        });
      },
      tool: (tool) => {
        tools.push(tool);
        return tool;
      },
    },
  });
  try {
    // Reason: Keep the recovery allowlist tied to the channel tools, including absent file tools.
    expect(RECOVERY_ALLOW_TOOLS).toEqual([
      "question",
      "read",
      "ls",
      "grep",
      "find",
    ]);
    expect(
      tools
        .filter((tool) => RECOVERY_ALLOW_TOOLS.includes(tool.name))
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["question", "read"]);
    expect(
      RECOVERY_ALLOW_TOOLS.filter(
        (name) => !tools.some((tool) => tool.name === name),
      ),
    ).toEqual(["ls", "grep", "find"]);
    expect(tools.length).toBeGreaterThan(20);
    for (const tool of tools)
      expect(tool.description.length).toBeLessThanOrEqual(4096);
    const served = definitions(tools, () => Effect.succeed({ text: "ok" }));
    expect(served.map((tool) => tool.name)).toEqual(
      tools.map((tool) => tool.name),
    );
    for (const tool of served) {
      expect(tool.strict).toBe(false);
      expect(tool.input).toBeUndefined();
    }
    await channel.handle(
      {
        op: "ask",
        author: "test",
        text: "Wait for Stop",
        model: { provider: "faux", modelId: "coder" },
      },
      () => {},
    );
    await started.promise;
    expect(channel.busy).toBe(true);
    committed.length = 0;
    await channel.handle({ op: "stop", author: "test" }, () => {});
    expect(committed).toContainEqual(
      expect.objectContaining({
        kind: STOP_ENTRY_KIND,
        data: expect.objectContaining({ author: "test" }),
      }),
    );
    expect(channel.busy).toBe(false);
    // The contract exposes no MCP metadata. maxResultSizeChars is the runtime track's server responsibility.
  } finally {
    response.resolve(fauxAssistantMessage("Test cleanup"));
    try {
      await channel.close();
    } finally {
      unsubscribe?.();
    }
  }
});

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
// Reason: A recovered production bash must neither invoke ace ask nor spend native usage; its abort error must reach the next requested turn.
for (const phase of ["call", "execute"] as const)
  test(`recovered production bash cannot invoke ace ask in ${phase}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "chat-runtime-15-"));
    const repo = fileURLToPath(new URL("../../../", import.meta.url)).replace(
      /\/$/,
      "",
    );
    await mkdir(root + "/channels/t", { recursive: true });
    await mkdir(root + "-lanes", { recursive: true });
    await mkdir(root + "/bin", { recursive: true });
    await writeFile(
      root + "/bin/tailscale",
      '#!/bin/sh\necho \'{"BackendState":"Stopped"}\'\n',
    );
    await chmod(root + "/bin/tailscale", 0o755);
    await writeFile(
      root + "/channels/t/channel.json",
      JSON.stringify({
        version: 2,
        id: "t",
        name: "t",
        prefix: "t",
        named: true,
        local: true,
        owner: "person",
        project: root,
        created: 0,
      }),
    );
    const preload = root + "/configured.ts";
    await writeFile(
      preload,
      `import {configure,bindConfiguredCatalog} from ${JSON.stringify(repo + "/apps/neuve-host/src/host-config.ts")}; configure({home:${JSON.stringify(root)},lanes:${JSON.stringify(root + "-lanes")},user:'person',port:0,environment:{PATH:process.env.PATH,HOME:${JSON.stringify(root)},TMPDIR:process.env.TMPDIR},worker:[process.execPath,'--version']}); await bindConfiguredCatalog();`,
    );
    const cli = [
      "/usr/bin/env",
      "PATH=" + root + "/bin:" + process.env.PATH,
      process.execPath,
      "--no-env-file",
      "--preload",
      repo + "/apps/neuve-host/tests/fixtures/memory-secrets.ts",
      "--preload",
      preload,
      repo + "/apps/neuve-host/src/cli.ts",
      "ask",
      "t",
      "--chat",
      "1",
      "--detach",
      "automatic replay",
    ]
      .map(quote)
      .join(" ");
    const command = `if [ -e ${quote(root + "/release")} ]; then exec ${cli}; else exec ${quote(process.execPath)} -e 'await Bun.sleep(100000000)'; fi`;
    const storage = new CapturedStorage();
    let runtime = await fixture();
    let ext = chatRuntimeExtension(runtime.bridge, (p) => p === "subscription");
    let harness: Harness | undefined;
    let channel: Awaited<ReturnType<typeof Channel.open>> | undefined;
    const sockets = new Set<Socket>();
    let routed = 0;
    const authors: string[] = [];
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        let nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          void (async () => {
            const { id, ...request } = JSON.parse(line);
            routed++;
            authors.push(request.author);
            try {
              const value = await channel!.handle(request, () => {});
              socket.write(JSON.stringify({ id, ok: true, value }) + "\n");
            } catch (error) {
              socket.write(
                JSON.stringify({ id, ok: false, error: String(error) }) + "\n",
              );
            }
          })();
        }
      });
    });
    const open = async (store: MemoryStorage) => {
      const rt = runtime,
        ex = ext;
      return Channel.open({
        id: "t",
        name: "t",
        owner: "person",
        project: root,
        model: { provider: "subscription", modelId: "sonnet" },
        storage: store,
        models: rt.models,
        resume: false,
        env: (cwd) => new NodeExecutionEnv({ cwd }),
        directory: {
          self: { id: "t", name: "t" },
          list: async () => [],
          deliver: async () => {},
        },
        log: () => {},
        extension: {
          extensions: ex.extensions,
          nonTurnModels: () => rt.native,
          attach: async (h) => {
            harness = h;
            await ex.attach(h);
          },
        },
      });
    };
    try {
      channel = await open(storage);
      runtime.fake.frames.push({
        calls: [{ callId: "cli-ask", toolName: "bash", input: { command } }],
      });
      await channel.handle(
        { op: "ask", author: "person", text: "do the shell operation" },
        () => {},
      );
      await until(() =>
        storage.commits.some((writes) =>
          writes.some(
            (w) =>
              w.type === "task" &&
              w.value.kind === "pi.tool" &&
              w.value.state.status === "running" &&
              typeof w.value.state.checkpoint === "object" &&
              w.value.state.checkpoint !== null &&
              !Array.isArray(w.value.state.checkpoint) &&
              w.value.state.checkpoint.phase === "execute",
          ),
        ),
      );
      const cut = storage.commits.findIndex((writes) =>
        writes.some(
          (w) =>
            w.type === "task" &&
            w.value.kind === "pi.tool" &&
            w.value.state.status === "running" &&
            typeof w.value.state.checkpoint === "object" &&
            w.value.state.checkpoint !== null &&
            !Array.isArray(w.value.state.checkpoint) &&
            w.value.state.checkpoint.phase === "execute",
        ),
      );
      const copy = new MemoryStorage();
      for (const writes of storage.commits.slice(
        0,
        cut + (phase === "execute" ? 1 : 0),
      ))
        await copy.commit(writes, context);
      await channel.close();
      channel = undefined;
      await ext.close();
      await runtime.close();
      runtime = await fixture();
      ext = chatRuntimeExtension(runtime.bridge, (p) => p === "subscription");
      channel = await open(copy);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(root + "/channels/t/channel.sock", resolve);
      });
      await writeFile(root + "/release", "yes");
      runtime.fake.frames.push({ text: "requested answer" });
      expect(runtime.fake.requests).toHaveLength(0);
      await harness!.resume();
      await harness!.waitForIdle(context);
      expect(routed).toBe(0);
      expect(authors).toEqual([]);
      expect(runtime.fake.opened).toHaveLength(0);
      expect(runtime.fake.requests).toHaveLength(0);
      const conversation = await harness!.conversation(
        ROOT_CONVERSATION_ID,
        context,
      );
      expect(conversation).toBeDefined();
      const results = (await conversation!.context(context)).messages.filter(
        (message) => message.role === "toolResult",
      );
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ toolName: "bash", isError: true });
      expect(JSON.stringify(results[0])).toContain("Tool bash was aborted");
      await channel.handle(
        { op: "ask", author: "person", text: "go on" },
        () => {},
      );
      await harness!.waitForIdle(context);
      expect(runtime.fake.requests).toHaveLength(1);
      const sent = JSON.stringify(runtime.fake.requests[0]?.input);
      expect(sent).toContain("The bash call returned an error:");
      expect(sent).toContain("Tool bash was aborted");
      expect(sent).toContain("go on");
      expect(routed).toBe(0);
    } finally {
      for (const s of sockets) s.destroy();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await channel?.close();
      await ext.close();
      await runtime.close();
      await rm(root, { recursive: true, force: true });
      await rm(root + "-lanes", { recursive: true, force: true });
    }
  }, 20000);
