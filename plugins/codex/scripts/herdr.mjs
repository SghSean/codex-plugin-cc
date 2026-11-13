#!/usr/bin/env node
/**
 * herdr.mjs — run Codex inside a visible Herdr tab.
 *
 * Shared runtime for the Claude Code plugin (commands/*, agents/*) and the
 * Pi extension (pi/codex-herdr). One script, two frontends.
 *
 * Subcommands:
 *   task   [--wait] [--name <n>] [--model <m>] [--effort <e>] [--sandbox <mode>] "<task text>"
 *   send   <name> "<text>"
 *   wait   <name> [--timeout <s>]   (wait until Codex stops working / exits)
 *   status [name] [--lines <n>]     (agent status + screen tail + report file)
 *   read   [name] [--lines <n>]
 *   kill   <name>
 *   list                           (all codex-* terminals started by this tool)
 *
 * Environment:
 *   HC_BIN            hc binary (default: "hc")
 *   HERDR_APP_BIN     herdr-app binary (default: "herdr-app")
 *   HC_TERMINAL_ID    caller's terminal (set by hc/herdr); used to find the space
 *   CODEX_BIN         codex binary (default: "codex")
 *   CODEX_HERDR_DIR   state dir for report files (default: $TMPDIR/codex-herdr)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const HC_BIN = process.env.HC_BIN || "hc";
const HERDR_APP_BIN = process.env.HERDR_APP_BIN || "herdr-app";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const STATE_DIR =
  process.env.CODEX_HERDR_DIR || path.join(os.tmpdir(), "codex-herdr");

function run(cmd, args, { timeout = 60_000, input } = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    input,
  });
  return {
    code: res.status,
    stdout: (res.stdout || "").trim(),
    stderr: (res.stderr || "").trim(),
    error: res.error ? String(res.error.message) : null,
  };
}

function hc(args, opts) {
  return run(HC_BIN, args, opts);
}

function fail(message) {
  process.stderr.write(`herdr: ${message}\n`);
  process.exit(1);
}

function jsonOrNull(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Repo root: git toplevel of cwd, else cwd. */
function repoRoot(flagRoot) {
  if (flagRoot) return path.resolve(flagRoot);
  const res = run("git", ["rev-parse", "--show-toplevel"], { timeout: 5000 });
  if (res.code === 0 && res.stdout) return res.stdout;
  return process.cwd();
}

function realpaths(p) {
  const out = [path.resolve(p)];
  try {
    const rp = fs.realpathSync(p);
    if (rp !== out[0]) out.push(rp);
  } catch {
    /* not there yet */
  }
  return out;
}

/** Quote a path as a TOML table key: projects."<path>" */
function tomlKey(p) {
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function slugify(text, max = 24) {
  const s = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "task";
}

/**
 * The Herdr space this run should appear in. Prefer the caller's own space
 * (started from an agent terminal inside Herdr); otherwise look for a space
 * whose folder matches the repo; otherwise create one.
 */
function herdrSpace(root) {
  const mine = process.env.HC_TERMINAL_ID;
  if (mine) {
    const res = hc(["get", mine, "--json"]);
    const t = jsonOrNull(res.stdout);
    if (t && t.labels && t.labels["herdr.space"]) return t.labels["herdr.space"];
  }
  const ls = run(HERDR_APP_BIN, ["ls"]);
  const doc = jsonOrNull(ls.stdout);
  if (doc && Array.isArray(doc.spaces)) {
    const byFolder = doc.spaces.find((s) => {
      if (!s.folder) return false;
      const f = path.resolve(s.folder);
      return f === path.resolve(root) || f === path.dirname(path.resolve(root));
    });
    if (byFolder) return byFolder.id;
    const byName = doc.spaces.find(
      (s) => s.name && s.name === path.basename(root)
    );
    if (byName) return byName.id;
  }
  const created = run(HERDR_APP_BIN, [
    "do",
    "space.new",
    "--name",
    path.basename(root),
    "--folder",
    root,
  ]);
  const doc2 = jsonOrNull(created.stdout);
  const id = doc2 && (doc2.space || doc2.id);
  if (id) return id;
  fail("could not determine a Herdr space; is the Herdr window open?");
  return null;
}

function liveTerminal(name) {
  const res = hc(["get", name, "--json"]);
  const t = jsonOrNull(res.stdout);
  return t && t.state === "live" ? t : null;
}

function uniqueName(base) {
  let name = base;
  let i = 2;
  while (liveTerminal(name)) name = `${base}-${i++}`;
  return name;
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--wait" || a === "--bg") flags.wait = a === "--wait";
    else if (a === "--name") flags.name = argv[++i];
    else if (a === "--model") flags.model = argv[++i];
    else if (a === "--effort") flags.effort = argv[++i];
    else if (a === "--sandbox") flags.sandbox = argv[++i];
    else if (a === "--root" || a === "--cwd") flags.root = argv[++i];
    else if (a === "--timeout") flags.timeout = Number(argv[++i]);
    else if (a === "--lines") flags.lines = Number(argv[++i]);
    else if (a === "--write") flags.write = true;
    else if (a === "--read-only") flags.readOnly = true;
    else flags._.push(a);
  }
  return flags;
}

function codexArgv({ root, task, model, effort, sandbox, reportDir, readOnly }) {
  const argv = [
    CODEX_BIN,
    "--no-daemon",
    "-C",
    root,
    "-s",
    readOnly ? "read-only" : sandbox || "workspace-write",
    "-a",
    "on-request",
  ];
  for (const p of realpaths(root)) {
    argv.push("-c", `projects."${tomlKey(p)}".trust_level="trusted"`);
  }
  if (!readOnly && reportDir) {
    for (const p of realpaths(reportDir)) {
      argv.push(
        "-c",
        `sandbox_workspace_write.writable_roots=["${tomlKey(p)}"]`
      );
    }
  }
  if (model) argv.push("-m", model);
  if (effort) argv.push("-c", `model_reasoning_effort="${effort}"`);
  argv.push(task);
  return argv;
}

function cmdTask(argv) {
  const flags = parseFlags(argv);
  const task = flags._.join(" ").trim();
  if (!task) fail("task: no task text given");
  const root = repoRoot(flags.root);

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const base = flags.name
    ? `codex-${slugify(flags.name, 32)}`
    : `codex-${slugify(task)}`;
  const name = uniqueName(base);
  const reportFile = path.join(STATE_DIR, `${name}.md`);

  const prompt =
    `${task}\n\n` +
    `When you finish (or get blocked and cannot continue), write a short markdown ` +
    `summary to ${reportFile} — what you did, files changed, and anything left open — ` +
    `then reply DONE. If you are blocked on an approval dialog, just wait for the person.`;

  const space = herdrSpace(root);
  const tab = "tb" + Array.from({ length: 32 }, () =>
    "0123456789abcdef"[Math.floor(Math.random() * 16)]
  ).join("");
  const title = `codex: ${slugify(task, 28)}`;

  const codexArgs = codexArgv({
    root,
    task: prompt,
    model: flags.model,
    effort: flags.effort,
    sandbox: flags.sandbox,
    reportDir: STATE_DIR,
    readOnly: flags.readOnly,
  });

  const res = hc([
    "run",
    "--bg",
    "--name",
    name,
    "--outlive-parent",
    "--cwd",
    root,
    "--label",
    `herdr.space=${space}`,
    "--label",
    `herdr.tab=${tab}`,
    "--label",
    "codex-herdr=true",
    "--",
    ...codexArgs,
  ]);
  const t = jsonOrNull(res.stdout);
  if (!t || !t.address) {
    fail(`hc run failed: ${res.stderr || res.stdout || res.error}`);
  }

  run(HERDR_APP_BIN, ["do", "tab.rename", "--id", tab, "--name", title], {
    timeout: 15_000,
  });

  const lines = [
    `launched Codex "${name}" (terminal ${t.address})`,
    `tab "${title}" in the current Herdr space — switch there to watch or steer it`,
    `report file: ${reportFile}`,
  ];
  if (flags.wait) {
    lines.push("");
    lines.push(waitFor(name));
    lines.push("");
    lines.push(readResult(name, 200));
  } else {
    lines.push(`async: check with \`herdr.mjs status ${name}\` or wait with \`herdr.mjs wait ${name}\``);
    lines.push(`follow-up: \`herdr.mjs send ${name} "<text>"\` · cancel: \`herdr.mjs kill ${name}\``);
  }
  process.stdout.write(lines.filter((l) => l !== null).join("\n") + "\n");
}

function waitFor(name) {
  const timeout = 90;
  for (;;) {
    const res = hc(["wait", name, "--timeout", String(timeout), "--json"], {
      timeout: (timeout + 30) * 1000,
    });
    const w = jsonOrNull(res.stdout);
    if (!w) return `wait failed: ${res.stderr || res.error}`;
    if (w.ended) {
      if (w.status === "blocked") {
        return `Codex is BLOCKED (needs a person): open the "${name}" tab in Herdr and answer its question, then re-run \`herdr.mjs wait ${name}\`.`;
      }
      if (w.status === "error") {
        return `Codex reported an error: see the "${name}" tab in Herdr.`;
      }
      return `Codex ${w.status || (w.exit_code != null ? `exited (${w.exit_code})` : "stopped")}.`;
    }
    if (w.reason === "message") continue; // a note arrived; keep waiting
  }
}

function reportTail(name, maxChars = 8000) {
  const file = path.join(STATE_DIR, `${name}.md`);
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    if (text.length > maxChars) {
      return `…${text.slice(-maxChars)}\n(report truncated, full file: ${file})`;
    }
    return text;
  } catch {
    return null;
  }
}

function readResult(name, lines) {
  const out = [];
  const rep = reportTail(name);
  if (rep) {
    out.push(`--- report (${path.join(STATE_DIR, name + ".md")}) ---`);
    out.push(rep);
  } else {
    out.push(`--- screen (report file not written yet) ---`);
    const res = hc(["read", name, "--lines", String(lines || 80)]);
    const text = (res.stdout || res.stderr || "").trim();
    out.push(text.split("\n").slice(-Math.max(10, lines || 80)).join("\n"));
  }
  return out.join("\n");
}

function resolveName(arg) {
  if (arg) return arg;
  // newest codex-herdr terminal
  const res = hc(["ls", "--label", "codex-herdr=true", "--json"]);
  const doc = jsonOrNull(res.stdout);
  const list = (doc && doc.terminals) || [];
  if (!list.length) fail("no codex-herdr terminals found");
  return list[list.length - 1].name || list[list.length - 1].address;
}

function cmdStatus(argv) {
  const flags = parseFlags(argv);
  const name = resolveName(flags._[0]);
  const res = hc(["get", name, "--json"]);
  const t = jsonOrNull(res.stdout);
  if (!t) fail(`no terminal "${name}"`);
  const st = t.status ? t.status.state : null;
  const out = [
    `${name}: ${t.state}${st ? ` / ${st}` : ""} · turn ${t.turn ?? "?"} · cwd ${t.cwd || "?"}`,
  ];
  if (t.status && t.status.kind) out.push(`status kind: ${t.status.kind}`);
  const rep = reportTail(name, 4000);
  if (st === "done" && rep) {
    out.push(`--- report ---`);
    out.push(rep);
  } else if (st === "done") {
    out.push("--- screen tail ---");
    out.push(
      (hc(["read", name, "--lines", String(flags.lines || 40)]).stdout || "")
        .split("\n")
        .filter((l) => l.trim())
        .slice(-(flags.lines || 40))
        .join("\n")
    );
  } else {
    out.push(
      `report: ${fs.existsSync(path.join(STATE_DIR, `${name}.md`)) ? "written" : "not yet"}`
    );
    out.push(
      `screen tail / wait: \`herdr.mjs read ${name}\` · \`herdr.mjs wait ${name}\``
    );
  }
  process.stdout.write(out.join("\n") + "\n");
}

function cmdRead(argv) {
  const flags = parseFlags(argv);
  const name = resolveName(flags._[0]);
  process.stdout.write(readResult(name, flags.lines || 80) + "\n");
}

function cmdWait(argv) {
  const flags = parseFlags(argv);
  const name = resolveName(flags._[0]);
  process.stdout.write(waitFor(name) + "\n");
  const t = jsonOrNull(hc(["get", name, "--json"]).stdout);
  if (t && t.status && t.status.state === "done") {
    process.stdout.write("\n" + readResult(name, 80) + "\n");
  }
}

function cmdSend(argv) {
  const flags = parseFlags(argv);
  const name = flags._[0];
  const text = flags._.slice(1).join(" ").trim();
  if (!name || !text) fail("send <name> <text>");
  const res = hc(["send", name, text]);
  process.stdout.write(res.stdout || res.stderr || "sent\n");
}

function cmdKill(argv) {
  const flags = parseFlags(argv);
  const name = resolveName(flags._[0]);
  hc(["kill", name]);
  process.stdout.write(`killed ${name}\n`);
}

function cmdList() {
  const res = hc(["ls", "--label", "codex-herdr=true", "--json"]);
  const doc = jsonOrNull(res.stdout);
  const list = (doc && doc.terminals) || [];
  if (!list.length) {
    process.stdout.write("no codex-herdr terminals\n");
    return;
  }
  for (const t of list) {
    const st = t.agent || "";
    process.stdout.write(`${t.name || t.address}  ${t.state} ${st}\n`);
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "task":
      return cmdTask(rest);
    case "send":
      return cmdSend(rest);
    case "wait":
      return cmdWait(rest);
    case "status":
      return cmdStatus(rest);
    case "read":
      return cmdRead(rest);
    case "kill":
      return cmdKill(rest);
    case "list":
      return cmdList(rest);
    default:
      fail(`unknown or missing subcommand: ${cmd || "(none)"} — task|send|wait|status|read|kill|list`);
  }
}

main();
