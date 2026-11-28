---
name: chrome-devtools
description: Uses Chrome DevTools via MCP for efficient debugging, troubleshooting and browser automation. Use when debugging web pages, automating browser interactions, analyzing performance, or inspecting network requests. This skill does not apply to `--slim` mode (MCP configuration).
---

<!-- Adapted from Chrome DevTools MCP. Copyright Google LLC. Licensed under Apache-2.0. -->

## Core Concepts

**Browser lifecycle**: The server attaches to Ace's running development browser. If the browser restarts, use `list_pages` again to get the current page IDs. If the tools are unavailable or the browser is stopped, report that to the person.

**Page targeting**: Page-scoped tools require a `pageId` parameter to target a specific page. Use `list_pages` to see available pages and their IDs (e.g. `pageId: 1`), or use the ID returned when creating a page with `new_page`.
**Element interaction**: Use `take_snapshot` to get page structure with element `uid`s. Each element has a unique `uid` for interaction. If an element isn't found, take a fresh snapshot - the element may have been removed or the page changed.

## Workflow Patterns

### Before interacting with a page

1. Navigate: `navigate_page` or `new_page`
2. Wait: `wait_for` to ensure content is loaded if you know what you look for.
3. Snapshot: `take_snapshot` with `pageId` to understand page structure
4. Interact: Use element `uid`s from snapshot for `click`, `fill`, etc., passing the corresponding `pageId`.

### Efficient data retrieval

- Use an absolute `filePath` in your working folder for screenshots, snapshots, traces, and screencasts.
- For a recording, call `screencast_start` with a page ID and output path, exercise the page, then call `screencast_stop`. The page needs to change for Chrome to capture frames.
- Use pagination (`pageIdx`, `pageSize`) and filtering (`types`) to minimize data
- Set `includeSnapshot: false` on input actions unless you need updated page state

### Tool selection

- **Automation/interaction**: `take_snapshot` (text-based, faster, better for automation)
- **Visual inspection**: `take_screenshot` (when user needs to see visual state)
- **CSS & Styling inspection**: Use `get_css_styles` to inspect computed styles, matched rules, cascade, and CSS variables (pass `computedProperties` for unmatched defaults). Treat the output as authoritative.
- **Additional details**: Use `evaluate_script` for runtime DOM/JS data not available via `get_css_styles` or `take_snapshot`.
- **Runtime values**: Use `set_logpoints` to log expressions at script or source-file lines (source maps supported) instead of editing code; read the output with `list_console_messages`.

### Parallel execution

You can send multiple tool calls in parallel, but maintain correct order: navigate → wait → snapshot → interact.

## Troubleshooting

If `chrome-devtools-mcp` is insufficient, guide users to use Chrome DevTools UI:

- https://developer.chrome.com/docs/devtools
- https://developer.chrome.com/docs/devtools/ai-assistance

If there are errors connecting to Chrome, refer to https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md.
