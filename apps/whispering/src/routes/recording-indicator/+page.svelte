<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import '@epicenter/ui/app.css';

	// State
	let audioLevel = $state(0);
	let elapsedSeconds = $state(0);
	let recordingState = $state<'recording' | 'processing' | 'idle'>('recording');
	let waveformBars = $state<number[]>(new Array(24).fill(0.15));

	// Animation frame for smooth waveform
	let animationFrameId: number | null = null;
	let targetLevels: number[] = new Array(24).fill(0.15);

	// Event listeners
	let unlistenFns: UnlistenFn[] = [];

	onMount(async () => {
		// Listen for audio level updates
		unlistenFns.push(
			await listen<{ level: number }>('audio-level-update', (event) => {
				audioLevel = event.payload.level;
				updateTargetLevels(audioLevel);
			}),
		);

		// Listen for time updates
		unlistenFns.push(
			await listen<{ seconds: number }>('recording-time-update', (event) => {
				elapsedSeconds = event.payload.seconds;
			}),
		);

		// Listen for state updates
		unlistenFns.push(
			await listen<{ state: 'recording' | 'processing' | 'idle' }>(
				'recording-state-update',
				(event) => {
					recordingState = event.payload.state;
				},
			),
		);

		// Start animation loop
		startAnimation();
	});

	onDestroy(() => {
		unlistenFns.forEach((fn) => fn());
		if (animationFrameId) {
			cancelAnimationFrame(animationFrameId);
		}
	});

	function updateTargetLevels(level: number) {
		// Create organic-looking waveform based on audio level
		targetLevels = targetLevels.map((_, i) => {
			const centerDistance = Math.abs(i - 11.5) / 12;
			const baseHeight = Math.max(0.1, level * (1 - centerDistance * 0.5));
			const variance = (Math.random() - 0.5) * 0.3 * level;
			return Math.max(0.08, Math.min(1, baseHeight + variance));
		});
	}

	function startAnimation() {
		function animate() {
			// Smooth interpolation towards target values
			waveformBars = waveformBars.map((current, i) => {
				const target = targetLevels[i];
				const diff = target - current;
				// Faster rise, slower fall for natural feel
				const speed = diff > 0 ? 0.25 : 0.08;
				return current + diff * speed;
			});

			animationFrameId = requestAnimationFrame(animate);
		}
		animate();
	}

	function formatTime(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	}

	// Derive visual state
	const isRecording = $derived(recordingState === 'recording');
	const isProcessing = $derived(recordingState === 'processing');
</script>

<div class="indicator dark" class:processing={isProcessing}>
	<!-- Recording dot with glow -->
	<div class="recording-dot" class:active={isRecording}>
		<div class="dot-core"></div>
		<div class="dot-glow"></div>
	</div>

	<!-- Waveform visualization -->
	<div class="waveform">
		{#each waveformBars as height, i}
			<div
				class="bar"
				style="--height: {height}; --delay: {i * 0.02}s"
			></div>
		{/each}
	</div>

	<!-- Timer -->
	<div class="timer">
		{#if isProcessing}
			<span class="processing-text">...</span>
		{:else}
			<span class="time">{formatTime(elapsedSeconds)}</span>
		{/if}
	</div>
</div>

<style>
	/* Container - sleek pill shape */
	.indicator {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 12px;
		padding: 0 16px;

		/* Premium glass effect */
		background: oklch(0.129 0.042 264.695 / 0.92);
		backdrop-filter: blur(20px) saturate(180%);
		-webkit-backdrop-filter: blur(20px) saturate(180%);

		/* Subtle border */
		border: 1px solid oklch(1 0 0 / 0.08);
		border-radius: 24px;

		/* Soft shadow for depth */
		box-shadow:
			0 4px 24px -4px oklch(0 0 0 / 0.4),
			0 0 0 1px oklch(1 0 0 / 0.05) inset,
			0 1px 0 oklch(1 0 0 / 0.1) inset;

		/* Smooth transitions */
		transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
	}

	.indicator.processing {
		background: oklch(0.15 0.03 264.695 / 0.95);
	}

	/* Recording dot */
	.recording-dot {
		position: relative;
		width: 10px;
		height: 10px;
		flex-shrink: 0;
	}

	.dot-core {
		position: absolute;
		inset: 0;
		background: oklch(0.628 0.258 29.234);
		border-radius: 50%;
		transition: all 0.2s ease;
	}

	.recording-dot.active .dot-core {
		animation: pulse 1.5s ease-in-out infinite;
	}

	.dot-glow {
		position: absolute;
		inset: -4px;
		background: oklch(0.628 0.258 29.234 / 0.4);
		border-radius: 50%;
		filter: blur(6px);
		opacity: 0;
		transition: opacity 0.3s ease;
	}

	.recording-dot.active .dot-glow {
		opacity: 1;
		animation: glow-pulse 1.5s ease-in-out infinite;
	}

	@keyframes pulse {
		0%, 100% {
			transform: scale(1);
			opacity: 1;
		}
		50% {
			transform: scale(0.85);
			opacity: 0.7;
		}
	}

	@keyframes glow-pulse {
		0%, 100% {
			opacity: 0.6;
			transform: scale(1);
		}
		50% {
			opacity: 0.3;
			transform: scale(1.1);
		}
	}

	/* Waveform */
	.waveform {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 2px;
		height: 24px;
		flex: 1;
		max-width: 120px;
	}

	.bar {
		width: 2.5px;
		height: calc(var(--height) * 100%);
		min-height: 3px;
		background: linear-gradient(
			to top,
			oklch(0.704 0.04 256.788 / 0.6),
			oklch(0.929 0.013 255.508)
		);
		border-radius: 2px;
		transition: height 0.05s ease-out;
		transform-origin: center;
	}

	/* Timer */
	.timer {
		font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
		font-size: 12px;
		font-weight: 500;
		letter-spacing: 0.5px;
		color: oklch(0.704 0.04 256.788);
		min-width: 36px;
		text-align: right;
		flex-shrink: 0;
	}

	.time {
		font-variant-numeric: tabular-nums;
	}

	.processing-text {
		animation: blink 1s ease-in-out infinite;
	}

	@keyframes blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.4; }
	}

	/* Reduced motion support */
	@media (prefers-reduced-motion: reduce) {
		.recording-dot.active .dot-core,
		.recording-dot.active .dot-glow,
		.processing-text {
			animation: none;
		}

		.bar {
			transition: none;
		}
	}
</style>
