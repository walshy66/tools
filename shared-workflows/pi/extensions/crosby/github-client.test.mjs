import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubClient } from "./github-client.mjs";

function issue(number, body = "") {
  return { number, title: `Issue ${number}`, body, state: "OPEN", labels: [], url: `https://github.com/walshy66/tools/issues/${number}`, comments: [] };
}

test("loads an ordered GitHub parent queue and normalizes children", async () => {
  const calls = [];
  const client = createGitHubClient({ repository: "git@github.com:walshy66/tools.git", exec: async (_command, args) => {
    calls.push(args);
    const number = args[2];
    return { code: 0, stdout: JSON.stringify(number === "14" ? issue(14, "## Child Issues\n- [ ] #17\n- [ ] #18") : issue(Number(number))), stderr: "" };
  } });
  const queue = await client.loadParentQueue("#14");
  assert.deepEqual(queue.children.map((child) => child.identifier), ["#17", "#18"]);
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [["issue", "view", "14"], ["issue", "view", "17"], ["issue", "view", "18"]]);
});

test("fails closed when an issue belongs to another repository", async () => {
  const client = createGitHubClient({ repository: "https://github.com/walshy66/tools", exec: async () => ({ code: 0, stdout: JSON.stringify({ ...issue(1), url: "https://github.com/other/repo/issues/1" }), stderr: "" }) });
  await assert.rejects(() => client.loadIssue("1"), /belongs to https:\/\/github\.com\/other\/repo/);
});

test("uses GitHub label transitions and issue comments", async () => {
  const calls = [];
  const client = createGitHubClient({ exec: async (_command, args) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; } });
  await client.moveIssue("17", "Building");
  await client.addComment("14", "progress");
  assert.deepEqual(calls[0].slice(0, 5), ["issue", "edit", "17", "--add-label", "status:building"]);
  assert.deepEqual(calls[1], ["issue", "comment", "14", "--body", "progress"]);
});
