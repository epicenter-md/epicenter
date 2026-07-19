import { createContext } from 'svelte';
import type { SkillsApplication } from './application.js';

export const [getSkillsApp, setSkillsApp] = createContext<SkillsApplication>();
