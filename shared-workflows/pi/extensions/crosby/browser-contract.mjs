// Shared issue/task contract parsing. Errors are data, not build-wide exceptions.
export function contractSection(body, name, level = 2) {
  const source = String(body ?? "");
  const heading = new RegExp(`^#{${level}}[ \\t]+${name}[ \\t]*\\r?$`, "im").exec(source);
  if (!heading) return "";
  const rest = source.slice(heading.index + heading[0].length);
  const end = new RegExp(`^#{1,${level}}[ \\t]+`, "m").exec(rest);
  return rest.slice(0, end?.index ?? rest.length).trim();
}

export function parseBrowserAcceptance(text, criteria = []) {
  text = String(text ?? "").trim();
  const visible = text.replace(/<!--[\s\S]*?(?:-->|$(?![\s\S]))/g, "").replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^\1[ \t]*$|$(?![\s\S]))/gm, "");
  const declarations = [...visible.matchAll(/^Browser testing:[ \t]*(.*)$/gim)];
  const required = declarations[0]?.[1]?.trim().toLowerCase() === "required";
  const reason = visible.match(/^Reason:[ \t]*(.+)$/im)?.[1]?.trim() ?? "";
  const scenarioMatches = [...visible.matchAll(/^###\s+(PW-\d+):[^\n]*\n([\s\S]*?)(?=^###\s|$(?![\s\S]))/gm)];
  const scenarios = scenarioMatches.map((match) => ({
    id: match[1],
    criteria: [...new Set((match[2].match(/^- Acceptance criteria:[ \t]*(.+)$/im)?.[1] ?? "").match(/\bAC-\d+\b/g) ?? [])],
  }));
  const errors = [];
  if (declarations.length !== 1 || !/^(required|not applicable)$/i.test(declarations[0]?.[1]?.trim() ?? "")) errors.push("Browser Acceptance must declare exactly one Browser testing: required or not applicable.");
  if (!required && !reason) errors.push("Browser Acceptance not applicable requires a reason.");
  if (required && !scenarios.length) errors.push("Browser Acceptance required needs PW scenarios.");
  if (!required && scenarios.length) errors.push("Not applicable cannot declare PW scenarios.");
  if (required && reason) errors.push("Required browser testing cannot declare a skip reason.");
  if (!required && /(?:no|missing|unavailable|lack of)\s+(?:\w+\s+)?(?:credentials|tooling|environment|accounts)|not configured/i.test(reason)) errors.push("Unavailable browser setup is a blocker, not a skip reason.");
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) errors.push("Duplicate PW scenario IDs.");
  for (const match of scenarioMatches) {
    for (const field of ["Preconditions/test data", "User actions", "Expected outcomes"]) {
      if (!new RegExp(`^- ${field}:[ \\t]*\\S.+$`, "im").test(match[2])) errors.push(`${match[1]} missing ${field}.`);
    }
  }
  const known = new Set(criteria.join("\n").match(/\bAC-\d+\b/g) ?? []);
  for (const scenario of scenarios) {
    if (!scenario.criteria.length || scenario.criteria.some((id) => !known.has(id))) errors.push(`${scenario.id} must link known AC IDs.`);
  }
  return { browserAcceptance: { required, reason, scenarios, text }, contractError: errors.join(" ") };
}

export function parseDependencies(value, issueIds = false) {
  const text = String(value ?? "").trim().replace(/^\s*-\s+/gm, "").trim();
  if (/^none$/i.test(text)) return { dependencies: [], contractError: "" };
  const tokens = text.split(/[\s,]+/).filter(Boolean);
  const pattern = issueIds ? /^#[1-9]\d*$/ : /^task-\d+$/;
  if (!tokens.length || tokens.some((token) => !pattern.test(token))) return { dependencies: [], contractError: "Missing or invalid Dependencies; declare explicit IDs or None." };
  return { dependencies: [...new Set(tokens.map((token) => `task-${String(Number(token.replace(issueIds ? "#" : "task-", ""))).padStart(3, "0")}`))], contractError: "" };
}

export function orderDependencyGraph(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const done = new Set();
  const stack = [];
  const ordered = [];
  const error = (task, message) => { task.contractError = [task.contractError, message].filter(Boolean).join(" "); };
  function visit(task) {
    if (done.has(task.id)) return;
    const cycleStart = stack.indexOf(task.id);
    if (cycleStart !== -1) {
      for (const id of stack.slice(cycleStart)) error(byId.get(id), "Dependency cycle detected.");
      return;
    }
    stack.push(task.id);
    for (const id of task.dependencies) {
      if (id === task.id) error(task, "Self dependency is invalid.");
      else if (!byId.has(id)) error(task, `Unknown dependency ${id}.`);
      else visit(byId.get(id));
    }
    stack.pop();
    done.add(task.id);
    ordered.push(task);
  }
  tasks.forEach(visit);
  return ordered;
}

export function reviewContract(body, criteria, level = 2) {
  const restoreHeadings = (text) => level === 3 ? text.replace(/^####/gm, "###") : text;
  const reviewContext = restoreHeadings(contractSection(body, "Review Context", level));
  const text = restoreHeadings(contractSection(body, "Browser Acceptance", level));
  const browser = parseBrowserAcceptance(text, criteria);
  const duplicates = ["Review Context", "Browser Acceptance", ...(level === 2 ? ["Dependencies"] : [])].filter((heading) => [...String(body ?? "").matchAll(new RegExp(`^#{${level}}[ \\t]+${heading}[ \\t]*\\r?$`, "gim"))].length > 1);
  return { reviewContext, ...browser, contractError: [!reviewContext && "Missing Review Context.", browser.contractError, ...duplicates.map((heading) => `Duplicate ${heading} sections.`)].filter(Boolean).join(" ") };
}
