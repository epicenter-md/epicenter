import { createContext } from 'svelte';
import type { HoneycrispRuntime } from './runtime.js';

export const [getHoneycrispRuntime, setHoneycrispRuntime] =
	createContext<HoneycrispRuntime>();
