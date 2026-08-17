<script lang="ts">
	import { Tooltip as TooltipPrimitive } from 'bits-ui';

	let {
		delayDuration = 300,
		skipDelayDuration = 150,
		...restProps
	}: TooltipPrimitive.ProviderProps = $props();
</script>

<!--
	Opinionated defaults: 300ms delay, 150ms skip delay. bits-ui defaults to
	700ms/300ms, which feels sluggish for desktop apps.

	One of these per app, at the root, and no second one anywhere below it.
	A provider is not a settings bag, it is a hover neighborhood: everything
	inside one shares the skip window, so after the first tooltip the rest
	appear instantly while the pointer keeps moving. `skipDelayDuration` can
	only be set here, never on a Tooltip.Root, which is the API saying the
	same thing. Nesting a second provider does not tune a subtree, it cuts
	that subtree out of the neighborhood and hides this delay from it.

	That is also why nothing overrides `delayDuration` on a Tooltip.Root. An
	icon whose tooltip is its only label reads like a case for opening
	sooner, but the skip window already covers the sweep, so all a zero delay
	buys is the first hover from rest: the one hover a person did not ask
	for.

	See: https://bits-ui.com/docs/components/tooltip#provider-component
-->
<TooltipPrimitive.Provider {delayDuration} {skipDelayDuration} {...restProps} />
