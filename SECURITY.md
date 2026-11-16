# Security policy

## Reporting a vulnerability

Please don't report a vulnerability in a public issue. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report.

Include what you found, how to reproduce it, the commit or `neuve --version` you used, and what an attacker could do with it. We will acknowledge the report, keep you updated while we work on it, and credit you in the fix unless you would rather we didn't.

## What is in scope

Today, Neuve runs on your machine, with your repositories and your model credentials, so these matter most:

- credentials: the Anthropic API key in a worker's environment, the ChatGPT sign-in, and anything that could print, log or send them;
- the system of records: the SQLite store in each repository's Git directory, session captures and their retention;
- local listeners: the worker socket, the workspace host and its web app, which bind to loopback, and the optional tailnet listeners;
- what Neuve installs: Git hooks, the Claude Code and Codex hook entries, the MCP server and the launchd agent;
- reviewed code: anything that makes a review run or execute code from the repository under review.

Neuve Graph has its [own repository](https://github.com/NeuveAI/neuve-graph); report vulnerabilities in Graph there the same way.

## Supported versions

Neuve has no releases yet. Fixes land on `main`; please check that the problem still happens there.
