# Final Cleanup Checklist

Use this checklist to finish the skills/agents consolidation one decision at a time.

## Decision 1 — Keep or remove tool-local wrappers?

**Question:** After verifying the shared repo works, do you want to keep thin tool-local wrappers/indexes, or remove the duplicates entirely?

**Options:**
- **Keep wrappers**: the tool-local files stay, but they only point to the shared repo
- **Remove duplicates**: delete the redundant local copies once the shared repo is confirmed working

**Recommendation:** Remove duplicates later, but only after you confirm the shared repo is the source of truth in each tool.

**Decision:** `keep wrappers`

**Decision needed:** `remove duplicates` is deferred for now

---

## Decision 2 — Handle the semantic outliers

These are similar but not identical:
- `design`
- `handover`

**Decision:** `keep Pi canonical; retire Claude handover and design`

**Why:**
- `handover` was formerly a Notion-based Claude workflow, but that source of truth is no longer used
- `design` was only needed for the old FEATURE.md-based flow and is no longer needed now that handover brings in the spec
- The Pi workflow is now the canonical path for both handoff and design/spec refinement

**Recommendation:** Retire the Claude `handover` and `design` copies.

**Decision needed:** `rename` is not needed at this time

---

## Decision 3 — Shared repo access model

**Decision:** `direct manifest`

**Why:**
- Simpler source-of-truth model
- Less duplication and fewer sync points
- Easier to keep Pi, Claude Code, and Codex aligned

**Recommendation:** Each tool reads the shared repo manifest directly.

**Decision needed:** `local index` is not preferred unless a tool cannot reliably read the repo

---

## Decision 4 — Rename any collisions?

**Decision:** `not needed`

**Why:**
- Pi is the canonical path for both `design` and `handover`
- Claude’s legacy copies are being retired
- No naming change is required if the shared repo is the source of truth

**Recommendation:** Keep the names as-is and retire the legacy tool-specific copies.

---

## Decision 5 — Remove tool-specific copies after confirmation

**Question:** Once the shared repo is verified, which tool-specific copies should be deleted?

**Options:**
- Delete all redundant local copies
- Delete only the ones you’ve confirmed are redundant
- Keep some local copies as fallback

**Recommendation:** Delete only after the shared repo is proven working in Pi, Claude Code, and Codex.

**Decision:** `delete some`

**Action taken:** Deleted the retired Claude `handover` and `design` files.

---

## Suggested order

1. Keep or remove wrappers
2. Handle the semantic outliers (`design`, `handover`)
3. Choose the shared access model
4. Decide whether to rename anything
5. Remove redundant local copies
