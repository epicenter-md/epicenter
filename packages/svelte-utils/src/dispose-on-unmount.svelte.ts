/**
 * Tie a resource to the lifetime of the component that opened it.
 *
 * One line, and it exists because the version every route was writing by hand
 * had three things wrong with it that nothing catches:
 *
 * ```ts
 * $effect(() => () => {
 * 	void opening.then((r) => isOk(r) && r.data[Symbol.asyncDispose]());
 * });
 * ```
 *
 * It reaches into a promise, so a resource still opening when the component
 * goes away is disposed by a closure that has to remember the shape of what it
 * is waiting for. It has to swallow the failure arm or an open that failed
 * reports twice, once through the surface waiting on it and once as an
 * unhandled rejection. And it has to be a teardown returned from `$effect`
 * rather than `onDestroy`, so it also runs for a component destroyed before it
 * ever mounted, which is what navigating away during a loading state does.
 *
 * Only the third is inherent, so only the third is here. Hand this a handle
 * that is disposable NOW and defers internally to whatever it is still
 * opening, and the other two stop being the caller's problem.
 *
 * Called during component initialisation, like every rune-backed helper in
 * this package. This is not `fromDisposableCache` beside it, which re-opens
 * when its id changes: a resource whose subject can change wants that one.
 */
export function disposeOnUnmount(resource: AsyncDisposable): void {
	$effect(() => () => void resource[Symbol.asyncDispose]());
}
