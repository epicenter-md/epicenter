import { type as osType } from '@tauri-apps/plugin-os';
import type { Os } from './contract';

// Tauri reads the real OS synchronously and it never changes during a session.
// Epicenter's desktop targets are macOS, Windows, and Linux, so Apple means
// macOS here.
const current = osType();

export const os: Os = {
	isApple: current === 'macos',
	isLinux: current === 'linux',
};
