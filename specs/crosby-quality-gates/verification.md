# Crosby quality gates — implementation verification

## Agreed behaviour

- Independent reviewer/tester agents in sibling panes of `Crosby #<child>` tabs.
- Repository-defined safe verification; no shared product constitution fallback.
- Three durable automatic repair attempts per child shared across review, browser and attributable parent defects.
- Explicit dependencies; independent tasks continue around manual blockers.
- Manual acknowledgement/resume cannot bypass code-bearing task gates.
- Verified-SHA integration, combined-parent gates, and an open parent for final human review/closure.
- Concise deduplicated control-terminal updates; detailed dashboard/evidence and actionable assistance requests.

## Validation performed

- `node --test shared-workflows/pi/extensions/crosby/*.test.mjs`: **208 tests passed**, zero failures/skips.
- `git diff --check`: passed (Git emits existing LF/CRLF conversion warnings).
- Loaded the updated TypeScript extension through the installed Pi extension loader: no errors.
  - Controller registers `/crosby` and manual acknowledgement.
  - Verifier mode registers only `crosby_gate_report`, not orchestration commands.
- Live Herdr smoke test against an isolated temporary JavaScript repository:
  - Baseline and changed commits with a behaviour test observed red then green.
  - Fresh Pi reviewer launched in a sibling pane with its own context.
  - Reviewer ran `node --test`, wrote evidence and submitted a validated passed gate.
  - Reviewed SHA: `d46d2bb877ba6a280ca7ea9fcd478307d8e0e1b9` (temporary fixture only).
  - Report: `C:/Users/camer/AppData/Local/Temp/crosby-live-artifacts/gate-runs/8a74c6dc-f4d8-4e19-840c-4a0546aec7c5/review.md`.
  - The synthetic smoke panes were closed after completion; report artifacts were retained.

The initial live attempts exposed an explicit-direction requirement in Herdr pane splitting and a Windows startup prompt left unsubmitted in the editor. Both were fixed; the final live run completed without operator input. Tests cover the CLI direction and single-Enter acknowledgement recovery.

Independent implementation review identified report-ingestion evidence validation, cross-stage revision drift, retained parent-verifier recovery, mutable-ref integration, stale publication contracts, and a manual-tool signature problem. Corrections include assigned-pane receipts/content hashes, stable-revision checks, parent/child retained-agent checks, immutable-SHA merge/publication, current build fingerprints, and the correct tool invocation signature.

## Operational boundaries / rollout still required

- This is runtime and skill implementation, not a completed Caylios browser acceptance run.
- No Caylios implementation, database, account, connector, production environment, or GitHub issue was modified by this work.
- Caylios needs approved repository testing instructions, safe browser/test-account fixtures, and committed `.pi/crosby.json` final integration commands before a real run.
- Existing child and parent issues need the documented review/browser/dependency sections. Missing or legacy evidence blocks explicitly; no automatic migration or invented acceptance steps were performed.
- Verifier hooks restrict direct file/tool mutations, and stable revision checks catch implementation changes. Shell access remains necessary for tests/Playwright; this is not an OS sandbox.
- Synthetic/browser command orchestration and failure gates are tested; no live website/browser journey or real GitHub publication was exercised here.
- Existing unrelated dashboard/workspace edits were preserved. No tools-repository commit or push was made. Temporary Git commits were only for isolated test fixtures.

Runtime contract and recovery instructions: `shared-workflows/pi/extensions/crosby/README.md`.
