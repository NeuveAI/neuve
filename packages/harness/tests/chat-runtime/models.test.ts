import { expect, test } from "bun:test";
import {
  createModels,
  fauxProvider,
  getSupportedThinkingLevels,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
  account,
  context,
  FakeRuntime,
  fixture,
  testModels,
  until,
} from "./fixture.ts";
import { Account, type SessionPolicy } from "@neuve/runtime";

// Status order, names and absent lists must survive without invented model choices.
test("models follow status rows in order, and an absent list offers none", async () => {
  const run = await fixture();
  try {
    expect(
      run.models
        .getModels("subscription")
        .map(({ id, name }) => ({ id, name })),
    ).toEqual([
      { id: "sonnet", name: "Sonnet default" },
      { id: "real", name: "Real" },
    ]);
    expect(run.models.getModel("subscription", "default")).toBeUndefined();
    run.statuses.set([
      { ...run.statuses.values[0]!, models: [...testModels].reverse() },
    ]);
    await until(() => run.models.getModels("subscription")[0]?.id === "real");
    expect(run.models.getModels("subscription").map(({ id }) => id)).toEqual([
      "real",
      "sonnet",
    ]);
    const { models: _models, ...status } = run.statuses.values[0]!;
    run.statuses.set([status]);
    expect(run.models.getModel("subscription", "sonnet")).toBeUndefined();
    await until(() => run.models.getModels("subscription").length === 0);
    expect(await run.models.getAvailable("subscription")).toEqual([]);
  } finally {
    await run.close();
  }
});

// A pinned id keeps the person's selection while borrowing the alias row's metadata.
test("pinned ids resolve the alias for getModel and streaming without replacing the pin", async () => {
  const run = await fixture();
  try {
    const pinned = run.models.getModel("subscription", "claude-sonnet-test")!;
    expect(pinned.id).toBe("claude-sonnet-test");
    expect(pinned.name).toBe("Sonnet default");
    expect(getSupportedThinkingLevels(pinned)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      run.models.getModelOfType("chat", "subscription", pinned.id),
    ).toEqual(pinned);
    await run.conversation.configure(
      {
        model: { provider: "subscription", modelId: pinned.id },
        thinkingLevel: "max",
      },
      context,
    );
    run.fake.frames.push({ text: "pinned" });
    expect((await run.submit("hello")).status).toBe("done");
    expect(run.fake.opened[0]?.policy.model).toEqual({
      id: "claude-sonnet-test",
      effort: "max",
    });
    expect((await run.messages()).at(-1)).toMatchObject({
      model: "claude-sonnet-test",
    });

    // A stream must resolve the row even if its caller holds outdated model metadata.
    run.fake.frames.push({ text: "fresh metadata" });
    const reply = await run.models
      .streamSimple(
        { ...pinned, reasoning: false },
        { messages: [{ role: "user", content: "another chat", timestamp: 1 }] },
        { reasoning: "xhigh" },
      )
      .result();
    expect(reply.stopReason).toBe("stop");
    expect(run.fake.opened.at(-1)?.policy.model).toEqual({
      id: "claude-sonnet-test",
      effort: "xhigh",
    });
  } finally {
    await run.close();
  }
});

const efforts: {
  level: ModelThinkingLevel;
  expected?: NonNullable<SessionPolicy["model"]>["effort"];
}[] = [
  { level: "minimal", expected: "low" },
  { level: "off" },
  { level: "low", expected: "low" },
  { level: "medium", expected: "medium" },
  { level: "high", expected: "high" },
  { level: "xhigh", expected: "xhigh" },
  { level: "max", expected: "max" },
];
for (const { level, expected } of efforts) {
  // Exercise open and setModel through Harness so both contract entry points agree.
  test(`thinking ${level} sends ${expected ?? "no effort"} at open and setModel`, async () => {
    const run = await fixture();
    try {
      await run.conversation.configure({ thinkingLevel: level }, context);
      run.fake.frames.push({ text: "first" });
      expect((await run.submit("first")).status).toBe("done");
      const selected =
        expected === undefined
          ? { id: "sonnet" }
          : { id: "sonnet", effort: expected };
      expect(run.fake.opened[0]?.policy.model).toEqual(selected);
      await run.conversation.configure(
        { model: { provider: "subscription", modelId: "claude-sonnet-test" } },
        context,
      );
      run.fake.frames.push({ text: "second" });
      expect((await run.submit("second")).status).toBe("done");
      expect(run.fake.opened).toHaveLength(1);
      expect(run.fake.opened[0]?.session.models).toEqual([
        { ...selected, id: "claude-sonnet-test" },
      ]);
      expect(run.fake.unrecordedRequests).toBe(0);
    } finally {
      await run.close();
    }
  });
}

// Unsupported settings must not silently select another effort.
for (const { label, supportsEffort, supportedEffortLevels } of [
  {
    label: "false",
    supportsEffort: false,
    supportedEffortLevels: ["low", "high"] as const,
  },
  {
    label: "true",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"] as const,
  },
  { label: "missing support", supportedEffortLevels: ["low", "high"] as const },
  { label: "true with missing levels", supportsEffort: true },
]) {
  test(`effort support ${label} sends nothing for unavailable settings at open and setModel`, async () => {
    const run = await fixture({
      statusModels: [
        {
          id: "sonnet",
          resolvedModel: "claude-sonnet-test",
          displayName: "Limited",
          description: "Model with limited efforts",
          ...(supportsEffort === undefined ? {} : { supportsEffort }),
          ...(supportedEffortLevels === undefined
            ? {}
            : { supportedEffortLevels: [...supportedEffortLevels] }),
        },
      ],
    });
    try {
      const model = run.models.getModel("subscription", "sonnet")!;
      expect(model.reasoning).toBe(supportsEffort === true);
      expect(getSupportedThinkingLevels(model)).toEqual(
        supportsEffort ? [...(supportedEffortLevels ?? [])] : ["off"],
      );
      await run.conversation.configure(
        { thinkingLevel: supportsEffort ? "max" : "low" },
        context,
      );
      run.fake.frames.push({ text: "first" });
      expect((await run.submit("first")).status).toBe("done");
      expect(run.fake.opened[0]?.policy.model).toEqual({ id: "sonnet" });
      await run.conversation.configure(
        {
          model: { provider: "subscription", modelId: "claude-sonnet-test" },
          thinkingLevel: supportsEffort ? "medium" : "low",
        },
        context,
      );
      run.fake.frames.push({ text: "second" });
      expect((await run.submit("second")).status).toBe("done");
      expect(run.fake.opened[0]?.session.models).toEqual([
        { id: "claude-sonnet-test" },
      ]);
    } finally {
      await run.close();
    }
  });
}

test("account model rows have route limits before the first turn", async () => {
  const fake = new FakeRuntime();
  const codex = Account.parse({
    name: "codex",
    kind: "chatgpt-subscription",
    runtime: "codex",
    credential: { kind: "codex-home" },
  });
  const run = await fixture({
    fake,
    accounts: [account("claude"), codex],
    runtimes: [
      {
        ...fake.shape,
        kind: "codex",
        continuation: ({ name }) => ({ runtime: "codex", key: name }),
      },
    ],
    statusModels: [],
  });
  try {
    const rows = (ids: string[]) =>
      ids.map((id) => ({ id, displayName: id, description: "" }));
    const [claudeStatus, codexStatus] = run.statuses.values;
    run.statuses.set([
      {
        ...claudeStatus!,
        models: [
          { ...testModels[0]!, resolvedModel: "claude-sonnet-5-5" },
          ...rows(["claude-fable-5-2", "claude-haiku-5-5", "unlisted"]),
        ],
      },
      {
        ...codexStatus!,
        models: rows([
          "gpt-6-sol",
          "gpt-6.1-sol",
          "gpt-6.2-sol",
          "gpt-6.2-astra",
          "gpt-6.1-terra",
        ]),
      },
    ]);
    await until(() => run.models.getModels("codex").length === 5);

    const limits = (account: string) =>
      run.models
        .getModels(account)
        .map(({ id, contextWindow, maxTokens }) => [
          id,
          contextWindow,
          maxTokens,
        ]);
    expect(limits("claude")).toEqual([
      ["sonnet", 1_000_000, 128_000],
      ["claude-fable-5-2", 1_000_000, 128_000],
      ["claude-haiku-5-5", 1_000_000, 128_000],
      ["unlisted", 64_000, 8_192],
    ]);
    expect(limits("codex")).toEqual([
      ["gpt-6-sol", 272_000, 128_000],
      // Codex's bundled window wins over pi-ai's 272,000-token entry.
      ["gpt-6.1-sol", 475_000, 128_000],
      ["gpt-6.2-sol", 475_000, 8_192],
      ["gpt-6.2-astra", 258_400, 8_192],
      ["gpt-6.1-terra", 475_000, 8_192],
    ]);
    expect(run.models.getModel("claude", "unlisted")?.contextWindow).toBe(
      64_000,
    );
    expect(
      fake.logs.filter(
        ({ event, fields }) =>
          event === "model-limits.default" && fields.account === "claude",
      ),
    ).toEqual([
      {
        event: "model-limits.default",
        fields: {
          account: "claude",
          model: "unlisted",
          contextWindow: 64_000,
          maxTokens: 8_192,
        },
      },
    ]);
    expect(fake.opened).toHaveLength(0);
  } finally {
    await run.close();
  }
});

// A runtime report wins even when the account's list is newer than the bundled catalogue.
test("catalog limits seed each model, turn usage updates alias and pin only on that account", async () => {
  const native = createModels();
  native.setProvider(
    fauxProvider({
      provider: "openai",
      models: [{ id: "real", contextWindow: 2_000_000, maxTokens: 128_000 }],
    }).provider,
  );
  native.setProvider(
    fauxProvider({
      provider: "anthropic",
      models: [
        { id: "claude-sonnet-test", contextWindow: 900_000, maxTokens: 64_000 },
        { id: "sonnet", contextWindow: 100_000, maxTokens: 10_000 },
        { id: "uncatalogued-real", contextWindow: 300_000, maxTokens: 16_000 },
      ],
    }).provider,
  );
  const run = await fixture({
    native,
    accounts: [account("subscription"), account("other")],
    statusModels: [
      { ...testModels[0]!, contextWindow: 880_000 },
      { ...testModels[1]!, resolvedModel: "uncatalogued-real" },
    ],
  });
  const limits = (provider: string, id: string) => {
    const model = run.models.getModel(provider, id)!;
    return [model.contextWindow, model.maxTokens];
  };
  try {
    expect(limits("subscription", "sonnet")).toEqual([880_000, 64_000]);
    expect(limits("subscription", "claude-sonnet-test")).toEqual([
      880_000, 64_000,
    ]);
    expect(limits("subscription", "real")).toEqual([300_000, 16_000]);
    run.fake.frames.push({
      text: "usage",
      modelUsage: {
        model: "claude-sonnet-test",
        contextWindow: 800_000,
        maxOutputTokens: 48_000,
      },
    });
    expect((await run.submit("first")).status).toBe("done");
    expect(limits("subscription", "sonnet")).toEqual([800_000, 48_000]);
    expect(limits("subscription", "claude-sonnet-test")).toEqual([
      800_000, 48_000,
    ]);
    expect(limits("other", "sonnet")).toEqual([880_000, 64_000]);
    expect(limits("subscription", "real")).toEqual([300_000, 16_000]);
    expect(
      native.getModel("anthropic", "claude-sonnet-test")?.contextWindow,
    ).toBe(900_000);
    // Aliased usage shares the resolved key, too.
    run.fake.frames.push({
      text: "alias usage",
      modelUsage: {
        model: "sonnet",
        contextWindow: 700_000,
        maxOutputTokens: 40_000,
      },
    });
    expect((await run.submit("second")).status).toBe("done");
    expect(limits("subscription", "claude-sonnet-test")).toEqual([
      700_000, 40_000,
    ]);
    run.statuses.set([...run.statuses.values]);
    await until(
      () => run.models.getModels("subscription")[0]?.contextWindow === 700_000,
    );
    expect(limits("subscription", "sonnet")).toEqual([700_000, 40_000]);
    await run.bridge.closeAccount(account().name);
    expect(limits("subscription", "sonnet")).toEqual([700_000, 40_000]);
  } finally {
    await run.close();
  }
  const restarted = await fixture({ native });
  try {
    expect(
      restarted.models.getModel("subscription", "sonnet")?.contextWindow,
    ).toBe(900_000);
  } finally {
    await restarted.close();
  }
});

// A turn can report either limit independently. Request usage does not change either limit.
test("missing, partial and request usage limits keep the row or fallback, and a window alone counts", async () => {
  const run = await fixture();
  try {
    for (const [modelUsage, expected] of [
      [{ model: "sonnet" }, [64_000, 8_192]],
      [{ model: "sonnet", maxOutputTokens: 48_000 }, [64_000, 48_000]],
      [
        {
          model: "sonnet",
          scope: "request" as const,
          contextWindow: 500_000,
          maxOutputTokens: 50_000,
        },
        [64_000, 48_000],
      ],
      [{ model: "sonnet", contextWindow: 500_000 }, [500_000, 48_000]],
    ] as const) {
      run.fake.frames.push({ text: "answer", modelUsage });
      expect((await run.submit("next")).status).toBe("done");
      const model = run.models.getModel("subscription", "sonnet")!;
      expect([model.contextWindow, model.maxTokens]).toEqual([...expected]);
    }
  } finally {
    await run.close();
  }
});
