import { expect, test } from 'bun:test';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { asPrincipalId } from '@epicenter/principal';
import { Hono } from 'hono';
import type { Env } from '../types.js';
import { mountSessionApp } from './session.js';

test('/api/session returns the principal projection', async () => {
	const app = new Hono<Env>();
	mountSessionApp(app, {
		auth: async (c, next) => {
			c.set('principal', {
				id: asPrincipalId('alice'),
				email: 'alice@example.com',
			});
			await next();
		},
	});

	const res = await app.request(API_ROUTES.session.url('https://x'));

	expect(res.status).toBe(200);
	const body = (await res.json()) as unknown;
	expect(body).toEqual({
		principalId: 'alice',
		email: 'alice@example.com',
	});
});

test('/api/session omits email when the principal has none', async () => {
	const app = new Hono<Env>();
	mountSessionApp(app, {
		auth: async (c, next) => {
			c.set('principal', { id: asPrincipalId('instance') });
			await next();
		},
	});

	const res = await app.request(API_ROUTES.session.url('https://x'));

	expect(res.status).toBe(200);
	const body = (await res.json()) as unknown;
	expect(body).toEqual({ principalId: 'instance' });
});
