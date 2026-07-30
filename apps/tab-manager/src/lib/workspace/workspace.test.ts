/**
 * Tab Manager Lens contract tests.
 *
 * These shapes are the wire contract for sync, so they are asserted rather than
 * left to a reviewer's eye. What is guarded here:
 * - the one namespace this application interprets (ADR-0160)
 * - the durable table names, which are what row addresses carry
 * - that no table authors an `id`, because row ids are runtime-minted
 * - that live browser state never became durable
 */

/// <reference types="bun" />

import { describe, expect, test } from 'bun:test';
import { tabManagerLens } from './index.js';

describe('the Tab Manager Lens', () => {
	test('interprets exactly one namespace', () => {
		expect(tabManagerLens.namespace).toBe('so.epicenter.tab-manager');
	});

	test('declares the durable tables and no others', () => {
		expect(Object.keys(tabManagerLens.tables).toSorted()).toEqual([
			'bookmarks',
			'conversations',
			'devices',
			'savedTabs',
			'toolTrust',
		]);
	});

	test('declares no durable values', () => {
		expect(Object.keys(tabManagerLens.values)).toEqual([]);
	});

	test('never authors an id field, because row ids are runtime-minted', () => {
		for (const [name, table] of Object.entries(tabManagerLens.tables)) {
			expect(Object.keys(table.fields), name).not.toContain('id');
		}
	});

	test('keeps live browser state out of durable storage', () => {
		// Chrome owns tabs, windows, and tab groups; they die with the panel. A
		// table named after any of them would mean that stopped being true.
		expect(Object.keys(tabManagerLens.tables)).not.toContain('tabs');
		expect(Object.keys(tabManagerLens.tables)).not.toContain('windows');
		expect(Object.keys(tabManagerLens.tables)).not.toContain('tabGroups');
	});

	test('stamps saved rows with the device that created them', () => {
		expect(Object.keys(tabManagerLens.tables.savedTabs.fields)).toContain(
			'sourceNodeId',
		);
		expect(Object.keys(tabManagerLens.tables.bookmarks.fields)).toContain(
			'sourceNodeId',
		);
		// The node id is a field on `devices` rather than its row id, so a
		// `sourceNodeId` has something stable to point at.
		expect(Object.keys(tabManagerLens.tables.devices.fields)).toContain(
			'nodeId',
		);
	});

	test('models tool trust as a presence set keyed by tool name', () => {
		// One row per grant, so two devices granting two different tools at once
		// keep both. A single value holding the list would lose one.
		expect(Object.keys(tabManagerLens.tables.toolTrust.fields)).toEqual([
			'toolName',
		]);
	});
});
