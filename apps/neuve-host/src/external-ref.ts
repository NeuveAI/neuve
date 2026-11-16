import { GitHubExternalRefSchema, type GitHubExternalRef } from "@neuve/records-schema";
import type { ExternalRef } from "@ace/channel/external-ref";
const PREFIX = "neuve:github-ref:v1:";
export function externalRef(value: GitHubExternalRef): ExternalRef {
	return {provider: "github", id: PREFIX + Buffer.from(JSON.stringify(GitHubExternalRefSchema.parse(value))).toString("base64url")};
}
export function githubRef(value: unknown): GitHubExternalRef {
	if (value && typeof value === "object" && "provider" in value && value.provider === "github" && "id" in value && typeof value.id === "string") {
		if (!value.id.startsWith(PREFIX)) throw new Error("Unknown GitHub reference encoding");
		return GitHubExternalRefSchema.parse(JSON.parse(Buffer.from(value.id.slice(PREFIX.length), "base64url").toString("utf8")));
	}
	return GitHubExternalRefSchema.parse(value);
}
