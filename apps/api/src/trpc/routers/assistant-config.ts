import {
	createEncryptionUtils,
	type EncryptedData,
} from '@repo/db/lib/encryption';
import {
	AssistantConfigInsert,
	type AssistantConfigSelect,
	assistantConfig,
	assistantConfigInsertSchema,
	assistantConfigUpdateSchema,
} from '@repo/db/schema';
import { TRPCError } from '@trpc/server';
import { type } from 'arktype';
import { and, desc, eq } from 'drizzle-orm';
import { extractErrorMessage } from 'wellcrafted/error';
import { authedProcedure, router } from '../index';

/**
 * TRPC middleware that adds encryption utilities to the context.
 * This ensures all assistant config procedures have access to consistent
 * encryption/decryption functions that are bound to the current user.
 */
export const assistantConfigProcedure = authedProcedure.use(
	async ({ ctx, next }) => {
		const encryptionUtils = await createEncryptionUtils({
			userId: ctx.user.id,
			env: ctx.env,
			purpose: 'assistant-config' as const,
		});

		/**
		 * Decrypts the password field of an assistant config.
		 * Returns null for password if decryption fails or password is not set.
		 */
		const decryptConfig = async (
			config: AssistantConfigSelect,
		): Promise<
			Omit<AssistantConfigSelect, 'password'> & { password: string | null }
		> => {
			if (!config.password) return { ...config, password: null };
			try {
				const decrypted = await encryptionUtils.decrypt(config.password);
				return { ...config, password: decrypted };
			} catch (error) {
				console.error('Failed to decrypt password:', error);
				return { ...config, password: null };
			}
		};

		/**
		 * Encrypts the password field of a config object if present.
		 * Returns the config with encrypted password or null if no password.
		 */
		const encryptConfig = async <T extends { password?: string | null }>(
			config: T,
		): Promise<Omit<T, 'password'> & { password: EncryptedData | null }> => {
			if (config.password) {
				return {
					...config,
					password: await encryptionUtils.encrypt(config.password),
				};
			}
			return { ...config, password: null };
		};

		return next({
			ctx: { ...ctx, encryptionUtils, decryptConfig, encryptConfig },
		});
	},
);

export const assistantConfigRouter = router({
	// List all assistant configs for user
	list: assistantConfigProcedure.query(async ({ ctx }) => {
		try {
			const configs = await ctx.db.query.assistantConfig.findMany({
				where: eq(assistantConfig.userId, ctx.user.id),
				orderBy: [desc(assistantConfig.lastAccessedAt)],
			});

			const decryptedConfigs = await Promise.all(
				configs.map(ctx.decryptConfig),
			);

			return decryptedConfigs;
		} catch (error) {
			throw new TRPCError({
				code: 'INTERNAL_SERVER_ERROR',
				message: `Failed to list assistant configurations: ${extractErrorMessage(error)}`,
			});
		}
	}),

	// Get specific assistant config
	getById: assistantConfigProcedure
		.input(type({ id: 'string' }))
		.query(async ({ ctx, input }) => {
			try {
				const config = await ctx.db.query.assistantConfig.findFirst({
					where: and(
						eq(assistantConfig.id, input.id),
						eq(assistantConfig.userId, ctx.user.id),
					),
				});

				if (!config) {
					throw new TRPCError({
						code: 'NOT_FOUND',
						message: 'Assistant configuration not found',
					});
				}

				// Update last accessed timestamp
				await ctx.db
					.update(assistantConfig)
					.set({ lastAccessedAt: new Date() })
					.where(eq(assistantConfig.id, input.id));

				const decryptedConfig = await ctx.decryptConfig(config);
				return decryptedConfig;
			} catch (error) {
				if (error instanceof TRPCError) throw error;

				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Failed to fetch assistant configuration: ${extractErrorMessage(error)}`,
				});
			}
		}),

	// Create new assistant config
	create: assistantConfigProcedure
		.input(assistantConfigInsertSchema.omit('userId'))
		.mutation(async ({ ctx, input }) => {
			try {
				const encryptedInput = await ctx.encryptConfig(input);

				const newConfig = await ctx.db
					.insert(assistantConfig)
					.values({ ...encryptedInput, userId: ctx.user.id })
					.onConflictDoNothing()
					.returning()
					.then((rows) => rows.at(0));

				return newConfig ? ctx.decryptConfig(newConfig) : null;
			} catch (error) {
				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Failed to create assistant configuration: ${extractErrorMessage(error)}`,
				});
			}
		}),

	// Update assistant config
	update: assistantConfigProcedure
		.input(assistantConfigUpdateSchema.omit('userId'))
		.mutation(async ({ ctx, input }) => {
			const { id, ...updateData } = input;

			try {
				// Encrypt password if provided
				const encryptedUpdateData = await ctx.encryptConfig(updateData);

				const [updated] = await ctx.db
					.update(assistantConfig)
					.set(encryptedUpdateData)
					.where(
						and(
							eq(assistantConfig.id, id),
							eq(assistantConfig.userId, ctx.user.id),
						),
					)
					.returning();

				if (!updated) {
					throw new TRPCError({
						code: 'NOT_FOUND',
						message: 'Assistant configuration not found',
					});
				}

				// Return with decrypted password
				return ctx.decryptConfig(updated);
			} catch (error) {
				if (error instanceof TRPCError) throw error;

				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Failed to update assistant configuration: ${extractErrorMessage(error)}`,
				});
			}
		}),

	delete: assistantConfigProcedure
		.input(type({ id: 'string' }))
		.mutation(async ({ ctx, input }) => {
			try {
				const [deleted] = await ctx.db
					.delete(assistantConfig)
					.where(
						and(
							eq(assistantConfig.id, input.id),
							eq(assistantConfig.userId, ctx.user.id),
						),
					)
					.returning();

				if (!deleted) {
					throw new TRPCError({
						code: 'NOT_FOUND',
						message: 'Assistant configuration not found',
					});
				}

				return { message: 'Assistant config deleted successfully' };
			} catch (error) {
				if (error instanceof TRPCError) throw error;

				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Failed to delete assistant configuration: ${extractErrorMessage(error)}`,
				});
			}
		}),
});
