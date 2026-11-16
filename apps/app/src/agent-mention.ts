export const AGENT_ALIAS = { name: "neuve", label: "Neuve" };

// Match the channel's whole mention token, including hyphens and underscores.
const ALIAS = "(?:neuve|ace)";
const TOKEN = `${ALIAS}(?![a-z0-9_-])`;
const MENTION = new RegExp(`(^|\\s)@${TOKEN}`, "i");
const LEADING = new RegExp(`^\\s*@${TOKEN}`, "i");
const ALL = new RegExp(`(^|\\s)@${TOKEN}\\s*`, "gi");
const LEGACY = /(^|\s)@ace(?![a-z0-9_-])/gi;
const NAME = new RegExp(`^${ALIAS}$`, "i");

export function isAgentAlias(name: string): boolean {
	return NAME.test(name);
}

export function hasAgentMention(text: string): boolean {
	return MENTION.test(text);
}

/** Legacy mentions stay readable without adding a second invocation marker. */
export function withAgentMention(text: string): string {
	return hasAgentMention(text) ? text : `@${AGENT_ALIAS.name} ${text}`;
}

export function withoutLeadingAgentMention(text: string): string {
	return text.replace(LEADING, "").trim();
}

export function withoutAgentMentions(text: string): string {
	return text.replace(ALL, "$1").trim();
}

/** Editable drafts use the advertised alias; persisted transcript text stays unchanged. */
export function normalizeAgentDraft(text: string): string {
	return text.replace(LEGACY, `$1@${AGENT_ALIAS.name}`);
}
