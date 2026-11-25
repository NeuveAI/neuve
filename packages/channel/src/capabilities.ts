import { createRegistry, type RegistryReader, type RegistrySnapshot } from "@earendil-works/pi-durable";
import { DESKTOP_EXTENSION } from "./desktop";

/** Resolve availability on every agent resolution, including stored extension selections. */
export function capabilities(registry: RegistryReader, desktop: () => boolean): RegistryReader {
	let source: RegistrySnapshot | undefined;
	let hidden: RegistrySnapshot;
	return {
		subscribe: listener => registry.subscribe(listener),
		snapshot() {
			const snapshot = registry.snapshot();
			if (desktop()) return snapshot;
			if (snapshot !== source) {
				const effective = createRegistry();
				for (const extension of snapshot.installed()) {
					if (extension.name !== DESKTOP_EXTENSION) effective.install(extension);
				}
				hidden = effective.snapshot();
				source = snapshot;
			}
			return hidden;
		},
	};
}
