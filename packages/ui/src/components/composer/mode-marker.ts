type Marked = { id: string; mention?: string; kind?: "chat" | "terminal" };

/** What, other than the mode menu, can move the composer's mode. */
type Cause<M> =
	/** The draft changed; `has` says whether it holds a mode's marker. */
	| { kind: "draft"; has: (mode: M) => boolean }
	/** A saved draft was restored. It belongs to the scope, while the mode belongs to the chat. */
	| { kind: "restore" }
	/** Escape, `double` when it follows another within the window. */
	| { kind: "escape"; double: boolean }
	/** `!` typed into an empty composer. */
	| { kind: "bang" }
	/** A sent message recalled from history, with the mode it was sent in. */
	| { kind: "recall"; mode?: string };

/** Plan has no mention as its marker, so only the mode menu enters or leaves it. */
function held(mode: string | undefined) {
	return mode === "plan";
}

/** The mode a cause moves the composer to; every change but the menu's goes through here. */
function nextMode<M extends Marked>(modes: readonly M[], current: string, cause: Cause<M>): string {
	if (held(current)) return current;
	let first = modes[0]!.id;
	switch (cause.kind) {
		case "draft": {
			// Another mode's marker moves to it; losing the current mode's marker returns to the first.
			for (let mode of modes) {
				if (mode.mention && mode.id !== current && cause.has(mode)) return mode.id;
			}
			let mode = modes.find(item => item.id === current);
			return mode?.mention && !cause.has(mode) ? first : current;
		}
		case "restore":
			return current;
		case "escape":
			if (current !== first) return first;
			return cause.double && modes.some(mode => mode.id === "ace") ? "ace" : current;
		case "bang":
			return modes.find(mode => mode.kind === "terminal")?.id ?? current;
		case "recall":
			return held(cause.mode) ? current : cause.mode || first;
	}
}

export { type Cause, held, nextMode };
