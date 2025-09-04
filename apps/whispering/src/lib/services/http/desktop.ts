import { fetch } from '@tauri-apps/plugin-http';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, tryAsync } from 'wellcrafted/result';
import type { HttpService } from '.';
import { ConnectionErr, ParseErr, ResponseErr } from './types';

export function createHttpServiceDesktop(): HttpService {
	return {
		async post({ body, url, schema, headers }) {
			const { data: response, error: responseError } = await tryAsync({
				try: () =>
					fetch(url, {
						method: 'POST',
						body,
						headers: headers,
					}),
				catch: (error) =>
					ConnectionErr({
						message: 'Failed to establish connection',
						context: { url, body, headers },
						cause: error,
					}),
			});
			if (responseError) return Err(responseError);

			if (!response.ok) {
				return ResponseErr({
					status: response.status,
					message: extractErrorMessage(await response.json()),
					context: { url, body, headers },
					cause: responseError,
				});
			}

			const parseResult = await tryAsync({
				try: async () => {
					const json = await response.json();
					return schema.parse(json);
				},
				catch: (error) =>
					ParseErr({
						message: 'Failed to parse response',
						context: { url, body, headers },
						cause: error,
					}),
			});
			return parseResult;
		},
	};
}
