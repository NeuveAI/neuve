// Redirect only fixture processes to their scratch settings, including real CLI entry points.
import { spyOn } from "bun:test";
import { z } from "zod";
import * as Settings from "../../../../packages/harness/src/settings.ts";

const path = z.string().min(1).parse(process.env.FRESH_STORE_SETTINGS);
const read = Settings.readSettings;
spyOn(Settings, "readSettings").mockImplementation(() => read(path));
