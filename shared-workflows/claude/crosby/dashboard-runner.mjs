#!/usr/bin/env node
// Standalone terminal dashboard renderer for Crosby.
//
// This is a plain Node process: it never starts a Pi model/session. It reads
// the append-only events.jsonl log written by dashboard.mjs's
// persistDashboardEvent() and renders the last known dashboard state with
// dashboard.mjs's existing renderCrosbyDashboard() — no duplicate renderer.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getCrosbyRunsRoot, renderCrosbyDashboard } from "./dashboard.mjs";

const WATCH_POLL_INTERVAL_MS = 250;

export function parseDashboardRunnerArgs(argv = []) {
  const args = { run: null, eventsPath: null, once: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run") {
      args.run = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--run-file") {
      args.runFile = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--events-path") {
      args.eventsPath = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--once") {
      args.once = true;
    }
  }
  return args;
}

function findMostRecentRunDir(runsRoot) {
  let entries;
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  let mostRecent = null;
  let mostRecentMtime = -Infinity;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "dashboard-panes") continue;
    const dirPath = path.join(runsRoot, entry.name);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(dirPath).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > mostRecentMtime) {
      mostRecentMtime = mtimeMs;
      mostRecent = dirPath;
    }
  }
  return mostRecent;
}

/**
 * Resolve the events.jsonl path to render from, honoring --events-path,
 * --run, or falling back to the most recently modified run directory.
 */
export function resolveDashboardEventsPath(args, options = {}) {
  if (args.eventsPath) return args.eventsPath;

  const runsRoot = getCrosbyRunsRoot(options);

  if (args.runFile) {
    try {
      const binding = JSON.parse(fs.readFileSync(args.runFile, "utf8"));
      return binding.runId ? path.join(runsRoot, binding.runId, "events.jsonl") : null;
    } catch {
      // A binding may be briefly unreadable while a rerun updates it.
      return null;
    }
  }

  if (args.run) return path.join(runsRoot, args.run, "events.jsonl");

  const mostRecentRunDir = findMostRecentRunDir(runsRoot);
  if (!mostRecentRunDir) return null;
  return path.join(mostRecentRunDir, "events.jsonl");
}

/**
 * Read the events.jsonl file and reconstruct the current dashboard state by
 * replaying JSON lines and returning the last successfully parsed one, since
 * each appended line is already the full dashboard snapshot.
 */
export function readLatestDashboardState(eventsPath) {
  let raw;
  try {
    raw = fs.readFileSync(eventsPath, "utf8");
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Skip a partially written/corrupt trailing line and try the previous one.
    }
  }
  return null;
}

export function renderDashboardFromEventsPath(eventsPath) {
  const dashboard = readLatestDashboardState(eventsPath);
  if (!dashboard) {
    return [`No dashboard state found at ${eventsPath}`];
  }
  return renderCrosbyDashboard(dashboard);
}

function printDashboard(eventsPath, options = {}) {
  const write = options.write ?? ((text) => process.stdout.write(text));
  const lines = renderDashboardFromEventsPath(eventsPath);
  write(`\u001b[2J\u001b[H${lines.join("\n")}\n`);
}

/**
 * Watch eventsPath for appended lines and reprint the dashboard on change.
 * Returns a stop() function that ends the watch loop.
 */
export function watchDashboardEventsPath(eventsPath, options = {}) {
  const write = options.write ?? ((text) => process.stdout.write(text));
  const intervalMs = options.intervalMs ?? WATCH_POLL_INTERVAL_MS;
  let lastSize = -1;
  let lastPath = null;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const currentPath = options.resolveEventsPath ? options.resolveEventsPath() : eventsPath;
    if (!currentPath) return;
    let size = -1;
    try {
      size = fs.statSync(currentPath).size;
    } catch {
      size = -1;
    }
    if (size !== lastSize || currentPath !== lastPath) {
      lastSize = size;
      lastPath = currentPath;
      printDashboard(currentPath, { write });
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);

  return function stop() {
    stopped = true;
    clearInterval(timer);
  };
}

export async function runDashboardRunner(argv, options = {}) {
  const args = parseDashboardRunnerArgs(argv);
  const eventsPath = resolveDashboardEventsPath(args, options);
  const write = options.write ?? ((text) => process.stdout.write(text));

  if (!eventsPath && (!args.runFile || args.once)) {
    write("No Crosby run found to render.\n");
    return { eventsPath: null, stop: null };
  }

  if (args.once) {
    printDashboard(eventsPath, { write });
    return { eventsPath, stop: null };
  }

  const stop = watchDashboardEventsPath(eventsPath, {
    ...options,
    ...(args.runFile ? { resolveEventsPath: () => resolveDashboardEventsPath(args, options) } : {}),
  });
  return { eventsPath, stop };
}

function isMainModule() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  runDashboardRunner(process.argv.slice(2), { runsRoot: getCrosbyRunsRoot() });
}
