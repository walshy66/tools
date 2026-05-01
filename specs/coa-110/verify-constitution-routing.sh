#!/usr/bin/env bash
set -euo pipefail

root="shared-workflows/references"
entry="$root/constitution.md"
dev="$root/constitution.development.md"
proc="$root/constitution.process-automation.md"
skills_root="shared-workflows/portable/skills"

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "missing $path"
}

require_line() {
  local pattern="$1"
  local path="$2"
  local message="$3"
  grep -Fq -- "$pattern" "$path" || fail "$message"
}

require_file "$entry"
require_file "$dev"
require_file "$proc"

require_line '## Core' "$entry" "constitution.md missing '## Core'"
require_line '## Work Type Routing' "$entry" "constitution.md missing '## Work Type Routing'"
require_line '## Selection Algorithm' "$entry" "constitution.md missing '## Selection Algorithm'"
require_line 'constitution.development.md' "$entry" "constitution.md missing development mapping"
require_line 'constitution.process-automation.md' "$entry" "constitution.md missing process-automation mapping"
require_line 'If the selector is missing, stop and tell the user to add `wt:development` or `wt:process-automation`.' "$entry" "constitution.md missing missing-label blocking guidance"
require_line 'If multiple work-type labels are present, stop and require exactly one.' "$entry" "constitution.md missing multiple-label blocking guidance"
require_line 'If the selector conflicts with the narrative issue content, proceed by selector and warn.' "$entry" "constitution.md missing mismatch warning guidance"
require_line 'If the mapped document is missing or unreadable, stop with a configuration error.' "$entry" "constitution.md missing missing-doc blocking guidance"
require_line 'Work Type: development' "$entry" "constitution.md missing non-Linear development header guidance"
require_line 'Work Type: process-automation' "$entry" "constitution.md missing non-Linear process-automation header guidance"
require_line 'Apply only the overrides declared in that document’s `## Overrides` section.' "$entry" "constitution.md missing explicit override handling guidance"

require_line '## Overrides' "$dev" "constitution.development.md missing '## Overrides'"
require_line '- None.' "$dev" "constitution.development.md missing explicit override declaration"
require_line '## Overrides' "$proc" "constitution.process-automation.md missing '## Overrides'"
require_line '- None.' "$proc" "constitution.process-automation.md missing explicit override declaration"

non_linear_hard_gated_skills=(
  "$skills_root/analyze/SKILL.md"
  "$skills_root/clarify/SKILL.md"
  "$skills_root/code-reviewer/SKILL.md"
  "$skills_root/design/SKILL.md"
  "$skills_root/design-reviewer/SKILL.md"
  "$skills_root/implement/SKILL.md"
  "$skills_root/plan/SKILL.md"
  "$skills_root/tasks/SKILL.md"
)

linear_only_hard_gated_skills=(
  "$skills_root/ralph-loop/SKILL.md"
)

for skill in "${non_linear_hard_gated_skills[@]}"; do
  require_file "$skill"
  require_line 'shared-workflows/references/constitution.md' "$skill" "$skill missing canonical constitution entrypoint"
  require_line 'wt:development' "$skill" "$skill missing development label selector"
  require_line 'wt:process-automation' "$skill" "$skill missing process-automation label selector"
  require_line 'Work Type: development' "$skill" "$skill missing non-Linear development header selector"
  require_line 'Work Type: process-automation' "$skill" "$skill missing non-Linear process-automation header selector"
  require_line 'If the selector is missing, invalid, or duplicated, stop with recovery guidance' "$skill" "$skill missing selector failure guidance"
  require_line 'If the selector conflicts with the issue narrative, warn and proceed by selector' "$skill" "$skill missing mismatch warning guidance"
  require_line 'Load `## Core` plus the mapped work-type document' "$skill" "$skill missing routing load guidance"
done

for skill in "${linear_only_hard_gated_skills[@]}"; do
  require_file "$skill"
  require_line 'shared-workflows/references/constitution.md' "$skill" "$skill missing canonical constitution entrypoint"
  require_line 'wt:development' "$skill" "$skill missing development label selector"
  require_line 'wt:process-automation' "$skill" "$skill missing process-automation label selector"
  require_line 'If the selector is missing, invalid, or duplicated, stop with recovery guidance' "$skill" "$skill missing selector failure guidance"
  require_line 'If the selector conflicts with the issue narrative, warn and proceed by selector' "$skill" "$skill missing mismatch warning guidance"
  require_line 'Load `## Core` plus the mapped work-type document' "$skill" "$skill missing routing load guidance"
done

require_file "$skills_root/grill-me/SKILL.md"
require_line 'If a work-type selector is present, use it as context; if it is missing or ambiguous, continue and ask the user which work type applies' "$skills_root/grill-me/SKILL.md" "grill-me missing ambiguity guidance"

echo "PASS: constitution routing verification covers selector routing, blocking, mismatch, non-Linear headers, and overrides"