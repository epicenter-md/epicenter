import path from 'node:path';
import {
	boolean,
	DateWithTimezone,
	date,
	defineMutation,
	defineQuery,
	defineWorkspace,
	generateId,
	id,
	markdownIndex,
	type SerializedRow,
	sqliteIndex,
	text,
} from '@epicenter/hq';
import { MarkdownIndexErr } from '@epicenter/hq/indexes/markdown';
import { setupPersistence } from '@epicenter/hq/providers';
import { type } from 'arktype';
import { google } from 'googleapis';
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, tryAsync } from 'wellcrafted/result';
import {
	deleteTokens,
	getAuthenticatedClient,
	loadTokens,
	performOAuthLogin,
} from './auth';
import {
	extractPlainText,
	getHeader,
	hasLabel,
	labelsToString,
	parseEmailDate,
} from './parser';

// ─────────────────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────────────────

const { GmailApiErr } = createTaggedError<
	'GmailApiError',
	{ operation: string; details?: string }
>('GmailApiError');

const { EmailNotFoundErr } = createTaggedError<
	'EmailNotFoundError',
	{ emailId: string }
>('EmailNotFoundError');

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────

const EMAILS_SCHEMA = {
	id: id(),
	gmail_id: text(),
	thread_id: text(),
	subject: text(),
	from: text(),
	to: text(),
	snippet: text(),
	body: text(),
	date: date(),
	received_at: date(),
	labels: text({ nullable: true }),
	is_read: boolean({ default: false }),
	is_starred: boolean({ default: false }),
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Workspace Definition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gmail workspace
 *
 * Manages Gmail emails with OAuth2 authentication.
 * Syncs emails from Gmail to local database for querying and archival.
 *
 * ## Setup
 * 1. Create GCP project with Gmail API enabled
 * 2. Create OAuth 2.0 credentials (Desktop App)
 * 3. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET env vars
 * 4. Run `login` action to authenticate
 *
 * ## Usage
 * - `login()` - Authenticate with Gmail
 * - `sync()` - Sync emails to local database
 * - `deleteEmail(id)` - Permanently delete email
 * - `trashEmail(id)` - Move email to trash
 */
export const gmail = defineWorkspace({
	id: 'gmail',

	schema: {
		emails: EMAILS_SCHEMA,
	},

	indexes: {
		sqlite: (c) => sqliteIndex(c),
		markdown: (c) =>
			markdownIndex(c, {
				tableConfigs: {
					emails: {
						serialize: ({ row: { body, id, ...row } }) => {
							// Strip null values for cleaner YAML
							const frontmatter = Object.fromEntries(
								Object.entries(row).filter(([_, value]) => value !== null),
							);
							return {
								frontmatter,
								body,
								filename: `${id}.md`,
							};
						},
						deserialize: ({ frontmatter, body, filename, table }) => {
							const rowId = path.basename(filename, '.md');

							const FrontMatter = table.validators
								.toArktype()
								.omit('id', 'body');
							const parsed = FrontMatter(frontmatter);

							if (parsed instanceof type.errors) {
								return MarkdownIndexErr({
									message: `Invalid frontmatter for row ${rowId}`,
									context: {
										fileName: filename,
										id: rowId,
										reason: parsed.summary,
									},
								});
							}

							const row = {
								id: rowId,
								body,
								...parsed,
							} satisfies SerializedRow<typeof table.schema>;

							return Ok(row);
						},
					},
				},
			}),
	},

	providers: [setupPersistence],

	exports: ({ db, indexes, epicenterDir }) => ({
		...db,
		pullToMarkdown: indexes.markdown.pullToMarkdown,
		pushFromMarkdown: indexes.markdown.pushFromMarkdown,
		pullToSqlite: indexes.sqlite.pullToSqlite,
		pushFromSqlite: indexes.sqlite.pushFromSqlite,

		// ─────────────────────────────────────────────────────────────────────────
		// Authentication
		// ─────────────────────────────────────────────────────────────────────────

		/**
		 * Authenticate with Gmail via OAuth2.
		 * Opens browser for Google sign-in, then stores tokens locally.
		 */
		login: defineMutation({
			description: 'Authenticate with Gmail via OAuth2',
			handler: async () => {
				if (!epicenterDir) {
					return GmailApiErr({
						message: 'Requires filesystem access (browser not supported)',
						context: {
							operation: 'login',
							details: 'Gmail workspace requires filesystem access',
						},
					});
				}

				const { error } = await performOAuthLogin(epicenterDir);
				if (error) return Err(error);

				return Ok({ message: 'Successfully authenticated with Gmail' });
			},
		}),

		/**
		 * Remove stored Gmail credentials.
		 */
		logout: defineMutation({
			description: 'Remove stored Gmail credentials',
			handler: async () => {
				if (!epicenterDir) {
					return GmailApiErr({
						message: 'Requires filesystem access (browser not supported)',
						context: { operation: 'logout' },
					});
				}

				const { error } = await deleteTokens(epicenterDir);
				if (error) return Err(error);

				return Ok({ message: 'Successfully logged out of Gmail' });
			},
		}),

		/**
		 * Check if Gmail credentials exist and are valid.
		 */
		isAuthenticated: defineQuery({
			description: 'Check if Gmail credentials exist',
			handler: async () => {
				if (!epicenterDir) return false;

				const { data: tokens, error } = await loadTokens(epicenterDir);
				if (error) return false;

				return tokens !== null && !!tokens.refresh_token;
			},
		}),

		// ─────────────────────────────────────────────────────────────────────────
		// Email Sync
		// ─────────────────────────────────────────────────────────────────────────

		/**
		 * Sync emails from Gmail to local database.
		 */
		sync: defineMutation({
			input: type({
				'query?': 'string',
				'maxResults?': 'number',
			}).describe(
				'Sync emails from Gmail. query: Gmail search syntax (e.g., "from:alice" or "is:unread"). maxResults: max emails to fetch (default 500).',
			),
			description: 'Sync emails from Gmail to local database',
			handler: async ({ query, maxResults = 500 }) => {
				if (!epicenterDir) {
					return GmailApiErr({
						message: 'Requires filesystem access (browser not supported)',
						context: { operation: 'sync' },
					});
				}

				// Get authenticated client
				const clientResult = await getAuthenticatedClient(epicenterDir);
				if (clientResult.error) return Err(clientResult.error);

				const gmailApi = google.gmail({
					version: 'v1',
					auth: clientResult.data,
				});

				// List message IDs with pagination
				const messageIds: string[] = [];
				let pageToken: string | undefined;

				while (messageIds.length < maxResults) {
					const remainingCount = maxResults - messageIds.length;
					const pageSize = Math.min(remainingCount, 100); // Gmail max is 100 per page

					const { data: listResponse, error: listError } = await tryAsync({
						try: () =>
							gmailApi.users.messages.list({
								userId: 'me',
								q: query,
								maxResults: pageSize,
								pageToken,
							}),
						catch: (e) =>
							GmailApiErr({
								message: 'Failed to list messages',
								context: {
									operation: 'sync.list',
									details: extractErrorMessage(e),
								},
							}),
					});

					if (listError) return Err(listError);

					const messages = listResponse.data.messages ?? [];
					for (const msg of messages) {
						if (msg.id && messageIds.length < maxResults) {
							messageIds.push(msg.id);
						}
					}

					pageToken = listResponse.data.nextPageToken ?? undefined;
					if (!pageToken) break;
				}

				// Fetch full message details and insert into database
				let syncedCount = 0;
				const now = DateWithTimezone({
					date: new Date(),
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}).toJSON();

				for (const gmailId of messageIds) {
					// Check if already exists
					const existing = db.emails
						.getAll()
						.find((e) => e.gmail_id === gmailId);
					if (existing) {
						// Skip already synced emails
						continue;
					}

					const { data: messageResponse, error: fetchError } = await tryAsync({
						try: () =>
							gmailApi.users.messages.get({
								userId: 'me',
								id: gmailId,
								format: 'full',
							}),
						catch: (e) =>
							GmailApiErr({
								message: 'Failed to fetch message',
								context: {
									operation: 'sync.get',
									details: extractErrorMessage(e),
								},
							}),
					});

					if (fetchError) {
						console.warn(`Skipping message ${gmailId}: ${fetchError.message}`);
						continue;
					}

					const message = messageResponse.data;
					const headers = message.payload?.headers;
					const labels = message.labelIds;

					const emailDate = parseEmailDate(getHeader(headers, 'Date'));

					db.emails.insert({
						id: generateId(),
						gmail_id: message.id ?? gmailId,
						thread_id: message.threadId ?? '',
						subject: getHeader(headers, 'Subject'),
						from: getHeader(headers, 'From'),
						to: getHeader(headers, 'To'),
						snippet: message.snippet ?? '',
						body: extractPlainText(message.payload),
						date: DateWithTimezone({
							date: emailDate,
							timezone: 'UTC',
						}).toJSON(),
						received_at: now,
						labels: labelsToString(labels),
						is_read: !hasLabel(labels, 'UNREAD'),
						is_starred: hasLabel(labels, 'STARRED'),
					});

					syncedCount++;
				}

				return Ok({
					message: `Synced ${syncedCount} new emails (${messageIds.length} total found)`,
					syncedCount,
					totalFound: messageIds.length,
				});
			},
		}),

		// ─────────────────────────────────────────────────────────────────────────
		// Email Operations
		// ─────────────────────────────────────────────────────────────────────────

		/**
		 * Permanently delete email from Gmail and local database.
		 */
		deleteEmail: defineMutation({
			input: type({ emailId: 'string' }).describe(
				'emailId: The local database ID of the email to delete.',
			),
			description: 'Permanently delete email from Gmail and local database',
			handler: async ({ emailId }) => {
				if (!epicenterDir) {
					return GmailApiErr({
						message: 'Requires filesystem access (browser not supported)',
						context: { operation: 'deleteEmail' },
					});
				}

				// Find email in local database
				const email = db.emails.get(emailId);
				if (!email) {
					return EmailNotFoundErr({
						message: 'Email not found in local database',
						context: { emailId },
					});
				}

				// Get authenticated client
				const clientResult = await getAuthenticatedClient(epicenterDir);
				if (clientResult.error) return Err(clientResult.error);

				const gmailApi = google.gmail({
					version: 'v1',
					auth: clientResult.data,
				});

				// Delete from Gmail
				const { error: deleteError } = await tryAsync({
					try: () =>
						gmailApi.users.messages.delete({
							userId: 'me',
							id: email.gmail_id,
						}),
					catch: (e) =>
						GmailApiErr({
							message: 'Failed to delete message from Gmail',
							context: {
								operation: 'deleteEmail',
								details: extractErrorMessage(e),
							},
						}),
				});

				if (deleteError) return Err(deleteError);

				// Delete from local database
				db.emails.delete({ id: emailId });

				return Ok({ message: 'Email permanently deleted' });
			},
		}),

		/**
		 * Move email to trash in Gmail.
		 */
		trashEmail: defineMutation({
			input: type({ emailId: 'string' }).describe(
				'emailId: The local database ID of the email to trash.',
			),
			description: 'Move email to trash in Gmail',
			handler: async ({ emailId }) => {
				if (!epicenterDir) {
					return GmailApiErr({
						message: 'Requires filesystem access (browser not supported)',
						context: { operation: 'trashEmail' },
					});
				}

				// Find email in local database
				const email = db.emails.get(emailId);
				if (!email) {
					return EmailNotFoundErr({
						message: 'Email not found in local database',
						context: { emailId },
					});
				}

				// Get authenticated client
				const clientResult = await getAuthenticatedClient(epicenterDir);
				if (clientResult.error) return Err(clientResult.error);

				const gmailApi = google.gmail({
					version: 'v1',
					auth: clientResult.data,
				});

				// Trash in Gmail
				const { error: trashError } = await tryAsync({
					try: () =>
						gmailApi.users.messages.trash({
							userId: 'me',
							id: email.gmail_id,
						}),
					catch: (e) =>
						GmailApiErr({
							message: 'Failed to trash message in Gmail',
							context: {
								operation: 'trashEmail',
								details: extractErrorMessage(e),
							},
						}),
				});

				if (trashError) return Err(trashError);

				// Update labels in local database
				const currentLabels = email.labels ?? '';
				const newLabels = currentLabels ? `${currentLabels},TRASH` : 'TRASH';

				db.emails.update({
					id: emailId,
					labels: newLabels,
				});

				return Ok({ message: 'Email moved to trash' });
			},
		}),
	}),
});
