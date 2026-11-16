import { expect, test } from "bun:test";
import {
  contextDigest,
  decodeContextSnapshot,
  selectContextSlice,
  admitContextAnswer,
  changedAllocation,
  admitProviderBudget,
  ContextSliceError,
  expandModelSubject,
  contextTask,
} from "../src/review-quality/context-slice.ts";
import {
  snapshotDigest,
  scoreContextSelection,
  scoreContextClassification,
  ContextMetricError,
} from "../src/review-quality/context-metrics.ts";
import {
  compileFiniteJevContext,
  normalizeFiniteJevAnswers,
  admitFiniteJevBudget,
} from "../src/review-quality/context-jev.ts";

const source = (
  text = "release() transfers ownership;\nqueue() retains the object;\n",
) => ({
  sourceKey: "context-a",
  path: "ownership/source",
  range: { start: 400, end: 401 },
  relation: "ownership",
  provenance: { kind: "synthetic", captureSha256: contextDigest(text) },
  trust: "fixture-only",
  evidence: { kind: "available", text },
});
const rawSnapshot = () => ({
  schemaVersion: 2,
  revisionIdentity: "synthetic-fixture",
  base: "a".repeat(40),
  head: "b".repeat(40),
  changed: [
    {
      ref: { hunkId: "h1", path: "main/source", side: "old", line: 10 },
      text: "queue(item);",
    },
    {
      ref: { hunkId: "h1", path: "main/source", side: "new", line: 10 },
      text: "queue(item.release());",
    },
    {
      ref: { hunkId: "h1", path: "main/source", side: "new", line: 11 },
      text: "recordMetric();",
    },
    {
      ref: { hunkId: "h2", path: "types/any-language", side: "new", line: 30 },
      text: "type Scope = Read | Write;",
    },
  ],
  subjects: [
    {
      subjectKey: "subject-a",
      hunkId: "h1",
      path: "main/source",
      old: [{ start: 10, end: 10 }],
      new: [{ start: 10, end: 10 }],
      contexts: [source()],
      obligations: [
        {
          sourceKey: "context-a",
          origin: "caller-observed ownership dependency, synthetic control",
        },
      ],
    },
  ],
});
const sliced = () =>
  selectContextSlice(
    decodeContextSnapshot(rawSnapshot()),
    "subject-a",
    "medium",
  );
test("schema rejects label-derived extra fields before preparation", () => {
  expect(() =>
    decodeContextSnapshot({ ...rawSnapshot(), goldChoice: "quiet" }),
  ).toThrow(ContextSliceError);
  const raw = rawSnapshot();
  expect(() =>
    decodeContextSnapshot({
      ...raw,
      subjects: [{ ...raw.subjects[0], lane: "agentic" }],
    }),
  ).toThrow(ContextSliceError);
});
test("full inventory is immutable and unselected changed lines remain explicit", () => {
  const snapshot = decodeContextSnapshot(rawSnapshot());
  const slice = selectContextSlice(snapshot, "subject-a", "medium");
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.changed)).toBe(true);
  expect(slice.kind).toBe("selected");
  const allocation = changedAllocation(snapshot, slice.subjectRefs);
  expect(allocation.totalChanged).toBe(4);
  expect(allocation.classified).toHaveLength(2);
  expect(allocation.unclassified.map((ref) => [ref.path, ref.line])).toEqual([
    ["main/source", 11],
    ["types/any-language", 30],
  ]);
  expect(slice.logicalRequest).not.toContain("recordMetric");
  expect(slice.logicalRequest).not.toContain("Read | Write");
  if (slice.kind !== "selected") throw new Error("Fixture must fit");
  const expanded = expandModelSubject(slice.factualState.subject);
  expect(expanded).toEqual(
    snapshot.changed.filter((value) =>
      slice.subjectRefs.some(
        (ref) => JSON.stringify(ref) === JSON.stringify(value.ref),
      ),
    ),
  );
});
test("payload carries exact subject range text but no obligation labels or gold", () => {
  const slice = sliced();
  expect(slice.logicalRequest).toContain("queue(item.release())");
  expect(slice.logicalRequest).toContain('"base"');
  expect(slice.logicalRequest).toContain('"head"');
  expect(slice.logicalRequest).toContain('"ownership"');
  expect(slice.logicalRequest).not.toContain("caller-observed");
  expect(slice.logicalRequest).not.toContain("obligations");
  expect(slice.logicalRequest).not.toContain("subject-a");
});
test("changed range cannot absorb unchanged hunk context or invented coordinates", () => {
  const raw = rawSnapshot();
  raw.subjects[0]?.old.push({ start: 9, end: 9 });
  expect(() => decodeContextSnapshot(raw)).toThrow(ContextSliceError);
});
test("changed allocation refuses duplicates, foreign work and overlapping subjects", () => {
  const snapshot = decodeContextSnapshot(rawSnapshot());
  const ref = snapshot.changed[0]?.ref;
  if (!ref) throw new Error("Missing fixture ref");
  expect(() => changedAllocation(snapshot, [ref, ref])).toThrow(
    ContextSliceError,
  );
  expect(() => changedAllocation(snapshot, [{ ...ref, line: 999 }])).toThrow(
    ContextSliceError,
  );
  const raw = rawSnapshot();
  const subject = raw.subjects[0];
  if (!subject) throw new Error("Missing fixture subject");
  raw.subjects.push({ ...subject, subjectKey: "duplicate-range" });
  expect(() => decodeContextSnapshot(raw)).toThrow(ContextSliceError);
});
test("source captures qualify exact bytes, ranges and revisions without Git proof claims", () => {
  const raw = rawSnapshot();
  const s = raw.subjects[0]?.contexts[0];
  if (!s) throw new Error("Missing source");
  s.evidence.text = "different capture\n";
  expect(() => decodeContextSnapshot(raw)).toThrow(ContextSliceError);
  const another = rawSnapshot();
  expect(() =>
    decodeContextSnapshot({ ...another, revisionIdentity: "git-object" }),
  ).toThrow(ContextSliceError);
  const subject = another.subjects[0];
  if (!subject) throw new Error("Missing subject");
  expect(() =>
    decodeContextSnapshot({
      ...another,
      subjects: [
        {
          ...subject,
          contexts: [
            {
              ...source(),
              provenance: {
                kind: "committed",
                revision: "c".repeat(40),
                blobId: "d".repeat(40),
              },
              trust: "untrusted-repository-content",
            },
          ],
        },
      ],
    }),
  ).toThrow(ContextSliceError);
});
test("missing required source fences quiet answers while retaining cited investigation", () => {
  const raw = rawSnapshot();
  const subject = raw.subjects[0];
  if (!subject) throw new Error("Missing subject");
  const snapshot = decodeContextSnapshot({
    ...raw,
    subjects: [
      {
        ...subject,
        contexts: [
          {
            ...source(),
            evidence: { kind: "missing", detail: "capture unavailable" },
          },
        ],
      },
    ],
  });
  const slice = selectContextSlice(snapshot, "subject-a", "medium");
  expect(slice.logicalRequest).toContain('"path":"ownership/source"');
  expect(slice.logicalRequest).toContain('"range":{"start":400,"end":401}');
  expect(slice.logicalRequest).toContain("capture unavailable");
  expect(
    admitContextAnswer(slice, {
      choice: "no-additional-signal",
      citations: [],
    }),
  ).toEqual({ kind: "rejected", reason: "required-context-unresolved" });
  expect(
    admitContextAnswer(slice, { choice: "inspect", citations: [] }).kind,
  ).toBe("rejected");
  expect(
    admitContextAnswer(slice, {
      choice: "no-additional-signal",
      citations: [{ kind: "subject", side: "new", start: 10, end: 10 }],
    }),
  ).toEqual({ kind: "rejected", reason: "required-context-unresolved" });
  expect(
    admitContextAnswer(slice, {
      choice: "inspect",
      citations: [{ kind: "subject", side: "new", start: 10, end: 10 }],
    }),
  ).toEqual({
    kind: "admitted",
    answer: {
      choice: "inspect",
      citations: [{ kind: "subject", side: "new", start: 10, end: 10 }],
    },
    classifiedRefs: [
      { hunkId: "h1", path: "main/source", side: "old", line: 10 },
      { hunkId: "h1", path: "main/source", side: "new", line: 10 },
    ],
    finalDisposition: null,
    lane: null,
  });
  expect(
    admitContextAnswer(slice, {
      choice: "inspect",
      citations: [
        { kind: "context", sourceKey: "context-a", start: 400, end: 400 },
      ],
    }).kind,
  ).toBe("rejected");
  const admitted = admitContextAnswer(slice, {
    choice: "abstain",
    citations: [],
  });
  expect(admitted.kind).toBe("admitted");
  expect(
    admitContextAnswer(slice, { choice: "ask-human", citations: [] }).kind,
  ).toBe("admitted");
  if (admitted.kind === "admitted") {
    expect(admitted.finalDisposition).toBeNull();
    expect(admitted.lane).toBeNull();
  }
});
test("truncated required source remains unavailable and cannot be cited", () => {
  const raw = rawSnapshot();
  const subject = raw.subjects[0];
  if (!subject) throw new Error("Missing subject");
  const text = "queue retains;\n";
  const snapshot = decodeContextSnapshot({
    ...raw,
    subjects: [
      {
        ...subject,
        contexts: [
          {
            ...source(),
            provenance: {
              kind: "synthetic",
              captureSha256: contextDigest(text),
            },
            evidence: {
              kind: "truncated",
              text,
              capturedRange: { start: 401, end: 401 },
            },
          },
        ],
      },
    ],
  });
  const slice = selectContextSlice(snapshot, "subject-a", "medium");
  expect(slice.selected).toHaveLength(0);
  expect(
    admitContextAnswer(slice, { choice: "no-additional-signal", citations: [] })
      .kind,
  ).toBe("rejected");
  expect(
    admitContextAnswer(slice, {
      choice: "abstain",
      citations: [
        { kind: "context", sourceKey: "context-a", start: 401, end: 401 },
      ],
    }).kind,
  ).toBe("rejected");
});
test("large necessary far context cannot be displaced by small optional noise then treated as quiet", () => {
  const raw = rawSnapshot();
  const subject = raw.subjects[0];
  if (!subject) throw new Error("Missing subject");
  const long =
    "retains ownership and must not free; ".repeat(150) + "\nnext line;\n";
  const noiseText = "colour = blue;\n";
  const snapshot = decodeContextSnapshot({
    ...raw,
    subjects: [
      {
        ...subject,
        contexts: [
          {
            ...source(noiseText),
            sourceKey: "noise",
            range: { start: 1, end: 1 },
            relation: "adjacency",
          },
          source(long),
        ],
      },
    ],
  });
  const slice = selectContextSlice(snapshot, "subject-a", "small");
  expect(slice.kind).toBe("selected");
  expect(slice.unresolvedObligations).toEqual(["context-a"]);
  expect(slice.selected.map((source) => source.sourceKey)).toEqual(["noise"]);
  expect(
    admitContextAnswer(slice, { choice: "no-additional-signal", citations: [] })
      .kind,
  ).toBe("rejected");
});
test("subject too large never silently crops decision lines", () => {
  const raw = rawSnapshot();
  const line = raw.changed[0];
  if (!line) throw new Error("Missing changed line");
  line.text = "x".repeat(9000);
  const snapshot = decodeContextSnapshot(raw);
  const slice = selectContextSlice(snapshot, "subject-a", "medium");
  expect(slice.kind).toBe("blocked");
  expect(slice.logicalRequest).toBeNull();
  expect(changedAllocation(snapshot, []).unclassified).toHaveLength(4);
  expect(
    admitContextAnswer(slice, { choice: "abstain", citations: [] }).kind,
  ).toBe("rejected");
});
test("unknown semantic dependency is not misrepresented as proven by admission", () => {
  const raw = rawSnapshot();
  const subject = raw.subjects[0];
  if (!subject) throw new Error("Missing subject");
  const snapshot = decodeContextSnapshot({
    ...raw,
    subjects: [{ ...subject, contexts: [], obligations: [] }],
  });
  const slice = selectContextSlice(snapshot, "subject-a", "medium");
  expect(slice.unresolvedObligations).toHaveLength(0);
  // Only an independent semantic label can assess this answer; structural admission cannot invent unseen dependencies.
  expect(
    admitContextAnswer(slice, { choice: "no-additional-signal", citations: [] })
      .kind,
  ).toBe("admitted");
  expect(slice.logicalRequest).not.toContain("capture unavailable");
});
test("citation containment, duplicate citations and invented authority fail admission", () => {
  const slice = sliced();
  const citation = {
    kind: "context",
    sourceKey: "context-a",
    start: 400,
    end: 401,
  };
  expect(
    admitContextAnswer(slice, { choice: "inspect", citations: [citation] })
      .kind,
  ).toBe("admitted");
  expect(
    admitContextAnswer(slice, {
      choice: "inspect",
      citations: [citation, citation],
    }).kind,
  ).toBe("rejected");
  expect(
    admitContextAnswer(slice, {
      choice: "inspect",
      citations: [{ kind: "subject", side: "new", start: 10, end: 10 }],
    }).kind,
  ).toBe("admitted");
  expect(
    admitContextAnswer(slice, {
      choice: "inspect",
      citations: [{ kind: "subject", side: "new", start: 10, end: 11 }],
    }).kind,
  ).toBe("rejected");
  expect(
    admitContextAnswer(slice, {
      choice: "inspect",
      citations: [
        {
          kind: "subject",
          side: "old",
          sourceKey: "context-a",
          start: 10,
          end: 10,
        },
      ],
    }).kind,
  ).toBe("rejected");
  expect(
    admitContextAnswer(slice, {
      choice: "inspect",
      citations: [{ ...citation, end: 402 }],
    }).kind,
  ).toBe("rejected");
  expect(
    admitContextAnswer(slice, {
      choice: "inspect",
      citations: [],
      disposition: "approved",
    }).kind,
  ).toBe("rejected");
});
test("bytes are reported honestly and unavailable exact tokenization blocks paid admission", () => {
  const slice = sliced();
  if (slice.kind !== "selected") throw new Error("Fixture must fit");
  expect(slice.logicalBytes).toBe(
    new TextEncoder().encode(slice.logicalRequest).byteLength,
  );
  const wire = JSON.stringify({
    model: "native-control",
    request: JSON.parse(slice.logicalRequest),
    maxOutputTokens: slice.outputAllowanceTokens,
  });
  expect(
    admitProviderBudget(slice, wire, {
      kind: "unavailable",
      reason: "no exact tokenizer for provider",
    }).kind,
  ).toBe("blocked");
  expect(
    admitProviderBudget(slice, wire, {
      kind: "exact",
      tokenizer: "native-literal-count-control-only",
      wireSha256: contextDigest(wire),
      inputTokens: 1000,
      contextWindowTokens: 1100,
    }).kind,
  ).toBe("blocked");
  expect(
    admitProviderBudget(slice, wire, {
      kind: "exact",
      tokenizer: "native-literal-count-control-only",
      wireSha256: contextDigest(wire),
      inputTokens: 1000,
      contextWindowTokens: 2000,
    }).kind,
  ).toBe("admitted");
  expect(() =>
    admitProviderBudget(slice, wire, {
      kind: "exact",
      tokenizer: "native-literal-count-control-only",
      wireSha256: "a".repeat(64),
      inputTokens: 1000,
      contextWindowTokens: 2000,
    }),
  ).toThrow(ContextSliceError);
  const mutatedWire = JSON.stringify({
    model: "native-control",
    request: { changed: "different factual payload" },
    maxOutputTokens: slice.outputAllowanceTokens,
  });
  expect(() =>
    admitProviderBudget(slice, mutatedWire, {
      kind: "exact",
      tokenizer: "native-control",
      wireSha256: contextDigest(mutatedWire),
      inputTokens: 1,
      contextWindowTokens: 2000,
    }),
  ).toThrow(ContextSliceError);
});
test("unknown dependency quiet answer can fail semantic scoring despite structural admission", () => {
  const raw = rawSnapshot();
  const subject = raw.subjects[0];
  if (!subject) throw new Error("Missing subject");
  const snapshot = decodeContextSnapshot({
    ...raw,
    subjects: [{ ...subject, contexts: [], obligations: [] }],
  });
  const slice = selectContextSlice(snapshot, "subject-a", "medium");
  if (slice.kind !== "selected") throw new Error("Fixture must fit");
  const result = scoreContextClassification(
    slice,
    { choice: "no-additional-signal", citations: [] },
    {
      status: "adjudicated",
      subjectKey: "subject-a",
      logicalRequestSha256: slice.logicalRequestSha256,
      acceptedChoices: ["abstain", "ask-human"],
      investigationRequired: true,
      reviewerEvidence: [
        "Literal native metric control; not independent candidate fixture adjudication",
      ],
    },
  );
  expect(result.admission).toBe("admitted");
  expect(result.unsafeFalseNegative).toBe(true);
  expect(result.wrongChoice).toBe(true);
  const selection = scoreContextSelection(snapshot, slice, {
    status: "adjudicated",
    subjectKey: "subject-a",
    snapshotSha256: snapshotDigest(snapshot),
    necessarySources: ["dependency-outside-candidate-pool"],
    relevantSources: ["dependency-outside-candidate-pool"],
    reviewerEvidence: ["Literal native source-recall arithmetic control"],
  });
  expect(selection.candidatePoolRecall).toBe(0);
  expect(selection.selectorRecall).toBeNull();
  expect(selection.retrievalMisses).toEqual([
    "dependency-outside-candidate-pool",
  ]);
});
test("pending or differently selected gold cannot produce comparative quality", () => {
  const snapshot = decodeContextSnapshot(rawSnapshot());
  const slice = selectContextSlice(snapshot, "subject-a", "medium");
  if (slice.kind !== "selected") throw new Error("Fixture must fit");
  expect(() =>
    scoreContextSelection(snapshot, slice, {
      status: "pending-independent-adjudication",
      subjectKey: "subject-a",
      snapshotSha256: snapshotDigest(snapshot),
    }),
  ).toThrow(ContextMetricError);
  expect(() =>
    scoreContextClassification(
      slice,
      { choice: "inspect", citations: [] },
      {
        status: "pending-independent-adjudication",
        subjectKey: "subject-a",
        logicalRequestSha256: slice.logicalRequestSha256,
      },
    ),
  ).toThrow(ContextMetricError);
  expect(() =>
    scoreContextClassification(
      slice,
      { choice: "inspect", citations: [] },
      {
        status: "adjudicated",
        subjectKey: "subject-a",
        logicalRequestSha256: "a".repeat(64),
        acceptedChoices: ["inspect"],
        investigationRequired: true,
        reviewerEvidence: ["Different request control"],
      },
    ),
  ).toThrow(ContextMetricError);
});
test("finite Jev primary choice and attribution questions preserve frozen state across option orders", () => {
  const slice = sliced();
  if (slice.kind !== "selected") throw new Error("Fixture must fit");
  const forward = compileFiniteJevContext(slice);
  const reverse = compileFiniteJevContext(slice, "reverse");
  expect(forward.logicalRequestSha256).toBe(reverse.logicalRequestSha256);
  expect(forward.body.state).toEqual(reverse.body.state);
  expect(forward.body.state).toEqual(slice.factualState);
  expect(JSON.stringify(forward.body.state)).not.toContain("outputSchema");
  expect(JSON.stringify(forward.body.state)).not.toContain(
    contextTask.instructions,
  );
  expect(forward.primaryQuestion).toBe("action");
  expect(forward.citationQuestions).toHaveLength(3);
  expect(Object.keys(reverse.body.questions.action?.criteria ?? {})).toEqual(
    Object.keys(forward.body.questions.action?.criteria ?? {}).reverse(),
  );
  const answers = Object.fromEntries(
    Object.keys(forward.body.questions).map((key) => [
      key,
      { type: "choice", choice: key === "action" ? "inspect" : "cite" },
    ]),
  );
  const result = normalizeFiniteJevAnswers(slice, answers);
  expect(result.kind).toBe("admitted");
  if (result.kind === "admitted")
    expect(result.answer.citations).toEqual(
      forward.citationQuestions.map((value) => value.citation),
    );
  expect(() =>
    normalizeFiniteJevAnswers(slice, {
      ...answers,
      explanation: { type: "choice", choice: "approve" },
    }),
  ).toThrow(ContextSliceError);
});
test("Jev admission binds actual state/question wire and distinguishes32k-longest from64k-total", () => {
  const slice = sliced();
  const compiled = compileFiniteJevContext(slice);
  const receipt = {
    kind: "exact",
    tokenizer: "native-literal-metric-control-only",
    wireSha256: compiled.wireSha256,
    stateAndLongestQuestionTokens: 1000,
    stateAndAllQuestionsTokens: 4000,
  };
  expect(admitFiniteJevBudget(slice, compiled.wireRequest, receipt).kind).toBe(
    "admitted",
  );
  expect(
    admitFiniteJevBudget(slice, compiled.wireRequest, {
      ...receipt,
      stateAndLongestQuestionTokens: 32_001,
      stateAndAllQuestionsTokens: 40_000,
    }).kind,
  ).toBe("blocked");
  expect(
    admitFiniteJevBudget(slice, compiled.wireRequest, {
      ...receipt,
      stateAndAllQuestionsTokens: 64_001,
    }).kind,
  ).toBe("blocked");
  expect(
    admitFiniteJevBudget(slice, compiled.wireRequest, {
      kind: "unavailable",
      reason: "No exact provider tokenizer available",
    }).kind,
  ).toBe("blocked");
  const wrong = JSON.stringify({
    ...compiled.body,
    state: { different: "facts" },
  });
  expect(() =>
    admitFiniteJevBudget(slice, wrong, {
      ...receipt,
      wireSha256: contextDigest(wrong),
    }),
  ).toThrow(ContextSliceError);
  expect(() =>
    admitFiniteJevBudget(
      slice,
      compileFiniteJevContext(slice, "reverse").wireRequest,
      receipt,
    ),
  ).toThrow(ContextSliceError);
});
