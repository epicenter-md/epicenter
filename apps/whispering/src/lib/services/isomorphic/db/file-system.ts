import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import {
	exists,
	mkdir,
	readDir,
	readTextFile,
	remove,
	rename,
	writeFile,
	writeTextFile,
} from '@tauri-apps/plugin-fs';
import { type } from 'arktype';
import matter from 'gray-matter';
import mime from 'mime';
import { nanoid } from 'nanoid/non-secure';
import { extractErrorMessage } from 'wellcrafted/error';
import { Ok, tryAsync } from 'wellcrafted/result';
import { PATHS } from '$lib/constants/paths';
import { FsServiceLive } from '$lib/services/desktop/fs';
import type { Recording } from './models';
import { Transformation, TransformationRun } from './models';
import type { DbService } from './types';
import { DbServiceErr } from './types';

/**
 * Schema validator for Recording front matter (everything except transcribedText)
 */
const RecordingFrontMatter = type({
	id: 'string',
	title: 'string',
	subtitle: 'string',
	timestamp: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	transcriptionStatus: '"UNPROCESSED" | "TRANSCRIBING" | "DONE" | "FAILED"',
});

type RecordingFrontMatter = typeof RecordingFrontMatter.infer;

/**
 * Convert Recording to markdown format (frontmatter + body)
 */
function recordingToMarkdown(recording: Recording): string {
	const { transcribedText, ...frontMatter } = recording;
	return matter.stringify(transcribedText ?? '', frontMatter);
}

/**
 * Convert markdown file (YAML frontmatter + body) to Recording
 */
function markdownToRecording({
	frontMatter,
	body,
}: {
	frontMatter: RecordingFrontMatter;
	body: string;
}): Recording {
	return {
		...frontMatter,
		transcribedText: body,
	};
}

/**
 * Reads all markdown files from a directory using the Rust command.
 * This is a single FFI call that reads all .md files natively in Rust,
 * avoiding thousands of individual async calls for path joining and file reading.
 *
 * @param directoryPath - Absolute path to the directory containing .md files
 * @returns Array of markdown file contents as strings
 */
async function readMarkdownFiles(directoryPath: string): Promise<string[]> {
	return invoke('read_markdown_files', { directoryPath });
}

/**
 * Deletes multiple files in parallel using the Rust command.
 * This is a single FFI call that handles bulk deletion natively in Rust,
 * avoiding thousands of individual async calls for file removal.
 *
 * @param paths - Array of absolute file paths to delete
 * @returns Number of files successfully deleted
 */
async function bulkDeleteFiles(paths: string[]): Promise<number> {
	return invoke('bulk_delete_files', { paths });
}

/**
 * File system-based database implementation for desktop.
 * Stores data as markdown files with YAML front matter.
 *
 * Directory structure:
 * - recordings/
 *   - {id}.md (metadata with YAML front matter + transcribed text)
 *   - {id}.{ext} (audio file: .wav, .opus, .mp3, etc.)
 * - transformations/
 *   - {id}.md (transformation configuration)
 * - transformation-runs/
 *   - {id}.md (execution history)
 */
export function createFileSystemDb(): DbService {
	return {
		recordings: {
			async getAll() {
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();

						// Ensure directory exists
						const dirExists = await exists(recordingsPath);
						if (!dirExists) {
							await mkdir(recordingsPath, { recursive: true });
							return [];
						}

						// Use Rust command to read all markdown files at once
						const contents = await readMarkdownFiles(recordingsPath);

						// Parse all files
						const recordings = contents.map((content) => {
							const { data, content: body } = matter(content);

							// Validate the front matter schema
							const frontMatter = RecordingFrontMatter(data);
							if (frontMatter instanceof type.errors) {
								return null; // Skip invalid recording, don't crash the app
							}

							return markdownToRecording({ frontMatter, body });
						});

						// Filter out any null entries and sort by timestamp (newest first)
						const validRecordings = recordings.filter(
							(r): r is Recording => r !== null,
						);
						validRecordings.sort(
							(a, b) =>
								new Date(b.timestamp).getTime() -
								new Date(a.timestamp).getTime(),
						);

						return validRecordings;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting all recordings from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async getLatest() {
				return tryAsync({
					try: async () => {
						const { data: recordings, error } = await this.getAll();
						if (error) throw error;

						if (recordings.length === 0) return null;
						// biome-ignore lint/style/noNonNullAssertion: length check above guarantees at least one element
						return recordings.at(0)!;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting latest recording from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async getTranscribingIds() {
				return tryAsync({
					try: async () => {
						const { data: recordings, error } = await this.getAll();
						if (error) throw error;

						return recordings
							.filter((r) => r.transcriptionStatus === 'TRANSCRIBING')
							.map((r) => r.id);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transcribing recording ids from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async getById(id: string) {
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();
						const mdPath = await join(recordingsPath, `${id}.md`);

						const fileExists = await exists(mdPath);
						if (!fileExists) return null;

						const content = await readTextFile(mdPath);
						const { data, content: body } = matter(content);

						// Validate the front matter schema
						const frontMatter = RecordingFrontMatter(data);
						if (frontMatter instanceof type.errors) {
							throw new Error(
								`Invalid recording front matter: ${frontMatter.summary}`,
							);
						}

						return markdownToRecording({ frontMatter, body });
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting recording by id from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async create(paramsOrParamsArray) {
				const paramsArray = Array.isArray(paramsOrParamsArray)
					? paramsOrParamsArray
					: [paramsOrParamsArray];
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();

						// Ensure directory exists
						await mkdir(recordingsPath, { recursive: true });

						await Promise.all(
							paramsArray.map(async ({ recording, audio }) => {
								// 1. Write audio file
								// Fallback to 'bin' for unknown MIME types - we're just saving raw bytes to disk,
								// the actual format doesn't matter for storage purposes
								const extension = mime.getExtension(audio.type) ?? 'bin';
								const audioPath = await join(
									recordingsPath,
									`${recording.id}.${extension}`,
								);
								const arrayBuffer = await audio.arrayBuffer();
								await writeFile(audioPath, new Uint8Array(arrayBuffer));

								// 2. Create .md file with front matter
								const mdContent = recordingToMarkdown(recording);
								const mdPath = await join(recordingsPath, `${recording.id}.md`);

								// Write to temp file first, then rename (atomic operation)
								const tmpPath = `${mdPath}.tmp`;
								await writeTextFile(tmpPath, mdContent);
								await rename(tmpPath, mdPath);
							}),
						);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error creating recording(s) in file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async update(recording) {
				const now = new Date().toISOString();
				const recordingWithTimestamp = {
					...recording,
					updatedAt: now,
				} satisfies Recording;

				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();
						const mdPath = await join(recordingsPath, `${recording.id}.md`);

						// Check if file exists
						const fileExists = await exists(mdPath);
						if (!fileExists) {
							throw new Error(
								`Cannot update recording ${recording.id}: file does not exist. Use create() to create new recordings.`,
							);
						}

						// Update .md file
						const mdContent = recordingToMarkdown(recordingWithTimestamp);

						// Atomic write
						const tmpPath = `${mdPath}.tmp`;
						await writeTextFile(tmpPath, mdContent);
						await rename(tmpPath, mdPath);

						// Note: We don't update audio files on update
						// Audio files are immutable once created

						return recordingWithTimestamp;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error updating recording in file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async delete(recordingOrRecordings) {
				const recordings = Array.isArray(recordingOrRecordings)
					? recordingOrRecordings
					: [recordingOrRecordings];
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();

						// Build a set of IDs to delete for fast lookup
						const idsToDelete = new Set(recordings.map((r) => r.id));

						// Read directory once and find all matching files
						const allFiles = await readDir(recordingsPath);
						const pathsToDelete = await Promise.all(
							allFiles
								.filter((file) => {
									// Extract ID from filename (everything before the first dot)
									const id = file.name.split('.')[0] ?? '';
									return idsToDelete.has(id);
								})
								.map((file) => join(recordingsPath, file.name)),
						);

						// Single FFI call to delete all files in parallel
						await bulkDeleteFiles(pathsToDelete);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error deleting recording(s) from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async cleanupExpired({ recordingRetentionStrategy, maxRecordingCount }) {
				switch (recordingRetentionStrategy) {
					case 'keep-forever': {
						return Ok(undefined);
					}
					case 'limit-count': {
						return tryAsync({
							try: async () => {
								const { data: recordings, error } = await this.getAll();
								if (error) throw error;

								const maxCount = Number.parseInt(maxRecordingCount, 10);
								if (recordings.length <= maxCount) return;

								// Delete oldest recordings (already sorted newest first)
								const toDelete = recordings.slice(maxCount);
								await this.delete(toDelete);
							},
							catch: (error) =>
								DbServiceErr({
									message: `Error cleaning up expired recordings: ${extractErrorMessage(error)}`,
								}),
						});
					}
				}
			},

			async getAudioBlob(recordingId: string) {
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();
						const audioPath = await findAudioFile(recordingsPath, recordingId);

						if (!audioPath) {
							throw new Error(
								`Audio file not found for recording ${recordingId}`,
							);
						}

						const { data: blob, error } =
							await FsServiceLive.pathToBlob(audioPath);
						if (error) throw error;

						return blob;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting audio blob from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async ensureAudioPlaybackUrl(recordingId: string) {
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();
						const audioPath = await findAudioFile(recordingsPath, recordingId);

						if (!audioPath) {
							throw new Error(
								`Audio file not found for recording ${recordingId}`,
							);
						}

						const assetUrl = convertFileSrc(audioPath);

						// Return the URL as-is from convertFileSrc()
						// The Tauri backend handles URL decoding automatically
						return assetUrl;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting audio playback URL from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			revokeAudioUrl(_recordingId: string) {
				// No-op on desktop, URLs are asset:// protocol managed by Tauri
			},

			async clear() {
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();
						const dirExists = await exists(recordingsPath);
						if (!dirExists) return undefined;

						// Get all files and build paths
						const files = await readDir(recordingsPath);
						const pathsToDelete = await Promise.all(
							files.map((file) => join(recordingsPath, file.name)),
						);

						// Single FFI call to delete all files in parallel
						await bulkDeleteFiles(pathsToDelete);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error clearing recordings from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async getCount() {
				return tryAsync({
					try: async () => {
						const recordingsPath = await PATHS.DB.RECORDINGS();
						const count = await invoke<number>('count_markdown_files', {
							directoryPath: recordingsPath,
						});
						return count;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting recordings count from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},
		},

		transformations: {
			async getAll() {
				return tryAsync({
					try: async () => {
						const transformationsPath = await PATHS.DB.TRANSFORMATIONS();

						// Ensure directory exists
						const dirExists = await exists(transformationsPath);
						if (!dirExists) {
							await mkdir(transformationsPath, { recursive: true });
							return [];
						}

						// Use Rust command to read all markdown files at once
						const contents = await readMarkdownFiles(transformationsPath);

						// Parse all files
						const transformations = contents.map((content) => {
							const { data } = matter(content);

							// Validate with migrating schema (accepts V1 or V2, outputs V2)
							const validated = Transformation(data);
							if (validated instanceof type.errors) {
								console.error(`Invalid transformation:`, validated.summary);
								return null; // Skip invalid transformation
							}

							return validated;
						});

						return transformations.filter(
							(t): t is Transformation => t !== null,
						);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting all transformations from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async getById(id: string) {
				return tryAsync({
					try: async () => {
						const transformationsPath = await PATHS.DB.TRANSFORMATIONS();
						const mdPath = await join(transformationsPath, `${id}.md`);

						const fileExists = await exists(mdPath);
						if (!fileExists) return null;

						const content = await readTextFile(mdPath);
						const { data } = matter(content);

						// Validate with migrating schema (accepts V1 or V2, outputs V2)
						const validated = Transformation(data);
						if (validated instanceof type.errors) {
							throw new Error(`Invalid transformation: ${validated.summary}`);
						}

						return validated;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transformation by id from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async create(transformationOrTransformations) {
				const transformations = Array.isArray(transformationOrTransformations)
					? transformationOrTransformations
					: [transformationOrTransformations];
				return tryAsync({
					try: async () => {
						const transformationsPath = await PATHS.DB.TRANSFORMATIONS();
						await mkdir(transformationsPath, { recursive: true });
						await Promise.all(
							transformations.map(async (transformation) => {
								const mdContent = matter.stringify('', transformation);
								const mdPath = await join(
									transformationsPath,
									`${transformation.id}.md`,
								);
								const tmpPath = `${mdPath}.tmp`;
								await writeTextFile(tmpPath, mdContent);
								await rename(tmpPath, mdPath);
							}),
						);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error creating transformation(s) in file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async update(transformation: Transformation) {
				const now = new Date().toISOString();
				const transformationWithTimestamp = {
					...transformation,
					updatedAt: now,
				} satisfies Transformation;

				return tryAsync({
					try: async () => {
						const transformationsPath = await PATHS.DB.TRANSFORMATIONS();
						const mdPath = await join(
							transformationsPath,
							`${transformation.id}.md`,
						);

						// Create .md file with front matter
						const mdContent = matter.stringify('', transformationWithTimestamp);

						// Atomic write
						const tmpPath = `${mdPath}.tmp`;
						await writeTextFile(tmpPath, mdContent);
						await rename(tmpPath, mdPath);

						return transformationWithTimestamp;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error updating transformation in file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async delete(transformationOrTransformations) {
				const transformations = Array.isArray(transformationOrTransformations)
					? transformationOrTransformations
					: [transformationOrTransformations];
				return tryAsync({
					try: async () => {
						const transformationsPath = await PATHS.DB.TRANSFORMATIONS();
						const pathsToDelete = await Promise.all(
							transformations.map((t) =>
								join(transformationsPath, `${t.id}.md`),
							),
						);
						await bulkDeleteFiles(pathsToDelete);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error deleting transformation(s) from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async clear() {
				return tryAsync({
					try: async () => {
						const transformationsPath = await PATHS.DB.TRANSFORMATIONS();
						const dirExists = await exists(transformationsPath);
						if (dirExists) {
							await remove(transformationsPath, { recursive: true });
							await mkdir(transformationsPath, { recursive: true });
						}
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error clearing transformations from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async getCount() {
				return tryAsync({
					try: async () => {
						const { data: transformations, error } = await this.getAll();
						if (error) throw error;
						return transformations.length;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transformations count from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},
		},

		runs: {
			async getAll() {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();

						// Ensure directory exists
						const dirExists = await exists(runsPath);
						if (!dirExists) {
							await mkdir(runsPath, { recursive: true });
							return [];
						}

						// Use Rust command to read all markdown files at once
						const contents = await readMarkdownFiles(runsPath);

						// Parse all files
						const runs = contents.map((content) => {
							const { data } = matter(content);

							// Validate with arktype schema
							const validated = TransformationRun(data);
							if (validated instanceof type.errors) {
								console.error(`Invalid transformation run:`, validated.summary);
								return null; // Skip invalid run
							}

							return validated;
						});

						// Filter out any invalid entries
						return runs.filter((run) => run !== null);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting all transformation runs from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async getById(id: string) {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();
						const mdPath = await join(runsPath, `${id}.md`);

						const fileExists = await exists(mdPath);
						if (!fileExists) return null;

						const content = await readTextFile(mdPath);
						const { data } = matter(content);

						// Validate with arktype schema
						const validated = TransformationRun(data);
						if (validated instanceof type.errors) {
							throw new Error(
								`Invalid transformation run: ${validated.summary}`,
							);
						}

						return validated;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transformation run by id from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async getByTransformationId(transformationId: string) {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();

						// Ensure directory exists
						const dirExists = await exists(runsPath);
						if (!dirExists) {
							await mkdir(runsPath, { recursive: true });
							return [];
						}

						// Use Rust command to read all markdown files at once
						const contents = await readMarkdownFiles(runsPath);

						// Parse and filter
						const runs = contents
							.map((content) => {
								const { data } = matter(content);

								// Validate with arktype schema
								const validated = TransformationRun(data);
								if (validated instanceof type.errors) {
									console.error(
										`Invalid transformation run:`,
										validated.summary,
									);
									return null; // Skip invalid run
								}

								return validated;
							})
							.filter((run) => run !== null)
							.filter((run) => run.transformationId === transformationId)
							.sort(
								(a, b) =>
									new Date(b.startedAt).getTime() -
									new Date(a.startedAt).getTime(),
							);

						return runs;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transformation runs by transformation id from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async getByRecordingId(recordingId: string) {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();

						// Ensure directory exists
						const dirExists = await exists(runsPath);
						if (!dirExists) {
							await mkdir(runsPath, { recursive: true });
							return [];
						}

						// Use Rust command to read all markdown files at once
						const contents = await readMarkdownFiles(runsPath);

						// Parse and filter
						const runs = contents
							.map((content) => {
								const { data } = matter(content);

								// Validate with arktype schema
								const validated = TransformationRun(data);
								if (validated instanceof type.errors) {
									console.error(
										`Invalid transformation run:`,
										validated.summary,
									);
									return null; // Skip invalid run
								}

								return validated;
							})
							.filter((run) => run !== null)
							.filter((run) => run.recordingId === recordingId)
							.sort(
								(a, b) =>
									new Date(b.startedAt).getTime() -
									new Date(a.startedAt).getTime(),
							);

						return runs;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transformation runs by recording id from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async create(runOrRuns) {
				const runs = Array.isArray(runOrRuns) ? runOrRuns : [runOrRuns];
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();
						await mkdir(runsPath, { recursive: true });

						await Promise.all(
							runs.map(async (run) => {
								const mdContent = matter.stringify('', run);
								const mdPath = await join(runsPath, `${run.id}.md`);
								const tmpPath = `${mdPath}.tmp`;
								await writeTextFile(tmpPath, mdContent);
								await rename(tmpPath, mdPath);
							}),
						);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error creating transformation run(s) in file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async addStep(run, step) {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();

						const now = new Date().toISOString();
						const newTransformationStepRun = {
							id: nanoid(),
							stepId: step.id,
							input: step.input,
							startedAt: now,
							completedAt: null,
							status: 'running',
						} as const;

						const updatedRun = {
							...run,
							stepRuns: [...run.stepRuns, newTransformationStepRun],
						} satisfies TransformationRun;

						// Update .md file
						const mdContent = matter.stringify('', updatedRun);
						const mdPath = await join(runsPath, `${run.id}.md`);

						// Atomic write
						const tmpPath = `${mdPath}.tmp`;
						await writeTextFile(tmpPath, mdContent);
						await rename(tmpPath, mdPath);

						return newTransformationStepRun;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error adding step to transformation run in file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async failStep(run, stepRunId, error) {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();

						const now = new Date().toISOString();

						const failedRun = {
							...run,
							status: 'failed' as const,
							completedAt: now,
							error,
							stepRuns: run.stepRuns.map((stepRun) => {
								if (stepRun.id === stepRunId) {
									return {
										...stepRun,
										status: 'failed' as const,
										completedAt: now,
										error,
									};
								}
								return stepRun;
							}),
						};

						// Update .md file
						const mdContent = matter.stringify('', failedRun);
						const mdPath = await join(runsPath, `${run.id}.md`);

						// Atomic write
						const tmpPath = `${mdPath}.tmp`;
						await writeTextFile(tmpPath, mdContent);
						await rename(tmpPath, mdPath);

						return failedRun;
					},
					catch: (e) =>
						DbServiceErr({
							message: `Error failing step in transformation run in file system: ${extractErrorMessage(e)}`,
						}),
				});
			},

			async completeStep(run, stepRunId, output) {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();

						const now = new Date().toISOString();

						const updatedRun = {
							...run,
							stepRuns: run.stepRuns.map((stepRun) => {
								if (stepRun.id === stepRunId) {
									return {
										...stepRun,
										status: 'completed',
										completedAt: now,
										output,
									};
								}
								return stepRun;
							}),
						} satisfies TransformationRun;

						// Update .md file
						const mdContent = matter.stringify('', updatedRun);
						const mdPath = await join(runsPath, `${run.id}.md`);

						// Atomic write
						const tmpPath = `${mdPath}.tmp`;
						await writeTextFile(tmpPath, mdContent);
						await rename(tmpPath, mdPath);

						return updatedRun;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error completing step in transformation run in file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async complete(run, output) {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();

						const now = new Date().toISOString();

						const completedRun = {
							...run,
							status: 'completed' as const,
							completedAt: now,
							output,
						};

						// Update .md file
						const mdContent = matter.stringify('', completedRun);
						const mdPath = await join(runsPath, `${run.id}.md`);

						// Atomic write
						const tmpPath = `${mdPath}.tmp`;
						await writeTextFile(tmpPath, mdContent);
						await rename(tmpPath, mdPath);

						return completedRun;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error completing transformation run in file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async delete(runOrRuns) {
				const runs = Array.isArray(runOrRuns) ? runOrRuns : [runOrRuns];
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();
						const pathsToDelete = await Promise.all(
							runs.map((run) => join(runsPath, `${run.id}.md`)),
						);
						await bulkDeleteFiles(pathsToDelete);
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error deleting transformation run(s) from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async clear() {
				return tryAsync({
					try: async () => {
						const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();
						const dirExists = await exists(runsPath);
						if (dirExists) {
							await remove(runsPath, { recursive: true });
							await mkdir(runsPath, { recursive: true });
						}
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error clearing transformation runs from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},

			async getCount() {
				return tryAsync({
					try: async () => {
						const { data: runs, error } = await this.getAll();
						if (error) throw error;
						return runs.length;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting transformation runs count from file system: ${extractErrorMessage(error)}`,
						}),
				});
			},
		},

		sounds: {
			async get(soundId) {
				return tryAsync({
					try: async () => {
						const soundsPath = await PATHS.DB.CUSTOM_SOUNDS();

						const dirExists = await exists(soundsPath);
						if (!dirExists) return null;

						const audioPath = await findAudioFile(soundsPath, soundId);
						if (!audioPath) return null;

						const { data: blob, error } =
							await FsServiceLive.pathToBlob(audioPath);
						if (error) throw error;

						return blob;
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error getting custom sound from file system (soundId: ${soundId}): ${extractErrorMessage(error)}`,
						}),
				});
			},

			async save(soundId, file) {
				return tryAsync({
					try: async () => {
						const soundsPath = await PATHS.DB.CUSTOM_SOUNDS();
						await mkdir(soundsPath, { recursive: true });

						// Delete any existing audio file for this soundId
						const existingAudioPath = await findAudioFile(soundsPath, soundId);
						if (existingAudioPath) {
							await remove(existingAudioPath);
						}

						// Write audio file
						const extension = mime.getExtension(file.type) ?? 'bin';
						const audioPath = await join(
							soundsPath,
							`${soundId}.${extension}`,
						);
						const arrayBuffer = await file.arrayBuffer();
						await writeFile(audioPath, new Uint8Array(arrayBuffer));
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error saving custom sound to file system (soundId: ${soundId}): ${extractErrorMessage(error)}`,
						}),
				});
			},

			async delete(soundId) {
				return tryAsync({
					try: async () => {
						const soundsPath = await PATHS.DB.CUSTOM_SOUNDS();
						const audioPath = await findAudioFile(soundsPath, soundId);
						if (audioPath) {
							await remove(audioPath);
						}
					},
					catch: (error) =>
						DbServiceErr({
							message: `Error deleting custom sound from file system (soundId: ${soundId}): ${extractErrorMessage(error)}`,
						}),
				});
			},
		},
	};
}

/**
 * Find audio file by ID in a directory.
 * Reads directory once and finds the file matching `{id}.{ext}` where ext is not `.md`.
 * Returns the full path to the audio file, or null if not found.
 */
async function findAudioFile(dir: string, id: string): Promise<string | null> {
	const files = await readDir(dir);
	const audioFile = files.find(
		(f) => f.name.startsWith(`${id}.`) && !f.name.endsWith('.md'),
	);
	if (!audioFile) return null;
	return join(dir, audioFile.name);
}
