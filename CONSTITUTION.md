# Repository constitution

## Contextual linkage

Accepted by the user on 2026-09-18. Applies to authored documentation, review records, and agent explanations in this repository.

A reference must tell the reader what it refers to and why it matters where it is mentioned. Use a short descriptive link and, when needed, a brief explanation. A reader must not have to open another document merely to decode an identifier.

For example, write “the [shared-work record](architecture/decisions/0016-shared-work.md), which gives each idempotency key one run and has every other caller subscribe to it.” Do not write “see 0016.”

Keep identifiers when useful for exact lookup, paired with their meaning and a source link. Machine keys, paths, and hashes may remain exact in structured records. Explain those records in the surrounding prose. Preserve verbatim source captures; apply this rule to the authored explanation around them.

Keep the description local and short. Link to the authoritative explanation instead of duplicating it. Distinguish accepted decisions, proposals, and historical evidence.

## Repository-language neutrality

Accepted by the user on 2026-09-28. Applies to product architecture, provider contracts, evidence types, retrieval behavior, plans, handovers, and review standards in this repository.

Neuve must not select, privilege, or exclude a repository language. Repository language is provider capability and observation metadata. A fixture establishes only the behavior it exercises and cannot define product scope. Structural and static analysis are separate, explicit operations, and the graph serves semantic retrieval ([decision 3.1](process/decisions.md)). Wherever language-specific analysis happens, it stays behind a capability-declared, language-neutral boundary.

Neuve-owned production code must not infer evidence eligibility or trust from a programming-language name or file-extension allowlist. Tests must prove that equivalent evidence receives equivalent treatment regardless of filename suffix, and that declared languages cross the provider boundary as data.

One exception, accepted by the owner on 2026-11-12: Neuve may mark a file as generated, vendored or minified, and so skip the model readings of it, by a published, well-defined standard of file names and paths (GitHub Linguist's generated and vendored rules), pinned to a version and recorded per file with the rule that fired. The marking never approves the file, never lowers it below a lane the repository's own declarations would give, is disclosed to the reader, and the repository's own declarations win in both directions (for example `linguist-generated=false` in `.gitattributes`). It treats every language alike.

## Show, don't tell

Accepted by the user on 2026-09-30 and narrowed on 2026-10-17 by [decision 7.5](process/decisions.md#area-7-how-agents-build-neuve-16-october-2026). Explanations, plans, proposals and requests for decisions addressed to the owner are written in product language and show connected information with the smallest useful rendered visual when that is materially easier to follow than prose; agent handovers and internal records stay short and plain. The [show-don't-tell principle](foundations/10-show-dont-tell.md) holds the trigger test, the representation choices and the delivery standard.
