import { expect, test } from "bun:test";
import { PI_TRANSITION_STORAGE_PROFILE } from "../../../scripts/pi-storage.ts";
import { testTemporaryDirectory } from "./fixtures/temporary.ts";

// Pin both branches because falling back on the owner's Mac would fill the main drive.
test("a present owner volume requires external TMPDIR", () => {
	for (const configured of [undefined, "/tmp", `${PI_TRANSITION_STORAGE_PROFILE.volume.mountPoint}-other/tmp`])
		expect(() => testTemporaryDirectory({ volumePresent: true, environment: { TMPDIR: configured }, temporary: "/tmp" })).toThrow("Use the external temporary directory");
	const temporary = `${PI_TRANSITION_STORAGE_PROFILE.volume.mountPoint}/tmp`;
	expect(testTemporaryDirectory({ volumePresent: true, environment: { TMPDIR: temporary }, temporary })).toBe(temporary);
});

test("an absent owner volume uses the platform temporary directory", () => {
	for (const configured of [undefined, "/tmp"])
		expect(testTemporaryDirectory({ volumePresent: false, environment: { TMPDIR: configured }, temporary: "/platform/tmp" })).toBe("/platform/tmp");
});
