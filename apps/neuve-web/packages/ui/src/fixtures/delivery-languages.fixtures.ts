import type {
  DeliveryLanguageInfo,
  DeliverySettings,
} from "@workspace/ui/neuve/shared/delivery"

/**
 * Sample languages "observed in the workspace" for the mock settings page and
 * stories. Fixture data only: production lists come from provider
 * observation, and this list defines no product scope.
 */
export const sampleWorkspaceLanguages: Array<DeliveryLanguageInfo> = [
  { id: "typescript", name: "TypeScript", fileTypes: [".ts", ".tsx"] },
  { id: "go", name: "Go", fileTypes: [".go"] },
  { id: "sql", name: "SQL", fileTypes: [".sql"] },
  { id: "hcl", name: "HCL", fileTypes: [".tf"] },
]

/** Sample refinements for the mock page and stories (Go and HCL refined). */
export const sampleDeliverySettings: DeliverySettings = {
  workspaceDefault: "briefed",
  byLanguage: { go: "explained", hcl: "guided" },
}
