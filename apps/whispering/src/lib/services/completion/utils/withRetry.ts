export async function withRetry<T>(
	fn: () => Promise<T>,
	options: {
		retries?: number;
		delayMs?: number;
		timeoutMs?: number;
	},
): Promise<T> {
	const { retries = 3, delayMs = 500, timeoutMs = 10000 } = options;

	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			const result = await Promise.race([
				fn(),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('Timeout')), timeoutMs),
				),
			]);
			return result;
		} catch (_error) {
			if (attempt === retries) throw _error;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	throw new Error('Retry failed');
}
