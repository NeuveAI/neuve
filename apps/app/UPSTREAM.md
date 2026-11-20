# Ace frontend integration

This app, `packages/ui` and `packages/split-tabs` come from [Ace revision fe662779](https://github.com/githubnext/ace/tree/fe66277931d2c46f12dcc250b63e1b4428a4e9ee). That revision is the source for the application composition, project navigation, dashboard, channels, GitHub work, panels, browser client contract and styling. [UPSTREAM-LICENSE](UPSTREAM-LICENSE) retains its MIT license.

Of the 161 original files under `packages/ui/src`, 160 are unchanged from that revision apart from the naming changes below. ChatComposer adds the optional `Mode.mentionAliases` contract and a token helper so saved drafts and history recognize legacy agent mentions. Its CSS, styles and layout are unchanged. The original HTML, CSS, assets, main entry, navigation and layout components remain.

Plan mode (NEU-424) changes these upstream files further, for the later rewrite tasks to find:

- `packages/ui/src/components/composer/chat-composer.tsx` uses the new `mode-marker.ts` beside it, so a draft, Escape, `!` or history recall never moves the composer out of the `plan` mode. Only the mode menu does. It shows the model and effort pickers in Plan as in the agent's mode, and adds an optional `Mode.color` for the mode's icon, as `Agent.color` is used. `packages/ui` gains a `test` script and the test launcher's `bunfig.toml` for the rule's test.
- `apps/app/src/composer.tsx` offers Plan between Chat and the agent, and sends the chat's mode with an ask. It remembers the mode per chat through `composer-mode.ts`, starting from the chat's stored mode and removing the old per-channel value. `conversation.tsx` passes the chat's stored mode. `timeline.ts` sets the "Plan" label on the newest message that invoked the agent while that mode is Plan. Neuve's review app keeps its own components and styles on a separate origin.

The app is called Neuve, with Ace credited (decision 12.18 of the [design decisions](../../process/decisions.md)). Settings › General credits Ace, and [UPSTREAM-LICENSE](UPSTREAM-LICENSE) is kept as it is. The naming changes these places:

- Shown strings that named Ace say Neuve, in this app, `packages/ui` and `apps/desktop/src`. Ace stays where it names upstream code, commands, Ace's download and install steps, or what macOS shows for the desktop bundle.
- The window title, manifest, favicon and home-screen icons use Neuve's mark, reused from `apps/neuve-web`. Ace's logo, avatar, emoji and their assets in `packages/ui` are unchanged; [its notice](../../packages/ui/NOTICE.md) says the MIT license grants no rights to Ace's name or marks.
- The timeline draws an agent avatar the app passes, keyed by the agent's sender value, in place of Ace's own. The app passes Neuve's mark there and as the composer's agent mention avatar.

The integration changes these boundaries:

- Original protocol imports retain `@ace/channel/protocol` and `@ace/host/protocol`. Neuve review types use the separate `@ace/host/extension-protocol`. The original browser gateway client is exported by `@ace/host/gateway-client`. Its private authenticated connection stays on the server.
- Desktop protocol types import the restored original `@ace/desktop/protocol` source. The original Electrobun view code remains a build dependency. Browser launch does not execute native helpers.
- Issue and pull-request work retains its canonical source reference when it creates a channel. The original immediate create-and-ask behavior stays. Neuve review actions and history use the host's Records callbacks and exact cycle links.
- Explicit project, channel and chat addresses restore the relevant original view after a Neuve review. Ordinary launches keep Ace's saved selections. Team, onboarding, key, directory, move, sharing and window flows retain their original operations.
- Neuve provider usage can have no monetary price. Usage views preserve that uncertainty rather than display a zero cost.
- Package manifests materialize Ace's catalog versions. The original native TypeScript compiler and UI library-check option remain. Neuve's `.ts` protocol imports are enabled in the shared app compiler configuration.
- The root check invokes each actual Ace compiler and its Vite build with output on the configured external volume. The unsupported direct Vite WebSocket proxy is removed. `bun workspace` owns the validated same-origin coding listener.

The Base UI dependency patch from upstream is not applied. The root lockfile separately pins compatible Shiki dependencies for the Pierre and ProseMirror integration, and shares the React declaration version across the two frontend stacks. These are dependency-resolution changes, not component copies or type casts. The two apps retain their own React and Motion runtime versions.
