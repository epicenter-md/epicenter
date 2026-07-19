import { defineErrors, type InferErrors } from 'wellcrafted/error';

/**
 * Structured error variants for the `/api/blobs` surface.
 *
 * The blob store uses caller-minted opaque ids: the upload is a presigned PUT
 * straight to R2 (the Worker never sees the bytes), and R2 itself is the index, so
 * there is no database row to conflict on. These variants cover only what the
 * Worker decides at ticket-mint and read time. See
 * ADR-0089 (presigned S3 kernel) as amended by ADR-0148 (opaque BlobId).
 *
 * Owned by the blobs route ({@link blobs.ts}), its only emitter. The serialized
 * envelope is `wellcrafted`'s `{ data: null, error: { name, message, ...fields } }`;
 * each variant bakes in its own HTTP `status`. A blob client branches on
 * `body.error.name` off the wire; it does not import this union (the client
 * SDK carries its own transport-level `ClientError`).
 *
 * @example
 * ```ts
 * import { BlobError } from './blob-errors.js';
 * const err = BlobError.BlobTooLarge({ size: 9e9, maxBytes: 5e9 });
 * return c.json(err, err.error.status); // 413
 * ```
 */
export const BlobError = defineErrors({
	/**
	 * The deployment did not configure the blob store (S3 endpoint or
	 * credentials absent). Mirrors the inference surface's optional-binding
	 * 503: a self-host without object storage simply does not offer blobs.
	 */
	StorageNotConfigured: () => ({
		message: 'Blob storage is not configured for this deployment.',
		status: 503 as const,
	}),
	/** `blobId` was not a canonical opaque BlobId. */
	InvalidBlobId: ({ value }: { value: string }) => ({
		message: `Invalid blobId: '${value}'. Expected blob_ followed by 21 lowercase alphanumeric characters.`,
		status: 400 as const,
		value,
	}),
	/** `sizeBytes` was negative or not an integer. */
	InvalidSize: ({ value }: { value: number }) => ({
		message: `Invalid sizeBytes: ${value}. Expected a non-negative integer.`,
		status: 400 as const,
		value,
	}),
	/** Declared `sizeBytes` exceeds the single-PUT ceiling. Advisory only. */
	BlobTooLarge: ({ size, maxBytes }: { size: number; maxBytes: number }) => ({
		message: `Blob exceeds ${maxBytes} byte limit (got ${size}). Larger objects need multipart or an external location.`,
		status: 413 as const,
		size,
		maxBytes,
	}),
	/** No object exists at `principals/<principalId>/blobs/<blobId>`. */
	NotFound: () => ({
		message: 'Blob not found.',
		status: 404 as const,
	}),
});

/**
 * Discriminated union of all blob error payloads. The `name` field
 * discriminates variants in exhaustive `switch` statements with
 * `default: error satisfies never`.
 */
export type BlobError = InferErrors<typeof BlobError>;
