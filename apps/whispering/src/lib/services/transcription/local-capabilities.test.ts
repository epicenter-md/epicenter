import { describe, expect, it } from 'bun:test';
import type { LocalTranscriptionReadiness } from '$lib/tauri/commands.types';
import { readLocalCapabilities } from './local-capabilities';

/**
 * The failure this file exists to prevent: a host that cannot answer being read
 * as a route that is ready.
 *
 * Readiness is advisory, so it is allowed to be stale. It is not allowed to be
 * optimistic. If a denied or dead host left the answer absent, every downstream
 * reader would see "not blocked" and the user would be told the local route was
 * fine right up to the moment they finished speaking.
 */
describe('reading local transcription capabilities', () => {
	it('turns a host that rejects into a typed unavailable, never ready', async () => {
		const { data, error } = await readLocalCapabilities(() =>
			Promise.reject(new Error('command open_home not allowed')),
		);
		expect(data).toBeNull();
		expect(error?.reason).toBe('host-unavailable');
		expect(error?.message).toContain('not allowed');
	});

	it('turns a host that is not there into the same typed unavailable', async () => {
		// The browser build passes `null` rather than making callers detect the
		// platform (ADR-0181): no host is a reason, not a missing namespace.
		const { data, error } = await readLocalCapabilities(null);
		expect(data).toBeNull();
		expect(error?.reason).toBe('host-unavailable');
	});

	it('passes the host verdict and its sentence through unchanged', async () => {
		const readiness: LocalTranscriptionReadiness = {
			status: 'unavailable',
			reason: 'no-active-model',
			message: 'No local transcription model is active on this device.',
		};
		const { error } = await readLocalCapabilities(() =>
			Promise.resolve(readiness),
		);
		expect(error).toEqual({
			reason: 'no-active-model',
			message: readiness.message,
		});
	});

	it('reports the capabilities of a usable route', async () => {
		const { data, error } = await readLocalCapabilities(() =>
			Promise.resolve({
				status: 'ready',
				supportsPrompt: true,
				supportsLanguage: false,
			} satisfies LocalTranscriptionReadiness),
		);
		expect(error).toBeNull();
		expect(data).toEqual({ supportsPrompt: true, supportsLanguage: false });
	});

	/**
	 * The shared Hugging Face cache changes outside Epicenter, so a `ready`
	 * answer can go stale between the read and the next transcription. That is
	 * tolerated by design: this read is advisory and never gates transcribe,
	 * which resolves the active model itself and fails closed. What must hold is
	 * that a later read reflects the new truth rather than caching the old one.
	 */
	it('reflects a route that became unavailable after a ready answer', async () => {
		const answers: LocalTranscriptionReadiness[] = [
			{ status: 'ready', supportsPrompt: true, supportsLanguage: true },
			{
				status: 'unavailable',
				reason: 'active-model-unavailable',
				message: 'The active local transcription model is not available.',
			},
		];
		const read = () =>
			Promise.resolve(answers.shift() as LocalTranscriptionReadiness);

		expect((await readLocalCapabilities(read)).error).toBeNull();
		expect((await readLocalCapabilities(read)).error?.reason).toBe(
			'active-model-unavailable',
		);
	});
});
