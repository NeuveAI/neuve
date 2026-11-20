type Marked = { id: string; mention?: string };

/** Plan has no mention as its marker, so only the mode menu leaves it: never a draft or a key. */
function held(mode: string) {
	return mode === "plan";
}

/**
 * The mode a draft's mentions call for: another mode's marker moves to that mode, and losing the
 * current mode's marker returns to the first. `has` says whether the draft holds a mode's marker.
 */
function markedMode<M extends Marked>(
	modes: readonly M[],
	current: string,
	has: (mode: M) => boolean,
) {
	if (held(current)) return current;
	for (let mode of modes) {
		if (mode.mention && mode.id !== current && has(mode)) return mode.id;
	}
	let mode = modes.find(item => item.id === current);
	return mode?.mention && !has(mode) ? modes[0]!.id : current;
}

export { held, markedMode };
