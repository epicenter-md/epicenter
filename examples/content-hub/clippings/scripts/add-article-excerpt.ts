import { createEpicenterClient } from '@epicenter/hq';
import epicenter from '../../epicenter.config';

await using client = await createEpicenterClient(epicenter);

// "Writing a good CLAUDE.md" - https://www.humanlayer.dev/blog/writing-a-good-claude-md
const ARTICLE_ID = '4z659zpoq2l3zi6';

client.clippings.addArticleExcerpt({
	article_id: ARTICLE_ID,
	content: `## Principle: LLMs are (mostly) stateless

LLMs are stateless functions. Their weights are frozen by the time they're used for inference, so they don't learn over time. The only thing that the model knows about your codebase is the tokens you put into it.

Similarly, coding agent harnesses such as Claude Code usually require you to manage agents' memory explicitly. \`CLAUDE.md\` (or \`AGENTS.md\`) is the only file that by default goes into *every single conversation* you have with the agent.

**This has three important implications:**

1. Coding agents know absolutely nothing about your codebase at the beginning of each session.
2. The agent must be told anything that's important to know about your codebase each time you start a session.
3. \`CLAUDE.md\` is the preferred way of doing this.`,
	comment:
		'Core insight: CLAUDE.md is the only persistent memory across sessions',
});

console.log('✓ Article excerpt added');
