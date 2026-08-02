/**
 * Consult Claude Runner Tests
 *
 * Verifies that the consultation runner exposes investigation tools while
 * preserving the fresh, read-only, one-shot execution boundary.
 *
 * Key behaviors:
 * - Claude receives only the intended investigation tools
 * - Plan mode and safe mode enforce a fresh read-only session
 * - High effort, bounded persistence, and browser isolation remain explicit
 */

import { describe, expect, test } from 'bun:test';
import { buildClaudeArgs } from './consult-claude';

describe('buildClaudeArgs', () => {
	test('configures one fresh high-effort read-only investigation', () => {
		expect(buildClaudeArgs()).toEqual([
			'-p',
			'--safe-mode',
			'--effort',
			'high',
			'--tools',
			'Read,Glob,Grep,WebFetch,WebSearch',
			'--permission-mode',
			'plan',
			'--no-session-persistence',
			'--no-chrome',
			'--output-format',
			'text',
		]);
	});
});
