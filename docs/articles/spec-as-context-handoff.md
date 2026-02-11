# Write Context to a File, Not a Prompt

**TL;DR**: When working with coding agents, externalize your context to a spec file. Subagents read the file directly—no copy-pasting, no re-explaining, no compression loss.

> The spec file is the handoff mechanism. Pass the filename, not the context.

## The Problem

You spend 20 minutes building shared understanding with your agent. Now you need to delegate a subtask. The subagent starts with nothing.

```
delegate_task(
  prompt="""
    ## TASK
    Migrate all usages of deprecated TableDefinitionMap...

    ## CONTEXT
    The spec is at specs/20260129T150000-migration.md
    workspace-doc.ts already has the updated pattern...
    The new generic pattern is TTableDefinitions extends readonly TableDefinition[]
    NOT TTableDefinitionMap extends TableDefinitionMap...

    ## MUST DO
    1. Start by reading workspace-doc.ts around line 150...
    2. Run type-check after each file...

    ## MUST NOT DO
    - Don't remove KvDefinition type...
    - Don't add @ts-ignore...
  """
)
```

You're re-writing context for every subagent. Different subagents, same context. Different sessions, same context.

## The Solution

Have your agent write the plan to a file first. Then execute from the file.

```
delegate_task(
  prompt="Read specs/20260129T150000-migration.md. Execute Phase 2."
)
```

The subagent reads fresh, complete context directly. No compression. No loss.

## The Workflow

1. Gather context: explore with your agent, messy back-and-forth
2. Output to spec: agent writes plan, constraints, file paths to markdown
3. Edit the spec: you refine it in your editor
4. Clear context: new chat or clear context; exploration is done
5. Execute from spec: point at the file, agent reads fresh

## Why This Works

The filename is a handle, not content. You're not copying context into the prompt; you're pointing to it. The subagent reads the file directly.

This means:

- If the spec updates, subagents get the latest
- Direct access, no lossy summarization
- Clean execution: clear your chat after writing the spec, start fresh, no stale assumptions from exploration

| Copy-Paste Context           | Spec-First              |
| ---------------------------- | ----------------------- |
| Re-written for each subagent | Written once, read many |
| Lossy compression            | Full fidelity           |
| Gets stale                   | Single source of truth  |
| Trapped in prompts           | Editable, versionable   |

## When to Apply

- Task has multiple steps or phases
- You'll delegate to subagents
- Context is complex enough to forget
- You might need to resume later

Skip it for one-liners. If you can explain it in a sentence, just do it.

## Summary

| Instead of                        | Do this                    |
| --------------------------------- | -------------------------- |
| Copy-pasting context to subagents | Write context to spec file |
| Re-explaining in each prompt      | Pass the filename          |
| Context trapped in conversation   | Context lives in a file    |
