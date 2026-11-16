import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { PI_TRANSITION_STORAGE_PROFILE } from "../../../../scripts/pi-storage.ts";

const ownerVolume = PI_TRANSITION_STORAGE_PROFILE.volume.mountPoint;

/** Keep temporary writes external on the owner's Mac; use platform defaults elsewhere. */
export function testTemporaryDirectory({
	volumePresent = existsSync(ownerVolume),
	environment = process.env,
	temporary = tmpdir(),
}: {
	volumePresent?: boolean;
	environment?: Readonly<Record<string, string | undefined>>;
	temporary?: string;
} = {}): string {
	if (volumePresent && !environment.TMPDIR?.startsWith(`${ownerVolume}/`))
		throw new Error("Use the external temporary directory");
	return temporary;
}
