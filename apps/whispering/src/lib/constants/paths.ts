/**
 * Centralized path constants for the Whispering desktop app.
 *
 * All paths are absolute and resolve relative to the platform-specific app data directory:
 * - macOS: `~/Library/Application Support/com.bradenwong.whispering/`
 * - Windows: `%APPDATA%/com.bradenwong.whispering/`
 * - Linux: `~/.config/com.bradenwong.whispering/`
 *
 * Methods are async because they use Tauri's path APIs which require dynamic imports.
 */
export const PATHS = {
	/**
	 * Paths to local ML model directories.
	 *
	 * Each model type has its own subdirectory under `models/` where downloaded
	 * model files are stored for local transcription.
	 */
	MODELS: {
		/** Directory for Whisper C++ model files (e.g., ggml-base.bin, ggml-large-v3.bin) */
		async WHISPER() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'models', 'whisper');
		},
		/** Directory for Parakeet model files */
		async PARAKEET() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'models', 'parakeet');
		},
		/** Directory for Moonshine model files */
		async MOONSHINE() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'models', 'moonshine');
		},
		/** Directory for Canary model files (supports language selection) */
		async CANARY() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'models', 'canary');
		},
	},

	/**
	 * Paths for the file-system database (desktop only).
	 *
	 * The desktop app stores data as markdown files with YAML frontmatter, organized into
	 * three directories:
	 *
	 * ```
	 * recordings/
	 *   {id}.md      <- metadata + transcribed text
	 *   {id}.webm    <- audio file (extension varies: .webm, .mp3, .wav, etc.)
	 * transformations/
	 *   {id}.md      <- transformation configuration
	 * transformation-runs/
	 *   {id}.md      <- execution history for a transformation
	 * ```
	 *
	 * ## Helper Types
	 *
	 * **Directory helpers** (`RECORDINGS`, `TRANSFORMATIONS`, `TRANSFORMATION_RUNS`):
	 * Return the base directory path. Use these when you need to list files, check if
	 * the directory exists, or pass to Rust commands that operate on directories.
	 *
	 * **Typed file helpers** (`RECORDING_MD`, `RECORDING_AUDIO`, `TRANSFORMATION_MD`, `TRANSFORMATION_RUN_MD`):
	 * Return the absolute path to a specific file type given an ID. Use these when you
	 * know exactly what file you're targeting (reading, writing, or deleting a specific record).
	 *
	 * **Generic file helper** (`RECORDING_FILE`):
	 * Returns the absolute path given any filename. Use this when iterating over directory
	 * contents where you have the full filename but not the parsed ID/extension.
	 */
	DB: {
		/*
		 * ============================================================================
		 * RECORDINGS
		 * ============================================================================
		 * Each recording consists of two files sharing the same ID:
		 * - {id}.md: Markdown file with YAML frontmatter (metadata) and body (transcribed text)
		 * - {id}.{ext}: Audio file (extension depends on recording format: webm, mp3, wav, etc.)
		 */

		/**
		 * Base directory containing all recording files.
		 *
		 * Use this when you need to:
		 * - List all files in the recordings directory
		 * - Check if the recordings directory exists
		 * - Pass to Rust commands like `read_markdown_files` or `count_markdown_files`
		 *
		 * @returns Absolute path to the recordings directory
		 *
		 * @example
		 * ```typescript
		 * const recordingsPath = await PATHS.DB.RECORDINGS();
		 * const files = await readDir(recordingsPath);
		 * const contents = await readMarkdownFiles(recordingsPath);
		 * ```
		 */
		async RECORDINGS() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'recordings');
		},

		/**
		 * Path to a recording's markdown metadata file.
		 *
		 * The markdown file contains:
		 * - YAML frontmatter: id, title, subtitle, timestamp, transcriptionStatus, etc.
		 * - Body: the transcribed text content
		 *
		 * Use this when you need to read, write, or delete a specific recording's metadata.
		 *
		 * @param id - The recording's unique identifier
		 * @returns Absolute path to `recordings/{id}.md`
		 *
		 * @example
		 * ```typescript
		 * const mdPath = await PATHS.DB.RECORDING_MD('abc123');
		 * const content = await readTextFile(mdPath);
		 * const { data: frontmatter, content: transcribedText } = matter(content);
		 * ```
		 */
		async RECORDING_MD(id: string) {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'recordings', `${id}.md`);
		},

		/**
		 * Path to a recording's audio file with a specific extension.
		 *
		 * Use this when **creating** a new recording where you know the audio format.
		 * The extension is determined by the MIME type of the recorded audio blob.
		 *
		 * @param id - The recording's unique identifier
		 * @param extension - The audio file extension without the dot (e.g., 'webm', 'mp3', 'wav')
		 * @returns Absolute path to `recordings/{id}.{extension}`
		 *
		 * @example
		 * ```typescript
		 * const extension = mime.getExtension(audioBlob.type) ?? 'bin';
		 * const audioPath = await PATHS.DB.RECORDING_AUDIO('abc123', extension);
		 * await writeFile(audioPath, new Uint8Array(await audioBlob.arrayBuffer()));
		 * ```
		 */
		async RECORDING_AUDIO(id: string, extension: string) {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'recordings', `${id}.${extension}`);
		},

		/**
		 * Path to any file in the recordings directory given its full filename.
		 *
		 * Use this when you have the complete filename (e.g., from `readDir`) and need
		 * the absolute path. This is the generic fallback when you don't know whether
		 * you're dealing with a .md file or an audio file.
		 *
		 * Common use cases:
		 * - Iterating over directory contents to build paths for bulk operations
		 * - Looking up audio files where the extension is unknown (scan directory, find match)
		 * - Deleting files when you only have the filename from a directory listing
		 *
		 * @param filename - The complete filename including extension (e.g., 'abc123.md', 'abc123.webm')
		 * @returns Absolute path to `recordings/{filename}`
		 *
		 * @example
		 * ```typescript
		 * // Bulk delete: iterate directory and build absolute paths
		 * const files = await readDir(recordingsPath);
		 * const pathsToDelete = await Promise.all(
		 *   files.filter(f => idsToDelete.has(f.name.split('.')[0]))
		 *        .map(f => PATHS.DB.RECORDING_FILE(f.name))
		 * );
		 * await bulkDeleteFiles(pathsToDelete);
		 *
		 * // Find audio file when extension is unknown
		 * const audioFile = files.find(f => f.name.startsWith(`${id}.`) && !f.name.endsWith('.md'));
		 * const audioPath = await PATHS.DB.RECORDING_FILE(audioFile.name);
		 * ```
		 */
		async RECORDING_FILE(filename: string) {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'recordings', filename);
		},

		/*
		 * ============================================================================
		 * TRANSFORMATIONS
		 * ============================================================================
		 * Each transformation is stored as a single markdown file:
		 * - {id}.md: Markdown file with YAML frontmatter containing the transformation config
		 *
		 * Transformations define reusable text processing pipelines (e.g., "Fix Grammar",
		 * "Translate to Spanish") that can be applied to transcribed text.
		 */

		/**
		 * Base directory containing all transformation configuration files.
		 *
		 * Use this when you need to:
		 * - List all transformation files
		 * - Check if the transformations directory exists
		 * - Pass to Rust commands for bulk operations
		 *
		 * @returns Absolute path to the transformations directory
		 *
		 * @example
		 * ```typescript
		 * const transformationsPath = await PATHS.DB.TRANSFORMATIONS();
		 * await mkdir(transformationsPath, { recursive: true });
		 * const contents = await readMarkdownFiles(transformationsPath);
		 * ```
		 */
		async TRANSFORMATIONS() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'transformations');
		},

		/**
		 * Path to a transformation's configuration file.
		 *
		 * The markdown file contains YAML frontmatter with the transformation definition:
		 * id, title, steps (array of transformation steps), createdAt, updatedAt, etc.
		 *
		 * @param id - The transformation's unique identifier
		 * @returns Absolute path to `transformations/{id}.md`
		 *
		 * @example
		 * ```typescript
		 * const mdPath = await PATHS.DB.TRANSFORMATION_MD('fix-grammar');
		 * const content = await readTextFile(mdPath);
		 * const { data } = matter(content);
		 * const transformation = Transformation(data);
		 * ```
		 */
		async TRANSFORMATION_MD(id: string) {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'transformations', `${id}.md`);
		},

		/*
		 * ============================================================================
		 * TRANSFORMATION RUNS
		 * ============================================================================
		 * Each transformation run is stored as a single markdown file:
		 * - {id}.md: Markdown file with YAML frontmatter containing execution history
		 *
		 * A "run" represents one execution of a transformation on a recording, tracking
		 * the input, output, intermediate steps, timing, and success/failure status.
		 */

		/**
		 * Base directory containing all transformation run history files.
		 *
		 * Use this when you need to:
		 * - List all transformation run files
		 * - Check if the transformation-runs directory exists
		 * - Pass to Rust commands for bulk operations
		 *
		 * @returns Absolute path to the transformation-runs directory
		 *
		 * @example
		 * ```typescript
		 * const runsPath = await PATHS.DB.TRANSFORMATION_RUNS();
		 * await mkdir(runsPath, { recursive: true });
		 * const contents = await readMarkdownFiles(runsPath);
		 * ```
		 */
		async TRANSFORMATION_RUNS() {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'transformation-runs');
		},

		/**
		 * Path to a transformation run's history file.
		 *
		 * The markdown file contains YAML frontmatter with execution details:
		 * id, transformationId, recordingId, status, startedAt, completedAt,
		 * stepRuns (array of step execution records), input, output, error, etc.
		 *
		 * @param id - The transformation run's unique identifier
		 * @returns Absolute path to `transformation-runs/{id}.md`
		 *
		 * @example
		 * ```typescript
		 * const mdPath = await PATHS.DB.TRANSFORMATION_RUN_MD('run-abc123');
		 * const content = await readTextFile(mdPath);
		 * const { data } = matter(content);
		 * const run = TransformationRun(data);
		 * ```
		 */
		async TRANSFORMATION_RUN_MD(id: string) {
			const { appDataDir, join } = await import('@tauri-apps/api/path');
			const dir = await appDataDir();
			return await join(dir, 'transformation-runs', `${id}.md`);
		},
	},
};
