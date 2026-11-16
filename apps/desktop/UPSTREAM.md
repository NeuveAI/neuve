# Ace desktop supporting sources

This complete tree comes from [Ace fe662779](https://github.com/githubnext/ace/tree/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/apps/desktop). The app imports the original desktop protocol rather than a copied type facade. Browser launch does not execute native helpers.

Original source, icons, native helpers, notices and release scripts are retained. `scripts/helper.ts`, `scripts/notices.ts` and the development launch in `scripts/build.ts` change only the host source path from `apps/host` to this repository's existing `apps/neuve-host` destination. Package manifests materialize pinned catalog versions and expose the original native compiler check as `typecheck`. The TypeScript configuration extends the copied original compiler policy in `tsconfig.ace.json` and resolves `bun` through `./node_modules/@types/bun/index.d.ts`, the actual installed original Bun 1.3.14 platform declarations. This keeps the declarations' bare self-import from resolving root Bun 1.4.4 and merging incompatible FFI types. All original strictness flags remain. TypeScript documents [how paths affect compiler resolution while leaving emitted imports unchanged](https://www.typescriptlang.org/tsconfig/paths.html).

No desktop launch, installation, release, permission grant or deployment is part of restoring these files.

For Neuve's name (decision 12.18), shown strings in `src` say Neuve, including the window title, the app menu and Neuve Helper. The bundle name, identifier, URL schemes, icons, helper binary name and the microphone and speech usage strings in `electrobun.config.ts` and `scripts` still say Ace, so messages that point at Login Items or the Applications folder keep Ace's name, which is what macOS shows.

The five original-file seams are `apps/desktop/package.json` for pinned dependency materialization and the root typecheck command, `apps/desktop/tsconfig.json` for the copied original compiler base and actual Bun platform declaration resolution, and `apps/desktop/scripts/helper.ts`, `apps/desktop/scripts/notices.ts` and `apps/desktop/scripts/build.ts` for the existing host destination path.
