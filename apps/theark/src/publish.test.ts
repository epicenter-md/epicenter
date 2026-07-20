/**
 * Publisher kernel tests.
 *
 * An in-memory store proves the whole authenticated orchestration without
 * credentials or production resources: reserve-first ownership, route-last
 * activation, idempotent retry, collision refusal, and read-back
 * verification. The final tests close the seam end to end: bytes written by
 * the kernel are served back through the delivery Worker's real
 * `handleRequest` over the same store.
 */
import { describe, expect, test } from 'bun:test';

import { handleRequest, resolveProjection } from './index';
import {
	type ArkObjectStore,
	type ArkPublication,
	publishProjection,
} from './publish';

type StoredObject = { value: Uint8Array; contentType: string };

function memoryStore() {
	const objects = new Map<string, StoredObject>();
	const putOrder: string[] = [];
	const store: ArkObjectStore = {
		async get(key) {
			return objects.get(key)?.value ?? null;
		},
		async put(key, value, { contentType }) {
			putOrder.push(key);
			objects.set(key, { value, contentType });
		},
	};
	return { store, objects, putOrder };
}

const bytes = (text: string) => new TextEncoder().encode(text);

const publication = (
	overrides: Partial<ArkPublication> = {},
): ArkPublication => ({
	artifactId: '01880000-0000-7000-8000-000000000001',
	page: {
		identity: 'braden',
		slug: 'first-artifact',
		title: 'First Artifact',
		publishedOn: '2026-07-20',
		body: 'Frozen words.',
	},
	...overrides,
});

// ============================================================================
// Ordering, ownership, and idempotency
// ============================================================================

describe('publishProjection', () => {
	test('reserves first, writes media, activates the page last', async () => {
		const { store, objects, putOrder } = memoryStore();
		const result = await publishProjection(store, {
			...publication(),
			files: { video: bytes('v'), narration: bytes('n'), cover: bytes('c') },
		});

		expect(putOrder).toEqual([
			'braden/first-artifact/.artifact',
			'braden/first-artifact/video.mp4',
			'braden/first-artifact/narration.mp3',
			'braden/first-artifact/cover.png',
			'braden/first-artifact/index.html',
		]);
		expect(result.url).toBe('https://theark.so/braden/first-artifact');
		expect(result.republished).toBe(false);
		expect(result.keys).toEqual(putOrder.slice(1));
		expect(objects.get('braden/first-artifact/video.mp4')?.contentType).toBe(
			'video/mp4',
		);
		expect(
			objects.get('braden/first-artifact/narration.mp3')?.contentType,
		).toBe('audio/mpeg');
		expect(objects.get('braden/first-artifact/cover.png')?.contentType).toBe(
			'image/png',
		);
		expect(objects.get('braden/first-artifact/index.html')?.contentType).toBe(
			'text/html; charset=utf-8',
		);
	});

	test('a text-only publication writes exactly the marker and the page', async () => {
		const { store, putOrder } = memoryStore();
		await publishProjection(store, publication());
		expect(putOrder).toEqual([
			'braden/first-artifact/.artifact',
			'braden/first-artifact/index.html',
		]);
	});

	test('republishing the same artifact converges without re-reserving', async () => {
		const { store, putOrder } = memoryStore();
		await publishProjection(store, publication());
		const retry = await publishProjection(store, publication());
		expect(retry.republished).toBe(true);
		expect(putOrder.filter((key) => key.endsWith('.artifact'))).toHaveLength(1);
	});

	test('a different artifact can never take over a frozen permalink', async () => {
		const { store, putOrder } = memoryStore();
		await publishProjection(store, publication());
		const writesBefore = putOrder.length;
		await expect(
			publishProjection(
				store,
				publication({ artifactId: '01880000-0000-7000-8000-000000000002' }),
			),
		).rejects.toThrow('already published by another artifact');
		expect(putOrder).toHaveLength(writesBefore);
	});

	test('refuses addresses the delivery Worker would refuse to serve', async () => {
		const { store, putOrder } = memoryStore();
		for (const [identity, slug] of [
			['Braden', 'ok'],
			['braden', 'Not_A_Slug'],
			['assets', 'theark'],
		] as const) {
			await expect(
				publishProjection(store, {
					...publication(),
					page: { ...publication().page, identity, slug },
				}),
			).rejects.toThrow('not a servable artifact address');
		}
		expect(putOrder).toEqual([]);
	});

	test('read-back verification catches a store that lies', async () => {
		const { store } = memoryStore();
		const lying: ArkObjectStore = {
			...store,
			async get(key) {
				// Honest about the unclaimed marker, corrupt on every read-back.
				return key.endsWith('.artifact') ? null : bytes('corrupted');
			},
		};
		await expect(publishProjection(lying, publication())).rejects.toThrow(
			'read-back after write did not match',
		);
	});

	test('the ownership marker is publicly unroutable by construction', () => {
		expect(resolveProjection('/braden/first-artifact/.artifact')).toBeNull();
	});
});

// ============================================================================
// End to end: kernel writes, the public Worker serves
// ============================================================================

/** Adapt the in-memory store to the R2 read surface handleRequest uses. */
function workerEnvOver(objects: Map<string, StoredObject>) {
	const meta = (key: string, stored: StoredObject) => ({
		key,
		size: stored.value.length,
		httpEtag: `"etag-${key}"`,
		writeHttpMetadata(headers: Headers) {
			headers.set('content-type', stored.contentType);
		},
	});
	return {
		PROJECTIONS: {
			async head(key: string) {
				const stored = objects.get(key);
				return stored ? meta(key, stored) : null;
			},
			async get(key: string) {
				const stored = objects.get(key);
				return stored
					? { ...meta(key, stored), body: new Response(stored.value).body }
					: null;
			},
		},
		ASSETS: {
			async fetch() {
				return new Response('<not-found shell>', {
					status: 200,
					headers: { 'content-type': 'text/html; charset=utf-8' },
				});
			},
		},
	} as unknown as Env;
}

describe('publish-to-read round trip', () => {
	test('a published artifact serves through the delivery plane under its CSP', async () => {
		const { store, objects } = memoryStore();
		const { url } = await publishProjection(store, {
			...publication({
				page: {
					identity: 'braden',
					slug: 'first-artifact',
					title: 'First Artifact',
					subtitle: 'The words as released',
					publishedOn: '2026-07-20',
					resonant: true,
					body: 'Frozen words with a [link](https://example.com).\n\n> Kept exactly.',
				},
			}),
			files: { video: bytes('vvv'), cover: bytes('ccc') },
		});
		const env = workerEnvOver(objects);

		const pageResponse = await handleRequest(new Request(url), env);
		expect(pageResponse.status).toBe(200);
		expect(pageResponse.headers.get('content-type')).toBe(
			'text/html; charset=utf-8',
		);
		expect(pageResponse.headers.get('content-security-policy')).toContain(
			"default-src 'none'",
		);
		const html = await pageResponse.text();
		expect(html).toContain('<h1>First Artifact</h1>');
		expect(html).toContain('<a href="https://example.com">link</a>');
		expect(html).toContain('poster="/braden/first-artifact/cover.png"');

		const video = await handleRequest(new Request(`${url}/video.mp4`), env);
		expect(video.status).toBe(200);
		expect(video.headers.get('content-type')).toBe('video/mp4');
		expect(await video.text()).toBe('vvv');
	});

	test('the ownership marker never serves publicly even though it exists', async () => {
		const { store, objects } = memoryStore();
		const { url } = await publishProjection(store, publication());
		expect(objects.has('braden/first-artifact/.artifact')).toBe(true);
		const response = await handleRequest(
			new Request(`${url}/.artifact`),
			workerEnvOver(objects),
		);
		expect(response.status).toBe(404);
	});
});
