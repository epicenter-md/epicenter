import { createContext } from 'svelte';
import type { HoneycrispApplication } from './application.js';

export const [getHoneycrispApp, setHoneycrispApp] =
	createContext<HoneycrispApplication>();
