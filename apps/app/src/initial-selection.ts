import { checkoutId } from "@ace/host/protocol";
import type { AppProject } from "./projects";

export function initialProject(available: AppProject[], host: string, path: string | null): AppProject | undefined {
	return path === null ? undefined : available.find((value) => value.checkouts.has(checkoutId(host, path)));
}
