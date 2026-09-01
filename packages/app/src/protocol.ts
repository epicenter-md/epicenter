/** Messages exchanged by an application handle and a trusted desktop owner. */

import type { SqliteValue } from '@epicenter/sqlite';

export const APP_STORAGE_PATH = '/api/app-storage';

export type SqliteStatement = {
	sql: string;
	parameters?: readonly SqliteValue[];
};

export type AppStorageRequest =
	| {
			kind: 'sqlite-run';
			appId: string;
			name: string;
			statement: SqliteStatement;
		}
	| {
			kind: 'sqlite-all';
			appId: string;
			name: string;
			statement: SqliteStatement;
		}
	| {
			kind: 'sqlite-batch';
			appId: string;
			name: string;
			statements: readonly SqliteStatement[];
		}
	| {
			kind: 'secret-put';
			appId: string;
			accountId: string;
			value: string;
		}
	| {
			kind: 'secret-get';
			appId: string;
			accountId: string;
		}
	| {
			kind: 'secret-delete';
			appId: string;
			accountId: string;
		};

export type AppStorageResponse =
	| { kind: 'sqlite-run'; changes: number }
	| { kind: 'sqlite-all'; rows: readonly Record<string, unknown>[] }
	| { kind: 'sqlite-batch'; changes: readonly number[] }
	| { kind: 'secret-put' }
	| { kind: 'secret-get'; value: string | null }
	| { kind: 'secret-delete' };

export function isAppStorageResponse(value: unknown): value is AppStorageResponse {
	if (typeof value !== 'object' || value === null || !('kind' in value)) {
		return false;
	}
	const kind = value.kind;
	return (
		kind === 'sqlite-run' ||
		kind === 'sqlite-all' ||
		kind === 'sqlite-batch' ||
		kind === 'secret-put' ||
		kind === 'secret-get' ||
		kind === 'secret-delete'
	);
}
