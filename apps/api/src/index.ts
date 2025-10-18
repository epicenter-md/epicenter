import { trpcServer } from '@hono/trpc-server';
import { APP_URLS, type CloudflareEnv } from '@repo/constants/cloudflare';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth, type Session, type User } from './lib/auth';
import { createContext } from './trpc/context';
import { appRouter } from './trpc/routers';

const app = new Hono<{
	Bindings: CloudflareEnv;
	Variables: {
		user: User | null;
		session: Session | null;
	};
}>();

app.use('*', (c, next) =>
	cors({
		origin: APP_URLS(c.env),
		allowHeaders: ['Content-Type', 'Authorization'],
		allowMethods: ['POST', 'GET', 'OPTIONS', 'PUT', 'DELETE'],
		exposeHeaders: ['Content-Length'],
		maxAge: 600,
		credentials: true,
	})(c, next),
);

// Better Auth session middleware - validates session on every request
app.use('*', async (c, next) => {
	const session = await auth(c.env).api.getSession({
		headers: c.req.raw.headers,
	});

	if (!session) {
		c.set('user', null);
		c.set('session', null);
		return next();
	}

	c.set('user', session.user);
	c.set('session', session.session);
	return next();
});

app.on(['POST', 'GET'], '/auth/*', (c) => {
	return auth(c.env).handler(c.req.raw);
});

app.use(
	'/trpc/*',
	trpcServer({
		router: appRouter,
		createContext: (opts, c) => createContext(c),
	}),
);

app.get('/health', (c) => {
	return c.json({ status: 'ok' });
});

export type { AppRouter } from './trpc/routers';

export default app;
