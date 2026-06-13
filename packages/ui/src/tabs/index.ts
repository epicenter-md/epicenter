import Root from './tabs.svelte';
import Content from './tabs-content.svelte';
import List, {
	type TabsListVariant,
	tabsListVariants,
} from './tabs-list.svelte';
import Trigger from './tabs-trigger.svelte';

export {
	Content,
	Content as TabsContent,
	List,
	List as TabsList,
	Root,
	//
	Root as Tabs,
	type TabsListVariant,
	Trigger,
	Trigger as TabsTrigger,
	tabsListVariants,
};
