import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveBranchName,
  editLabelArguments,
  issueLabels,
  normalizeRepositoryUrl,
  parseChildIssueRefs,
  parseParentIssueRef,
  repositoryFromIssueUrl,
  statusFromIssue,
  toCrosbyIssue,
} from "./github-source.mjs";

test("normalizes GitHub remotes and issue URLs to one repository identity", () => {
  assert.equal(normalizeRepositoryUrl("git@github.com:walshy66/tools.git"), "https://github.com/walshy66/tools");
  assert.equal(normalizeRepositoryUrl("https://github.com/walshy66/tools/"), "https://github.com/walshy66/tools");
  assert.equal(repositoryFromIssueUrl("https://github.com/walshy66/tools/issues/14"), "https://github.com/walshy66/tools");
});

test("parses ordered parent child references only from the child section", () => {
  assert.deepEqual(parseChildIssueRefs("See #999.\n\n## Child Issues\n- [ ] #17 One\n- [ ] #18 Two\n\n## Notes\n#19"), ["17", "18"]);
  assert.equal(parseParentIssueRef("Intro\nParent: #14\n"), "#14");
});

test("normalizes GitHub issues into the Crosby queue shape", () => {
  const issue = toCrosbyIssue({ number: 17, title: "Adapter", body: "Branch: crosby/github\nParent: #14", state: "OPEN", labels: ["type:child", "status:ready-to-build", "mode:afk"] });
  assert.equal(issue.identifier, "#17");
  assert.equal(issue.state.name, "Ready to Build");
  assert.equal(issue.branchName, "crosby/github");
  assert.equal(issue.parent.identifier, "#14");
  assert.deepEqual(issueLabels(issue), ["type:child", "status:ready-to-build", "mode:afk"]);
});

test("maps GitHub states and label transitions", () => {
  assert.equal(statusFromIssue({ state: "CLOSED", labels: [] }), "Done");
  assert.equal(statusFromIssue({ state: "OPEN", labels: ["status:building"] }), "Building");
  assert.deepEqual(editLabelArguments("17", "Building"), ["issue", "edit", "17", "--add-label", "status:building", "--remove-label", "status:ready", "--remove-label", "status:execute", "--remove-label", "status:ready-to-build", "--remove-label", "status:review"]);
  assert.deepEqual(editLabelArguments("17", "Done"), ["issue", "close", "17"]);
});

test("derives a safe branch name when no branch metadata exists", () => {
  assert.equal(deriveBranchName({ number: 14, title: "GitHub Crosby integration" }), "issue-14-github-crosby-integration");
});
