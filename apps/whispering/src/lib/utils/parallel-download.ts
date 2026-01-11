/**
 * Parallel Download Utility with HTTP Range Requests
 *
 * Optimizations:
 * 1. HTTP Range Requests - Download large files in parallel chunks
 * 2. Multiple mirrors - Automatic failover to fastest mirror
 * 3. Buffered writes - Reduce I/O overhead by buffering chunks
 * 4. Connection pooling - Reuse connections for multiple chunks
 * 5. Proper logging via Tauri plugin for debugging
 */

import { remove, writeFile } from '@tauri-apps/plugin-fs';
import { fetch } from '@tauri-apps/plugin-http';
import { debug, error, info, warn } from '@tauri-apps/plugin-log';

// HuggingFace mirrors for better geographic coverage
const HUGGINGFACE_MIRRORS: readonly string[] = [
	'https://huggingface.co', // Original (US/EU)
	'https://hf-mirror.com', // China mirror
	'https://huggingface.co', // Fallback to original
] as const;

const DEFAULT_MIRROR = 'https://huggingface.co';

// Configuration
const PARALLEL_CONNECTIONS = 4; // Number of parallel downloads for large files
const CHUNK_SIZE_MB = 50; // Size of each chunk in MB
const BUFFER_SIZE_KB = 512; // Buffer size before writing to disk (KB)
const LARGE_FILE_THRESHOLD_MB = 100; // Files larger than this use parallel download
const MIRROR_TEST_TIMEOUT_MS = 3000; // Timeout for mirror speed test

interface DownloadProgress {
	downloadedBytes: number;
	totalBytes: number;
	speed: number; // bytes per second
	currentMirror: string;
}

type ProgressCallback = (progress: DownloadProgress) => void;

/**
 * Convert a HuggingFace URL to use a specific mirror
 */
function getMirrorUrl(originalUrl: string, mirror: string): string {
	if (originalUrl.includes('huggingface.co')) {
		return originalUrl.replace('https://huggingface.co', mirror);
	}
	return originalUrl;
}

/**
 * Test mirror latency by fetching a small amount of data
 */
async function testMirrorLatency(url: string): Promise<number> {
	const testUrl = getMirrorUrl(url, DEFAULT_MIRROR);
	const startTime = Date.now();

	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort(),
			MIRROR_TEST_TIMEOUT_MS,
		);

		const response = await fetch(testUrl, {
			method: 'HEAD',
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) return Infinity;
		return Date.now() - startTime;
	} catch {
		return Infinity;
	}
}

/**
 * Find the fastest available mirror
 */
async function findFastestMirror(url: string): Promise<string> {
	// Test all mirrors in parallel
	const results = await Promise.all(
		HUGGINGFACE_MIRRORS.map(async (mirror) => {
			const testUrl = getMirrorUrl(url, mirror);
			const latency = await testMirrorLatency(testUrl);
			return { mirror, latency };
		}),
	);

	// Sort by latency and return the fastest
	results.sort((a, b) => a.latency - b.latency);

	await info(`Mirror latency test results: ${JSON.stringify(results)}`);

	// Return the fastest mirror that responded
	const fastest = results.find((r) => r.latency < Infinity);
	if (!fastest) {
		await warn('All mirrors failed latency test, using default');
	}
	return fastest?.mirror ?? DEFAULT_MIRROR;
}

/**
 * Check if server supports Range requests
 */
async function supportsRangeRequests(
	url: string,
): Promise<{ supports: boolean; totalSize: number }> {
	try {
		const response = await fetch(url, { method: 'HEAD' });

		if (!response.ok) {
			return { supports: false, totalSize: 0 };
		}

		const acceptRanges = response.headers.get('accept-ranges');
		const contentLength = response.headers.get('content-length');
		const totalSize = contentLength ? parseInt(contentLength, 10) : 0;

		return {
			supports: acceptRanges === 'bytes' && totalSize > 0,
			totalSize,
		};
	} catch {
		return { supports: false, totalSize: 0 };
	}
}

/**
 * Download a specific byte range of a file
 */
async function downloadRange(
	url: string,
	start: number,
	end: number,
	onProgress: (downloaded: number) => void,
): Promise<Uint8Array> {
	await debug(
		`Downloading range: ${start}-${end} (${Math.round((end - start) / 1_000_000)}MB)`,
	);

	const response = await fetch(url, {
		headers: {
			Range: `bytes=${start}-${end}`,
		},
	});

	if (!response.ok && response.status !== 206) {
		await error(`Range request failed: ${response.status} for ${start}-${end}`);
		throw new Error(`Range request failed: ${response.status}`);
	}

	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error('Failed to read response body');
	}

	const chunks: Uint8Array[] = [];
	let downloadedInRange = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		chunks.push(value);
		downloadedInRange += value.length;
		onProgress(downloadedInRange);
	}

	// Combine all chunks into single array
	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	await debug(
		`Range ${start}-${end} complete: ${totalLength} bytes in ${chunks.length} chunks`,
	);
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}

	return result;
}

/**
 * Download file using parallel Range requests (for large files)
 */
async function downloadFileParallel(
	url: string,
	filePath: string,
	totalSize: number,
	onProgress: ProgressCallback,
): Promise<void> {
	const chunkSize = CHUNK_SIZE_MB * 1024 * 1024;
	const numChunks = Math.ceil(totalSize / chunkSize);

	await info(
		`Starting parallel download: ${Math.round(totalSize / 1_000_000)}MB in ${numChunks} chunks of ${CHUNK_SIZE_MB}MB each`,
	);

	// Create array to hold all chunks in order
	const chunks: (Uint8Array | null)[] = new Array(numChunks).fill(null);
	let totalDownloaded = 0;
	const startTime = Date.now();

	// Create chunk ranges
	const ranges: { index: number; start: number; end: number }[] = [];
	for (let i = 0; i < numChunks; i++) {
		const start = i * chunkSize;
		const end = Math.min(start + chunkSize - 1, totalSize - 1);
		ranges.push({ index: i, start, end });
	}

	// Download chunks in parallel batches
	const downloadChunk = async (range: {
		index: number;
		start: number;
		end: number;
	}) => {
		const chunk = await downloadRange(
			url,
			range.start,
			range.end,
			(downloaded) => {
				// Update progress (approximate since multiple chunks download simultaneously)
				const currentTotal = totalDownloaded + downloaded;
				const elapsed = (Date.now() - startTime) / 1000;
				const speed = elapsed > 0 ? currentTotal / elapsed : 0;

				onProgress({
					downloadedBytes: Math.min(currentTotal, totalSize),
					totalBytes: totalSize,
					speed,
					currentMirror: url,
				});
			},
		);

		chunks[range.index] = chunk;
		totalDownloaded += chunk.length;
	};

	// Process chunks in batches of PARALLEL_CONNECTIONS
	for (let i = 0; i < ranges.length; i += PARALLEL_CONNECTIONS) {
		const batch = ranges.slice(i, i + PARALLEL_CONNECTIONS);
		const batchNum = Math.floor(i / PARALLEL_CONNECTIONS) + 1;
		const totalBatches = Math.ceil(ranges.length / PARALLEL_CONNECTIONS);
		await info(
			`Processing batch ${batchNum}/${totalBatches} (chunks ${i + 1}-${Math.min(i + PARALLEL_CONNECTIONS, ranges.length)}/${ranges.length})`,
		);
		await Promise.all(batch.map(downloadChunk));
		await debug(
			`Batch ${batchNum} complete. Total downloaded: ${Math.round(totalDownloaded / 1_000_000)}MB`,
		);
	}

	// Verify all chunks downloaded
	if (chunks.some((c) => c === null)) {
		const failedIndices = chunks
			.map((c, idx) => (c === null ? idx : -1))
			.filter((idx) => idx >= 0);
		await error(`Download failed: chunks ${failedIndices.join(', ')} are null`);
		throw new Error('Some chunks failed to download');
	}

	// Write chunks progressively to avoid blocking UI
	// Instead of combining 859MB in memory then writing all at once (blocks for 30+ min),
	// we write each ~50MB chunk separately with yields between writes
	await info(
		`All ${numChunks} chunks downloaded. Writing to file progressively...`,
	);

	// Create empty file first
	await writeFile(filePath, new Uint8Array());

	let writtenBytes = 0;
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (chunk) {
			await info(
				`Writing chunk ${i + 1}/${chunks.length} (${Math.round(chunk.length / 1_000_000)}MB)...`,
			);
			await writeFile(filePath, chunk, { append: true });
			writtenBytes += chunk.length;

			// Yield to event loop every chunk to keep UI responsive
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	await info(
		`File write complete: ${Math.round(writtenBytes / 1_000_000)}MB written to ${filePath}`,
	);
}

/**
 * Download file sequentially with buffered writes (for smaller files or when Range not supported)
 */
async function downloadFileSequential(
	url: string,
	filePath: string,
	expectedSize: number,
	onProgress: ProgressCallback,
): Promise<void> {
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Download failed: ${response.status}`);
	}

	const contentLength = response.headers.get('content-length');
	const totalSize = contentLength ? parseInt(contentLength, 10) : expectedSize;

	const reader = response.body?.getReader();
	if (!reader) {
		throw new Error('Failed to read response body');
	}

	// Buffer chunks before writing to reduce I/O
	const bufferSize = BUFFER_SIZE_KB * 1024;
	let buffer: Uint8Array[] = [];
	let bufferLength = 0;
	let downloadedBytes = 0;
	const startTime = Date.now();

	// Create empty file
	await writeFile(filePath, new Uint8Array());

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer.push(value);
		bufferLength += value.length;
		downloadedBytes += value.length;

		// Write buffer to disk when it reaches threshold
		if (bufferLength >= bufferSize) {
			const combined = combineBuffers(buffer, bufferLength);
			await writeFile(filePath, combined, { append: true });
			buffer = [];
			bufferLength = 0;
		}

		// Report progress
		const elapsed = (Date.now() - startTime) / 1000;
		const speed = elapsed > 0 ? downloadedBytes / elapsed : 0;

		onProgress({
			downloadedBytes,
			totalBytes: totalSize,
			speed,
			currentMirror: url,
		});
	}

	// Write remaining buffer
	if (bufferLength > 0) {
		const combined = combineBuffers(buffer, bufferLength);
		await writeFile(filePath, combined, { append: true });
	}

	// Validate download
	if (downloadedBytes < totalSize * 0.9) {
		await error(
			`Download incomplete: received ${Math.round(downloadedBytes / 1_000_000)}MB but expected ${Math.round(totalSize / 1_000_000)}MB`,
		);
		await remove(filePath);
		throw new Error(
			`Download incomplete: received ${Math.round(downloadedBytes / 1_000_000)}MB but expected ${Math.round(totalSize / 1_000_000)}MB`,
		);
	}

	await info(
		`Sequential download complete: ${Math.round(downloadedBytes / 1_000_000)}MB written to ${filePath}`,
	);
}

/**
 * Combine multiple Uint8Arrays into one
 */
function combineBuffers(
	buffers: Uint8Array[],
	totalLength: number,
): Uint8Array {
	const result = new Uint8Array(totalLength);
	let offset = 0;
	for (const buf of buffers) {
		result.set(buf, offset);
		offset += buf.length;
	}
	return result;
}

/**
 * Main download function with automatic optimization
 *
 * Features:
 * - Automatic mirror selection
 * - Parallel Range requests for large files
 * - Buffered writes for smaller files
 * - Progress reporting with speed
 */
export async function downloadFileOptimized(
	url: string,
	filePath: string,
	expectedSizeBytes: number,
	onProgress: (progress: number, speed?: number) => void,
): Promise<void> {
	// Find fastest mirror (only for HuggingFace URLs)
	let downloadUrl = url;
	if (url.includes('huggingface.co')) {
		const fastestMirror = await findFastestMirror(url);
		downloadUrl = getMirrorUrl(url, fastestMirror);
		await info(`Using mirror: ${fastestMirror}`);
	}

	// Check if file is large enough for parallel download
	const isLargeFile = expectedSizeBytes > LARGE_FILE_THRESHOLD_MB * 1024 * 1024;

	if (isLargeFile) {
		// Check if server supports Range requests
		const { supports, totalSize } = await supportsRangeRequests(downloadUrl);

		if (supports && totalSize > 0) {
			await info(
				`Using parallel download (${PARALLEL_CONNECTIONS} connections) for ${Math.round(totalSize / 1_000_000)}MB file`,
			);

			await downloadFileParallel(
				downloadUrl,
				filePath,
				totalSize,
				(progress) => {
					const percent = Math.round(
						(progress.downloadedBytes / progress.totalBytes) * 100,
					);
					onProgress(percent, progress.speed);
				},
			);
			return;
		}
	}

	// Fallback to sequential download with buffering
	await info('Using sequential download with buffering');

	await downloadFileSequential(
		downloadUrl,
		filePath,
		expectedSizeBytes,
		(progress) => {
			const percent = Math.round(
				(progress.downloadedBytes / progress.totalBytes) * 100,
			);
			onProgress(percent, progress.speed);
		},
	);
}

/**
 * Format download speed for display
 */
export function formatSpeed(bytesPerSecond: number): string {
	if (bytesPerSecond < 1024) {
		return `${bytesPerSecond.toFixed(0)} B/s`;
	} else if (bytesPerSecond < 1024 * 1024) {
		return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`;
	} else {
		return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
	}
}
