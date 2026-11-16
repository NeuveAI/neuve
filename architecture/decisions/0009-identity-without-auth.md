# 0009: Identity without auth

Status: accepted, 16 October 2026. Source: decisions [1.5, 5.7 and 6.6](../../process/decisions.md).

## Decision

Neuve has no authentication or authorization code. Git credentials are enough for repository access.

Commits link to agent sessions through `post-commit` and `post-rewrite` records. The hook finds the session from the process ancestry first. When it cannot read the process table, as inside an agent's sandbox, it uses the agent session ID the harness sets in its shells, recorded as a declared link with its source (8.13). Otherwise the commit has no known author; the hook never guesses. In users' repositories an opt-in `Neuve-Session` trailer is also available. It is never used in this repository, which forbids agent attribution trailers (8.1).

Agents run in their own sessions in external harnesses and give Neuve a fingerprint. Records gives each agent an alias based on its fingerprint and attributes their work to it. It captures any valid telemetry and identifying metadata: harness, model, session ID, commits, turns and token usage. This follows entire-cli's pattern: sessions are tied to commits and the agent's own session ID is used. Neuve takes parts of entire-cli that fit its own principles, without fitting its product into Entire's.

## Consequences

- Remove all token gates, credential checks and auth documentation.
- Actor identity is for attribution, not access control. Actor kind (agent or human) still enforces review-workflow rules, such as an agent never approving a human-required unit (4.5). Those are rules about who decides in a lane, not security checks.
