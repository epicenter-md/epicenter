# Agent Skills Are Just Prompt Injection (And That's Fine)

Agent skills aren't complicated. The agent scans a folder for `SKILL.md` files, reads the description from each one, and pastes those descriptions into the system prompt. That's it.

## How It Works

When you start an agent like Claude Code or OpenCode, here's what happens:

1. The agent scans directories for `SKILL.md` files
2. It reads the YAML frontmatter at the top of each file
3. It injects a list of skill names and descriptions into the system prompt
4. The LLM sees the list and decides when to load one

There's no special API. No protocol negotiation. No runtime hooks. The agent literally reads files and stuffs text into the prompt.

## The Clever Bit: Progressive Disclosure

Here's why this isn't as dumb as it sounds.

A skill file might be 300 lines. You might have 20 skills. Loading all of that upfront would burn 6,000+ tokens before you've even asked a question.

So instead, the agent only injects the metadata:

```
Available skills:
- typescript: TypeScript code style and patterns. Use when writing TypeScript...
- git: Git commit guidelines. Use when creating commits...
- error-handling: Error handling patterns. Use when writing try-catch...
```

Maybe 50 tokens per skill. With 20 skills, that's 1,000 tokens. Not 6,000.

When the LLM decides it needs one, it calls a tool that loads the full content. Most conversations only need one or two skills. The rest never get loaded at all.

## The Description Is the Trigger

The entire system hinges on one field: `description`.

```yaml
---
name: git
description: Git commit and pull request guidelines. Use when creating
commits, writing commit messages, creating PRs, or reviewing PR descriptions.
---
```

See that "Use when..." phrase? That's the activation trigger. The LLM pattern-matches your request against these descriptions and decides which skill to load.

Bad description, bad matching. Good description, the skill loads exactly when you need it.

## Every App Does This

I looked at how different tools handle skills:

| Tool        | Where It Looks                        | How It Injects      |
| ----------- | ------------------------------------- | ------------------- |
| Claude Code | `.claude/skills/`                     | System prompt XML   |
| OpenCode    | `.opencode/skill/`, `.claude/skills/` | System prompt XML   |
| Cursor      | `.cursor/rules/`                      | Prepends to context |
| Codex       | agentskills.io spec                   | System prompt       |

Different directories. Same mechanism. Scan files, extract metadata, inject into prompt, let the LLM decide.

## You Could Build This Yourself

Seriously. The whole pattern is maybe 50 lines:

```typescript
// Scan for skills
const skills = await glob('skills/*/SKILL.md');

// Parse frontmatter
const index = skills.map((path) => {
	const { name, description } = parseFrontmatter(readFile(path));
	return { name, description, path };
});

// Inject into prompt
const prompt = `
Available skills:
${index.map((s) => `- ${s.name}: ${s.description}`).join('\n')}

Call loadSkill(name) when you need detailed instructions.
`;

// Tool handler
function loadSkill(name) {
	const skill = index.find((s) => s.name === name);
	return readFile(skill.path);
}
```

That's the entire architecture. The "intelligence" is just the LLM matching requests to descriptions.

## Why This Matters

Skills aren't magic. They're a pattern for managing context efficiently.

MCP servers, by contrast, require actual runtime integration. They expose tools, handle requests, manage connections. Real complexity.

Skills? They're just files. You read them. You inject text. The LLM does the rest.

This means you can:

- Write skills in any text editor
- Version them with git
- Share them across projects
- Understand exactly what's happening

No black boxes. No protocols to learn. Just markdown files and prompt injection.

## The Takeaway

Agent skills solve a real problem: LLMs need context, but context is expensive. Progressive disclosure lets you provide detailed instructions without burning tokens on stuff you'll never use.

But the implementation is refreshingly simple. Scan directories. Parse YAML. Inject descriptions. Let the model decide.

That's it. That's the whole thing.
