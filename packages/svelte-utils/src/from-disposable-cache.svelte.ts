/**
 * Reactive binding to a disposable opener. Opens a handle for the current id
 * and disposes it on unmount or id swap.
 *
 * The id is read through `idFn` inside a `$derived`, so the handle tracks
 * prop/state changes. When the id changes, the opener returns a handle for the
 * new id and the effect's teardown disposes the handle for the old id.
 *
 * Takes only an `{ open(id) }` opener, not a full `DisposableCache`: this
 * binding disposes the per-call *handle*, never the cache itself, so anything
 * that hands out disposable handles fits, a `createDisposableCache` or a
 * database `tables.<t>.docs.<field>` row child-doc opener alike.
 *
 * Why a getter (`() => id`) and not the id directly: destructured props and
 * `$state` reads are not reactive when captured at module top. See Svelte's
 * `state_referenced_locally` warning. Passing a function keeps the read
 * inside the derived's closure.
 */
export function fromDisposableCache<
	TId extends string | number,
	TValue extends Disposable,
>(
	cache: { open(id: TId): TValue },
	idFn: () => TId,
): { readonly current: TValue } {
	const handle = $derived(cache.open(idFn()));
	$effect(() => {
		const handleToDispose = handle;
		return () => handleToDispose[Symbol.dispose]();
	});
	return {
		get current() {
			return handle;
		},
	};
}
