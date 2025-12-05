<script>
	// Microphone hero animation component
</script>

<div class="relative inline-block mb-16 lg:mb-20">
	<!-- Microphone Icon -->
	<div class="relative z-20 text-8xl lg:text-9xl select-none">🎙️</div>

	<!-- Sound Waves -->
	<div
		class="absolute top-1/2 left-full ml-6 lg:ml-8 -translate-y-1/2 flex items-end space-x-1"
	>
		<div class="w-2 h-4 bg-primary/40 rounded-full animate-sound-wave"></div>
		<div
			class="w-2 h-8 bg-primary/50 rounded-full animate-sound-wave animation-delay-200"
		></div>
		<div
			class="w-2 h-12 bg-primary/60 rounded-full animate-sound-wave animation-delay-400"
		></div>
		<div
			class="w-2 h-6 bg-primary/50 rounded-full animate-sound-wave animation-delay-600"
		></div>
		<div
			class="w-2 h-3 bg-primary/40 rounded-full animate-sound-wave animation-delay-800"
		></div>
	</div>

	<div
		class="absolute top-1/2 right-full mr-6 lg:mr-8 -translate-y-1/2 flex items-end space-x-1"
	>
		<div
			class="w-2 h-3 bg-primary/40 rounded-full animate-sound-wave animation-delay-800"
		></div>
		<div
			class="w-2 h-6 bg-primary/50 rounded-full animate-sound-wave animation-delay-600"
		></div>
		<div
			class="w-2 h-12 bg-primary/60 rounded-full animate-sound-wave animation-delay-400"
		></div>
		<div
			class="w-2 h-8 bg-primary/50 rounded-full animate-sound-wave animation-delay-200"
		></div>
		<div class="w-2 h-4 bg-primary/40 rounded-full animate-sound-wave"></div>
	</div>
</div>

<style>
	@keyframes sound-wave {
		0%,
		100% {
			transform: scaleY(0.5);
			opacity: 0.4;
		}
		50% {
			transform: scaleY(1.2);
			opacity: 0.9;
		}
	}

	.animate-sound-wave {
		animation: sound-wave 1.8s ease-in-out infinite;
	}

	/* Animation delays */
	.animation-delay-200 {
		animation-delay: 0.2s;
	}

	.animation-delay-400 {
		animation-delay: 0.4s;
	}

	.animation-delay-600 {
		animation-delay: 0.6s;
	}

	.animation-delay-800 {
		animation-delay: 0.8s;
	}
</style>
