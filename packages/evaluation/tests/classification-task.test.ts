import { expect, test } from "bun:test";
import {
  ClassificationError,
  admitClassificationOutput,
  classificationOutputJsonSchema,
  decodeClassificationTask,
} from "../src/review-quality/classification-task.ts";
import { contextDigest } from "../src/review-quality/context-slice.ts";

export const classificationFixture = (
  task:
    | "hunk-source-attribution"
    | "consequence-and-support" = "consequence-and-support",
  path = "main/source",
) => ({
  schemaVersion: 1,
  taskVersion: "finite-1",
  policyVersion: "experimental-policy-1",
  rubricVersion: "independent-rubric-1",
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  targetId: "target-1",
  mode: "development",
  task,
  facts: {
    members: [
      {
        kind: "text",
        memberId: "old-1",
        hunkId: "h1",
        path,
        side: "old",
        line: 10,
        blobId: "c".repeat(40),
        exactText: "queue(item);",
      },
      {
        kind: "text",
        memberId: "new-1",
        hunkId: "h1",
        path,
        side: "new",
        line: 10,
        blobId: "d".repeat(40),
        exactText: "queue(item.release());",
      },
      {
        kind: "nontext",
        memberId: "binary-1",
        hunkId: "h2",
        path: "asset/image",
        old: { blobId: "e".repeat(40), mode: "100644" },
        new: { blobId: "f".repeat(40), mode: "100644" },
        retainedIdentity: "whole-binary-change",
      },
    ],
    sources: [
      {
        sourceId: "support",
        ref: {
          kind: "committed-source",
          revision: "b".repeat(40),
          blobId: "1".repeat(40),
          path: "ownership/source",
          side: "new",
          range: { start: 1, end: 1 },
        },
        content: {
          kind: "available",
          exactText: "release() transfers ownership;",
          bytesSha256: contextDigest("release() transfers ownership;"),
        },
        relation: "ownership",
        trust: "untrusted-source-content",
        limitations: [],
      },
      {
        sourceId: "contrary",
        ref: {
          kind: "committed-source",
          revision: "a".repeat(40),
          blobId: "2".repeat(40),
          path: "ownership/source",
          side: "old",
          range: { start: 1, end: 1 },
        },
        content: {
          kind: "available",
          exactText: "queue() retains ownership;",
          bytesSha256: contextDigest("queue() retains ownership;"),
        },
        relation: "ownership",
        trust: "untrusted-source-content",
        limitations: [],
      },
    ],
    limitations: [
      "Synthetic literal control; no repository behavior or independent truth is established.",
    ],
  },
  candidates:
    task === "hunk-source-attribution"
      ? {
          pairs: [
            { hunkId: "h1", sourceId: "support" },
            { hunkId: "h2", sourceId: "contrary" },
          ],
        }
      : {
          claims: [
            {
              claimId: "transfer",
              claim: "The new call transfers ownership.",
              operation: "queue",
              obligation: "Investigate ownership transfer",
              hunkIds: ["h1"],
              supportIds: ["support"],
              contraryIds: ["contrary"],
              verificationIds: [],
            },
          ],
          questions: [
            {
              questionId: "investigate-missing-candidates",
              question:
                "Investigate consequences omitted from supplied candidates.",
            },
          ],
        },
});
const consequence = (
  status: "supported" | "contradicted" | "unresolved" = "supported",
  supportIds: string[] = ["support"],
  contraryIds: string[] = [],
) =>
  ({
    task: "consequence-and-support",
    candidateCoverage: { kind: "evaluated-supplied-candidates" },
    judgments: [
      {
        claimId: "transfer",
        status,
        supportIds,
        contraryIds,
        verification: "unavailable",
      },
    ],
  }) satisfies ReturnType<typeof admitClassificationOutput>["output"];
const attribution = () =>
  ({
    task: "hunk-source-attribution",
    judgments: [
      { hunkId: "h1", sourceId: "support", relevance: "material" },
      { hunkId: "h2", sourceId: "contrary", relevance: "irrelevant" },
    ],
  }) satisfies ReturnType<typeof admitClassificationOutput>["output"];

test("frozen input keeps old/new text and whole nontext identity without caller mutation", () => {
  const raw = classificationFixture();
  const task = decodeClassificationTask(raw);
  raw.facts.members[0]!.exactText = "caller mutation";
  expect(task.facts.members[0]).toEqual({
    kind: "text",
    memberId: "old-1",
    hunkId: "h1",
    path: "main/source",
    side: "old",
    line: 10,
    blobId: "c".repeat(40),
    exactText: "queue(item);",
  });
  expect(task.facts.members[2]).toEqual({
    kind: "nontext",
    memberId: "binary-1",
    hunkId: "h2",
    path: "asset/image",
    old: { blobId: "e".repeat(40), mode: "100644" },
    new: { blobId: "f".repeat(40), mode: "100644" },
    retainedIdentity: "whole-binary-change",
  });
  expect(Object.isFrozen(task.facts.members)).toBe(true);
  expect(() =>
    decodeClassificationTask({ ...classificationFixture(), gold: "supported" }),
  ).toThrow(ClassificationError);
});
test("duplicate members and foreign candidate sources are rejected", () => {
  const raw = classificationFixture();
  expect(() =>
    decodeClassificationTask({
      ...raw,
      facts: {
        ...raw.facts,
        members: [raw.facts.members[0], raw.facts.members[0]],
      },
    }),
  ).toThrow(ClassificationError);
  expect(() =>
    decodeClassificationTask({
      ...raw,
      candidates: {
        claims: [
          {
            claimId: "x",
            claim: "x",
            operation: "x",
            obligation: "x",
            hunkIds: ["h1"],
            supportIds: ["foreign"],
            contraryIds: [],
            verificationIds: [],
          },
        ],
        questions: [{ questionId: "q", question: "Investigate" }],
      },
    }),
  ).toThrow(ClassificationError);
});
test("attribution demands exactly the requested tuples rather than the Cartesian set", () => {
  const task = decodeClassificationTask(
    classificationFixture("hunk-source-attribution"),
  );
  expect(admitClassificationOutput(task, attribution()).output).toEqual(
    attribution(),
  );
  for (const judgments of [
    [],
    [attribution().judgments[0], attribution().judgments[0]],
    [
      { hunkId: "h1", sourceId: "contrary", relevance: "material" },
      { hunkId: "h2", sourceId: "support", relevance: "irrelevant" },
    ],
    [
      ...attribution().judgments,
      { hunkId: "h3", sourceId: "support", relevance: "material" },
    ],
  ])
    expect(() =>
      admitClassificationOutput(task, {
        task: "hunk-source-attribution",
        judgments,
      }),
    ).toThrow(ClassificationError);
});
test("consequence admission preserves declared contrary evidence without asserting independent support", () => {
  const task = decodeClassificationTask(classificationFixture());
  const result = admitClassificationOutput(
    task,
    consequence("supported", ["support"], ["contrary"]),
  );
  expect(result.kind).toBe("structurally-admitted");
  expect(result.semanticSupport).toBe("not-established");
  expect(result.output).toEqual(
    consequence("supported", ["support"], ["contrary"]),
  );
  expect(
    admitClassificationOutput(
      task,
      consequence("contradicted", [], ["contrary"]),
    ).output,
  ).toEqual(consequence("contradicted", [], ["contrary"]));
});
test("output excludes duplicate/foreign/missing claims, invented support and authority/prose fields", () => {
  const task = decodeClassificationTask(classificationFixture());
  for (const output of [
    { ...consequence(), judgments: [] },
    {
      ...consequence(),
      judgments: [...consequence().judgments, ...consequence().judgments],
    },
    {
      ...consequence(),
      judgments: [{ ...consequence().judgments[0], claimId: "foreign" }],
    },
    consequence("supported", []),
    consequence("supported", ["contrary"]),
    consequence("supported", ["support", "support"]),
    consequence("contradicted", [], []),
    { ...consequence(), approval: true },
    {
      ...consequence(),
      judgments: [
        {
          ...consequence().judgments[0],
          path: "invented",
          range: { start: 1, end: 2 },
          explanation: "fluent prose",
        },
      ],
    },
  ])
    expect(() => admitClassificationOutput(task, output)).toThrow(
      ClassificationError,
    );
  expect(() => admitClassificationOutput(task, attribution())).toThrow(
    ClassificationError,
  );
});
test("unavailable/conflicting bytes allow unresolved uncertainty but cannot count as support", () => {
  for (const kind of ["missing", "unavailable", "conflicting"]) {
    const raw = classificationFixture();
    const task = decodeClassificationTask({
      ...raw,
      facts: {
        ...raw.facts,
        sources: raw.facts.sources.map((source) => ({
          ...source,
          content: { kind, detail: "No usable bytes" },
        })),
      },
    });
    expect(
      admitClassificationOutput(task, consequence("unresolved", [], [])).output,
    ).toEqual(consequence("unresolved", [], []));
    expect(() => admitClassificationOutput(task, consequence())).toThrow(
      ClassificationError,
    );
    expect(() =>
      admitClassificationOutput(
        task,
        consequence("contradicted", [], ["contrary"]),
      ),
    ).toThrow(ClassificationError);
  }
});
test("partial sources preserve captured ranges and cannot imply complete verification", () => {
  const raw = classificationFixture();
  const task = decodeClassificationTask({
    ...raw,
    facts: {
      ...raw.facts,
      sources: raw.facts.sources.map((source) => ({
        ...source,
        ref: { ...source.ref, range: { start: 1, end: 2 } },
        content: {
          ...source.content,
          kind: "partial",
          capturedRange: { start: 1, end: 1 },
          detail: "Only first line captured",
        },
      })),
    },
    candidates: {
      claims: [
        {
          claimId: "transfer",
          claim: "Transfer",
          operation: "queue",
          obligation: "Check",
          hunkIds: ["h1"],
          supportIds: ["support"],
          contraryIds: ["contrary"],
          verificationIds: ["support"],
        },
      ],
      questions: [{ questionId: "q", question: "Investigate" }],
    },
  });
  expect(admitClassificationOutput(task, consequence()).kind).toBe(
    "structurally-admitted",
  );
  expect(() =>
    admitClassificationOutput(task, {
      ...consequence(),
      judgments: [
        {
          ...consequence().judgments[0],
          verification: "covered-for-obligation",
        },
      ],
    }),
  ).toThrow(ClassificationError);
});
test("missing necessary candidate leaves source bytes fixed and retains an insufficiency route", () => {
  const raw = classificationFixture();
  const task = decodeClassificationTask({
    ...raw,
    candidates: {
      claims: [],
      questions: [
        {
          questionId: "investigate-missing-candidates",
          question:
            "Investigate consequences omitted from supplied candidates.",
        },
      ],
    },
  });
  expect(task.facts).toEqual(decodeClassificationTask(raw).facts);
  const output = {
    task: "consequence-and-support",
    candidateCoverage: {
      kind: "candidate-set-insufficient",
      nextQuestionId: "investigate-missing-candidates",
    },
    judgments: [],
  } satisfies ReturnType<typeof admitClassificationOutput>["output"];
  expect(admitClassificationOutput(task, output).output).toEqual(output);
  expect(() =>
    admitClassificationOutput(task, {
      ...output,
      candidateCoverage: {
        kind: "candidate-set-insufficient",
        nextQuestionId: "invented",
      },
    }),
  ).toThrow(ClassificationError);
  expect(JSON.stringify(classificationOutputJsonSchema(task))).toContain(
    "candidate-set-insufficient",
  );
});
test("equivalent source bytes receive the same behavior across filename suffixes", () => {
  for (const path of [
    "main/change.ts",
    "main/change.go",
    "main/change.unknown",
    "main/change",
  ])
    expect(
      admitClassificationOutput(
        decodeClassificationTask(
          classificationFixture("consequence-and-support", path),
        ),
        consequence(),
      ).output,
    ).toEqual(consequence());
});
test("selected source cannot simultaneously be support and contrary for one claim", () => {
  const raw = classificationFixture();
  const task = decodeClassificationTask({
    ...raw,
    candidates: {
      claims: [
        {
          claimId: "transfer",
          claim: "Transfer",
          operation: "queue",
          obligation: "Check",
          hunkIds: ["h1"],
          supportIds: ["support"],
          contraryIds: ["support"],
          verificationIds: [],
        },
      ],
      questions: [{ questionId: "q", question: "Investigate" }],
    },
  });
  expect(() =>
    admitClassificationOutput(
      task,
      consequence("unresolved", ["support"], ["support"]),
    ),
  ).toThrow(ClassificationError);
});

test("source byte digest, captured ranges and history high-water declaration are structural constraints", () => {
  const raw = classificationFixture();
  const source = raw.facts.sources[0];
  if (!source) throw new Error("Literal source fixture missing");
  for (const changed of [
    { ...source, content: { ...source.content, bytesSha256: "0".repeat(64) } },
    { ...source, ref: { ...source.ref, range: { start: 1, end: 2 } } },
    {
      ...source,
      content: {
        ...source.content,
        kind: "partial",
        capturedRange: { start: 2, end: 2 },
        detail: "Outside declared source",
      },
    },
    {
      ...source,
      ref: {
        kind: "history",
        recordUUID: "ee5ae2bf-41e6-4e9d-8007-11b905ac0589",
        sequence: 2,
        through: 1,
        unitId: "unit",
        cycleId: null,
        actor: "recorded-actor",
        origin: "recorded-origin",
        field: "summary",
        utf16Range: { start: 0, end: source.content.exactText.length },
        revision: "a".repeat(40),
      },
    },
  ])
    expect(() =>
      decodeClassificationTask({
        ...raw,
        facts: { ...raw.facts, sources: [changed, raw.facts.sources[1]] },
      }),
    ).toThrow(ClassificationError);
  const attributionRaw = classificationFixture("hunk-source-attribution");
  const unavailable = decodeClassificationTask({
    ...attributionRaw,
    facts: {
      ...attributionRaw.facts,
      sources: attributionRaw.facts.sources.map((value) => ({
        ...value,
        content: { kind: "unavailable", detail: "No capture" },
      })),
    },
  });
  expect(() => admitClassificationOutput(unavailable, attribution())).toThrow(
    ClassificationError,
  );
});

test("every selected support and contrary link needs bytes, including unresolved and mixed lists", () => {
  const raw = classificationFixture();
  const source = raw.facts.sources[0];
  if (!source) throw new Error("Literal source fixture missing");
  for (const kind of ["missing", "unavailable", "conflicting"]) {
    const task = decodeClassificationTask({
      ...raw,
      facts: {
        ...raw.facts,
        sources: [
          ...raw.facts.sources,
          {
            ...source,
            sourceId: "absent",
            content: { kind, detail: "No captured bytes" },
          },
        ],
      },
      candidates: {
        claims: [
          {
            claimId: "transfer",
            claim: "Transfer",
            operation: "queue",
            obligation: "Check",
            hunkIds: ["h1"],
            supportIds: ["support", "absent"],
            contraryIds: ["contrary", "absent"],
            verificationIds: [],
          },
        ],
        questions: [{ questionId: "q", question: "Investigate" }],
      },
    });
    for (const output of [
      consequence("supported", ["support", "absent"]),
      consequence("supported", ["support"], ["absent"]),
      consequence("contradicted", [], ["contrary", "absent"]),
      consequence("contradicted", ["absent"], ["contrary"]),
      consequence("unresolved", ["absent"]),
      consequence("unresolved", [], ["absent"]),
      consequence("unresolved", ["support", "absent"]),
      consequence("unresolved", [], ["contrary", "absent"]),
    ])
      expect(() => admitClassificationOutput(task, output)).toThrow(
        ClassificationError,
      );
    expect(
      admitClassificationOutput(task, consequence("unresolved", [], [])).output,
    ).toEqual(consequence("unresolved", [], []));
  }
});

test("text and metadata on one path retain one old/new blob identity across member kinds", () => {
  const raw = classificationFixture();
  const metadata = {
    kind: "nontext",
    memberId: "mode-change",
    hunkId: "mode-hunk",
    path: "main/source",
    old: { blobId: "c".repeat(40), mode: "100644" },
    new: { blobId: "d".repeat(40), mode: "100755" },
    retainedIdentity: "whole-mode-change",
  } satisfies ReturnType<
    typeof decodeClassificationTask
  >["facts"]["members"][number];
  const task = decodeClassificationTask({
    ...raw,
    facts: { ...raw.facts, members: [...raw.facts.members, metadata] },
  });
  expect(task.facts.members[3]).toEqual(metadata);
  for (const changed of [
    { ...metadata, old: { ...metadata.old, blobId: "0".repeat(40) } },
    { ...metadata, new: { ...metadata.new, blobId: "0".repeat(40) } },
  ]) {
    expect(() =>
      decodeClassificationTask({
        ...raw,
        facts: { ...raw.facts, members: [...raw.facts.members, changed] },
      }),
    ).toThrow(ClassificationError);
    expect(() =>
      decodeClassificationTask({
        ...raw,
        facts: { ...raw.facts, members: [changed, ...raw.facts.members] },
      }),
    ).toThrow(ClassificationError);
  }
});

test("duplicate physical coordinates cannot hide identical or different text under another hunk", () => {
  const raw = classificationFixture();
  const text = raw.facts.members[1];
  if (!text) throw new Error("Literal text fixture missing");
  for (const exactText of ["queue(item.release());", "different();"])
    expect(() =>
      decodeClassificationTask({
        ...raw,
        facts: {
          ...raw.facts,
          members: [
            ...raw.facts.members,
            {
              ...text,
              memberId: "duplicate-line",
              hunkId: "other-hunk",
              exactText,
            },
          ],
        },
      }),
    ).toThrow(ClassificationError);
});

test("declared object modes and absence cannot contradict another member in either order", () => {
  const raw = classificationFixture();
  const oldText = raw.facts.members[0];
  const newText = raw.facts.members[1];
  if (!oldText || !newText) throw new Error("Literal text fixture missing");
  const metadata = {
    kind: "nontext",
    memberId: "metadata",
    hunkId: "mode-hunk",
    path: "main/source",
    old: { blobId: "c".repeat(40), mode: "100644" },
    new: { blobId: "d".repeat(40), mode: "100755" },
    retainedIdentity: "whole-mode-change",
  };
  const duplicateMetadata = {
    ...metadata,
    memberId: "metadata-2",
    hunkId: "other-mode-hunk",
  };
  for (const members of [
    [
      metadata,
      { ...duplicateMetadata, new: { ...metadata.new, mode: "100644" } },
    ],
    [
      metadata,
      { ...duplicateMetadata, old: { ...metadata.old, mode: "100755" } },
    ],
    [{ ...metadata, new: null }, newText],
    [{ ...metadata, old: null }, oldText],
  ])
    for (const ordered of [members, [...members].reverse()])
      expect(() =>
        decodeClassificationTask({
          ...raw,
          facts: { ...raw.facts, members: ordered },
        }),
      ).toThrow(ClassificationError);
  for (const members of [
    [metadata, oldText, newText, duplicateMetadata],
    [{ ...metadata, old: null }, newText],
    [{ ...metadata, new: null }, oldText],
  ])
    for (const ordered of [members, [...members].reverse()]) {
      const task = decodeClassificationTask({
        ...raw,
        facts: { ...raw.facts, members: ordered },
      });
      expect(JSON.stringify(task.facts.members)).toBe(JSON.stringify(ordered));
      expect(
        task.facts.members
          .filter((member) => member.kind === "text")
          .some((member) => "mode" in member),
      ).toBe(false);
    }
});
