import { z } from "zod";

/** Provider-owned receipts. Existing version-1 document objects retain their original encoding. */
export const ExternalRefSchema = z.union([
	z.strictObject({ provider: z.string().min(1).max(256), id: z.string().min(1).max(8192) }),
	z.record(z.string(), z.json()),
]);
export type ExternalRef = z.infer<typeof ExternalRefSchema>;
