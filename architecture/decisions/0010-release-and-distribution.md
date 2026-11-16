# 0010: Release and distribution

Status: accepted, 16 October 2026. Source: decisions [6.5](../../process/decisions.md).

## Context

`bun run test` rebuilt and re-signed the CLI binary that `~/.local/bin/neuve` symlinks to. Every test run replaced the command that other sessions were using. Local launch scripts had also drifted from the code.

## Decision

- An official release pipeline produces a binary distribution with its modules: the CLI, the graph engine, and the semantic runtime and models. It installs on the PATH, can be upgraded, and registers the launchd agent ([0002](0002-event-driven-processes.md)).
- Development and tests run from source. They never build into, or overwrite, the installed binary.
- One local-development command starts the stack from one config. It checks ports and orphaned processes first and never rebuilds on start. Old launch scripts are deleted rather than patched.
- End-to-end tests exercise the release build, because the final distribution is what users get.
