import { Select as SelectPrimitive } from 'bits-ui';
import Content from './select-content.svelte';
import Group from './select-group.svelte';
import GroupHeading from './select-group-heading.svelte';
import Item from './select-item.svelte';
import Label from './select-label.svelte';
import ScrollDownButton from './select-scroll-down-button.svelte';
import ScrollUpButton from './select-scroll-up-button.svelte';
import Separator from './select-separator.svelte';
import Trigger from './select-trigger.svelte';

const Root = SelectPrimitive.Root;

export {
	Content,
	Content as SelectContent,
	Group,
	Group as SelectGroup,
	GroupHeading,
	GroupHeading as SelectGroupHeading,
	Item,
	Item as SelectItem,
	Label,
	Label as SelectLabel,
	Root,
	//
	Root as Select,
	ScrollDownButton,
	ScrollDownButton as SelectScrollDownButton,
	ScrollUpButton,
	ScrollUpButton as SelectScrollUpButton,
	Separator,
	Separator as SelectSeparator,
	Trigger,
	Trigger as SelectTrigger,
};
