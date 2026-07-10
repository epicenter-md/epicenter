import type { WhisperingDesktop } from './contract';

/**
 * Type-only fallback for checking Epicenter-only source in the browser project.
 * It emits no runtime export, so a browser-reachable `#desktop` import fails the
 * production build instead of silently receiving a fake desktop implementation.
 */
export declare const desktop: WhisperingDesktop;
