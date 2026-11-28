# Ace service sources

The [service notice](NOTICE) retains Ace's MIT license for these copied trees.

The complete `directory`, `channel` and `compute` trees are restored from [Ace fe662779](https://github.com/githubnext/ace/tree/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/services). These sources implement the directory, hosted-channel and compute operations used by the original host. Restoring them does not deploy or configure those services.

Deployment configuration retains its pinned bytes. Source changes appear in the table below. Package manifests materialize the original catalog versions because Neuve uses an array workspace declaration. Their `typecheck` scripts expose the original native compiler checks to the root workspace selector. TypeScript configurations extend the copied original compiler policy in `tsconfig.ace.json`; no service source is rewritten to satisfy Neuve's stricter consumer flags. Directory package type exports use checked generated declarations while runtime exports retain its actual source.

These original-file seams retain the actual implementations:

| Candidate path | Change and reason |
| --- | --- |
| `services/channel/package.json` | Materialize pinned catalog dependencies and expose the original native compiler command as `typecheck` for root workspace selection. |
| `services/channel/tsconfig.json` | Point at the copied original `tsconfig.ace.json` so the service retains its pinned compiler policy. |
| `services/compute/package.json` | Materialize pinned catalog dependencies and expose both original worker and runner compiler checks as `typecheck`. |
| `services/compute/tsconfig.json` | Point at the copied original compiler policy for the Cloudflare worker. |
| `services/compute/tsconfig.runner.json` | Point at the copied original compiler policy for the Bun runner. |
| `services/directory/package.json` | Materialize pinned catalog dependencies, expose the original compiler as `typecheck`, and export checked generated declaration types alongside actual runtime source. |
| `services/directory/tsconfig.json` | Point at the copied original compiler policy so runtime-neutral consumers do not force Neuve's stricter flags into the directory implementation. |
| `services/channel/src/object.ts` | Validate a hosted channel request with the same schema as the local worker. The channel can then return a stored tool image.<br>`@@ -5,0 +6 @@`<br>`@@ -285 +286 @@` |
