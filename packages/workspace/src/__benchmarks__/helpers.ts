/**
 * Shared fixtures and utilities for benchmark tests.
 *
 * All benchmark files import from here to avoid duplicating
 * table definitions, row generators, and formatting helpers.
 */

import { Type } from 'typebox';
import { field } from '@epicenter/field';
import { defineKv } from '../document/define-kv';
import { defineTable } from '../document/define-table';

// ═══════════════════════════════════════════════════════════════════════════════
// Table & KV Definitions
// ═══════════════════════════════════════════════════════════════════════════════

export const postDefinition = defineTable({
	id: field.string(),
	title: field.string(),
	views: field.number(),
});

export const noteDefinition = defineTable({
	id: field.string(),
	title: field.string(),
	content: field.string(),
	tags: field.json(Type.Array(Type.String())),
	createdAt: field.number(),
	updatedAt: field.number(),
});

export const heavyNoteDefinition = defineTable({
	id: field.string(),
	title: field.string(),
	content: field.string(),
	summary: field.string(),
	tags: field.json(Type.Array(Type.String())),
	createdAt: field.number(),
	updatedAt: field.number(),
});

export const eventDefinition = defineTable({
	id: field.string(),
	type: field.select(['command', 'event']),
	name: field.string(),
	payload: field.string(),
	timestamp: field.number(),
});

export const settingsDefinition = defineKv(
	Type.Object({
		theme: Type.Enum(['light', 'dark']),
		fontSize: Type.Number(),
	}),
	() => ({ theme: 'light' as const, fontSize: 14 }),
);

// ═══════════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════════

export function generateId(index: number): string {
	return `id-${index.toString().padStart(6, '0')}`;
}

export function generateHeavyContent(charCount: number): string {
	const paragraph =
		'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. ';
	return paragraph
		.repeat(Math.ceil(charCount / paragraph.length))
		.slice(0, charCount);
}

export function makeHeavyRow(id: string, contentChars: number) {
	return {
		id,
		title: `Document: ${id} - A Very Important Title That Is Reasonably Long`,
		content: generateHeavyContent(contentChars),
		summary: generateHeavyContent(Math.floor(contentChars / 10)),
		tags: ['research', 'important', 'draft', 'long-form'],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

export const sampleEventPayload = JSON.stringify({
	userId: 'usr-001',
	action: 'click',
	target: 'button.submit',
	metadata: { page: '/dashboard', sessionId: 'sess-abc123' },
});

// ═══════════════════════════════════════════════════════════════════════════════
// Measurement Utilities
// ═══════════════════════════════════════════════════════════════════════════════

export function measureTime<T>(fn: () => T): { result: T; durationMs: number } {
	const start = performance.now();
	const result = fn();
	const durationMs = performance.now() - start;
	return { result, durationMs };
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
