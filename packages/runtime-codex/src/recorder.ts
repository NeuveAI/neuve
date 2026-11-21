/**
 * Records a conversation with the real program for the replay tests: every line each way, as the
 * client's `onLine` hands it over, redacted before it is kept. A recording holds no credential, no email, no path of
 * the machine that made it, and no path into an app.
 */
import { writeFileSync } from "node:fs";
import type { Line } from "./client.ts";
import { redact } from "./redact.ts";

/** One line each way, as the client hands it to `onLine`. */
export type Recorded = Line;
export interface Recording {
  readonly version: 1;
  /** The release that answered, from the handshake's user agent. */
  readonly codex: string;
  readonly note: string;
  readonly entries: ReadonlyArray<Recorded>;
}

/** Writes a redacted recording to a new file; an existing one is never replaced. */
export const saveRecording = (
  path: string,
  recording: Recording,
  known: ReadonlyArray<readonly [string, string]>,
) =>
  writeFileSync(
    path,
    `${JSON.stringify(redact(recording, known), null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
