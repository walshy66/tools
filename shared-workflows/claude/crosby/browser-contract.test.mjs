import test from "node:test";
import assert from "node:assert/strict";
import { reviewContract } from "./browser-contract.mjs";

test("commented or fenced browser declarations are not explicit contracts", () => {
  const declaration = "Browser testing: not applicable\nReason: CLI only.";
  for (const text of [`<!--\n${declaration}\n-->`, `\`\`\`text\n${declaration}\n\`\`\``]) {
    const result = reviewContract(`## Review Context\nAGENTS.md\n## Browser Acceptance\n${text}`, []);
    assert.ok(result.contractError);
    assert.equal(result.browserAcceptance.text, text);
  }
});

test("duplicate new sections are ambiguous rather than silently selecting the first", () => {
  const body = "## Review Context\nAGENTS.md\n## Browser Acceptance\nBrowser testing: not applicable\nReason: CLI only.";
  for (const extra of ["\n## Browser Acceptance\nBrowser testing: required", "\n## Review Context\nConflicting rules"]) {
    assert.match(reviewContract(body + extra, []).contractError, /duplicate/i);
  }
});

test("browser declarations fail closed for absent, ambiguous, or invalid contracts", () => {
  const scenario = `### PW-01: Check
- Acceptance criteria: AC-01
- Preconditions/test data: Synthetic
- User actions: Open
- Expected outcomes: Visible`;
  for (const text of ["", "Browser testing: maybe", "Browser testing: required", "Browser testing: not applicable", "Browser testing: required\nBrowser testing: not applicable\nReason: CLI only", `Browser testing: required\n${scenario.replace("AC-01", "AC-99")}`, `Browser testing: required\n${scenario}\n${scenario}`, `Browser testing: not applicable\nReason: No credentials`, `Browser testing: not applicable\nReason: CLI only\n${scenario}`, `Browser testing: required\n${scenario.replace("- User actions: Open", "")}`]) {
    assert.ok(reviewContract(`## Review Context\nAGENTS.md\n## Browser Acceptance\n${text}`, ["AC-01: visible"]).contractError, text);
  }
  const valid = reviewContract("## Review Context\nAGENTS.md\n## Browser Acceptance\nBrowser testing: not applicable\nReason: Pure CLI parser; no browser surface.", []);
  assert.equal(valid.contractError, "");
  assert.equal(valid.browserAcceptance.required, false);
});
