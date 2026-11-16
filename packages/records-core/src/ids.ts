import { monotonicFactory } from "ulid";

const next = monotonicFactory();

/**
 * Mints a ULID for a new event or entity (D4). Monotonic within a process, so IDs minted in the
 * same millisecond still sort in minting order, which is the spool's ingestion order.
 */
export const mintUlid = (): string => next();
