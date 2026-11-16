import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

/** Detached test workers belong to the test runner, which may outlive their starter. */
const watchFixtureOwner = () => {
  const directory = process.env.NEUVE_FIXTURE_OWNER;
  if (directory === undefined) return;
  writeFileSync(join(directory, `${process.pid}.pid`), String(process.pid));
  const audit = process.env.NEUVE_FIXTURE_AUDIT_DIRECTORY;
  if (audit !== undefined)
    writeFileSync(join(audit, `${process.pid}.pid`), String(process.pid));
  const socket = createConnection(join(directory, "owner.sock"));
  const exit = () => process.exit(143);
  socket.once("end", exit);
  socket.once("close", exit);
  socket.once("error", exit);
};

watchFixtureOwner();
