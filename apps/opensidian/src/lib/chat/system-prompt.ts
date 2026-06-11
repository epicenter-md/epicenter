/**
 * System prompt building blocks for Opensidian chat.
 *
 * Opensidian composes its chat instructions as three separate system messages
 * instead of one giant string:
 *
 * 1. `OPENSIDIAN_SYSTEM_PROMPT` establishes the base role, tool capabilities,
 *    and hard constraints of the note-taking environment.
 * 2. `buildGlobalSkillsPrompt()` injects shared Epicenter platform skills like
 *    writing voice or documentation conventions.
 * 3. `buildVaultSkillsPrompt()` injects per-vault user customizations from
 *    `/skills/*.md`.
 *
 * This layering keeps the prompt architecture legible and makes precedence
 * explicit. Global skills can shape the assistant across the ecosystem, while
 * vault skills come last so personal instructions win when they conflict with
 * platform defaults.
 *
 * @example
 * ```typescript
 * const systemPrompts = [
 * 	OPENSIDIAN_SYSTEM_PROMPT,
 * 	buildGlobalSkillsPrompt(globalSkills),
 * 	buildVaultSkillsPrompt(vaultSkills),
 * ].filter(Boolean);
 * ```
 */
export const OPENSIDIAN_SYSTEM_PROMPT = `You are an AI assistant for Opensidian, a local-first note-taking app built on Epicenter.

You have access to the user's notes via a Yjs CRDT-backed virtual filesystem. Changes you make are immediately visible in the editor and sync across devices.

## Capabilities
- Search notes by content (full-text search via files_search)
- Read file content (files_read)
- List directory contents (files_list)
- Create, edit, and delete files (files_write, files_create, files_delete: requires approval)
- Move and rename files (files_move: requires approval)
- Create directories (files_mkdir: requires approval)
- Execute bash commands against the virtual filesystem (bash_exec: requires approval)

## Constraints
- All file paths are absolute and start with /
- The filesystem is virtual and backed by Yjs CRDTs: all changes sync in real-time
- Files are typically markdown (.md) but any text format is supported
- Mutations (write, create, delete, move, mkdir, bash) require user approval before executing
- Queries (search, read, list) execute automatically without approval
- When reading large files, content may be truncated: use bash head/tail for specific sections`;

/**
 * Build the system prompt section for global platform skills (Layer 2).
 *
 * Global skills come from the `@epicenter/skills` workspace: a CRDT-backed
 * skill registry shared across ALL Epicenter apps. They define ecosystem-wide
 * conventions like writing voice, documentation patterns, and code style.
 *
 * These skills are maintained by developers and the platform, not by the user.
 * They form the middle layer of the system prompt: after the base prompt
 * (Layer 1) and before vault skills (Layer 3).
 *
 * When vault skills conflict with global skills, the vault skill wins because
 * it appears later in the LLM context window (later instructions take priority).
 *
 * @param skills - Array of global skills with name and instructions content
 * @returns Formatted markdown section, or empty string if no skills are loaded
 */
export function buildGlobalSkillsPrompt(
	skills: ReadonlyArray<{ name: string; instructions: string }>,
): string {
	if (skills.length === 0) return '';

	return `## Global Skills (Epicenter Platform)\n\nThese skills define ecosystem-wide conventions shared across all Epicenter apps. Follow them unless a vault skill below explicitly overrides.\n\n${skills.map((s) => `### ${s.name}\n${s.instructions}`).join('\n\n')}`;
}

/**
 * Build the system prompt section for vault skills (Layer 3).
 *
 * Vault skills are markdown files in the user's `/skills/` directory: personal
 * customizations that only apply to this vault. The user creates and edits them
 * like any other note in Opensidian.
 *
 * Examples: "format my meeting notes with these headers", "use Spanish for
 * responses", "when summarizing, always include action items".
 *
 * Vault skills appear LAST in the system prompt, so they override global skills
 * when there's a conflict. This is intentional: the user's personal preferences
 * take priority over platform defaults.
 *
 * @param skills - Array of vault skills with filename and content
 * @returns Formatted markdown section, or empty string if no skills exist
 */
export function buildVaultSkillsPrompt(
	skills: ReadonlyArray<{ name: string; content: string }>,
): string {
	if (skills.length === 0) return '';

	return `## Vault Skills (User Customizations)\n\nThese skills are personal to this vault. The user created and maintains them. They override global skills when there is a conflict.\n\n${skills.map((s) => `### ${s.name}\n${s.content}`).join('\n\n')}`;
}
