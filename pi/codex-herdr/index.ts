/**
 * codex-herdr — Pi extension: delegate tasks to Codex running in a visible
 * Herdr tab (spaces/tabs TUI). Thin wrapper over the shared bridge script
 * plugins/codex/scripts/herdr.mjs from the codex-plugin-cc fork.
 *
 * Tools:
 *   codex_task    launch a Codex run in a Herdr tab (async by default)
 *   codex_wait    wait for a run to finish and get its report
 *   codex_result  status / read the report or screen of a run
 *   codex_send    send a follow-up message to a running Codex session
 *   codex_kill    cancel a run
 *
 * Command: /codex <task> — queues a message telling the agent to use codex_task.
 *
 * Configure with CODEX_HERDR_SCRIPT (path to herdr.mjs). Default points at the
 * fork checkout at ~/dev/cc/codex-plugin-cc.
 */

import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_SCRIPT = path.join(
  os.homedir(),
  "dev/cc/codex-plugin-cc/plugins/codex/scripts/herdr.mjs"
);
const SCRIPT = process.env.CODEX_HERDR_SCRIPT || DEFAULT_SCRIPT;

function text(t: string) {
  return [{ type: "text" as const, text: t }];
}

export default function (pi: ExtensionAPI) {
  async function runBridge(
    args: string[],
    opts: { signal?: AbortSignal; timeout?: number } = {}
  ) {
    const res = await pi.exec(process.execPath, [SCRIPT, ...args], {
      signal: opts.signal,
      timeout: opts.timeout ?? 60_000,
    });
    return res;
  }

  pi.registerTool(
    defineTool({
      name: "codex_task",
      label: "Codex (Herdr)",
      description:
        "Delegate a coding task to Codex. Codex runs interactively in a new tab of the user's Herdr terminal (visible, watchable, steerable by the person). " +
        "Async by default: returns immediately with the terminal name, Herdr tab and report file. Use codex_wait / codex_result to collect the outcome later. " +
        "The user can switch to the Herdr tab at any time to watch progress or answer approval prompts.",
      parameters: Type.Object({
        task: Type.String({
          description: "The task for Codex, in plain language. Passed through verbatim.",
        }),
        wait: Type.Optional(
          Type.Boolean({
            description: "Wait for Codex to finish and return its report (default false)",
          })
        ),
        name: Type.Optional(
          Type.String({
            description: "Short name for the run (becomes the terminal name, e.g. codex-fix-auth)",
          })
        ),
        model: Type.Optional(Type.String({ description: "Codex model override" })),
        effort: Type.Optional(
          Type.String({
            description: "Reasoning effort: none|minimal|low|medium|high|xhigh",
          })
        ),
        readOnly: Type.Optional(
          Type.Boolean({
            description: "Run read-only (review/diagnosis) instead of workspace-write",
          })
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const args = ["task"];
        if (params.wait) args.push("--wait");
        if (params.name) args.push("--name", params.name);
        if (params.model) args.push("--model", params.model);
        if (params.effort) args.push("--effort", params.effort);
        if (params.readOnly) args.push("--read-only");
        args.push(params.task);
        const res = await runBridge(args, {
          signal,
          timeout: params.wait ? 45 * 60_000 : 60_000,
        });
        return {
          content: text(res.stdout || res.stderr || "(no output)"),
          details: { code: res.code },
        };
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "codex_wait",
      label: "Codex wait",
      description:
        "Wait for a Codex Herdr run to finish (or block on approval), then get its report. Returns immediately if already done.",
      parameters: Type.Object({
        name: Type.String({ description: "Terminal name, e.g. codex-fix-auth" }),
      }),
      async execute(_toolCallId, params, signal) {
        const res = await runBridge(["wait", params.name], {
          signal,
          timeout: 40 * 60_000,
        });
        return { content: text(res.stdout || res.stderr || "(no output)"), details: {} };
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "codex_result",
      label: "Codex result",
      description:
        "Check a Codex Herdr run: agent status (working/done/blocked) plus its written report, or a screen tail if not finished.",
      parameters: Type.Object({
        name: Type.Optional(
          Type.String({ description: "Terminal name; defaults to the most recent run" })
        ),
        lines: Type.Optional(
          Type.Number({ description: "Screen tail lines when reading (default 40)" })
        ),
        read: Type.Optional(
          Type.Boolean({
            description: "Read the full report/screen instead of a short status (default false)",
          })
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const args = [params.read ? "read" : "status"];
        if (params.name) args.push(params.name);
        if (params.lines) args.push("--lines", String(params.lines));
        const res = await runBridge(args, { signal, timeout: 30_000 });
        return { content: text(res.stdout || res.stderr || "(no output)"), details: {} };
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "codex_send",
      label: "Codex send",
      description:
        "Send a follow-up instruction to a running (or finished but still open) Codex session in its Herdr tab.",
      parameters: Type.Object({
        name: Type.String({ description: "Terminal name" }),
        message: Type.String({ description: "The message to send" }),
      }),
      async execute(_toolCallId, params, signal) {
        const res = await runBridge(["send", params.name, params.message], {
          signal,
          timeout: 60_000,
        });
        return { content: text(res.stdout || res.stderr || "sent"), details: {} };
      },
    })
  );

  pi.registerTool(
    defineTool({
      name: "codex_kill",
      label: "Codex kill",
      description: "Cancel a Codex Herdr run.",
      parameters: Type.Object({
        name: Type.String({ description: "Terminal name" }),
      }),
      async execute(_toolCallId, params, signal) {
        const res = await runBridge(["kill", params.name], { signal, timeout: 30_000 });
        return { content: text(res.stdout || res.stderr || "killed"), details: {} };
      },
    })
  );

  pi.registerCommand("codex", {
    description: "Delegate a task to Codex in a visible Herdr tab (/codex <task>)",
    handler: async (args, ctx) => {
      const task = (args || "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /codex <task description>", "info");
        return;
      }
      pi.sendUserMessage(
        `Use the codex_task tool to delegate this task to Codex (async, then continue other work): ${task}`
      );
    },
  });
}
