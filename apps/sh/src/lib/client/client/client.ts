import type { Client, Config, RequestOptions } from './types';

import {
	buildUrl,
	createConfig,
	createInterceptors,
	getParseAs,
	mergeConfigs,
	mergeHeaders,
	setAuthParams,
} from './utils';

/**
 * Request initialization options with custom body and headers handling
 */
type ReqInit = Omit<RequestInit, 'body' | 'headers'> & {
	body?: any;
	headers: ReturnType<typeof mergeHeaders>;
};

/**
 * Creates an HTTP client with configurable options and interceptors
 * @param config - Configuration options for the client
 * @returns A client object with HTTP methods and utilities
 */
export const createClient = (config: Config = {}): Client => {
	let _config = mergeConfigs(createConfig(), config);

	/**
	 * Returns a copy of the current configuration
	 * @returns Current client configuration
	 */
	const getConfig = (): Config => ({ ..._config });

	/**
	 * Updates the client configuration by merging with existing config
	 * @param config - New configuration to merge
	 * @returns Updated configuration
	 */
	const setConfig = (config: Config): Config => {
		_config = mergeConfigs(_config, config);
		return getConfig();
	};

	const interceptors = createInterceptors<
		Request,
		Response,
		unknown,
		RequestOptions
	>();

	/**
	 * Makes an HTTP request with the configured options and interceptors
	 * @param options - Request options including method, headers, body, etc.
	 * @returns Promise resolving to response data or error information
	 */
	const request: Client['request'] = async (options) => {
		const opts = {
			..._config,
			...options,
			fetch: options.fetch ?? _config.fetch ?? globalThis.fetch,
			headers: mergeHeaders(_config.headers, options.headers),
		};

		if (opts.security) {
			await setAuthParams({
				...opts,
				security: opts.security,
			});
		}

		if (opts.requestValidator) {
			await opts.requestValidator(opts);
		}

		if (opts.body && opts.bodySerializer) {
			opts.body = opts.bodySerializer(opts.body);
		}

		// remove Content-Type header if body is empty to avoid sending invalid requests
		if (opts.body === undefined || opts.body === '') {
			opts.headers.delete('Content-Type');
		}

		const url = buildUrl(opts);
		const requestInit: ReqInit = {
			redirect: 'follow',
			...opts,
		};

		let request = new Request(url, requestInit);

		for (const fn of interceptors.request._fns) {
			if (fn) {
				request = await fn(request, opts);
			}
		}

		// fetch must be assigned here, otherwise it would throw the error:
		// TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation
		const _fetch = opts.fetch!;
		let response = await _fetch(request);

		for (const fn of interceptors.response._fns) {
			if (fn) {
				response = await fn(response, request, opts);
			}
		}

		const result = {
			request,
			response,
		};

		if (response.ok) {
			if (
				response.status === 204 ||
				response.headers.get('Content-Length') === '0'
			) {
				return opts.responseStyle === 'data'
					? {}
					: {
							data: {},
							...result,
						};
			}

			const parseAs =
				(opts.parseAs === 'auto'
					? getParseAs(response.headers.get('Content-Type'))
					: opts.parseAs) ?? 'json';

			let data: any;
			switch (parseAs) {
				case 'arrayBuffer':
				case 'blob':
				case 'formData':
				case 'json':
				case 'text':
					data = await response[parseAs]();
					break;
				case 'stream':
					return opts.responseStyle === 'data'
						? response.body
						: {
								data: response.body,
								...result,
							};
			}

			if (parseAs === 'json') {
				if (opts.responseValidator) {
					await opts.responseValidator(data);
				}

				if (opts.responseTransformer) {
					data = await opts.responseTransformer(data);
				}
			}

			return opts.responseStyle === 'data'
				? data
				: {
						data,
						...result,
					};
		}

		const textError = await response.text();
		let jsonError: unknown;

		try {
			jsonError = JSON.parse(textError);
		} catch {
			// noop
		}

		const error = jsonError ?? textError;
		let finalError = error;

		for (const fn of interceptors.error._fns) {
			if (fn) {
				finalError = (await fn(error, response, request, opts)) as string;
			}
		}

		finalError = finalError || ({} as string);

		if (opts.throwOnError) {
			throw finalError;
		}

		// TODO: we probably want to return error and improve types
		return opts.responseStyle === 'data'
			? undefined
			: {
					error: finalError,
					...result,
				};
	};

	return {
		buildUrl,
		/**
		 * Makes a CONNECT request
		 * @param options - Request options
		 * @returns Promise resolving to response data
		 */
		connect: (options) => request({ ...options, method: 'CONNECT' }),
		/**
		 * Makes a DELETE request
		 * @param options - Request options
		 * @returns Promise resolving to response data
		 */
		delete: (options) => request({ ...options, method: 'DELETE' }),
		/**
		 * Makes a GET request
		 * @param options - Request options
		 * @returns Promise resolving to response data
		 */
		get: (options) => request({ ...options, method: 'GET' }),
		getConfig,
		/**
		 * Makes a HEAD request
		 * @param options - Request options
		 * @returns Promise resolving to response data
		 */
		head: (options) => request({ ...options, method: 'HEAD' }),
		interceptors,
		/**
		 * Makes an OPTIONS request
		 * @param options - Request options
		 * @returns Promise resolving to response data
		 */
		options: (options) => request({ ...options, method: 'OPTIONS' }),
		/**
		 * Makes a PATCH request
		 * @param options - Request options
		 * @returns Promise resolving to response data
		 */
		patch: (options) => request({ ...options, method: 'PATCH' }),
		/**
		 * Makes a POST request
		 * @param options - Request options
		 * @returns Promise resolving to response data
		 */
		post: (options) => request({ ...options, method: 'POST' }),
		/**
		 * Makes a PUT request
		 * @param options - Request options
		 * @returns Promise resolving to response data
		 */
		put: (options) => request({ ...options, method: 'PUT' }),
		request,
		setConfig,
		/**
		 * Makes a TRACE request
		 * @param options - Request options
		 * @returns Promise resolving to response data
		 */
		trace: (options) => request({ ...options, method: 'TRACE' }),
	};
};
