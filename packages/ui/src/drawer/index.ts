import { Drawer as DrawerPrimitive } from 'vaul-svelte';

import Root from './drawer.svelte';
import Close from './drawer-close.svelte';
import Content from './drawer-content.svelte';
import Description from './drawer-description.svelte';
import Footer from './drawer-footer.svelte';
import Header from './drawer-header.svelte';
import NestedRoot from './drawer-nested.svelte';
import Overlay from './drawer-overlay.svelte';
import Title from './drawer-title.svelte';
import Trigger from './drawer-trigger.svelte';

const Portal: typeof DrawerPrimitive.Portal = DrawerPrimitive.Portal;

export {
	Close,
	Close as DrawerClose,
	Content,
	Content as DrawerContent,
	Description,
	Description as DrawerDescription,
	Footer,
	Footer as DrawerFooter,
	Header,
	Header as DrawerHeader,
	NestedRoot,
	NestedRoot as DrawerNestedRoot,
	Overlay,
	Overlay as DrawerOverlay,
	Portal,
	Portal as DrawerPortal,
	Root,
	//
	Root as Drawer,
	Title,
	Title as DrawerTitle,
	Trigger,
	Trigger as DrawerTrigger,
};
