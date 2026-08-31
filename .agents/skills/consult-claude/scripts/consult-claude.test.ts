import { expect, test } from 'bun:test';

import { laboratorySettings, parseFollowUpOptions, parseNativeAgentId, parseStartOptions } from './consult-claude.js';

test('parses an explicit waiting research run', () => {
	expect(parseStartOptions(['--name', 'store-boundary', '--wait'])).toEqual({
		name: 'store-boundary',
		wait: true,
		dryRun: false,
	});
});

test('rejects repeated and unknown options', () => {
	expect(parseStartOptions(['--wait', '--wait'])).toBeUndefined();
	expect(parseStartOptions(['--unknown'])).toBeUndefined();
});

test('captures the native Agent View ID when Claude backgrounds a run', () => {
	expect(parseNativeAgentId('backgrounded · 500a038f\nclaude attach 500a038f')).toBe('500a038f');
	expect(parseNativeAgentId('ordinary output')).toBeUndefined();
});

test('parses a follow-up that can wait for the revised checkpoint', () => {
	expect(parseFollowUpOptions(['research-42', '--wait'])).toEqual({ id: 'research-42', wait: true });
	expect(parseFollowUpOptions(['research-42', '--unexpected'])).toBeUndefined();
});

test('builds a sealed editable laboratory policy', () => {
	const settings = laboratorySettings();
	expect(settings.permissions.deny).not.toContain('Edit');
	expect(settings.permissions.deny).not.toContain('Write');
	expect(settings.sandbox.network).toEqual({ allowedDomains: [], strictAllowlist: true });
	expect(settings.worktree).toEqual({ bgIsolation: 'none' });
});
