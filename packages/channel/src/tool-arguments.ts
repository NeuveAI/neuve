import { Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { JsonObject } from "@earendil-works/pi-durable";
import { z } from "zod";

type ActionSchema = z.ZodObject<z.ZodRawShape & { action: z.ZodLiteral<string> }>;
type ToolSchema = z.ZodObject | z.ZodDiscriminatedUnion<readonly ActionSchema[], "action">;

export interface ToolParameters<Arguments> extends ReturnType<typeof Type.Unsafe<Arguments>> {}

type ToolArguments<Arguments> = {
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
	{ coerce = false }: { coerce?: boolean } = {},
): ToolArguments<Arguments> {
	const actions = "options" in schema
		? new Map(schema.options.map(option => [option.shape.action.value, option]))
		: undefined;
	const properties: Record<string, z.ZodType> = {};
	for (const option of actions?.values() ?? []) {
		for (const [key, field] of Object.entries(option.shape)) {
			if (key !== "action" && !Object.hasOwn(properties, key)) properties[key] = z.optional(field);
		}
	}
	// Providers such as Anthropic read top-level properties when presenting a tool to the model.
	const parameters = actions
		? z.strictObject({ action: z.enum([...actions.keys()]), ...properties })
		: schema;
	// zod hides its validators on the result; TypeBox would copy them into the schema a runtime is served.
	const jsonSchema: z.core.JSONSchema.BaseSchema = JSON.parse(JSON.stringify(z.toJSONSchema(parameters, { target: "draft-07" })));
	// Pi's native TypeBox fields accept conversions that its JSON-schema fallback does not.
	const coercers = coerce ? Object.entries(jsonSchema.properties ?? {}).map(([key, field]) => {
		const type = typeof field === "object" ? field.type : undefined;
		const scalar = type === "boolean" ? Type.Boolean()
			: type === "number" || type === "integer" ? Type.Number()
			: type === "string" ? Type.String()
			: Type.Unsafe(field);
		const property = jsonSchema.required?.includes(key) ? scalar : Type.Optional(scalar);
		return { key, tool: { name, description: "", parameters: Type.Object({ [key]: property }) } };
	}) : [];
	return {
		name,
		parameters: Type.Unsafe<Arguments>(jsonSchema),
		prepareArguments(args: unknown): Arguments {
			let prepared = args;
			if (coerce && args !== null && typeof args === "object" && !Array.isArray(args)) {
				const fields = { ...args } as JsonObject;
				for (const { key, tool } of coercers) {
					if (!Object.hasOwn(fields, key)) continue;
					try {
						const normalized: JsonObject = validateToolArguments(tool, {
							type: "toolCall", id: "", name, arguments: { [key]: fields[key] },
						});
						if (Object.hasOwn(normalized, key)) fields[key] = normalized[key];
						else delete fields[key];
					} catch {
						// Zod can report this field while pi still normalizes the others.
					}
				}
				prepared = fields;
			}
			const parsed = schema.safeParse(prepared);
			if (parsed.success) return parsed.data;

			const input = prepared !== null && typeof prepared === "object" ? prepared : undefined;
			const action = input && "action" in input ? input.action : undefined;
			const variant = typeof action === "string" ? actions?.get(action) : undefined;
			const issues = actions && !variant
				? parameters.safeParse(prepared).error?.issues ?? parsed.error.issues
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
