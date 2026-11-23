import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";

type ActionSchema = z.ZodObject<z.ZodRawShape & { action: z.ZodLiteral<string> }>;
type ToolSchema = z.ZodObject | z.ZodDiscriminatedUnion<readonly ActionSchema[], "action">;

export interface ToolParameters<Arguments> extends ReturnType<typeof Type.Unsafe<Arguments>> {}

export type ToolArguments<Arguments> = {
	name: string;
	parameters: ToolParameters<Arguments>;
	prepareArguments(args: unknown): Arguments;
};

export function toolRefusal(name: string, args: unknown, problems: readonly string[]): Error {
	return new Error([
		`Tool "${name}" refused the call.`,
		...problems.map(problem => `  - ${problem}`),
		"",
		"Received arguments:",
		JSON.stringify(args, null, 2),
	].join("\n"));
}

export function toolArguments<Arguments>(
	name: string,
	schema: z.ZodType<Arguments> & ToolSchema,
	expected: Readonly<Record<string, string>> = {},
): ToolArguments<Arguments> {
	const actions = "options" in schema
		? new Map(schema.options.map(option => [option.shape.action.value, option]))
		: undefined;
	const properties: Record<string, z.ZodType> = {};
	for (const option of actions?.values() ?? []) {
		for (const [key, field] of Object.entries(option.shape)) {
			if (key !== "action") properties[key] = z.optional(field);
		}
	}
	// Providers such as Anthropic read top-level properties when presenting a tool to the model.
	const parameters = actions
		? z.strictObject({ action: z.enum([...actions.keys()]), ...properties })
		: schema;
	return {
		name,
		parameters: Type.Unsafe<Arguments>(z.toJSONSchema(parameters, { target: "draft-07" })),
		prepareArguments(args: unknown): Arguments {
			const parsed = schema.safeParse(args);
			if (parsed.success) return parsed.data;

			const input = args !== null && typeof args === "object" ? args : undefined;
			const action = input && "action" in input ? input.action : undefined;
			const variant = typeof action === "string" ? actions?.get(action) : undefined;
			const issues = actions && !variant
				? parameters.safeParse(args).error?.issues ?? parsed.error.issues
				: parsed.error.issues;
			const keys = Object.keys(variant?.shape ?? ("shape" in parameters ? parameters.shape : {}));
			const allowed = keys.length ? `use only ${keys.join(", ")}` : "pass an empty object";
			const problems = issues.flatMap(issue => {
				if (issue.code === "unrecognized_keys") {
					return issue.keys.map(key => {
						const field = /^[\w-]+$/.test(key) ? key : `[${JSON.stringify(key)}]`;
						return `${field}: Unknown argument, ${allowed}.`;
					});
				}

				const field = issue.path.join(".");
				const requirement = Object.hasOwn(expected, field) ? expected[field] : undefined;
				const missing = field && input && !Object.hasOwn(input, field);
				const prefix = `${field || "arguments"}: ${missing ? "Missing required value, so supply" : "Expected"}`;
				if (requirement) return `${prefix} ${requirement}.`;
				switch (issue.code) {
					case "invalid_value":
						return `${prefix} one of ${issue.values.map(value => JSON.stringify(value)).join(", ")}.`;
					case "invalid_type":
						return `${prefix} ${issue.expected === "boolean" ? "true or false" : `a JSON ${issue.expected}`}.`;
					default:
						return `${field || "arguments"}: ${issue.message}.`;
				}
			});
			throw toolRefusal(name, args, problems);
		},
	};
}
