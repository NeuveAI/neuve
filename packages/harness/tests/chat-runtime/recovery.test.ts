import { expect, test } from "bun:test";
import { resumeFailed } from "../../src/chat-runtime/failure.ts";
import { context, fixture, until } from "./fixture.ts";

test("a seed's Stop or reset leaves the idle source open, so imported pointers never confer ownership", async () => {
  for (const kind of ["ace.stopped", "pi.reset"]) {
    const run = await fixture();
    try {
      run.fake.frames.push({ text: "source" });
      await run.submit("first");
      const source = run.fake.opened[0]!.session;
      const seed = await run.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: "subscription", modelId: "sonnet" } },
        },
        context,
      );
      await (
        await seed.submit(
          {
            type: "write",
            entry: { kind: "import", model: await run.messages() },
          },
          context,
        )
      ).wait(context);
      await (
        await seed.submit(
          {
            type: "write",
            entry: {
              kind,
              ...(kind === "pi.reset" ? { head: "self" as const } : {}),
              data: {},
            },
          },
          context,
        )
      ).wait(context);
      expect(source.closed).toBe(0);
      // A seed that has continued owns its fork, and can close only that fork.
      run.fake.frames.push({ text: "fork" });
      await (
        await seed.submit({ type: "input", content: "continue" }, context)
      ).wait(context);
      expect(run.fake.opened[1]?.start).toEqual(
        kind === "pi.reset"
          ? { kind: "new" }
          : { kind: "resume", session: source.id, at: "point-1", fork: true },
      );
      await (
        await seed.submit(
          {
            type: "write",
            entry: {
              kind,
              ...(kind === "pi.reset" ? { head: "self" as const } : {}),
              data: {},
            },
          },
          context,
        )
      ).wait(context);
      await until(() => run.fake.opened[1]!.session.closed === 1);
      expect(source.closed).toBe(0);
      await (
        await run.conversation.submit(
          {
            type: "write",
            entry: {
              kind,
              ...(kind === "pi.reset" ? { head: "self" as const } : {}),
              data: {},
            },
          },
          context,
        )
      ).wait(context);
      await until(() => source.closed === 1);
    } finally {
      await run.close();
    }
  }
});

test("Stop in a seed leaves its source's running tool attached, so the native loop gets the real result", async () => {
  let finishTool = () => {};
  const tool = new Promise<void>((resolve) => {
    finishTool = resolve;
  });
  const run = await fixture({
    execute: async () => {
      await tool;
      return { content: [{ type: "text", text: "completed" }] };
    },
  });
  let work: ReturnType<typeof run.submit> | undefined;
  try {
    run.fake.frames.push(
      {
        calls: [{ callId: "busy-source", toolName: "probe", input: { n: 1 } }],
      },
      { text: "after" },
    );
    work = run.submit("source");
    await until(
      () =>
        run.executed.length === 1 &&
        run.fake.order.includes("handler:busy-source"),
    );
    const source = run.fake.opened[0]!.session;
    const seed = await run.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "subscription", modelId: "sonnet" } },
      },
      context,
    );
    await (
      await seed.submit(
        {
          type: "write",
          entry: { kind: "import", model: await run.messages() },
        },
        context,
      )
    ).wait(context);
    await (
      await seed.submit(
        { type: "write", entry: { kind: "ace.stopped", data: {} } },
        context,
      )
    ).wait(context);
    expect(source.closed).toBe(0);
    expect(run.fake.results).toEqual([]);
    finishTool();
    expect((await work).status).toBe("done");
    expect(run.fake.results).toEqual([
      { id: "busy-source", outcome: { text: "completed" } },
    ]);
    expect(source.closed).toBe(0);
    expect(run.fake.unrecordedRequests).toBe(0);
  } finally {
    finishTool();
    await run.close();
    await work;
  }
});

for (const when of ["already aborted", "while pi runs the tool"]) {
  test(`native call cancellation ${when} closes before another request, so pi can record and re-attach its tool result`, async () => {
    const cancelled = new AbortController();
    if (when === "already aborted") cancelled.abort();
    let finishTool = () => {};
    const tool = new Promise<void>((resolve) => {
      finishTool = resolve;
    });
    let piSignal: AbortSignal | undefined;
    const run = await fixture({
      registry: (registry) => ({
        ...registry,
        openSession: (name, policy, start) =>
          registry.openSession(
            name,
            {
              ...policy,
              tools: policy.tools.map((tool) => ({
                ...tool,
                handle: (input, call) =>
                  tool.handle(
                    input,
                    call ? { ...call, signal: cancelled.signal } : call,
                  ),
              })),
            },
            start,
          ),
      }),
      execute: async (_n, _read, signal) => {
        piSignal = signal;
        await tool;
        return { content: [{ type: "text", text: "completed once" }] };
      },
    });
    let work: ReturnType<typeof run.submit> | undefined;
    try {
      run.fake.frames.push(
        {
          calls: [{ callId: "held", toolName: "probe", input: { n: 1 } }],
          delayHandler: () => until(() => run.executed.length === 1),
        },
        { text: "reattached" },
      );
      work = run.submit("hold");
      await until(
        () =>
          run.executed.length === 1 && run.fake.order.includes("handler:held"),
      );
      cancelled.abort();
      const source = run.fake.opened[0]!.session;
      await until(() => source.closed === 1 && source.jobs.size === 0);
      expect(run.fake.requests).toHaveLength(1);
      expect(run.fake.unrecordedRequests).toBe(0);
      expect(run.fake.results).toEqual([]);
      expect(piSignal?.aborted).toBe(false);
      finishTool();
      expect((await work).status).toBe("done");
      expect(run.executed).toEqual([1]);
      // Ruling 27: no completed turn precedes the original input.
      expect(run.fake.opened[1]?.start).toEqual({ kind: "new" });
      expect(run.fake.requests[1]?.input).toEqual([
        { type: "text", text: "hold" },
        {
          type: "text",
          text: "probe already ran. Do not call it again. Result:\ncompleted once",
        },
      ]);
      expect(
        (await run.messages())
          .filter((message) => message.role === "toolResult")
          .map((message) => message.content),
      ).toEqual([[{ type: "text", text: "completed once" }]]);
      expect(run.fake.requests).toHaveLength(2);
      expect(run.fake.unrecordedRequests).toBe(0);
    } finally {
      finishTool();
      await run.close();
      await work;
    }
  });
}

// Ruling 25(b): without a receipt, repeated partial failures recover fresh without inventing a handoff.
test("partial-only recovery opens fresh, so it never forks at an unmirrored point", async () => {
  const run = await fixture();
  try {
    for (let n = 0; n < 2; n++) {
      run.fake.frames.push({
        beforeMessage: () =>
          run.fake.opened[n]!.session.emit({ type: "text", text: "partial" }),
        failure: {
          _tag: "TurnFailed",
          account: run.statuses.values[0]!.name,
          reason: "provider-failed",
        },
      });
      expect((await run.submit(`try-${n}`)).status).toBe("unanswered");
    }
    run.fake.frames.push({ text: "recovered" });
    expect((await run.submit("again")).status).toBe("done");
    expect(run.fake.opened.map((opened) => opened.start)).toEqual([
      { kind: "new" },
      { kind: "new" },
      { kind: "new" },
    ]);
    expect(JSON.stringify(run.fake.requests)).not.toContain(
      "Previous conversation",
    );
  } finally {
    await run.close();
  }
});

for (const mismatch of ["owner", "digest", "missing head", "resume failure"]) {
  test(`ruling 25(b): a partial-only ${mismatch} opens fresh without a handoff`, async () => {
    const run = await fixture();
    try {
      run.fake.frames.push({
        beforeMessage: () =>
          run.fake.opened[0]!.session.emit({ type: "text", text: "partial" }),
        failure: {
          _tag: "TurnFailed",
          account: run.statuses.values[0]!.name,
          reason: "provider-failed",
        },
      });
      await run.submit("first");
      const head = run.heads.get(String(run.conversation.id))!;
      if (mismatch === "owner")
        await run.heads.restore(String(run.conversation.id), head, undefined);
      if (mismatch === "owner")
        await run.heads.set("another conversation", head);
      if (mismatch === "digest")
        await run.heads.set(String(run.conversation.id), {
          ...head,
          digest: "edited",
        });
      if (mismatch === "missing head")
        await run.heads.restore(String(run.conversation.id), head, undefined);
      if (mismatch === "resume failure")
        run.fake.failOpen = (start) => start.kind === "resume";
      run.fake.frames.push({ text: "fresh answer" });
      expect((await run.submit("again")).status).toBe("done");
      expect(run.fake.opened.at(-1)?.start).toEqual({ kind: "new" });
      expect(run.fake.requests.at(-1)?.input).toEqual([
        { type: "text", text: "first" },
        { type: "text", text: "again" },
      ]);
      expect(run.fake.opened).toHaveLength(2);
      expect(run.fake.requests).toHaveLength(2);
      expect(run.fake.failures).toEqual([]);
    } finally {
      await run.close();
    }
  });
}

test("a failed first open does not hand off, so recovery cannot invent a person's model switch", async () => {
  const run = await fixture();
  try {
    run.fake.failOpen = () => true;
    await run.submit("first");
    run.fake.failOpen = () => false;
    run.fake.frames.push({ text: "recovered" });
    await run.submit("again");
    expect(run.fake.opened[0]?.start).toEqual({ kind: "new" });
    expect(JSON.stringify(run.fake.requests[0]!.input)).not.toContain(
      "Previous conversation",
    );
  } finally {
    await run.close();
  }
});
