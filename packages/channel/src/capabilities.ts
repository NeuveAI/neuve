import { createRegistry, type RegistryReader } from "@earendil-works/pi-durable";

/** Resolve availability on every agent resolution, including stored extension selections. */
export function capabilities(registry: RegistryReader, desktop: () => boolean): RegistryReader {
	return {
		subscribe: listener => registry.subscribe(listener),
		snapshot() {
			const snapshot = registry.snapshot();
			if (desktop()) return snapshot;
			const effective = createRegistry();
			for (const extension of snapshot.installed()) {
				effective.install(extension.name === "ace-desktop"
					? { ...extension, tools: [], sections: [] }
					: extension);
			}
			return effective.snapshot();
		},
	};
}
