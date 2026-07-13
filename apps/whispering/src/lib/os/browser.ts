import type { Os } from './contract';

/**
 * Web build: there is no native OS API, so identity is inferred from the user
 * agent, once, at module load. Prefer User-Agent Client Hints (Chromium exposes
 * a synchronous low-entropy `platform`) and fall back to the user-agent string
 * (Firefox, Safari, older browsers). In a non-DOM context (SSR, a Node test)
 * `navigator` is absent, so both facts resolve to false instead of throwing.
 */
function detect(): Os {
	if (typeof navigator === 'undefined') {
		return { isApple: false, isLinux: false };
	}

	// `userAgentData` is Chromium-only and not in the standard DOM lib types.
	// Its `platform` is one of 'macOS' | 'iOS' | 'Windows' | 'Linux' | 'Android'
	// | 'Chrome OS' | 'Unknown'; absent (undefined) on Firefox and Safari.
	const hint = (
		navigator as Navigator & { userAgentData?: { platform?: string } }
	).userAgentData?.platform;
	if (hint) {
		return {
			isApple: hint === 'macOS' || hint === 'iOS',
			isLinux: hint === 'Linux',
		};
	}

	const ua = navigator.userAgent;
	return {
		// 'Macintosh' covers macOS and iPadOS-in-desktop-mode; iPhone/iPad/iPod
		// cover mobile Safari. All are Apple ⌘ platforms, so no Mac-vs-iPad split.
		isApple: /mac|iphone|ipad|ipod/i.test(ua),
		// Android user agents also contain 'Linux', so exclude them.
		isLinux: /linux|x11/i.test(ua) && !/android/i.test(ua),
	};
}

export const os: Os = detect();
