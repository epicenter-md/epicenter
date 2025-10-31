import { defineMutation } from './_client';
import { mark } from '$lib/utils/timing';
import { settings } from '$lib/stores/settings.svelte';
import { IS_MACOS } from '$lib/constants/platform/is-macos';
import { tryAsync, Ok, Err } from 'wellcrafted/result';

type PausedPlayers = { players: string[] };

const pausedPlayersBySession = new Map<string, string[]>();

async function invoke<T>(command: string, args?: Record<string, unknown>) {
    // Prefer dynamic import to avoid bundling on web
    const { invoke } = await import('@tauri-apps/api/core');
    return tryAsync({
        try: async () => await invoke<T>(command, args),
        catch: (error) => Err({ name: 'TauriInvokeError', command, error } as const),
    });
}

export const media = {
    pauseIfEnabled: defineMutation({
        mutationKey: ['media', 'pauseIfEnabled'] as const,
        resultMutationFn: async ({ sessionId }: { sessionId: string }) => {
            const enabled = settings.value['sound.autoPauseMediaDuringRecording'];
            if (!enabled || !IS_MACOS || !window.__TAURI_INTERNALS__) return Ok(undefined);

            // Fire-and-forget pause; we still await inside this mutation so errors are logged,
            // but callers should not await this mutation if they want background behavior.
            console.info('[media] attempting to pause active media...');
            mark('media:pause:begin');
            console.time('[media] macos_pause_active_media invoke');
            const { data, error } = await invoke<PausedPlayers>('macos_pause_active_media');
            console.timeEnd('[media] macos_pause_active_media invoke');
            if (error) {
                console.warn('[media] pause failed', error);
                mark('media:pause:end', { error: true });
                return Ok(undefined);
            }
            const players = data.players ?? [];
            console.info('[media] paused players:', players);
            pausedPlayersBySession.set(sessionId, players);
            mark('media:pause:end', { players });
            return Ok(undefined);
        },
    }),

    resumePaused: defineMutation({
        mutationKey: ['media', 'resumePaused'] as const,
        resultMutationFn: async ({ sessionId }: { sessionId: string }) => {
            if (!IS_MACOS || !window.__TAURI_INTERNALS__) return Ok(undefined);
            const players = pausedPlayersBySession.get(sessionId) ?? [];
            if (players.length === 0) return Ok(undefined);

            pausedPlayersBySession.delete(sessionId);
            console.info('[media] resuming players:', players);
            mark('media:resume:begin', { players });
            console.time('[media] macos_resume_media invoke');
            const { error } = await invoke<void>('macos_resume_media', { players });
            console.timeEnd('[media] macos_resume_media invoke');
            if (error) {
                console.warn('[media] resume failed', error);
            }
            mark('media:resume:end');
            return Ok(undefined);
        },
    }),
};


