import { Database } from "bun:sqlite";
import { join } from "node:path";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import {
  CredentialEpochId,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import { openPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
const [mode, root] = process.argv.slice(2);
if (root === undefined) throw new Error("fixture root missing");
const source = join(root, "source"),
  directory = join(root, "private");
if (mode === "uncommitted") {
  const database = new Database(join(directory, "authority.sqlite"));
  database.exec("BEGIN IMMEDIATE");
  database.query("UPDATE authority SET key=? WHERE id=1").run(Buffer.alloc(32));
  process.exit(93);
}
const ownership = SourceOwnership.acquire(source);
const authority = openPrivateInspection({
  ownership,
  source,
  directory,
  excludedRoots: [source],
});
try {
  if (mode === "register") {
    const result = await authority.register({
      epoch: CredentialEpochId.parse("child-committed"),
      headers: new Headers({ "x-api-key": "synthetic-child-secret" }),
      budget: new InspectionBudget(),
    });
    if (result.status !== "registered") process.exit(94);
    process.stdout.write(JSON.stringify({ registered: true }));
    process.exit(0);
  }
  const result = await authority.inspectText({
    text: "synthetic-original and synthetic-child-secret",
    budget: new InspectionBudget(),
  });
  if (result.status !== "complete") process.exit(95);
  process.stdout.write(
    JSON.stringify({
      epochs: [...new Set(result.matches.map((match) => match.epoch))].sort(),
    }),
  );
} finally {
  authority.close();
  ownership.release();
}
