import type { ApiApp } from '@epicenter/local-mail/http/api';
import { hc } from 'hono/client';
import { mailApiBase, mailApiFetch } from '#platform/mail-host';

// The mail `/api` client, typed end to end by `hc<ApiApp>`: its request and
// response shapes are inferred from the Hono routes in
// `apps/local-mail/src/http/api.ts`, so the wire contract cannot drift from the
// server.
//
// Where that surface is mounted, and what authenticates it, belong to the host
// (ADR-0191) and reach this module through the `#platform/mail-host` seam:
// `/api` behind a per-launch bearer under standalone `local-mail app`,
// `/api/mail` behind Epicenter's own browser session under the Epicenter build.
// The routes themselves are prefix-free, so one generated client serves both.
const client = hc<ApiApp>(mailApiBase, { fetch: mailApiFetch });

async function toError(res: Response): Promise<Error> {
	// Errors arrive as wellcrafted's envelope `{ data: null, error: { name,
	// message, status } }` from the `/api` app's `defineErrors` variants.
	const body = (await res.json().catch(() => null)) as {
		error?: { message?: string };
	} | null;
	return new Error(body?.error?.message ?? `Request failed (${res.status}).`);
}

type MessageQuery = {
	label?: string;
	search?: string;
	limit?: number;
	offset?: number;
};

// Every read/write is account-scoped: the host serves all connected mailboxes
// under one origin (`/accounts/:account/*`), and the caller (the page's
// account switcher) passes which one. `accounts()` lists the connected set.
export const api = {
	accounts: async () => {
		const res = await client.accounts.$get();
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	status: async (account: string) => {
		const res = await client.accounts[':account'].status.$get({
			param: { account },
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	labels: async (account: string) => {
		const res = await client.accounts[':account'].labels.$get({
			param: { account },
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	messages: async (account: string, query: MessageQuery = {}) => {
		const res = await client.accounts[':account'].messages.$get({
			param: { account },
			query: {
				...(query.label ? { label: query.label } : {}),
				...(query.search ? { q: query.search } : {}),
				...(query.limit != null ? { limit: String(query.limit) } : {}),
				...(query.offset != null ? { offset: String(query.offset) } : {}),
			},
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	message: async (account: string, id: string) => {
		const res = await client.accounts[':account'].messages[':id'].$get({
			param: { account, id },
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	sync: async (account: string) => {
		const res = await client.accounts[':account'].sync.$post({
			param: { account },
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	modify: async (
		account: string,
		input: {
			ids: string[];
			addLabels?: string[];
			removeLabels?: string[];
		},
	) => {
		const res = await client.accounts[':account'].messages.modify.$post({
			param: { account },
			json: input,
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
	setTrashed: async (
		account: string,
		input: { ids: string[]; trashed: boolean },
	) => {
		const res = await client.accounts[':account'].messages.trash.$post({
			param: { account },
			json: input,
		});
		if (!res.ok) throw await toError(res);
		return res.json();
	},
};
