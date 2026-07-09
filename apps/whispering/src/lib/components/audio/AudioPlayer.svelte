<script lang="ts">
    let audioElement: HTMLAudioElement | null = $state(null);
    let track: HTMLDivElement | null = $state(null);

    let {src, title = ''} = $props();

    let isPlaying = $state(false);
    let isPaused = $derived(!isPlaying);
    let isDragging = $state(false);
    let isMuted = $state(false);

    let volume = $state(1);
    let previousVolume = $state(1);
    let currentTime = $state(0);
    let duration = $state(0);

    function handleTimelineClick(e: MouseEvent) {
        const timeline = e.currentTarget as HTMLDivElement;
        const rect = timeline.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const percentage = clickX / rect.width;

        if (audioElement) audioElement.currentTime = percentage * duration;
    }

    function formatTime(seconds: number) {
        if (isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }

    function togglePlay() {
        if (isPlaying) {
            audioElement?.pause();
        } else {
            void audioElement?.play();
        }

        isPlaying = !isPlaying;
    }

    function toggleMute() {
        if (isMuted) {
            volume = previousVolume;
            isMuted = false;
        } else {
            previousVolume = volume;
            volume = 0;
            isMuted = true;
        }
    }

    const onVolumeSliderMove = (e: MouseEvent | TouchEvent) => {
        if (!track) return;

        const rect = track.getBoundingClientRect();
        const clientX =
            e instanceof MouseEvent ? e.clientX : e.touches[0]?.clientX || 0;

        volume = Math.max(
            0,
            Math.min(1, (clientX - rect.left) / rect.width)
        );
        isMuted = volume === 0;
    };

    $effect(() => {
        if (audioElement) {
            audioElement.volume = volume;
            audioElement.muted = isMuted;
        }

        if (!isDragging) return;
        window.addEventListener('mousemove', onVolumeSliderMove);
        window.addEventListener('mouseup', () => isDragging = false);

        return () => {
            window.removeEventListener('mousemove', onVolumeSliderMove);
            window.removeEventListener('mouseup', () => isDragging = false);
        };
    });

    let showVolume = $state(false);
</script>

<div class="flex-col justify-items-center gap-4">

    {#if title !== ''}
        <div class="text-sm font-medium text-slate-800 truncate max-w-60 text-center">{title}</div>
    {/if}

    <div class="flex justify-center items-center gap-4 p-2">
        <button
                onclick={togglePlay}
                class="flex items-center justify-center h-10 w-10 rounded-full bg-slate-900 hover:bg-slate-800 text-white transition-colors shrink-0"
                aria-label={isPlaying ? 'Пауза' : 'Воспроизвести'}
        >
            {#if isPlaying}
                <svg class="h-4 w-4 fill-current" viewBox="0 0 24 24">
                    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                </svg>
            {:else}
                <svg class="h-5 w-5 fill-current" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z"/>
                </svg>
            {/if}
        </button>

        <div class="text-xs font-mono text-slate-900 select-none min-w-22">
            {formatTime(currentTime)} / {formatTime(duration)}
        </div>

        <button
                type="button"
                onclick={handleTimelineClick}
                class={`relative h-1.5 overflow-hidden transition-all duration-200 ease-out ${showVolume || isDragging ? 'w-10' : 'w-30'} bg-slate-300 rounded-full cursor-pointer group`}
                aria-label="Timeline"
        >
            <div
                    class="absolute top-0 left-0 h-full bg-slate-900 rounded-full"
                    style:width={`${(currentTime / (duration || 1)) * 100}%`}
            ></div>
        </button>


        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
                class="flex flex-start items-center gap-2"
                onmouseenter={() => showVolume = true}
                onmouseleave={() => {
					if (!isDragging) showVolume = false;
				}}
        >
            <div
                    class={`transition-all duration-200 ease-out ${showVolume || isDragging ? 'w-20 opacity-100' : 'w-0 opacity-0'}`}
            >
                <div
                        bind:this={track}
                        onmousedown={(e) => {
						isDragging = true;
						onVolumeSliderMove(e);
					}}
                        class={`relative h-2 bg-gray-200 rounded-full cursor-pointer select-none`}
                        style:--p={`${volume * 100}%`}
                >
                    <div
                            class="absolute left-0 top-0 h-full bg-slate-800 rounded-full"
                            style:width="var(--p)"
                    ></div>

                    <div
                            class="absolute top-1/2 w-4 h-4 bg-slate-800 border-2 border-white rounded-full -translate-x-1/2 -translate-y-1/2"
                            style:left="var(--p)"
                    ></div>
                </div>
            </div>

            <button
                    onclick={toggleMute}
                    class={`shrink-0 text-slate-400 ${showVolume ? 'text-slate-700' : ''} transition-colors focus:outline-none`}
                    aria-label={isMuted ? 'Включить звук' : 'Выключить звук'}
            >
                {#if isMuted || volume === 0}
                    <svg class="h-5 w-5 fill-current" viewBox="0 0 24 24">
                        <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
                    </svg>
                {:else if volume < 0.5}
                    <svg class="h-5 w-5 fill-current" viewBox="0 0 24 24">
                        <path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/>
                    </svg>
                {:else}
                    <svg class="h-5 w-5 fill-current" viewBox="0 0 24 24">
                        <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
                    </svg>
                {/if}
            </button>


        </div>

    </div>

</div>

<audio
        src={src}
        bind:this={audioElement}
        bind:paused={isPaused}
        bind:currentTime
        bind:duration
        onended={() => {
			isPlaying = false;
			currentTime = 0;
		}}
></audio>