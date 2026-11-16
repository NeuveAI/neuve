/** Whole invocation tokens, excluding teammate suffixes and email addresses. */
export function mentionTokens(text: string, names: readonly string[]) {
	let tokens: { from: number; to: number }[] = [];
	for (let match of text.matchAll(/(^|\s)@([a-z0-9_-]+)/gi)) {
		if (!names.some(name => name.toLowerCase() === match[2]!.toLowerCase())) continue;
		let from = match.index + match[1]!.length;
		tokens.push({ from, to: from + match[2]!.length + 1 });
	}
	return tokens;
}
