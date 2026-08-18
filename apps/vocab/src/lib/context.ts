import { createContext } from 'svelte';
import type { VocabRuntime } from './runtime.js';

export const [getVocabRuntime, setVocabRuntime] = createContext<VocabRuntime>();
