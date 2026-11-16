# Design-pass inspection record

Date: 2026-09-20. This records the scope of evidence for the [worked review](../worked-review.md), not product acceptance.

## Source identity

| Checkout | Inspected revision | Initial working tree |
| --- | --- | --- |
| Current Neuve corpus | `ebbac54`, handover refresh | Clean |
| Legacy Neuve | `522501bc007beefc8d1ed116d805ec0454a56392` | Clean |
| Entire Graph | `5637039f7da7c8f35726eec22c230491a3f90b9f` | Read-only inspection |

The [legacy repair review](../../../neuve-git/docs/handover/mcp-review-redesign/remediation-2026-07-02/reviews/ticket-a-review.md) identifies client repair `c6259096`, producer repair `161512ec`, and packaged rebuild `4d270128`. Git diffs for the first two and evidence correction `bb4b3d57` were inspected. The [verification review](../../../neuve-git/docs/handover/mcp-review-redesign/remediation-2026-07-02/reviews/ticket-c-review.md) records the challenged claims and historical acceptance. No historical passing count was treated as a newly executed test.

## Browser observations

The existing [mock-host server](../../../neuve-git/apps/web/test/review-shell-ui/static-server.ts) served the checked-in HTML and checked-in fixture without rebuilding either. Command, from the legacy repository:

```sh
PORT=4317 bun run apps/web/test/review-shell-ui/static-server.ts
```

Chrome DevTools MCP opened `http://127.0.0.1:4317/mock-host.html?scenario=loaded` in an isolated browser context. This ran the packaged browser UI with fixture data, not a live Neuve backend or a real Goose host.

| Action or observation | Result | Scope |
| --- | --- | --- |
| Load packaged UI | Scope header, required list, selected bounded diff, notes, records, and disposition bar rendered. | Screenshot and accessibility tree inspected in the task. |
| Inspect mock-host state | `ready=true`; log included `ui/initialize`, `ui/notifications/initialized`, and `push:tool-result:truncated`. | Supports handshake and pushed fixture delivery through this mock host. |
| Click Accept on required unit | Progress remained `0 of 2 reviewed`. | No durable approval was demonstrated. |
| Switch to suggested filter | One suggested row appeared; required unit remained selected in the detail pane. | Confirms filter and selection can diverge. |
| Select suggested row | Detail changed to the documentation unit; no focused diff slice was linked; scoped check showed “needs check.” | Observed fixture state, not a general claim about all suggested units. |
| Click Add note | No editable note appeared in the observed state. | Consistent with source-inspected inert live controls. |

A full-page screenshot was viewed inline. Attempts to save the screenshot and accessibility snapshot under this checkout were rejected by the connector's configured workspace roots. No saved screenshot file is claimed. After navigation to the unavailable scenario, the connector reported “No page found,” so that state and the branch picker were not verified in this session. Source inspection supplies the limits of live writes; this record does not claim persistence testing.

## Checks and limits

Executed `bun run validate:mcp-review-shell` in the legacy checkout. It exited 0 with `MCP review shell app harness passed offline validation scenarios.` The [harness entry point](../../../neuve-git/tools/validate-mcp-review-shell-app.ts) calls existing offline scenarios. They exercise source validators and adapters plus literal checks against the packaged HTML. They do not render a DOM or contact the live backend.

The source-only harness and browser mock observation are complementary. Together they still do not prove production transport, exact build reproducibility, all contract cases in the browser, durable review actions, or evidence applicability across arbitrary revisions.

Retrieval methods were compared using source inspection and primary research. No vector index, graph benchmark, comparative retrieval evaluation, token-saving experiment, or new product implementation was run.

## Connector capability finding

The [current Chrome DevTools MCP tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md#screencast_start), accessed 2026-09-20, documents screenshots and experimental video recording through `screencast_start` and `screencast_stop`, enabled by `--experimentalScreencast=true`, with WebM and MP4 output. This session exposed screenshot and trace tools but no screencast tools. Screenshot capture worked inline; repository export did not. Video capture and export remain unverified here.

This is a bounded capability finding, not a connector selection. Browser recording also needs the artifact, revision, source data, and run conditions attached before it can support a review claim. Trace recording is not evidence that video export is available.

## Workflow and audit

Poteto Mode routed this pass through source exploration, a bounded workflow, technical writing, a decision trail, and direct artifact verification. The Prove It Works principle changed the evidence standard: the packaged UI was operated and the existing offline harness was executed, rather than treating the historical green reports as current proof.

The repository's model-role map remains proposed. Research agents inherited the active model because skill-default model IDs were unavailable. The run uses the existing [decision trail](../../process/decisions.tsv); it does not modify accepted foundations or vocabulary.

All four Mermaid diagrams rendered successfully with Mermaid CLI 11.17.0 and local Chrome. Each PNG was visually inspected; the assessment diagram was simplified to remove crossing labels, and the cycle diagram now follows one concrete correction path. The [rendered diagrams](../review-diagrams.md) link to those outputs. Reproduce from this repository:

```sh
PUPPETEER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' bunx --yes @mermaid-js/mermaid-cli@11.17.0 -i design/review-diagrams.md -o design/evidence/diagram.png -w 1400 -s 1 -j 1
```

A final local-reference check covered 91 links across the new documents, handover, and plan, including target existence, cited line bounds, and heading anchors. It found no failures. External research links were inspected separately. `git diff --check` passed. The legacy checkout remained clean and the temporary mock-host server was stopped.

GPT-5.5 independently audited the proposed documents, accepted foundations, cited source, and decision trail. This was a different-model review, not review across independent model families or a transcript-file audit. The review flagged ambiguous automated-correction arrows in the cycle diagram and unfinished progress records. The arrows were removed from the specific two-cycle path, their counting implications are explained in prose, and completion records were updated. Source synthesis separately corrected the example to unpinned diagnostics after inspection of the parent commit.

The independent reviewer rechecked both findings and confirmed them resolved. Accepted foundations, vocabulary, and the constitution were checked against Git and remain unchanged.
