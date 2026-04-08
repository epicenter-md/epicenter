<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import {
		CommandPalette,
		type CommandPaletteItem,
	} from '@epicenter/ui/command-palette';
	import * as Resizable from '@epicenter/ui/resizable';
	import { ScrollArea } from '@epicenter/ui/scroll-area';
	import * as Tooltip from '@epicenter/ui/tooltip';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { skillsState } from '$lib/state/skills-state.svelte';
	import NewSkillDialog from './dialogs/NewSkillDialog.svelte';
	import SkillEditor from './editor/SkillEditor.svelte';
	import SkillsList from './SkillsList.svelte';
	import StorageBadge from './StorageBadge.svelte';

	let commandPaletteOpen = $state(false);

	const skillItems = $derived<CommandPaletteItem[]>(
		skillsState.skills.map((skill) => ({
			id: skill.id,
			label: skill.name,
			description: skill.description,
			group: 'Skills',
			onSelect: () => skillsState.selectSkill(skill.id),
		})),
	);
</script>

<Tooltip.Provider>
	<div class="flex h-screen flex-col">
		<Resizable.PaneGroup direction="horizontal" class="flex-1">
			<Resizable.Pane defaultSize={25} minSize={15} maxSize={50}>
				<div class="flex h-full flex-col">
					<!-- Sidebar Header -->
					<div class="flex items-center justify-between border-b px-3 py-2">
						<span
							class="text-xs font-medium uppercase tracking-wide text-muted-foreground"
						>
							Skills
						</span>
						<NewSkillDialog />
					</div>

					<!-- Search Trigger — opens command palette -->
					<div class="px-2 pt-2">
						<Button
							variant="outline"
							class="h-7 w-full justify-start gap-2 text-xs font-normal text-muted-foreground"
							onclick={() => (commandPaletteOpen = true)}
						>
							<SearchIcon class="size-3.5" />
							<span>Search skills…</span>
							<kbd
								class="pointer-events-none ml-auto inline-flex h-5 select-none items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground"
							>
								⌘K
							</kbd>
						</Button>
					</div>

					<ScrollArea class="flex-1">
						<div class="p-2"><SkillsList /></div>
					</ScrollArea>
					<StorageBadge />
				</div>
			</Resizable.Pane>
			<Resizable.Handle withHandle />
			<Resizable.Pane defaultSize={75}> <SkillEditor /> </Resizable.Pane>
		</Resizable.PaneGroup>
		<CommandPalette
			items={skillItems}
			bind:open={commandPaletteOpen}
			placeholder="Search skills…"
			emptyMessage="No skills found."
			title="Search Skills"
			description="Search for a skill by name or description"
		/>
	</div>
</Tooltip.Provider>
