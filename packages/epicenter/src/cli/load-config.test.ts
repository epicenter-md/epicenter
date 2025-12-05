import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadEpicenterConfig } from './load-config';

describe('loadEpicenterConfig', () => {
	const BASE_TEST_DIR = path.join(import.meta.dir, '.data/load-config-test');
	let testDir: string;

	beforeEach(async () => {
		// Create unique test directory for each test
		testDir = path.join(
			BASE_TEST_DIR,
			`test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(testDir)) {
			await rm(testDir, { recursive: true, force: true });
		}
	});

	afterAll(async () => {
		// Clean up the base test directory
		if (existsSync(BASE_TEST_DIR)) {
			await rm(BASE_TEST_DIR, { recursive: true, force: true });
		}
	});

	test('throws error when no config file found', async () => {
		const nonExistentDir = `/tmp/nonexistent-epicenter-test-dir-${Date.now()}`;

		await expect(loadEpicenterConfig(nonExistentDir)).rejects.toThrow(
			/No epicenter config file found/,
		);
	});

	test('throws error when config has no id', async () => {
		const configPath = path.join(testDir, 'epicenter.config.js');
		await writeFile(configPath, `module.exports = { workspaces: [] };`);

		await expect(loadEpicenterConfig(testDir)).rejects.toThrow(
			/must have a valid string id/,
		);
	});

	test('throws error when config has no workspaces array', async () => {
		const configPath = path.join(testDir, 'epicenter.config.js');
		await writeFile(configPath, `module.exports = { id: 'test' };`);

		await expect(loadEpicenterConfig(testDir)).rejects.toThrow(
			/must have a workspaces array/,
		);
	});

	test('loads config from epicenter.config.ts', async () => {
		const configPath = path.join(testDir, 'epicenter.config.js');
		await writeFile(
			configPath,
			`module.exports = { id: 'test-config', workspaces: [] };`,
		);

		const result = await loadEpicenterConfig(testDir);
		expect(result.config.id).toBe('test-config');
		expect(Array.isArray(result.config.workspaces)).toBe(true);
		expect(result.configPath).toBe(configPath);
	});

	test('loads config with ES module syntax', async () => {
		const configPath = path.join(testDir, 'epicenter.config.mjs');
		await writeFile(
			configPath,
			`export default { id: 'test-esm-config', workspaces: [] };`,
		);

		const result = await loadEpicenterConfig(testDir);
		expect(result.config.id).toBe('test-esm-config');
	});

	test('prefers .ts over other extensions when multiple exist', async () => {
		await writeFile(
			path.join(testDir, 'epicenter.config.ts'),
			`module.exports = { id: 'typescript-config', workspaces: [] };`,
		);
		await writeFile(
			path.join(testDir, 'epicenter.config.js'),
			`module.exports = { id: 'javascript-config', workspaces: [] };`,
		);

		const result = await loadEpicenterConfig(testDir);
		expect(result.config.id).toBe('typescript-config');
	});
});
