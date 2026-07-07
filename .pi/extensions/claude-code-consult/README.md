# Pi Claude Code Consult

A Pi extension that asks local Claude Code for read-only consulting.

The boundary is intentionally narrow: Pi owns the coding session and executes the work. Claude Code is a high-cost advisor for architecture, adversarial review, greenfield planning, ownership calls, and API tradeoffs.

## Tool

This project-local extension registers one tool:

```txt
claude_code_consult
```

It runs:

```bash
claude -p --output-format json --permission-mode plan
```

By default it also strips inherited MCP configuration:

```bash
--strict-mcp-config --disallowedTools mcp__*
```

Set `allow_mcp: true` on a call when a consult should inherit Claude Code MCP tools, such as DeepWiki.

## Parameters

- `prompt`: the consulting request. Include the decision, files, evidence, boundaries, and artifact wanted.
- `cwd`: working directory for Claude Code. Defaults to Pi's current working directory.
- `session_id`: continue a previous Claude Code consult with `--resume`.
- `model`: optional Claude Code model override.
- `effort`: optional Claude Code effort override: `low`, `medium`, `high`, `xhigh`, or `max`.
- `max_budget_usd`: optional print-mode budget cap.
- `allow_mcp`: optional MCP inheritance. Defaults to `false`.

## What Pi should use it for

Use `claude_code_consult` when a second opinion is worth the cost:

- architecture decisions
- greenfield clean-break review
- adversarial review
- complex implementation planning
- unclear ownership boundaries
- API design tradeoffs

Do not use it for routine work:

- search or grep
- normal file reading
- tests
- small edits
- straightforward refactors
- ordinary implementation

## Consultant prompt doctrine

Every call wraps the user's prompt with instructions that tell Claude Code:

- act as a consultant, not the executor
- stay read-only
- delegate token-heavy context gathering to Codex subagents when available
- treat Codex outputs as evidence, not authority
- return a recommendation, evidence, risks, and an implementation plan when useful

That keeps Claude Code focused on judgment instead of spending budget on broad repository exploration.

## Use it in this repository

This extension lives in `.pi/extensions/claude-code-consult/index.ts`, so Pi auto-discovers it after the project is trusted.

From this repository:

```bash
pi --approve
```

To test only this extension for one run:

```bash
pi -e ./.pi/extensions/claude-code-consult
```

The extension uses your local `claude` binary and login. It never passes `--bare`, because `--bare` disables OAuth and keychain auth for Claude Code.
