# Secrets and exfiltration: a credential guard and a vault

Research, 2 November 2026. Nothing here is decided. It proposes two layers of the owner's multi-layered security model: a **credential guard** that watches what Neuve sends out, and a **vault** that keeps environment values out of logs, messages and stored artifacts. Both names are the owner's working words for this study. Neither is in the [product vocabulary](../../vocabulary.md) yet, so neither should be used as a product term until the owner adds it.

Web sources were read on 2 November 2026. Vendor claims are marked as such, and anything not confirmed is marked **unverified**.

## The short answer

- **The guard has two halves.** A thin broker sits on the path out. It holds the real credentials, injects them into approved requests, and refuses a request that carries a known credential value. It does exact-value checks only, so it adds no scan time. A separate background watcher reads a record of everything that left and runs the heavy scans off the critical path, the same way decision 12.27 already moved Capture's scan off the close.
- **The vault stores nothing of Neuve's own.** That respects [decision 10.5](../../process/decisions.md), under which Neuve stores, generates and manages no credentials of its own. Configuration holds references, such as a keychain name, a 1Password reference or a Cloudflare Secrets Store binding, never values. Only the broker resolves them. Inside Neuve a resolved value travels as an Effect `Redacted`, and it is unwrapped in one place, the broker's injection point.
- **Smallest first steps.** For the guard: register every credential Ace seals, plus one canary, with the detectors the existing background scan already uses. For the vault: turn the credential-bearing settings fields into references read through `Schema.Redacted`.

## What Neuve does today

These facts come from the rewrite in this repository, read on 2 November 2026.

**Capture's credential scan (decisions 12.26 and 12.27).** The scan works on known values. At each model call the route registers the credentials it sent: headers, authorization tokens and cookie values. Each is recorded as a keyed digest and a short prefix in [`credential-detectors.ts`](../../packages/harness/src/pi/capture/credential-detectors.ts). The scan then looks for those exact values in four encodings: UTF-16 strings, raw UTF-8, UTF-16LE and UTF-16BE. Since 12.27 the scan runs as a Records queue job after the close. A capture is marked clean only when its scan passes. Export, the shareable copy and the scorer read that mark and never scan again.

**What the scan's final security review says it guards.** The final security review of the background scan (a private coordination record) approved it. It found no path for bytes that were not scanned clean to leave through export, scoring, the portable copy, the replay dump or a receipt. The scan child gets no provider keys. Its stderr is never relayed, and stored errors carry only public fields.

**What that review says the scan does not guard:**
- The Modal replay's whole-store archive (`store.tar`) carries raw captures that were never scanned off the machine. The review files this beside S6, an earlier finding about `--archive-store` in the same review trail.
- Raw bytes can outlive the 30-day prune, in SQLite free pages (there is no `secure_delete`) and in migration backups.
- A trusted in-process writer can forge a mark, by design.

**What the scan does not cover at all.** The scan guards one egress point, Records leaving through export. It recognizes only the credentials a model route registered. These things are outside it:

- **Other credentials.** `GH_TOKEN`, the Modal tokens, and any secret in the repository or in the user's environment are never registered.
- **Other egress points.** The scan does not watch git pushes, pull-request bodies or comments, the agent's own network calls, OTLP telemetry, the review desk's rendering of agent text, or the content sent to the model provider.

**Ace's key handling** ([`apps/neuve-host/src/keys.ts`](../../apps/neuve-host/src/keys.ts)):
- Keys resolve from `ACE_<NAME>`, then `<NAME>`, then the OS keychain through `Bun.secrets`.
- `seal()` removes variables whose names end in `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD` or `_CREDENTIAL(S)` from `process.env` before tools run. The GitHub CLI receives only `GH_TOKEN`.
- Two limits:
  - The seal works by name. A secret under another name, such as a database URL with a password in it, is not sealed.
  - Channel workers still hold the real values in memory (`workerEnv`), and agents run `lane push` and `gh pr create` themselves with the host's GitHub token. The agent's process tree therefore has both an outbound channel and a credential.

**Redaction elsewhere.** Neither of these is the main guard:
- [`masking.ts`](../../packages/harness/src/masking.ts) masks credential shapes in raw captures.
- [`pr-replay/redact.ts`](../../packages/evaluation/src/pr-replay/redact.ts) masks secret-shaped text in cloud stderr.

**Telemetry.** [`settings.ts`](../../packages/harness/src/settings.ts) builds the OTLP exporters from explicit settings and reads no `OTEL_*` variable. Its `telemetry.otlp.headers` field is a plain string map, so a collector's auth token sits in the settings file as a value. Only `count-tokens.ts` uses Effect's `Redacted` today.

**Prior art inside Neuve.** [Decision 10.131](../../process/decisions.md) already has the brokered shape for the cloud's ChatGPT sign-in: one refresher holds the sign-in, and review machines only borrow short-lived access.

## Research findings

### 1. Secret managers and references in place of values

| Tool | What matters here | Source |
| --- | --- | --- |
| 1Password CLI | `op://vault/item/field` references in env files and config. `op run` resolves them for one subprocess and masks them in its output; `op inject` fills a template. Service accounts restrict the CLI to chosen vaults (third-party: needs CLI 2.18 or later, token in `OP_SERVICE_ACCOUNT_TOKEN`; **unverified**) | [secret references](https://developer.1password.com/docs/cli/secret-references), [secrets in scripts](https://developer.1password.com/docs/cli/secrets-scripts) |
| HashiCorp Vault | Dynamic secrets always carry a lease. Revoking a token revokes every lease made with it, and leases can be revoked by prefix. Response wrapping hands over a one-time, short-lived token. Read only in secondary sources, so **unverified** against the official docs | [lease concepts (mirror)](https://docs.enclaive.cloud/vault/documentation/concepts/operations/lease-renew-and-revoke), [wrapping lifecycle issue](https://github.com/hashicorp/vault/issues/12173) |
| Doppler, Infisical | Both resolve references and inject them as environment variables (`doppler run`, `infisical run`). Infisical is open source and can be self-hosted. Neither keeps a value away from whatever authenticates (vendor comparisons, 2025–26) | [Infisical vs Doppler (vendor)](https://infisical.com/infisical-vs-doppler), [Doppler's comparison (vendor)](https://www.doppler.com/blog/infisical-doppler-secrets-management-comparison-2025) |
| Cloudflare Secrets Store | Account-level secrets bound to a Worker with `secrets_store_secrets` and read with `env.<binding>.get()`. A deployer role can bind a secret without seeing its value. Production values cannot be read locally. Open beta | [Workers integration](https://developers.cloudflare.com/secrets-store/integrations/workers/), [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/) |
| macOS Keychain through `Bun.secrets` | Uses the login keychain on macOS, libsecret on Linux and Credential Manager on Windows. Bun says it is mainly for local developer tools, and an older page calls it experimental | [Bun secrets](https://bun.com/docs/runtime/secrets) |
| Modal Secrets | Named secrets become environment variables of a function or sandbox. Modal advises attaching a stored secret instead of passing keys in `env` | [Modal JS Secret](https://modal.com/docs/sdk/js/latest/Secret) |
| fnox | A local secrets tool combining references, short-lived "leases" and a placeholder proxy (below) | [leases](https://fnox.jdx.dev/guide/leases.html) |

**What they share.** Every store hands the value to whatever authenticates to it. A reference keeps the value out of configuration and the repository. It does not keep the value out of the process that resolves it.

### 2. Credential brokering, so the agent never holds the key

- **Placeholder and injecting proxy.** This is the established pattern. The agent's environment holds a placeholder. Every outbound request goes through a proxy outside the sandbox, which swaps in the real value for approved destinations and refuses the rest. Sources:
  - [fnox proxy](https://fnox.jdx.dev/guide/proxy.html): placeholders, strict egress by default, rules per domain, header, method and path. It warns that it is "not yet an operating-system sandbox".
  - [Hermes iron-proxy](https://hermes-agent.nousresearch.com/docs/user-guide/egress/iron-proxy).
  - [Blaxel](https://blaxel.ai/blog/egress-proxy-api-credentials-ai-agent-sandboxes).
  - [Simon Edwards, 5 June 2026](https://simedw.com/2026/06/05/proxy-agents/): a firewall allowlist cannot inject the right key.

  The proxy, and its interception CA if it terminates TLS, becomes the trust boundary.
- **Cloudflare's version.** Outbound Workers for Sandboxes and Containers ([changelog, 13 April 2026](https://developers.cloudflare.com/changelog/post/2026-04-13-sandbox-outbound-workers-tls-auth/); [blog, 13 April 2026, updated 15 July 2026](https://blog.cloudflare.com/sandbox-auth/)):
  - Handlers run outside the sandbox and can set an auth header from a Worker secret.
  - Credentials can differ per instance, keyed by container ID.
  - Allowed and denied hosts can be changed at runtime with `setOutboundHandler`.
  - Requires `@cloudflare/sandbox` 0.8.9 or `@cloudflare/containers` 0.3.0.
  - HTTPS inspection uses a per-sandbox ephemeral CA.
- **Git through a proxy.** In [Anthropic's sandboxing write-up (20 October 2025)](https://www.anthropic.com/engineering/claude-code-sandboxing), Claude Code on the web keeps git credentials outside the sandbox. The git client authenticates to a proxy with a scoped credential. The proxy checks the operation, for example that a push targets only the configured branch, then attaches the real token.
- **GitHub's version.** [GitHub's Copilot cloud agent](https://docs.github.com/en/copilot/concepts/security-governance-and-network-settings/risks-and-mitigations) limits pushes to `copilot/` branches, runs a firewall by default, and needs a human's approval before Actions run on its pull requests.
- **Short-lived, scoped tokens:**
  - **GitHub App installation tokens** ([GitHub docs](https://docs.github.com/es/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)) expire after one hour. They can be narrowed to named repositories and to fewer permissions. GitHub began rolling out a new stateless token format on 27 April 2026, so code should not depend on a token's shape.
  - **OpenAI project keys** can be restricted or read-only per endpoint ([OpenAI help](https://help.openai.com/en/articles/9186755-managing-your-work-in-the-api-platform-with-projects)).
  - **Anthropic workspace keys** can carry workspace spend limits, but only a third-party source says so ([Requesty blog](https://www.requesty.ai/blog/llm-spend-limits-per-api-key-and-customer)); **unverified**.
  - **OIDC federation**, where a workload trades its identity for a short-lived cloud credential, is the standard way to avoid stored keys in CI. It is not researched further here because Neuve's runs are not CI jobs today.
- **Revocation.** Short-lived tokens limit the damage by expiry. Vault-style leases allow revocation by token or prefix. A broker that mints a token for each run can revoke all of that run's tokens when the run ends.

### 3. Keeping secrets out of logs and telemetry

- **Redact at the source with a typed wrapper.** In Effect 4.0.0, the version Neuve pins, `Redacted` prints and serializes as `<redacted>` or `<redacted:label>`. This was checked in the installed source, where `toJSON` returns `toString()`. Three related APIs:
  - `Config.Redacted(name)` reads a secret setting straight into a `Redacted`.
  - `Schema.Redacted(schema, { label, disallowJsonEncode })` makes JSON encoding fail instead of printing the placeholder.
  - `Redacted.value` unwraps the value, and `Redacted.wipeUnsafe` clears it.

  [Effect's v4 page](https://effect.website/docs/v4/data-types/redacted.md) warns that protection ends once `Redacted.value` is called and the result is logged or stored.
- **Collector processors are a backstop.** The OpenTelemetry Collector's [redaction processor](https://pkg.go.dev/github.com/open-telemetry/opentelemetry-collector-contrib/processor/redactionprocessor@v0.111.0) keeps only `allowed_keys` and masks values that match `blocked_values` patterns. Its own documentation calls it one line of defence. [Splunk's guide to the same processor](https://help.splunk.com/en/splunk-observability-cloud/manage-data/manage-sensitive-data/sanitize-data-with-opentelemetry-collector-processors/redaction-processor) says the same.
- **Why pattern redaction after the fact is weaker:**
  - It finds only known shapes, so an internal token format or a password passes.
  - It misses transformed values: base64, URL-encoded, split across fields or lines.
  - It produces false positives that people learn to ignore.
  - Above all, it runs after the value has already been written, sent or buffered somewhere else.

  Exact known-value matching, which Neuve's capture detectors already do, has no false positives for registered values. But it knows only what was registered. The two approaches complement each other.

### 4. Detection on the way out

- **Three kinds of detection** (sources: [Jit comparison](https://www.jit.io/blog/trufflehog-vs-gitleaks-a-detailed-comparison-of-secret-scanning-tools), [AppSec Santa](https://appsecsanta.com/secret-scanning-tools/gitleaks-vs-trufflehog); secondary):
  - **Pattern and entropy**, as in gitleaks with TOML rules plus entropy and a baseline. It is fast and offline, which suits a pre-commit hook.
  - **Verified**: TruffleHog keeps only matches that authenticate. It is precise, but it calls the provider with the found key, which is itself a send-out.
  - **Baseline-first**: detect-secrets records accepted findings in `.secrets.baseline`.

  The common advice is to layer them.
- **GitHub push protection** ([about push protection](https://docs.github.com/en/code-security/concepts/secret-security/about-push-protection), [custom patterns](https://docs.github.com/enterprise-cloud@latest//code-security/secret-scanning/using-advanced-secret-scanning-and-push-protection-features/custom-patterns)):
  - It blocks pushes carrying known provider token formats.
  - Custom patterns are regular expressions on paid plans.
  - By default anyone with write access can bypass it by giving a reason.

  It is a server-side last check, not Neuve's guard.
- **Canary tokens.** A canary is a fake but live-looking credential whose use raises an alert:
  - [Thinkst's AWS canary](https://help.canary.tools/hc/en-gb/articles/4415516925585-AWS-API-Key-Canarytoken-safety-net-triggered) watches AWS logs and runs a safety-net check for uses the logs miss.
  - [Grafana Labs (25 August 2025)](https://grafana.com/blog/2025/08/25/canary-tokens-learn-all-about-the-unsung-heroes-of-security-at-grafana-labs/) contained a real intrusion within minutes this way.
  - A canary alerts after use, not before. [grith's documentation](https://docs.grith.ai/docs/concepts/canary-tokens) instead gates an outbound payload that contains a registered canary (vendor).
- **Scanning agent outputs before publication.** In [GitHub Agentic Workflows' threat detection](https://github.github.com/gh-aw/reference/threat-detection/) (public preview, June 2026):
  - The agent job is read-only and proposes "safe outputs".
  - A separate detection job reads the proposed issues, comments and patch, judging prompt injection, secret leaks and malicious patches, before any write job runs.
  - Custom steps can run TruffleHog on the patch.
  - The default is warn mode: reviewable outputs are labelled and still go out, and only irreversible ones are held back. Strict mode applies nothing.
- **Off the critical path.** This is the same principle as 12.27:
  - Keep only cheap, exact checks inline: known values, canaries, destination rules.
  - Put the full scan on a queue that never makes the review wait.
  - Hold back only what cannot be taken back, such as a push, a published comment or a dataset export.

### 5. Prompt-injection channels that carry data out

[Simon Willison's "lethal trifecta" (16 June 2025)](https://simonwillison.net/2025/jun/16/the-lethal-trifecta/) is the frame: private data, untrusted content and a way to communicate out. Neuve's agents have all three. They read untrusted repository code, they can reach keys and private source, and they can push and use the network. The reliable fix is to remove a leg rather than filter it.

| Channel | Known case | What closes it |
| --- | --- | --- |
| Markdown image or link URL with data in the query | Cline, Amp, OpenHands token leak ([Embrace The Red, 2025](https://embracethered.com/blog/posts/2025/openhands-the-lethal-trifecta-strikes-again)) | Don't load external images automatically: a content security policy `img-src` limited to own origins in the review desk. Neutralize links to hosts not on the allowlist before publishing. GitHub proxies images through its own image proxy, but whether that still requests the attacker's URL is **unverified** |
| Tool arguments (fetch, MCP, shell) | HiddenLayer's README injection in Cursor ([grith summary](https://grith.ai/blog/your-ai-agent-has-broad-access)) | An egress allowlist at the proxy, plus a known-value check on outbound bodies |
| DNS | Claude Code CVE-2025-55284, fixed in 1.0.4 ([Embrace The Red](https://embracethered.com/blog/posts/2025/claude-code-exfiltration-via-dns-requests)); AWS AgentCore ([CSA note, March 2026](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-sandbox-dns-exfiltration-bedrock-langsm/)) | No direct network from the sandbox; name resolution only through the proxy. A command allowlist alone failed here |
| Git push to a fork or another remote | Agents push with the host's token today | A git proxy that permits only the lane's remote and branch; a GitHub App token scoped to one repository; no token in the agent's environment |
| Pull-request bodies and comments | Any agent with a write token | The agent proposes; a separate publisher checks and posts (the gh-aw shape) |
| Prompt content sent to the model provider | Inherent | Cannot be closed; it is the work. Narrow what the agent can read (sandbox denies for `~/.config/neuve`, `.env`, keychains), and keep Capture's known-value scan on what was recorded |
| Telemetry and logs | General | `Redacted` at the source; a collector redaction processor as backstop |

## Mapping to Neuve

### Where Neuve sends things out

1. Model-provider calls: the credential in headers, and the review content in bodies.
2. The agent's own processes: shell, network tools, MCP tools.
3. GitHub: clone, `lane push`, `gh pr create`, comments.
4. Records leaving the machine: export, the shareable copy, the scorer, datasets.
5. The Modal replay's archive and cloud stderr.
6. OTLP telemetry and the run log.
7. The review desk rendering agent-written briefings and comments in a browser.
8. On the hosted target, every outbound request from a Worker or container.

### The credential guard: an independent service at those points

**Two parts, on separate trust footing:**

- **Broker, on the path.** A separate local process (on the hosted target, an outbound Worker) owns the real credentials and is the only exit for points 1 to 3.
  - Agents and workers receive placeholders.
  - The broker injects the real value by destination rule.
  - It checks each outbound body for registered values, meaning real credentials, placeholders and canaries, with the same keyed-digest detectors Capture uses.
  - It refuses only a request that contains one, or one to a destination with no rule.
  - It never runs pattern scans inline, so it never makes the review wait.
  - For git, it permits only the lane's own remote and branch, and only with a short-lived token scoped to that repository.
- **Watcher, in the background.**
  - The broker and each publishing step append a record of what left, where it went and its content hash. "Record of send-outs" is a description, not a proposed term.
  - The watcher consumes these through a Records queue job with the same rules as 12.27: the background slot, spaced retries, a dead-letter list.
  - It runs pattern and entropy scans, and only on the owner's choice verified ones, since verifying sends the key to its provider.
  - It watches for canary use and tampering: a change to a lane's git remotes, hooks or CI workflow files; a detached child process outliving its run; a guard configuration that changed outside the install path.
  - On a finding it records a refusal and revokes that run's short-lived tokens. It does not stop the review.

**Holding back what cannot be taken back.** The pre-publication check at points 3, 4 and 5 sits in front of the action, like the mark gate 12.27 already uses for export. It holds only that action until its job passes; the review itself carries on.

**Kept narrow:**
- The guard sees send-outs and registered digests, not the repository or Records at large.
- It writes only its own findings.
- It cannot mark a capture clean; the scan job's mark stays the authority.
- It holds only the credentials for the destinations it brokers.

**"Forks" is ambiguous in the owner's goal.** This design covers both readings, git pushes to a fork and stray process forks. Which one the owner meant is **open**.

### The vault: local and hosted

- **No storage of Neuve's own (10.5).** Neuve's settings and lane configuration hold references only. A reference names its store:
  - the OS keychain, through `Bun.secrets`;
  - a 1Password reference resolved with a service account scoped to one vault;
  - an environment variable name;
  - a Cloudflare Secrets Store binding;
  - a Modal Secret name.

  Only the broker resolves them.
- **Local mode.**
  - The broker resolves at first use, holds each value as a `Redacted`, and hands workers placeholders.
  - The OpenAI sign-in file under `~/.config/neuve/` (10.85) stays where it is, but becomes readable by the broker only, and the sandbox must deny it to agents.
  - The research on sandboxing written alongside this study owns that enforcement. It is not linked here because its file name was not fixed when this was written.
- **Hosted mode (Cloudflare).**
  - Secrets Store bindings attach only to the outbound Worker. Sandboxes and containers get no bindings.
  - Credentials for each run come from short-lived tokens the broker mints, or from KV keyed by container, as Cloudflare's blog shows.
  - Secrets Store is in open beta, so its limits need checking before relying on it (**unverified** for production use).
- **Modal.** Keep the 10.131 shape: the refresher alone holds the Modal Secret, and review machines borrow short-lived access.

### How `Redacted` and typed boundaries carry it

- **Schema.** A credential-bearing field in `records-schema` or in settings is `Schema.Redacted(..., { disallowJsonEncode: true })`. A record, receipt or log line holding one then fails to encode instead of storing the value. That covers the OTLP `headers` field, which should become a reference.
- **Reading values.** Use `Config.Redacted` wherever Effect reads a secret value.
- **One unwrap point.** `Redacted.value` is allowed only in the broker's injection module. A `bun run check` rule that refuses it anywhere else would make that boundary visible to review. This is a proposal; whether the check may grow is the owner's call.
- **Registration by type.** A credential becomes known to the guard when it becomes a `Redacted`, not by name matching. That closes `seal()`'s gap for secrets under other names.

### Smallest first step for each

1. **Guard.** Register every credential Ace seals (`GH_TOKEN`, the Modal tokens, the lease keys), plus one canary credential, with the existing detectors. The current background scan then covers them at export with no new service. Next: a git proxy for `lane push` that permits only the lane's remote and branch, so the agent no longer holds the GitHub token.
2. **Vault.** Change the OTLP `headers` setting and the provider-key lookups to references read through `Schema.Redacted`, with `disallowJsonEncode`. Next: move model-route credentials out of the worker into the broker.

### What each does not cover

- **The guard does not stop:**
  - leaks through the model provider's own channel;
  - encoded or chunked secrets the watcher's patterns miss;
  - reads of local files by the same user without a sandbox;
  - a compromised broker, which becomes the new trust boundary.

  A canary alerts after use, not before. Pre-publication checks catch secrets, not every harmful change; the gh-aw documentation says the same.
- **The vault does not stop:**
  - a value unwrapped and then logged;
  - a secret that entered as plain text, such as an agent reading `.env` or the model echoing a key;
  - a compromise of the resolving store or of the broker's process.

  Capture's known-value scan stays needed for these.
- **Neither one addresses the open items from the background scan's review.** The archive that carries unscanned raw captures, and bytes outliving the prune, need their own fixes: putting the archive behind the mark gate, and `secure_delete` or vacuuming with backups pruned. Both are proposals here.

## Open points for the owner

- Whether "credential guard" and "vault" become vocabulary terms, and with what meaning.
- What "forks" means in the goal: git forks, process forks, or both.
- Whether the watcher may run verified detection, since verifying a key sends it to its provider.
- Whether a GitHub App, as opposed to the user's `gh` sign-in, fits decision 10.5's "no credentials of Neuve's own".
