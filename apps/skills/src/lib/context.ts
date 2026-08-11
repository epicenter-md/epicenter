import { createContext } from 'svelte';
import type { SkillsRuntime } from './application.js';

export const [getSkills, setSkills] = createContext<SkillsRuntime>();
