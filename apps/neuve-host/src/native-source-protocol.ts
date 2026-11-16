import {z} from "zod";

export const NativeAuthorityReceiptSchema = z.strictObject({
	version: z.literal(1),
	id: z.string().regex(/^[a-f0-9]{64}$/),
	nativeSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type NativeAuthorityReceipt = z.infer<typeof NativeAuthorityReceiptSchema>;

/** Private Unix worker IPC only. This operation is absent from browser and model protocols. */
export const NativeSourceRequestSchema = z.strictObject({
	op: z.literal("native-source-checkpoint"),
	nativeDatabase: z.string().startsWith("/"),
	nativeSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type NativeSourceRequest = z.infer<typeof NativeSourceRequestSchema>;
