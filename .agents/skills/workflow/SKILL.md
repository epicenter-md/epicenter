---
name: workflow
description: Standard workflow for implementing features with specs and planning documents. Use when starting a new feature, planning implementation, or working on any non-trivial task.
---

# Standard Workflow

1. First think through the problem, read the codebase for relevant files, and write a plan to specs/[timestamp] [feature-name].md where [timestamp] is the timestamp in YYYYMMDDThhmmss format and [feature-name] is the name of the feature.
2. The plan should have a list of todo items that you can check off as you complete them
3. Before you begin working, check in with me and I will verify the plan.
4. Then, begin working on the todo items, marking them as complete as you go.
5. Please every step of the way just give me a high level explanation of what changes you made
6. Make every task and code change you do as simple as possible. We want to avoid making any massive or complex changes. Every change should impact as little code as possible. Everything is about simplicity.
7. Finally, add a review section to the .md file with a summary of the changes you made and any other relevant information.

# Spec Placement

Specs always live at the root level of their scope (not inside `docs/`):

- **`/specs/`** - Cross-cutting features, architecture decisions, general tooling
- **`/apps/[app]/specs/`** - Features specific to one app only
- **`/packages/[pkg]/specs/`** - Package-specific implementation details

When in doubt, use `/specs/`. Move to app/package-specific only if the spec truly belongs there.
