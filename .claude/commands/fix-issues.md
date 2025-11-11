---
allowed-tools: Bash(*), Read, Write, Edit, Glob, Grep, Task
description: Analyze GitHub issues in parallel and create specification documents for implementation
model: claude-sonnet-4-5
argument-hint: [label] [limit]
dangerouslyDisableSandbox: true
---

# Parallel GitHub Issue Analyzer

Automatically fetch GitHub issues, spawn parallel sub-agents to analyze each issue, and create detailed specification documents that can be handed off to implementation agents.

## Arguments

- `$1`: GitHub issue label filter (default: "bug")
- `$2`: Maximum number of issues to process (default: 7)

User provided: $ARGUMENTS

---

## Workflow Overview

1. **Fetch Issues**: Get open GitHub issues with specified label
2. **Quick Assessment**: Determine which issues have enough context for analysis
3. **Parallel Analysis**: Spawn sub-agents to deeply analyze each issue
4. **Generate Specs**: Each agent creates a detailed markdown specification document
5. **Summary Report**: Aggregate results and show next steps

---

## Phase 1: Issue Discovery

### Step 1.1: Fetch GitHub Issues

Fetch issues with the specified label:

```bash
gh issue list \
  --label "${1:-bug}" \
  --state open \
  --limit "${2:-7}" \
  --json number,title,body,labels,url
```

### Step 1.2: Quick Assessment

For each issue, do a quick check:
- Has a description (not just a title)
- Contains some technical context (error messages, reproduction steps, etc.)
- Not labeled "needs-more-info" or "question"

Create a summary:
```
ISSUES TO ANALYZE:
==================

✓ Issue #920: audio playback has lag on linux
  Labels: bug, linux
  Reason: Has reproduction context

✓ Issue #918: White screen on launch on windows
  Labels: bug
  Reason: Clear technical issue

⚠ Issue #910: Add GPT-5 and GPT-5 mini
  Labels: feature request
  Reason: Feature request, but can still analyze

Total: X issues ready for analysis
```

---

## Phase 2: Parallel Analysis Agents

Spawn one analysis agent per issue using the Task tool. All agents run in parallel.

### Analysis Agent Prompt Template

For each issue, spawn a Task agent with this prompt:

```
You are a technical analyst agent. Your mission: deeply analyze GitHub issue #{number} and create a comprehensive specification document for implementation.

ISSUE DETAILS:
--------------
Number: #{number}
Title: {title}
Body: {body}
URL: {url}
Labels: {labels}

YOUR OBJECTIVE:
--------------

Create a detailed specification document at:
`/Users/braden/Code/whispering/.conductor/bilbao/issue-specs/{number}-{kebab-case-title}.md`

The spec should enable another agent (or human developer) to implement a fix without having to re-analyze the issue.

ANALYSIS WORKFLOW:
------------------

### 1. UNDERSTAND THE ISSUE (10-15 min)

Read the issue carefully and extract:
- What is the user trying to do?
- What is happening instead (symptoms)?
- What error messages or logs are provided?
- What platform/environment (OS, version, etc.)?
- Reproduction steps if provided
- Expected vs actual behavior

### 2. INVESTIGATE THE CODEBASE (15-20 min)

Use Grep and Glob to explore:
- Search for relevant error messages in the code
- Find files related to the feature area (e.g., "audio", "transcription", "recording")
- Look for similar issues or recent changes in related files
- Identify the likely file(s) and functions involved
- Check for platform-specific code paths if relevant

Example searches:
```bash
# Find error messages
rg "error message text" /Users/braden/Code/whispering/.conductor/bilbao

# Find feature area files
rg -t typescript "audio.*playback" /Users/braden/Code/whispering/.conductor/bilbao

# Check recent changes to related files
git log --oneline --since="3 months ago" -- path/to/suspected/file.ts
```

### 3. FORM HYPOTHESES (5-10 min)

Based on your investigation:
- What is the most likely root cause?
- Are there alternative explanations?
- What code paths are involved?
- Is this a timing issue, configuration issue, logic error, or something else?
- Are there related issues or patterns in the codebase?

### 4. DESIGN SOLUTION APPROACH (10-15 min)

Outline potential solutions:
- What is the simplest fix?
- What files need to be modified?
- What functions/classes need changes?
- Are there edge cases to consider?
- What testing approach is needed?
- Are there architectural considerations?

### 5. CREATE SPECIFICATION DOCUMENT

Write a comprehensive spec file with this structure:

```markdown
# Issue #{number}: {title}

**Status**: Ready for Implementation
**Issue URL**: {url}
**Labels**: {labels}
**Analyzed**: {current_date}

---

## Problem Summary

[1-2 paragraph summary of the issue in your own words. What is broken and why does it matter?]

## User Impact

- **Severity**: Critical / High / Medium / Low
- **Frequency**: Always / Often / Sometimes / Rarely
- **Affected Users**: [Who experiences this? All users, specific platform, specific configuration?]

## Technical Analysis

### Symptoms

- [Bullet list of observed symptoms]
- [Include error messages, logs, screenshots mentioned in issue]

### Reproduction Steps

1. [Step by step if provided, or "Not provided - see user report" if unclear]
2. ...

### Root Cause Hypothesis

[Your analysis of what's likely causing this. Be specific about code paths, files, functions.]

**Confidence Level**: High / Medium / Low

**Evidence**:
- [Why you think this is the cause]
- [Code references: file.ts:123]
- [Related issues or commits]

### Affected Code Paths

**Primary Files**:
- `path/to/file1.ts` (lines XXX-YYY) - [Description]
- `path/to/file2.ts` (lines XXX-YYY) - [Description]

**Related Files** (may need updates):
- `path/to/file3.ts` - [Description]

### Platform-Specific Considerations

[If the issue is platform-specific (Linux, macOS, Windows), note any platform-specific code paths or considerations]

---

## Proposed Solution

### Approach

[Describe the solution approach at a high level. Why this approach?]

### Implementation Steps

1. **[Step 1]**: [What to do and where]
   - File: `path/to/file.ts`
   - Change: [Specific change description]
   - Reason: [Why this change]

2. **[Step 2]**: [Next step]
   - File: `path/to/file.ts`
   - Change: [Specific change description]
   - Reason: [Why this change]

[Continue for all steps]

### Code Changes Required

**File 1: `path/to/file.ts`**

```typescript
// BEFORE (current code - approximate):
function existingFunction() {
  // current implementation
}

// AFTER (proposed change):
function existingFunction() {
  // new implementation with fix
}
```

**File 2: `path/to/file.ts`**

[Similar for each file that needs changes]

### Alternative Approaches Considered

**Option A**: [Alternative approach]
- Pros: [Benefits]
- Cons: [Drawbacks]
- Why not chosen: [Reason]

**Option B**: [Another alternative]
- Pros: [Benefits]
- Cons: [Drawbacks]
- Why not chosen: [Reason]

---

## Testing Strategy

### Manual Testing

1. [How to manually verify the fix]
2. [What to check]
3. [Expected behavior after fix]

### Automated Tests

**New Tests Needed**:
- [ ] Test case 1: [Description]
- [ ] Test case 2: [Description]

**Existing Tests to Verify**:
- [ ] Run test suite: `npm test path/to/test`
- [ ] Specific test: [test name]

### Regression Concerns

[Any areas that might break as a result of this fix? What to watch out for?]

---

## Implementation Guidance

### Prerequisites

- [Any required knowledge or context]
- [Relevant documentation to read]
- [Related issues or PRs to review]

### Estimated Complexity

- **Time Estimate**: [X hours/days]
- **Difficulty**: Low / Medium / High
- **Risk**: Low / Medium / High

### Dependencies

- [Any external dependencies or blockers]
- [Other issues that should be fixed first]

### Follow-up Work

- [Any related improvements or cleanups that could be done after]
- [Technical debt to address]

---

## Additional Context

### Related Issues

- #XXX - [Related issue with link]
- #YYY - [Another related issue]

### Recent Changes

[Any recent commits or PRs that touched this area]

```bash
git log --oneline --since="3 months ago" -- path/to/file
```

### Community Discussion

[Relevant comments from the GitHub issue that provide context]

---

## Questions for Implementer

- [ ] [Question 1 if anything is unclear]
- [ ] [Question 2]
- [ ] [Should we consider X approach instead?]

---

## Notes for Reviewer

[Any special considerations for PR review]

---

## Implementation Checklist

Use this when implementing:

- [ ] Read entire spec document
- [ ] Review issue comments on GitHub
- [ ] Understand root cause before coding
- [ ] Make changes to listed files
- [ ] Write/update tests
- [ ] Run full test suite
- [ ] Manual testing per Testing Strategy
- [ ] Update documentation if needed
- [ ] Create PR with conventional commit
- [ ] Link PR to issue #{number}

---

**Spec created by**: Automated analysis agent
**Confidence**: [Your confidence in this analysis: High/Medium/Low]
**Needs human review**: [Yes/No - if Yes, explain what needs review]
```

### 6. SAVE THE SPECIFICATION

Write the spec file to:
`/Users/braden/Code/whispering/.conductor/bilbao/issue-specs/{number}-{kebab-case-short-title}.md`

Use the Write tool with absolute path.

### 7. REPORT RESULTS

Provide a brief summary:

```
✅ ANALYSIS COMPLETE

Issue: #{number}
Title: {title}
Spec File: issue-specs/{number}-{title}.md

Key Findings:
- Root cause: [Brief description]
- Affected files: [List 2-3 main files]
- Complexity: [Low/Medium/High]
- Confidence: [High/Medium/Low]

The specification is ready for handoff to an implementation agent.
```

### ANALYSIS LIMITATIONS

If you cannot complete the analysis:

```
❌ ANALYSIS INCOMPLETE

Issue: #{number}
Title: {title}
Reason: [Why analysis couldn't be completed]

Recommendations:
- [What's needed to complete analysis]
- [Suggest adding "needs-more-info" label]
- [Or suggest manual investigation]
```

Common reasons for incomplete analysis:
- Issue description is too vague
- Cannot locate relevant code
- Requires domain expertise beyond code analysis
- Requires environment setup or reproduction

REMEMBER: Your goal is to create a thorough, actionable specification. Take your time to investigate properly. Quality over speed.
```

### Parallel Execution

Invoke all analysis agents in a SINGLE message with multiple Task tool calls:

```
Task(subagent_type: "general-purpose", description: "Analyze issue #920", prompt: {analysis_agent_prompt_920})
Task(subagent_type: "general-purpose", description: "Analyze issue #918", prompt: {analysis_agent_prompt_918})
Task(subagent_type: "general-purpose", description: "Analyze issue #916", prompt: {analysis_agent_prompt_916})
...
```

This launches all agents simultaneously, maximizing parallelism.

---

## Phase 3: Results Aggregation

After all sub-agents complete:

### Step 3.1: Collect Specification Files

List all generated specs:

```bash
ls -lh /Users/braden/Code/whispering/.conductor/bilbao/issue-specs/
```

### Step 3.2: Create Summary Report

Generate a summary showing:

```
ISSUE ANALYSIS COMPLETE
=======================

📊 Summary:
- Total issues analyzed: {N}
- Specifications created: {success_count}
- Analysis incomplete: {incomplete_count}

✅ SPECIFICATIONS READY:

1. Issue #920: audio playback has lag on linux
   Spec: issue-specs/920-audio-playback-lag-linux.md
   Complexity: Medium | Confidence: High
   Files: 3 files identified

2. Issue #918: White screen on launch on windows
   Spec: issue-specs/918-white-screen-launch-windows.md
   Complexity: High | Confidence: Medium
   Files: 5 files identified

[... continue for all successful analyses ...]

⚠️ INCOMPLETE ANALYSIS:

1. Issue #XXX: {title}
   Reason: {reason}
   Next Steps: {recommendation}

---

📁 SPECIFICATION FILES:

All specs are located at:
/Users/braden/Code/whispering/.conductor/bilbao/issue-specs/

To review a specific spec:
cat issue-specs/{number}-{title}.md

---

🚀 NEXT STEPS:

Option 1: Review and hand off to implementation agents
  - Review each specification document
  - Use Task tool to spawn implementation agents with specs

Option 2: Implement manually
  - Use specs as implementation guides
  - Each spec has detailed steps and code references

Option 3: Create PRs from specs
  - Run: /implement-from-spec {issue-number}
  - This will spawn an implementation agent with the spec

---

📋 QUICK COMMANDS:

# Review all specs
ls issue-specs/

# Read a specific spec
cat issue-specs/920-audio-playback-lag-linux.md

# Hand off to implementation agent (example)
Task with prompt: "Implement the fix described in issue-specs/920-audio-playback-lag-linux.md"
```

### Step 3.3: Create Index File

Create an index of all specifications:

```bash
cat > /Users/braden/Code/whispering/.conductor/bilbao/issue-specs/INDEX.md <<EOF
# Issue Specifications Index

Generated: $(date)

## Ready for Implementation

$(for file in /Users/braden/Code/whispering/.conductor/bilbao/issue-specs/*.md; do
  if [ "$file" != "/Users/braden/Code/whispering/.conductor/bilbao/issue-specs/INDEX.md" ]; then
    issue_num=$(basename "$file" | cut -d'-' -f1)
    title=$(head -1 "$file" | sed 's/# Issue #[0-9]*: //')
    echo "- [Issue #$issue_num]($file): $title"
  fi
done)

## Usage

Each specification contains:
- Problem analysis and root cause
- Proposed solution with code examples
- Testing strategy
- Implementation checklist

To implement a fix, read the spec and use it as your implementation guide.

EOF
```

---

## Configuration

Default settings (edit this file to customize):

```markdown
DEFAULT_LABEL="bug"
DEFAULT_LIMIT=7
SPEC_OUTPUT_DIR="/Users/braden/Code/whispering/.conductor/bilbao/issue-specs"
ANALYSIS_TIMEOUT=30  # minutes per issue
REQUIRE_CONFIDENCE_LEVEL=true
```

---

## Usage Examples

### Analyze all bugs (default)
```
/fix-issues
```

### Analyze specific label
```
/fix-issues "linux" 5
```

### Analyze feature requests
```
/fix-issues "feature request" 3
```

### Analyze high priority issues
```
/fix-issues "high-priority" 10
```

---

## Benefits of This Approach

✅ **No Risky Auto-Implementation**: Specifications are reviewed before implementation
✅ **Better Quality**: Deep analysis before writing code
✅ **Reusable**: Specs can be used by multiple implementers
✅ **Learning**: Specs document understanding of codebase
✅ **Async Work**: Specs can be implemented at any time
✅ **Parallel Analysis**: Process many issues quickly
✅ **Historical Record**: Specs serve as documentation

---

## Error Handling

### Issue Fetch Failures
- If `gh issue list` fails: Check authentication (`gh auth status`)
- If no issues found: Suggest different label
- If API rate limited: Show current limit (`gh api rate_limit`)

### Agent Failures
- If agent times out: Mark as incomplete, preserve any partial analysis
- If agent crashes: Report error and skip to next issue
- Continue with remaining agents even if some fail

### File System Issues
- If spec directory doesn't exist: Create it automatically
- If spec file already exists: Append timestamp to avoid overwriting
- If disk space low: Warn and limit number of issues

---

## Notes

- Analysis agents read the codebase but do NOT modify it
- All spec files are written to `issue-specs/` directory
- Each spec is self-contained and can be read independently
- Specs can be committed to git for team collaboration
- Specs serve as implementation blueprints for any developer

---

**Execution begins now. Starting Phase 1: Issue Discovery...**
