import { createContext } from 'svelte';
import type { TabManagerApplication } from './application.js';

export const [getTabManagerApp, setTabManagerApp] =
	createContext<TabManagerApplication>();
