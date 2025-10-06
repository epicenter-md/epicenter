<script>
	let {
		children,
		class: className = '',
		threshold = 0.1,
		rootMargin = '0px',
	} = $props();
	let element = $state(null);
	let isVisible = $state(false);

	$effect(() => {
		if (!element) return;

		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting && !isVisible) {
						isVisible = true;
						observer.unobserve(entry.target); // Stop observing after animation
					}
				});
			},
			{
				threshold,
				rootMargin,
			},
		);

		observer.observe(element);

		return () => {
			observer.disconnect();
		};
	});
</script>

<div
	bind:this={element}
	class="{className} transition-all duration-700 {isVisible
		? 'opacity-100 translate-y-0'
		: 'opacity-0 translate-y-8'}"
>
	{@render children()}
</div>
