---
name: review-pr
description: Review a pull request or local branch diff for correctness, security, lifecycle, error handling, tests, and meaningful performance risks. Use when asked to review PR changes, a branch, a commit range, or the current working tree and return a structured review.
---

# Review PR

Review the requested change set and return one structured JSON review as the final response.

## Establish scope

1. Use the base branch, commit, or range named by the user.
2. Otherwise determine the merge base with the repository's default branch.
3. Include committed branch changes plus relevant staged, unstaged, and untracked files.
4. Use available change descriptions, specifications, and review context.
5. Focus on changed code and the unchanged call sites needed to prove or disprove a finding.

## Review priorities

Prioritize:

1. Correctness, data loss, security, crashes, and broken user behavior.
2. Lifecycle, concurrency, stale state, cleanup, and error-handling problems.
3. Material performance regressions on demonstrated hot paths.
4. Missing tests only when they cover a distinct behavior or edge case.

Avoid speculative findings. Trace relevant callers, state transitions, cleanup paths, and existing tests before reporting an issue. Do not flag untouched code unless the change makes it unsafe.

Treat robustness ideas as suggestions unless they present a concrete correctness, security, or data-loss risk. Do not request tests that merely vary constructor inputs or fields already covered by the same behavior.

## Finding rules

Use these severities:

- `critical`: security issue, data loss, crash, or broadly broken behavior.
- `important`: concrete logic, lifecycle, edge-case, or error-handling bug.
- `suggestion`: worthwhile non-blocking improvement.
- `nit`: precise cleanup with a concrete replacement.

For every finding:

- Cite a repository-relative path.
- Cite an exact changed line when possible; otherwise use `null`.
- Explain the failure mode and when it occurs.
- Give a concrete fix direction.
- Keep the body concise and actionable.

Return `REQUEST_CHANGES` only when at least one `critical` or `important` finding remains. Suggestions and nits do not block approval.

## Output

Return only valid JSON with this shape. Do not wrap it in a Markdown fence and do not write it to disk.

```json
{
  "verdict": "REQUEST_CHANGES",
  "overview": "Short description of the reviewed change and overall assessment.",
  "findings": [
    {
      "severity": "important",
      "path": "path/to/file.ts",
      "line": 42,
      "title": "Short finding title",
      "body": "Failure mode, evidence, and concrete fix direction."
    }
  ],
  "counts": {
    "critical": 0,
    "important": 1,
    "suggestion": 0,
    "nit": 0
  }
}
```

`verdict` must be exactly `APPROVE` or `REQUEST_CHANGES`. `findings` must be empty when no issues remain. Counts must match the findings array.

Do not modify the repository or publish the review unless the user separately asks.
