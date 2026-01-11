<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

	// Debug logging
	const DEBUG = true;
	function log(...args: unknown[]) {
		if (DEBUG) console.log('[RecordingIndicator]', ...args);
	}

	// State
	let audioLevel = $state(0);
	let elapsedSeconds = $state(0);
	let recordingState = $state<'recording' | 'processing' | 'idle'>('recording');
	let waveformBars = $state<number[]>(new Array(16).fill(0.15));
	let debugInfo = $state('initializing...');
	let eventCount = $state(0);

	// Internal timer (self-contained, no dependency on events)
	let timerInterval: ReturnType<typeof setInterval> | null = null;
	let startTime: number | null = null;

	// Animation interval for smooth waveform (using setInterval, not requestAnimationFrame)
	let animationInterval: ReturnType<typeof setInterval> | null = null;
	let targetLevels: number[] = new Array(16).fill(0.15);

	// Event listeners
	let unlistenFns: UnlistenFn[] = [];

	function startTimer() {
		log('startTimer called');
		startTime = Date.now();
		elapsedSeconds = 0;

		// Update timer every second
		timerInterval = setInterval(() => {
			if (startTime) {
				const newSeconds = Math.floor((Date.now() - startTime) / 1000);
				elapsedSeconds = newSeconds;
				log('Timer tick:', newSeconds);
			}
		}, 1000);
		log('Timer interval started');
	}

	function stopTimer() {
		log('stopTimer called');
		if (timerInterval) {
			clearInterval(timerInterval);
			timerInterval = null;
		}
		startTime = null;
	}

	function resetTimer() {
		log('resetTimer called');
		stopTimer();
		elapsedSeconds = 0;
		startTimer();
	}

	onMount(async () => {
		log('=== onMount START ===');
		debugInfo = 'onMount started';

		try {
			// Fix transparency issue on Windows by disabling shadow
			log('Getting webview window...');
			const webview = getCurrentWebviewWindow();
			log('Webview window:', webview.label);

			await webview.setShadow(false);
			log('Shadow disabled');

			// Signal that we're ready to receive events
			log('Emitting recording-indicator-ready...');
			await emit('recording-indicator-ready');
			log('Ready event emitted');

			// Start the internal timer immediately
			log('Starting timer...');
			startTimer();

			// Start animation loop (using setInterval for consistency)
			log('Starting animation...');
			startAnimation();

			// Listen for audio level updates
			log('Setting up audio-level-update listener...');
			unlistenFns.push(
				await listen<{ level: number }>('audio-level-update', (event) => {
					eventCount++;
					audioLevel = event.payload.level;
					updateTargetLevels(audioLevel);
					if (eventCount % 20 === 0) {
						log('Audio level event #' + eventCount + ':', event.payload.level.toFixed(3));
					}
				}),
			);
			log('audio-level-update listener ready');

			// Listen for reset events (when window is shown again)
			log('Setting up recording-indicator-reset listener...');
			unlistenFns.push(
				await listen('recording-indicator-reset', () => {
					log('Reset event received');
					resetTimer();
					recordingState = 'recording';
				}),
			);
			log('recording-indicator-reset listener ready');

			// Listen for state updates
			log('Setting up recording-state-update listener...');
			unlistenFns.push(
				await listen<{ state: 'recording' | 'processing' | 'idle' }>(
					'recording-state-update',
					(event) => {
						log('State update received:', event.payload.state);
						recordingState = event.payload.state;
						if (event.payload.state === 'processing') {
							stopTimer();
						}
					},
				),
			);
			log('recording-state-update listener ready');

			debugInfo = 'ready, waiting for events...';
			log('=== onMount COMPLETE ===');
		} catch (error) {
			log('ERROR in onMount:', error);
			debugInfo = 'ERROR: ' + String(error);
		}
	});

	onDestroy(() => {
		log('onDestroy called');
		unlistenFns.forEach((fn) => fn());
		stopTimer();
		if (animationInterval) {
			clearInterval(animationInterval);
			animationInterval = null;
		}
	});

	function updateTargetLevels(level: number) {
		// Create organic-looking waveform based on audio level
		const amplifiedLevel = Math.min(1, level * 1.5);
		targetLevels = targetLevels.map((_, i) => {
			const centerDistance = Math.abs(i - 7.5) / 8;
			const baseHeight = Math.max(0.12, amplifiedLevel * (1 - centerDistance * 0.6));
			const variance = (Math.random() - 0.5) * 0.35 * amplifiedLevel;
			return Math.max(0.1, Math.min(1, baseHeight + variance));
		});
	}

	function startAnimation() {
		// Use setInterval instead of requestAnimationFrame for consistency
		animationInterval = setInterval(() => {
			// Smooth interpolation towards target values
			waveformBars = waveformBars.map((current, i) => {
				const target = targetLevels[i];
				const diff = target - current;
				// Faster rise, slower fall for natural feel
				const speed = diff > 0 ? 0.3 : 0.1;
				return current + diff * speed;
			});
		}, 50); // ~20fps
		log('Animation interval started');
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

<div class="indicator" class:processing={isProcessing}>
	<!-- Recording dot with pulse effect -->
	<div class="recording-dot" class:active={isRecording}>
		<div class="dot-inner"></div>
	</div>

	<!-- Waveform visualization -->
	<div class="waveform">
		{#each waveformBars as height, i}
			<div
				class="bar"
				style="height: {Math.round(height * 100)}%"
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

<!-- Debug info - VISIBLE FOR DEBUGGING -->
<div class="debug">
	{debugInfo} | Events: {eventCount} | Level: {audioLevel.toFixed(2)} | Time: {elapsedSeconds}s
</div>

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		background: transparent !important;
		overflow: hidden;
	}

	/* Main container - floating pill design */
	.indicator {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 44px; /* Fixed height for pill, leaving room for debug */
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 10px;
		padding: 0 14px;

		/* Solid dark background for Windows compatibility */
		background: linear-gradient(
			135deg,
			rgba(24, 24, 32, 0.97) 0%,
			rgba(18, 18, 24, 0.98) 100%
		);

		/* Subtle border for definition */
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 22px;

		/* Soft glow effect */
		box-shadow:
			0 4px 20px -2px rgba(0, 0, 0, 0.5),
			0 0 0 1px rgba(255, 255, 255, 0.04) inset,
			0 1px 0 rgba(255, 255, 255, 0.06) inset;

		/* Smooth state transitions */
		transition: all 0.25s ease;
	}

	.indicator.processing {
		background: linear-gradient(
			135deg,
			rgba(30, 30, 40, 0.97) 0%,
			rgba(22, 22, 30, 0.98) 100%
		);
	}

	/* Recording indicator dot */
	.recording-dot {
		position: relative;
		width: 10px;
		height: 10px;
		flex-shrink: 0;
	}

	.dot-inner {
		width: 100%;
		height: 100%;
		background: #ef4444;
		border-radius: 50%;
		box-shadow: 0 0 8px 2px rgba(239, 68, 68, 0.5);
		transition: all 0.2s ease;
	}

	.recording-dot.active .dot-inner {
		animation: pulse-dot 1.2s ease-in-out infinite;
	}

	@keyframes pulse-dot {
		0%, 100% {
			transform: scale(1);
			opacity: 1;
			box-shadow: 0 0 8px 2px rgba(239, 68, 68, 0.5);
		}
		50% {
			transform: scale(0.85);
			opacity: 0.8;
			box-shadow: 0 0 12px 4px rgba(239, 68, 68, 0.6);
		}
	}

	/* Waveform visualization */
	.waveform {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 2px;
		height: 22px;
		flex: 1;
		max-width: 90px;
	}

	.bar {
		width: 3px;
		min-height: 3px;
		background: linear-gradient(
			to top,
			rgba(148, 163, 184, 0.5) 0%,
			rgba(226, 232, 240, 0.9) 100%
		);
		border-radius: 1.5px;
		transition: height 0.06s ease-out;
		will-change: height;
	}

	/* Timer display */
	.timer {
		font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.3px;
		color: rgba(226, 232, 240, 0.9);
		min-width: 32px;
		text-align: right;
		flex-shrink: 0;
	}

	.time {
		font-variant-numeric: tabular-nums;
	}

	.processing-text {
		animation: blink 1s ease-in-out infinite;
		color: rgba(148, 163, 184, 0.8);
	}

	@keyframes blink {
		0%, 100% { opacity: 1; }
		50% { opacity: 0.3; }
	}

	/* Debug overlay - HIGHLY VISIBLE */
	.debug {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		height: 18px;
		background: #ff0000;
		color: #fff;
		font-family: monospace;
		font-size: 9px;
		font-weight: bold;
		padding: 2px 4px;
		white-space: nowrap;
		overflow: hidden;
		z-index: 9999;
		display: flex;
		align-items: center;
	}

	/* Reduced motion support */
	@media (prefers-reduced-motion: reduce) {
		.recording-dot.active .dot-inner,
		.processing-text {
			animation: none;
		}
		.bar {
			transition: none;
		}
	}
</style>
