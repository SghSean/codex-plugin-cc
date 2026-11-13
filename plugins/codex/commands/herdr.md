---
description: Delegate a task to Codex running in a visible Herdr tab you can switch to and watch
argument-hint: "[--wait] [--name <name>] [--model <model>] [--effort <none|low|medium|high|xhigh>] [task for Codex]"
allowed-tools: Bash(node:*)
---

Run Codex through the Herdr bridge. Codex runs interactively in a new tab of the
person's Herdr space (the user's terminal app), so the person can switch to it,
watch it work, and answer its approval dialogs.

The final user-visible response must be the script's output verbatim.

Raw user request:
$ARGUMENTS

Execution:

- Invoke the helper with the raw arguments (flags and task text) in one `Bash` call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/herdr.mjs" task $ARGUMENTS
```

- Default (no flag) is asynchronous: the helper returns immediately after
  launching, printing the terminal name, the Herdr tab, and the report file
  path. Relay that output to the user as-is.
- With `--wait`, the helper blocks until Codex finishes (or blocks on an
  approval) and then prints Codex's report. Relay it as-is.
- Pass the task text through unchanged. Do not paraphrase, tighten, or append
  context of your own.
- `--model`, `--effort`, `--name` are runtime controls; pass them through.
- If the helper reports Codex is BLOCKED, tell the user to open the named
  Herdr tab and answer Codex's question, then re-check later with
  `/codex:herdr-status`.
- If the user gave no task, ask what Codex should do before invoking the helper.
- While a run is in flight, you may check on it with
  `node "${CLAUDE_PLUGIN_ROOT}/scripts/herdr.mjs" status <name>` (or wait with
  `wait <name>`) — but do not summarize or act on Codex's work; the person
  watches it in the Herdr tab.
