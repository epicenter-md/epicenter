/**
 * The Ark publisher kernel: the one owner of how a rendered projection
 * becomes public bytes.
 *
 * This module is trusted, private-side code. It is NOT imported by the public
 * Worker entry (src/index.ts), so the deployed public plane keeps zero write
 * paths; the kernel runs wherever an authenticated caller holds bucket
 * credentials (an operator CLI today, an authenticated endpoint only if one
 * is ever earned). The object store is injected so the whole orchestration is
 * provable in-memory without credentials or production resources.
 *
 * Invariants owned here, and nowhere else:
 * - Reserve-first: a publicly-unroutable `.artifact` marker claims the
 *   `<identity>/<slug>` subtree for one private artifact id before any
 *   public byte lands. The marker is the entire collision registry: a second
 *   artifact publishing to the same slug is refused; the same artifact
 *   re-publishing (crash retry, theme rebuild) converges idempotently.
 * - Route-last: generated media is written before `index.html`, so the page
 *   address only ever answers with its media already in place.
 * - Verification: every written object is read back and byte-compared before
 *   the kernel reports success. Public-URL verification stays with the
 *   caller, which knows the expected URL (the Vault port's contract).
 * - Route agreement: keys are derived through the delivery Worker's own
 *   `resolveProjection`, so the kernel cannot write an object the Worker
 *   would refuse to serve.
 */
import { resolveProjection } from './index';
import {
	type ArkArtifactPage,
	type ArkMediaSet,
	renderArtifactPage,
} from './render';

/**
 * The minimal R2-shaped write contract the kernel needs. An `R2Bucket`
 * satisfies it with a two-line adapter; tests satisfy it with a Map.
 */
export type ArkObjectStore = {
	get(key: string): Promise<Uint8Array | null>;
	put(
		key: string,
		value: Uint8Array,
		options: { contentType: string },
	): Promise<void>;
};

/** Generated media bytes, keyed by the renderer's closed media vocabulary. */
export type ArkMediaFiles = {
	readonly [Name in keyof ArkMediaSet]?: Uint8Array;
};

const MEDIA_OBJECTS = [
	['video', 'video.mp4', 'video/mp4'],
	['narration', 'narration.mp3', 'audio/mpeg'],
	['cover', 'cover.png', 'image/png'],
] as const;

export type ArkPublication = {
	/** Private artifact identity for ownership; never appears in public routes. */
	readonly artifactId: string;
	/** The page input, minus `media`, which is derived from `files` here. */
	readonly page: Omit<ArkArtifactPage, 'media'>;
	readonly files?: ArkMediaFiles;
};

export type PublishedProjection = {
	readonly url: string;
	/** Every object key written, media first, page last. */
	readonly keys: readonly string[];
	/** True when the slug was already reserved by this same artifact. */
	readonly republished: boolean;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	return left.every((byte, index) => byte === right[index]);
}

async function putVerified(
	store: ArkObjectStore,
	key: string,
	value: Uint8Array,
	contentType: string,
): Promise<void> {
	await store.put(key, value, { contentType });
	const readBack = await store.get(key);
	if (!readBack || !bytesEqual(readBack, value)) {
		throw new Error(
			`${key}: read-back after write did not match written bytes`,
		);
	}
}

/**
 * Render and publish one frozen artifact projection. Idempotent for the same
 * artifact id; refuses the slug for any other artifact. Throws on any
 * violated invariant; a throw after the marker is written leaves a reserved,
 * retryable subtree and never a half-activated page over wrong media.
 */
export async function publishProjection(
	store: ArkObjectStore,
	publication: ArkPublication,
): Promise<PublishedProjection> {
	const { artifactId, page, files } = publication;

	// Route agreement: the delivery Worker's resolver is the single truth for
	// which addresses exist. Anything it refuses, the kernel refuses to write.
	const pageAddress = `/${page.identity}/${page.slug}`;
	const resolved = resolveProjection(pageAddress);
	if (!resolved?.isPage) {
		throw new Error(
			`${pageAddress}: not a servable artifact address (lowercase-hyphenated identity and slug required)`,
		);
	}

	// Reserve-first. The dotfile name is publicly unroutable by construction:
	// the Worker's FILE_SEGMENT pattern refuses dotfiles, so the ownership
	// marker can never be fetched through the public plane.
	const markerKey = `${page.identity}/${page.slug}/.artifact`;
	const existingMarker = await store.get(markerKey);
	const owner = existingMarker
		? decoder.decode(existingMarker).trim()
		: undefined;
	if (owner !== undefined && owner !== artifactId) {
		throw new Error(
			`${pageAddress}: already published by another artifact (${owner}); a frozen permalink is never reassigned`,
		);
	}
	if (owner === undefined) {
		await putVerified(
			store,
			markerKey,
			encoder.encode(artifactId),
			'text/plain',
		);
	}

	// Media before the page, so activation is route-last.
	const keys: string[] = [];
	const media: { video?: boolean; narration?: boolean; cover?: boolean } = {};
	for (const [name, fileName, contentType] of MEDIA_OBJECTS) {
		const bytes = files?.[name];
		if (!bytes) continue;
		const fileAddress = `${pageAddress}/${fileName}`;
		const resolvedFile = resolveProjection(fileAddress);
		if (!resolvedFile) {
			throw new Error(`${fileAddress}: not a servable media address`);
		}
		await putVerified(store, resolvedFile.key, bytes, contentType);
		keys.push(resolvedFile.key);
		media[name] = true;
	}

	const html = renderArtifactPage({ ...page, media });
	await putVerified(
		store,
		resolved.key,
		encoder.encode(html),
		'text/html; charset=utf-8',
	);
	keys.push(resolved.key);

	return {
		url: `https://theark.so${pageAddress}`,
		keys,
		republished: owner !== undefined,
	};
}
