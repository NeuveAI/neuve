# Ace frontend integration

This app, `packages/ui` and `packages/split-tabs` come from [Ace revision fe662779](https://github.com/githubnext/ace/tree/fe66277931d2c46f12dcc250b63e1b4428a4e9ee). That revision is the source for the application composition, project navigation, dashboard, channels, GitHub work, panels, browser client contract and styling. [UPSTREAM-LICENSE](UPSTREAM-LICENSE) retains its MIT license.

Of the 161 original files under `packages/ui/src`, 160 are unchanged from that revision apart from the naming changes below. ChatComposer adds the optional `Mode.mentionAliases` contract and a token helper so saved drafts and history recognize legacy agent mentions. Its CSS, styles and layout are unchanged. The original HTML, CSS, assets, main entry, navigation and layout components remain. Neuve's review app keeps its own components and styles on a separate origin.

Plan mode (NEU-424) changes these upstream files further, for the later rewrite tasks to find:

- `packages/ui/src/components/composer/chat-composer.tsx` sends every change of mode, the mode menu's included, through the new `mode-marker.ts` beside it. That rule tells `onModeChange` whether a person chose the mode in the menu, and reports a menu choice even when the mode stays. The other causes are the draft's markers, a restored draft, Escape, `!` and history recall. None of them enters or leaves the `plan` mode. A restored draft no longer sets the mode, because drafts stay per scope while the app remembers the mode per chat. Plan drops other modes' markers when it is entered, and a mention typed in it stays a mention. It shows the model and effort pickers in Plan as in the agent's mode, and adds an optional `Mode.color` for the mode's icon, as `Agent.color` is used. `packages/ui` gains a `test` script and the test launcher's `bunfig.toml` for the rule's test.
- `apps/app/src/composer.tsx` offers Plan between Chat and the agent. An ask carries a mode only when it changes the chat's stored mode. Through `composer-mode.ts` the composer remembers only a person's menu choice, per chat. Other changes last while the chat is open, and none is taken before the chat's stored mode is known, which the composer starts from. It removes the old per-channel value. `conversation.tsx` passes the chat's stored mode. `transcript.ts` keeps the mode each reply's run ran in, and `timeline.ts` labels a reply written in Plan. The shared `types.ts` and `lib/timeline.ts` in `packages/ui` let an agent's message carry the label that a person's message already could.

The plan, the Plan tab and approval (NEU-458) change these upstream files further:

- `packages/ui/src/components/requests/question.tsx` and `review.tsx` draw on one shared card shell, `card.tsx` beside them, with no visible change. The plan's card (`plan.tsx` there) uses the same shell, and `components/plan/plan-view.tsx` is the Plan tab's view. `types.ts`, `lib/timeline.ts`, `components/blocks` and `components/timeline/layout.ts` and `timeline.tsx` place the plan's card in the timeline as they place the review card.
- `apps/app/src/layout/storage.ts` and `layout.tsx` add the Plan tab, which opens beside the chat once for each new plan, and offer it in the new-tab menu. `channel.tsx` renders it from `panels/plan.tsx`. `transcript.ts` keeps the chat's plans, `conversation.tsx` places their cards, turns on the `plan.md` reference and passes it to `composer.tsx`, `details.ts` shares the plans and the Plan tab's opener, `review-card.ts` places plan cards with review cards, and `timeline.ts` gives the plan's writing tool a plain row.

Approval requests in the chat change these upstream files further:

- `packages/ui/src/components/requests/approval.tsx`, Ace's unused approval view, is deleted. `packages/ui/src/index.ts` exports the shared card shell, the `Code` block, `Diff` and `patchFile` instead, which the app's approval card uses. `components/diff/diff.tsx` and `lib/highlighter.ts` let a diff wrap its long lines instead of scrolling them.
- `transcript.ts` keeps the chat's approval requests, `conversation.tsx` shows their cards above the composer where the question shows, and `composer.tsx` and the new channel's first message in `app.tsx` mark the chat attended. `package.json` gains `jsdom` for the card's tests.

Menus and popovers open and close with motion: `packages/ui/src/shadcn.css` scans `ui/popup.ts`, whose classes it never saw, and `popup.ts` keeps only the enter and exit animations, which play only when motion is allowed. Their timing comes from Neuve's popover tokens in `styles/neuve.css`.

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

Approving a plan returns the approving browser's composer to the mode it had before Plan: `composer-mode.ts` keeps that mode per chat when the menu enters Plan, and the Plan tab (`panels/plan.tsx`) and the plan card's approval in `conversation.tsx` restore it once approval succeeds, unless the person has since left Plan.
