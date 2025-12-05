# Standard Workflow

1. First think through the problem, read the codebase for relevant files, and write a plan to specs/[timestamp] [feature-name].md where [timestamp] is the timestamp in YYYYMMDDThhmmss format and [feature-name] is the name of the feature.
2. The plan should have a list of todo items that you can check off as you complete them
3. Before you begin working, check in with me and I will verify the plan.
4. Then, begin working on the todo items, marking them as complete as you go.
5. Please every step of the way just give me a high level explanation of what changes you made
6. Make every task and code change you do as simple as possible. We want to avoid making any massive or complex changes. Every change should impact as little code as possible. Everything is about simplicity.
7. Finally, add a review section to the .md file with a summary of the changes you made and any other relevant information.

# Expensive/destructive actions

1. Always get prior approval before performing expensive/destructive actions (tool calls).
   - Expensive actions require extended time to complete. Examples: test, build.
     - Why: Unexpected tests/builds just waste time and tokens. The test results are often innaccurate ("It works!" when it doesn't.)
   - Destructive actions result in permanant changes to project files. Examples: commit to git, push changes, edit a GitHub PR description.
      - Why: changes should be verified before adding to permanent project history. Often additional changes are needed.
2. Instead, you may automatically show a plan for the tool call you would like to make.
   - Commit messages should follow the conventional commits specification.
3. Then either the plan will be explicitly approved or changes to the plan will be requested.
4. Unless otherwise stated, any approval applies only to the plan directly before it. So any future action will require a new plan with associated approval.

# Human-Readable Control Flow

When refactoring complex control flow, mirror natural human reasoning patterns:

1. **Ask the human question first**: "Can I use what I already have?" → early return for happy path
2. **Assess the situation**: "What's my current state and what do I need to do?" → clear, mutually exclusive conditions
3. **Take action**: "Get what I need" → consolidated logic at the end
4. **Use natural language variables**: `canReuseCurrentSession`, `isSameSettings`, `hasNoSession`: names that read like thoughts
5. **Avoid artificial constructs**: No nested conditions that don't match how humans actually think through problems

Transform this: nested conditionals with duplicated logic
Into this: linear flow that mirrors human decision-making

# Honesty

Be brutally honest, don't be a yes man.
If I am wrong, point it out bluntly.
I need honest feedback on my code.

# Spec Placement

Specs always live at the root level of their scope (not inside `docs/`):

- **`/specs/`** - Cross-cutting features, architecture decisions, general tooling
- **`/apps/[app]/specs/`** - Features specific to one app only
- **`/packages/[pkg]/specs/`** - Package-specific implementation details

When in doubt, use `/specs/`. Move to app/package-specific only if the spec truly belongs there.

# Script Commands

The monorepo uses consistent script naming conventions:

| Command | Purpose | When to use |
|---------|---------|-------------|
| `bun format` | **Fix** formatting (biome + prettier) | Development |
| `bun format:check` | Check formatting | CI |
| `bun lint` | **Fix** lint issues (eslint + biome) | Development |
| `bun lint:check` | Check lint issues | CI |
| `bun check` | Type checking (tsc, svelte-check, astro check) | Both |

**Convention:**
- No suffix = **fix** (modifies files)
- `:check` suffix = check only (for CI, no modifications)
- `check` alone = type checking (separate concern, cannot auto-fix)

**After completing code changes**, run type checking to verify:
```bash
bun check
```

This runs `turbo run check` which executes the `check` script in each package (e.g., `tsc --noEmit`, `svelte-check`).
