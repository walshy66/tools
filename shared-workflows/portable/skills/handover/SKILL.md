---
name: handover
description: Fetch Linear issue with "Handover" status, extract spec.md attachment, create feature branch and directory structure for development work.
---

# Handover Agent Skill

This skill fetches a Linear issue marked with "Handover" status, extracts the attached spec.md document, creates a feature branch, sets up the local directory structure, and prepares the project for development work.

## Setup

Ensure you have the Linear CLI installed and authenticated:
```bash
linear --version
```

You should be logged into Linear. If not, run:
```bash
linear auth login
```

## Usage

Invoke this skill with:
```
/skill:handover
```

## Workflow

### Step 1: Search Linear for "Handover" Status Issues

Use the Linear CLI to search for issues with status "Handover":
```bash
linear issue list --filter "state.name=Handover"
```

Interpret the results:
- **0 issues found**: Stop — tell user to mark an issue as "Handover" in Linear first
- **1 issue found**: Proceed automatically
- **2+ issues found**: Ask user which one to hand off

### Step 2: Extract Issue Metadata

From the selected Linear issue, extract:
- **Issue key** (e.g., `ENG-42`)
- **Issue title** (e.g., `Exercise Block & Tempo Persistence`)
- **URL** (for reference)
- **Attachments** (look for `spec.md`)

### Step 3: Generate Feature Slug

Create a slug from the issue key and title:
- Start with the issue key (e.g., `ENG-42`)
- Convert title to lowercase, hyphens for spaces, no special characters
- Keep it to ~50 characters total
- Examples:
  - `ENG-42` + `Exercise Block & Tempo Persistence` → `eng-42-exercise-block-tempo-persistence`
  - `ENG-99` + `User Preferences` → `eng-99-user-preferences`

### Step 4: Download the Attached spec.md

Using Linear's attachment mechanism:
- Find any attachment matching `*spec.md` or `{ISSUE-KEY}-spec.md` (e.g., `COA-30-spec.md`)
- Download it to a temporary location
- If no `spec.md` attachment is found, stop and ask the user to attach it first

### Step 5: Create Local Directory Structure

Create directory: `specs/{feature-slug}/`

Copy the downloaded `spec.md` into `specs/{feature-slug}/spec.md`

### Step 6: Git Workflow

```bash
# 1. Create feature branch (use the Linear key + slugified title)
git checkout -b {feature-slug}

# 2. Stage the spec directory
git add specs/{feature-slug}/

# 3. Commit
git commit -m "chore: handover {ISSUE-KEY} - {issue-title}"

# 4. Stay on the feature branch (do NOT merge to main yet)
```

### Step 7: Update Linear Issue Status

After committing successfully:
- Update the Linear issue status from "Handover" → "Planning"
- Add a comment: "Handover complete. Spec extracted and feature branch created. Ready for design/planning."
- Link to the feature branch name in the comment

### Step 8: Confirm Success

```
✅ Handover successful!

📁 specs/{feature-slug}/
   └── spec.md  ← from Linear issue {ISSUE-KEY}

🔗 Git: on branch {feature-slug}
   Status:
   - specs/{feature-slug}/ staged and committed
   - Ready for development

🔗 Linear: Issue {ISSUE-KEY} status updated to "Planning"

📝 Next steps:
   1. Begin work on this branch
   2. When ready: git push origin {feature-slug}
   3. Create PR against main
```

## Key Rules

✅ **DO:**
- Use Linear CLI to find and fetch issue attachments
- Preserve the exact spec.md from Linear — do not edit it
- Name the branch using the Linear key + slugified title
- Stay on the feature branch after commit (do NOT merge to main)
- Report the Linear URL for reference

❌ **DON'T:**
- Modify or interpret the spec.md before copying it
- Push to origin without user confirmation
- Merge to main during handover (that's done after dev/review)
- Skip if no spec.md is attached — ask the user to attach it first

## Tools Used

- Bash — Linear CLI, git commands, file operations
- File system — create directories and copy files

## Error Handling

**No "Handover" issues found in Linear:**
→ Stop. Tell user to mark an issue "Handover" in Linear first.

**Issue has no spec.md attachment:**
→ Stop. Show the issue URL and ask user to attach spec.md before retrying.

**Feature directory already exists:**
→ Ask: "specs/{slug}/ already exists. Overwrite or skip?"

**Git branch already exists:**
→ Ask: "Branch {feature-slug} already exists. Checkout existing or create new?"

**Git command fails:**
→ Show the error. Ask user to resolve before continuing.

**Linear CLI fails:**
→ Tell user to check Linear CLI authentication and try again.