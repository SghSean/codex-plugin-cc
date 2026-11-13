---
description: Show the state of Codex runs started through the Herdr bridge
argument-hint: "[name] [--lines <n>]"
allowed-tools: Bash(node:*)
---

Show what a Codex-in-Herdr run is doing.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/herdr.mjs" status $ARGUMENTS
```

- With no name, the most recent Herdr-bridge run is shown.
- Relay the script output to the user verbatim. Do not add commentary.
- To read a finished run's full report: `... herdr.mjs read <name>`.
- To wait for it: `... herdr.mjs wait <name>`.
- To send a follow-up: `... herdr.mjs send <name> "<text>"`.
- To cancel: `... herdr.mjs kill <name>`.
