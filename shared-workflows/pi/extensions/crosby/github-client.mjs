import {
  editLabelArguments,
  normalizeIssueRef,
  normalizeRepositoryUrl,
  parseChildIssueRefs,
  repositoryFromIssueUrl,
  toCrosbyIssue,
} from "./github-source.mjs";

function details(result) {
  return [result?.stderr, result?.stdout].filter(Boolean).join("\n").trim();
}

function fail(message) {
  throw new Error(`GitHub Crosby: ${message}`);
}

export function createGitHubClient({ exec, repository } = {}) {
  if (typeof exec !== "function") fail("client requires an exec(command, args, options) function.");
  const expectedRepository = normalizeRepositoryUrl(repository);
  const run = async (args, options) => {
    const transient = /\b(eof|timeout|timed out|connection reset|connection refused|temporary failure|service unavailable|502|503|504)\b/i;
    let result;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      result = await exec("gh", args, options);
      if (result.code === 0) return result;
      if (!transient.test(details(result)) || attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, [250, 750, 1500][attempt]));
    }
    fail(details(result) || `gh ${args.join(" ")} failed with exit code ${result.code}.`);
  };
  const json = async (args, options) => {
    const result = await run(args, options);
    try { return JSON.parse(result.stdout || "null"); } catch (error) { fail(`gh ${args.join(" ")} returned invalid JSON: ${error.message}`); }
  };

  async function loadIssue(issueRef, { includeChildren = true, ancestors = [] } = {}) {
    const normalizedRef = normalizeIssueRef(issueRef);
    if (ancestors.includes(normalizedRef)) fail(`issue ${issueRef} contains a circular child reference.`);
    const issue = await json(["issue", "view", normalizedRef, "--json", "number,title,body,state,labels,milestone,url,comments" ]);
    if (expectedRepository && repositoryFromIssueUrl(issue?.url) && repositoryFromIssueUrl(issue.url) !== expectedRepository) {
      fail(`issue ${issueRef} belongs to ${repositoryFromIssueUrl(issue.url)}, not the current checkout ${expectedRepository}.`);
    }
    const children = includeChildren
      ? await Promise.all(parseChildIssueRefs(issue?.body).map((child) => loadIssue(child, { includeChildren: true, ancestors: [...ancestors, normalizedRef] })))
      : [];
    return toCrosbyIssue(issue, children);
  }

  function executableChildren(children) {
    return children.flatMap((child) => child.children?.length ? executableChildren(child.children) : [child]);
  }

  async function loadParentQueue(issueRef) {
    const parent = await loadIssue(issueRef);
    if (parent.parent) fail(`${parent.identifier} is a child issue; run Crosby with its parent issue.`);
    const children = executableChildren(parent.children ?? []);
    if (!children.length) fail(`${parent.identifier} has no executable child issues in its Child Issues section.`);
    return { parent: { ...parent, children }, children };
  }

  async function loadExecuteParentQueues() {
    const issues = await json(["issue", "list", "--state", "open", "--limit", "100", "--label", "type:parent", "--label", "status:execute", "--json", "number"]);
    return Promise.all((Array.isArray(issues) ? issues : []).map((issue) => loadParentQueue(issue.number)));
  }

  async function moveIssue(issueRef, state) {
    const args = editLabelArguments(issueRef, state);
    if (args) await run(args);
  }

  async function addComment(issueRef, body) {
    await run(["issue", "comment", normalizeIssueRef(issueRef), "--body", String(body)]);
  }

  return { loadIssue, loadParentQueue, loadExecuteParentQueues, moveIssue, addComment, repository: expectedRepository };
}
