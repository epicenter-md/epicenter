import type { ApiApp } from '@epicenter/local-mail/http/api';
import { MAIL_API_PREFIX } from '@epicenter/local-mail/mount';
import { hc } from 'hono/client';

// The mail `/api` client, typed end to end by `hc<ApiApp>`: its request and
// response shapes are inferred from the Hono routes in
// `apps/local-mail/src/http/api.ts`, so the wire contract cannot drift from the
// server.
//
// One base, because there is one place this surface is ever served: the host
// mounts it at MAIL_API_PREFIX on the origin serving this SPA (ADR-0191). In
// production that host is Epicenter; in dev it is `scripts/dev-api.ts` behind
// the Vite proxy, at the same path. No credential is attached: an application
// window inside Epicenter runs as Epicenter, riding the session the host
// already requires of every request it serves.
//
// `hc` needs an absolute base, and this module only ever executes in the
// browser (the SPA is `ssr: false`, `prerender: false`); the localhost fallback
// keeps a stray import from throwing at load.
const base =
	typeof window === 'undefined'
		? `http://localhost${MAIL_API_PREFIX}`
		: `${window.location.origin}${MAIL_API_PREFIX}`;
const client = hc<ApiApp>(base);

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
