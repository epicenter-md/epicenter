import { open as openBrowser } from '@epicenter/data/browser';
import { honeycrispLens } from '@epicenter/honeycrisp';
import { createLogger } from 'wellcrafted/logger';
import { auth } from '#platform/auth';
import type { HoneycrispDependencies } from './application.js';

const log = createLogger('honeycrisp/application');

/**
 * Where Honeycrisp's data lives: here, in this surface's own storage.
 *
 * Every build, with no seam and no condition. That is a refusal rather than an
 * omission, and it is worth stating because the alternative was already half
 * designed: the desktop host owns a Bun process, `openBunStore` runs there, and
 * a window could have been a replica of a store the host owned.
 *
 * It is not, because the sharing that arrangement buys is sharing this
 * application already has. A surface is a replica of one authority per account
 * (ADR-0225), so two windows on one machine converge through the same authority
 * every other device uses. Building a second, machine-local authority beside it
 * would mean a host that serves data as well as bundles, a second transport
 * topology, and a second set of answers to what happens when the two disagree,
 * all to make a convergence that already happens happen sooner.
 *
 * What it costs is honest and bounded: two surfaces on one machine with no
 * network stay apart until one of them reconnects. Each is complete on its own
 * meanwhile, because each holds the whole document.
 *
 * So "am I the build the desktop host serves" is a question with no consequence
 * here, and the `#platform/application` seam that existed to answer it is gone.
 * Auth still differs per build and keeps its seam (`#platform/auth`), because
 * the host really does broker a credential its windows cannot obtain.
 *
 * Where the data lives is not named here either. The lens names the store it
 * opens (ADR-0229), so `so.epicenter.honeycrisp` is the namespace, the durable
 * record, and the authority address, and there is no second string for this
 * file to get wrong.
 *
 * Inert: nothing opens until the root calls it.
 */
export const honeycrispPlatform: HoneycrispDependencies = {
	async open() {
		const { data, error } = await openBrowser(honeycrispLens);
		if (error !== null) throw error;
		return data;
	},
	auth,
	reportBackgroundError: (cause) =>
		log.warn(new Error('Honeycrisp background work failed', { cause })),
};
