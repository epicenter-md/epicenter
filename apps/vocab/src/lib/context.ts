import { createContext } from 'svelte';
import type { VocabApplication } from './application.js';

export const [getVocabApp, setVocabApp] = createContext<VocabApplication>();
