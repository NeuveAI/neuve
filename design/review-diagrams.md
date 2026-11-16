# Four views of the worked review

Status: conceptual design exploration, 2026-09-20. These diagrams explain the [mixed-tier repair](worked-review.md). They combine accepted relationships with proposed processing steps; neither boxes nor arrows select a graph schema, storage system, or algorithm. Example unit names refer to hunk groupings, not permanent product identities.

Rendered copies: [information and attribution](evidence/diagram-1.png), [retrieval and ingestion](evidence/diagram-2.png), [assessment and reclustering](evidence/diagram-3.png), and [evidence across cycles](evidence/diagram-4.png).

## 1. Information and attribution

The accepted [unit and context foundation](../foundations/04-review-units-and-context.md) separates the hunks receiving a decision from information used to make it. In this example the same producer fragment supports both producer and client hunks. The representation of those links remains open.

```mermaid
flowchart TD
    S["Versioned sources: code, Git history, docs, tickets, prior reviews"]
    M["Retrieved source fragment: contextual marker"]
    A["Attribution explanation: what it establishes, why it applies, uncertainty"]
    H1["Client aggregation hunk"]
    H2["Producer membership hunk"]
    U1["Client review unit for this cycle"]
    U2["Producer review unit for this cycle"]
    E["Check observation: examined version, conditions, result and limits"]
    B["Contextual briefings with source drilldown"]
    I["Isolated briefing: shared contract and verification; advisory"]
    D1["Client disposition over its responsibility segment"]
    D2["Producer disposition over its responsibility segment"]
    S -->|exact fragment and source location| M
    M -->|corroborates| A
    A -->|supported connection| H1
    A -->|supported connection| H2
    H1 -->|cycle membership| U1
    H2 -->|cycle membership| U2
    E -->|applicable support only| U1
    E -->|applicable support only| U2
    A --> B
    E --> B
    B -->|surrounding context| U1
    B -->|surrounding context| U2
    U1 --> D1
    U2 --> D2
    I -. shared context .-> U1
    I -. shared context .-> U2
```

The marker remains a source fragment. The attribution explanation and generated briefing are interpretations linked to it. A different-lane neighboring hunk may be shown as a read-only neighbor while retaining its own responsibility. Prior approval alone does not make something a read-only neighbor. The isolated briefing has no approval arrow because it adds no disposition requirement.

## 2. Retrieval, attribution, and ingestion

The three ingestion routes and incomplete-processing disclosure are [established requirements](../foundations/08-ingestion-and-setup.md). The common processing, refresh, and filtering boxes are a proposed logical decomposition. Search and graph alternatives are compared in the [retrieval analysis](retrieval-comparison.md#compare-the-candidates-on-the-same-change).

```mermaid
flowchart TD
    P["Initial pre-population: foreground or background choice"]
    G["Git events and event reconciliation"]
    X["External source updates and active ingestion"]
    V["Capture source versions, changes, deletions and processing progress"]
    F["Available source fragments and relations"]
    H["Changed hunk, agreed scope and submitted revision"]
    R["Candidate discovery: lexical, vector, graph, or combinations"]
    Q["Check source coverage, freshness, authority and relevance"]
    A["Explain and check attribution to this hunk"]
    M["Attributed contextual markers and explicit uncertainty"]
    N["Missing or conflicting support remains visible"]
    U["Whole-unit assessment and contextual briefing"]
    P --> V
    G --> V
    X --> V
    V --> F
    V -->|unfinished or stale processing| N
    H --> R
    F --> R
    R --> Q
    Q --> A
    Q -->|stale, absent or conflicting material| N
    A -->|supported attachment| M
    A -->|unsupported connection| N
    M --> U
    N --> U
    N -. targeted additional retrieval .-> R
```

Users can work while initial processing is incomplete. Proposed source-level progress would explain which material is available and which remains unprocessed. A completed query over incomplete sources is still incomplete evidence. A duplicate event should not create independent corroboration. An updated ticket must not silently change what a historical review cited.

## 3. Whole-unit assessment and reclustering

Markers attach to hunks; assessment uses the unit's whole surrounding context. That distinction and the possibility of splitting/recomputing clusters are [accepted](../foundations/06-escalation-and-decomposition.md). The feedback mechanism and stopping condition below remain design questions.

```mermaid
flowchart TD
    H["Hunks and changed-dependency decision signals"]
    C["Candidate proximity groupings"]
    M["Per-hunk markers, prior review, evidence and coverage limits"]
    A["Assess whole unit: risk, complexity, blast radius and verification"]
    F{"Does the candidate grouping still fit?"}
    R["Split or recompute grouping; preserve supported hunk attribution"]
    D["Targeted discovery or enrichment"]
    L["Assign responsibility: static, agentic, human-suggested or human-required"]
    B["Show decision hunks, contextual briefing and different-lane neighbors"]
    O["Open: stopping rule when further discovery cannot settle assessment"]
    H --> C
    C --> A
    M --> A
    A --> F
    F -->|yes| L
    F -->|no| R
    R --> A
    A -->|material missing context| D
    D -->|new supported per-hunk information| A
    D -->|cannot resolve| O
    L --> B
```

In the example, discovering that hidden members affect the branch verdict changes the producer unit's surrounding context. It does not automatically assign a human lane or permit de-escalation. Further evidence can change assessment in either direction. No weight, certainty scale, universal marker gate, or iteration limit is selected. Separate units keep separate dispositions even when a briefing explains their shared dependency.

## 4. Evidence and decisions across cycles

This is the [worked example's simulated sequence](worked-review.md#walk-the-example-through-the-workflow), not a historical timeline. The accepted [cycle boundary](../foundations/02-review-modes-and-cycles.md#cycle-boundary-and-corrections) counts external submissions, not inner correction attempts. Exact partial/concurrent submission counting remains open.

```mermaid
flowchart TD
    S["Agreed scope and planning"]
    I1["Implement, collect evidence and adversarially review revision 1"]
    C1["Correct implementation or inadequate evidence within inner loop"]
    A1{"Adversarial approval?"}
    X["Operational inability to obtain approval: handling unspecified"]
    E1["Submission lands outside inner loop: counted cycle 1"]
    F1["Final automated processing and agent dispositions"]
    H1["Final human gate"]
    R["Human correction request attached to affected unit"]
    P["New patch: identify invalidation from relevant changes or findings"]
    K["Reuse existing fragments and evidence; keep original observations"]
    N["Recompute affected evidence and raise renewed decision signals"]
    I2["Recluster, implement corrections and obtain adversarial approval"]
    E2["Submission lands outside inner loop: counted cycle 2"]
    F2["Final automated processing and agent dispositions"]
    H2["Final human gate; required human decisions remain"]
    S --> I1
    I1 --> A1
    A1 -->|corrections needed| C1
    C1 --> I1
    A1 -->|operational limit| X
    A1 -->|yes| E1
    E1 --> F1
    F1 -->|ready| H1
    H1 -->|request changes| R
    R --> P
    P -->|not invalidated| K
    P -->|invalidated or missing evidence| N
    K --> I2
    N --> I2
    I2 --> E2
    E2 --> F2
    F2 -->|ready| H2
```

The diagram follows one human-correction path. Final automated reviewers can also request corrections, returning work to implementation and adversarial review. Their later external resubmission would be another counted cycle, not another pass through an unchanged cycle number. Partial and concurrent submission rules remain open.

The fallback change needs fresh behavioral evidence. An unchanged aggregation hunk can remain context when its outcome is unaffected. If a changed producer alters that outcome, the client needs renewed attention even without a textual change. Reuse existing valid evidence and context unless invalidated, as required by the [no-repetition principle](../foundations/05-reviewers-tax.md#established-principle). A new commit alone does not require a fresh applicability proof.

Within the development loop, agents [query surrounding context and reason against pinned task scope](../foundations/02-review-modes-and-cycles.md#context-for-agent-reasoning). Conflict resolution belongs mostly to their workflow, supported by Neuve's context aggregation. The exception box concerns operational inability to obtain approval, whose handling remains unspecified. It does not imply an approval bypass or routine human-scoping exit.
