/**
 * Contract for `#os`: host-OS identity, resolved once per build target.
 * The Epicenter build reads the real OS natively; the web build infers it from
 * the user agent. Only the two facts the app actually branches on are exposed.
 */
export type Os = {
	/**
	 * An Apple platform: macOS, iOS, or iPadOS. These share the Command (⌘)
	 * primary modifier and the Option-key character layout, which is what every
	 * keyboard call site branches on. In the Epicenter build this is exactly
	 * macOS; iOS only ever appears on the web.
	 */
	isApple: boolean;
	/** Desktop Linux, excluding Android. Gates the Linux-only VAD notice. */
	isLinux: boolean;
};
