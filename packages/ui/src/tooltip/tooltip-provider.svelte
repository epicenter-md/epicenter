<script lang="ts">
	import { Tooltip as TooltipPrimitive } from 'bits-ui';

	let {
		...restProps
	}: Omit<
		TooltipPrimitive.ProviderProps,
		'delayDuration' | 'skipDelayDuration'
	> = $props();
</script>

<!--
	How long a tooltip waits is a property of Epicenter, not of an app, so the
	two timings are constants here rather than props. bits-ui waits 700ms and
	skips for 300ms, which reads as sluggish on a desktop app.

	One of these per app, at the root, and no second one anywhere below it. A
	provider is not a settings bag, it is a hover neighborhood: everything
	inside one shares the skip window, so after the first tooltip the rest
	appear instantly while the pointer keeps moving. `skipDelayDuration` can
	only be set on a provider, never on a Tooltip.Root, which is the API
	saying the same thing. Nesting a second provider does not tune a subtree,
	it cuts that subtree out of the neighborhood.

	That is also why nothing overrides the delay on a Tooltip.Root. An icon
	whose tooltip is its only label reads like a case for opening sooner, but
	the skip window already covers the sweep such an icon lives in, so all a
	zero delay buys is the first hover from rest: the one hover nobody asked
	for.

	See: https://bits-ui.com/docs/components/tooltip#provider-component
-->
<TooltipPrimitive.Provider
	delayDuration={300}
	skipDelayDuration={150}
	{...restProps}
/>
