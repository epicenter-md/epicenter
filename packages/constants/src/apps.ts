/**
 * Produces a map of all Epicenter applications with their metadata. Currently only includes the URL,
 * which varies depending on the environment (development or production).
 *
 * These URLs are reused in Vite, Node, and Cloudflare to properly access specific app URLs.
 */
export const createApps = (env: 'development' | 'production') => {
	const isProduction = env === 'production';
	return {
		/**
		 * Main API service for the application ecosystem (includes auth)
		 */
		API: {
			URL: isProduction ? 'https://api.epicenter.so' : 'http://localhost:8787',
		},
		/**
		 * Main epicenter.sh web application
		 */
		SH: {
			URL: isProduction ? 'https://epicenter.sh' : 'http://localhost:5173',
		},
		/**
		 * Whispering audio transcription application
		 */
		AUDIO: {
			URL: isProduction
				? 'https://whispering.epicenter.so'
				: 'http://localhost:1420',
		},
	} as const;
};

/**
 * Derives all URLs from createApps and returns them as an array.
 *
 * Useful for:
 * - CORS configuration
 * - Security policies
 * - Any scenario requiring a list of all service endpoints
 */
export const createAppUrls = (env: 'development' | 'production') =>
	Object.values(createApps(env)).map((app) => app.URL);
