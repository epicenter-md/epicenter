import { Popover as PopoverPrimitive } from 'bits-ui';
import Content from './popover-content.svelte';
import Trigger from './popover-trigger.svelte';

const Root = PopoverPrimitive.Root;
const Close = PopoverPrimitive.Close;

export {
	Close,
	Close as PopoverClose,
	Content,
	Content as PopoverContent,
	Root,
	//
	Root as Popover,
	Trigger,
	Trigger as PopoverTrigger,
};
