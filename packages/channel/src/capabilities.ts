import { createRegistry, type RegistryReader, type RegistrySnapshot } from "@earendil-works/pi-durable";

/** Resolve availability on every agent resolution, including stored extension selections. */
export function capabilities(registry: RegistryReader, unavailable: () => readonly string[]): RegistryReader {
	let source: RegistrySnapshot | undefined;
	let hidden: readonly string[] = [];
	let visible: RegistrySnapshot;
	return {
		subscribe: listener => registry.subscribe(listener),
		snapshot() {
			const snapshot = registry.snapshot();
			const names = unavailable();
			if (names.length === 0) return snapshot;
			if (snapshot !== source || names.length !== hidden.length || names.some((name, index) => name !== hidden[index])) {
				const effective = createRegistry();
				for (const extension of snapshot.installed()) {
					if (!names.includes(extension.name)) effective.install(extension);
				}
				visible = effective.snapshot();
				source = snapshot;
				hidden = names;
			}
			return visible;
		},
	};
}
