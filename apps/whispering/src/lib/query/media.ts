import { defineMutation } from './_client';
import { settings } from '$lib/stores/settings.svelte';
import { IS_MACOS } from '$lib/constants/platform/is-macos';
import { tryAsync, Ok, Err } from 'wellcrafted/result';

type PausedPlayers = { players: string[] };

let pausedPlayers: string[] = [];

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
        resultMutationFn: async () => {
            const enabled = settings.value['system.autoPauseMediaDuringRecording'];
            if (!enabled || !IS_MACOS || !window.__TAURI_INTERNALS__) return Ok(undefined);

            const { data, error } = await invoke<PausedPlayers>('macos_pause_active_media');
            if (error) {
                console.warn('[media] pause failed', error);
                return Ok(undefined);
            }
            pausedPlayers = data.players ?? [];
            return Ok(undefined);
        },
    }),

    resumePaused: defineMutation({
        mutationKey: ['media', 'resumePaused'] as const,
        resultMutationFn: async () => {
            if (!IS_MACOS || !window.__TAURI_INTERNALS__) return Ok(undefined);
            if (pausedPlayers.length === 0) return Ok(undefined);

            const players = [...pausedPlayers];
            pausedPlayers = [];
            const { error } = await invoke<void>('macos_resume_media', { players });
            if (error) {
                console.warn('[media] resume failed', error);
            }
            return Ok(undefined);
        },
    }),
};


