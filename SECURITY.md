# Security policy

## Reporting a vulnerability

Please don't report a vulnerability in a public issue. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Only the maintainers can see the report.

Include what you found, how to reproduce it, the commit or `neuve --version` you used, and what an attacker could do with it. We will acknowledge the report, keep you updated while we work on it, and credit you in the fix unless you would rather we didn't.

## What is in scope

Today, Neuve runs on your machine, with your repositories and your model credentials, so these matter most:

- credentials: the Anthropic API key in a worker's environment, the ChatGPT sign-in, the Claude Code sign-in that the Claude route runs reviews through (Neuve never reads it), and anything that could print, log or send them;
- the system of records: the SQLite store in each repository's Git directory, session captures and their retention;
- local listeners: the worker socket, the review desk, the workspace host and its web app, which bind to loopback, and the workspace's optional tailnet listeners;
- what Neuve installs: the installer served at `https://neuve.ai/install.sh`, Git hooks, the Claude Code and Codex hook entries, the Neuve skill, the MCP server, and the launchd agent on macOS or the systemd timer on Linux;
- reviewed code: anything that makes a review run or execute code from the repository under review.

Neuve Graph has its [own repository](https://github.com/NeuveAI/neuve-graph); report vulnerabilities in Graph there the same way.

## Supported versions

Fixes land on `main` and ship in the next release. Please check that the problem still happens in the latest release, or on `main` if you build from a checkout.
