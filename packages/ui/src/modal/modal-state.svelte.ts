/*
	Installed from @ieedan/shadcn-svelte-extras
*/

import { Context } from 'runed';
import { MediaQuery } from 'svelte/reactivity';

class ModalRootState {
	get view() {
		return this.#isDesktop.current ? 'desktop' : 'mobile';
	}

	#isDesktop = new MediaQuery('(min-width: 768px)');
}

class ModalSubState {
	get view() {
		return this.root.view;
	}

	constructor(private root: ModalRootState) {}
}

const ctx = new Context<ModalRootState>('modal-root-state');

export function useModal() {
	return ctx.set(new ModalRootState());
}

export function useModalSub() {
	return new ModalSubState(ctx.get());
}
