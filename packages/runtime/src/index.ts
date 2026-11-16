/**
 * Runtime and account contracts follow the [Claude subscription design](../../../process/proposals/claude-subscription-route.md#2-one-runtime-contract-and-an-account-registry).
 * [Decision 12.59](../../../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026)
 * requires isolated loops behind this shared contract. This package holds no runtime implementation.
 */
export * from "./account.ts";
export * from "./defaults.ts";
export * from "./status.ts";
export * from "./contract.ts";
export * from "./errors.ts";
export * from "./registry.ts";
export { signInCommand } from "./sign-in-command.ts";
export * as AccountStore from "./store/index.ts";
