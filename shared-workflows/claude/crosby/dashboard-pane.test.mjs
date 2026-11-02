import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDashboardPane } from "./dashboard-launch.mjs";

test("reruns reuse the persisted dashboard pane and retarget its runner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crosby-pane-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const exec = async (_command, args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ result: { pane: { pane_id: "dashboard-pane" } } }) };
  };
  const options = { exec, root, paneId: "trigger-pane", sourcePath: root, nodePath: process.execPath, runnerPath: "/runner.mjs" };
  const first = await ensureDashboardPane({ ...options, runId: "run-one" });
  const second = await ensureDashboardPane({ ...options, runId: "run-two" });
  assert.equal(first.paneId, second.paneId);
  assert.equal(calls.filter((args) => args[1] === "split").length, 1);
  assert.equal(calls.filter((args) => args[1] === "run").length, 1);
  assert.equal(JSON.parse(fs.readFileSync(second.runFile, "utf8")).runId, "run-two");
});

test("a closed dashboard is replaced without closing or interrupting other panes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crosby-pane-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let count = 0;
  const exec = async (_command, args) => {
    calls.push(args);
    if (args[1] === "get") return { code: 1, stderr: "Pane not found" };
    if (args[1] === "split") count++;
    return { code: 0, stdout: JSON.stringify({ result: { pane_id: `dashboard-${count}` } }) };
  };
  const options = { exec, root, paneId: "trigger", sourcePath: root, nodePath: process.execPath, runnerPath: "/runner.mjs", runId: "one" };
  await ensureDashboardPane(options);
  const replacement = await ensureDashboardPane({ ...options, runId: "two" });
  assert.equal(replacement.paneId, "dashboard-2");
  assert.deepEqual(calls.map((args) => args[1]), ["split", "run", "get", "split", "run"]);
});

test("a failed initial launch is retried in the same pane", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crosby-pane-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let launches = 0;
  let splits = 0;
  const exec = async (_cmd, args) => {
    if (args[1] === "split") splits++;
    if (args[1] === "run" && ++launches === 1) return { code: 1, stderr: "launch failed" };
    return { code: 0, stdout: JSON.stringify({ result: { pane_id: "dashboard" } }) };
  };
  const options = { exec, root, paneId: "trigger", sourcePath: root, nodePath: process.execPath, runnerPath: "/runner.mjs", runId: "one" };
  await assert.rejects(ensureDashboardPane(options), /launch failed/);
  await ensureDashboardPane(options);
  assert.equal(splits, 1);
  assert.equal(launches, 2);
});

test("inspection failures do not create duplicates or retarget the previous run", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crosby-pane-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { root, paneId: "trigger", sourcePath: root, nodePath: process.execPath, runnerPath: "/runner.mjs", runId: "one" };
  const first = await ensureDashboardPane({ ...options, exec: async () => ({ code: 0, stdout: JSON.stringify({ result: { pane_id: "dashboard" } }) }) });
  await assert.rejects(ensureDashboardPane({ ...options, runId: "two", exec: async (_cmd, args) => {
    assert.equal(args[1], "get");
    return { code: 1, stderr: "Herdr connection unavailable" };
  } }), /connection unavailable/);
  assert.equal(JSON.parse(fs.readFileSync(first.runFile, "utf8")).runId, "one");
});
