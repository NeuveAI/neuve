import { createHash } from "node:crypto"

export const matrixTransportBytes = new Uint8Array([
  0x1a, 0x45, 0xdf, 0xa3, 0, 1, 2, 3,
])

export const matrixTransportFixture = (repository: string, revision: string) => ({
  schemaVersion: 1,
  runId: "matrix-fixture",
  provenance: {
    repository,
    revision,
    scenario: "Artifact transport fixture",
    scope: "bounded response",
  },
  startedAt: "2026-10-03T00:00:00.000Z",
  finishedAt: "2026-10-03T00:00:01.000Z",
  outcome: "failed",
  capture: {
    status: "incomplete",
    browserVersion: "fixture",
    playwrightVersion: "fixture",
    headless: true,
    video: true,
  },
  pages: [],
  errors: ["Fixture incomplete"],
  limitations: ["Generated fixture does not prove browser behavior"],
  artifacts: [
    {
      path: "video.webm",
      kind: "video",
      bytes: matrixTransportBytes.length,
      sha256: createHash("sha256").update(matrixTransportBytes).digest("hex"),
    },
  ],
})
