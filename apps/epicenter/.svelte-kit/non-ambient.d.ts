
// this file is generated — do not edit it


declare module "svelte/elements" {
	export interface HTMLAttributes<T> {
		'data-sveltekit-keepfocus'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-noscroll'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-preload-code'?:
			| true
			| ''
			| 'eager'
			| 'viewport'
			| 'hover'
			| 'tap'
			| 'off'
			| undefined
			| null;
		'data-sveltekit-preload-data'?: true | '' | 'hover' | 'tap' | 'off' | undefined | null;
		'data-sveltekit-reload'?: true | '' | 'off' | undefined | null;
		'data-sveltekit-replacestate'?: true | '' | 'off' | undefined | null;
	}
}

export {};


declare module "$app/types" {
	export interface AppTypes {
		RouteId(): "/(workspace)" | "/(home)" | "/" | "/(workspace)/workspaces" | "/(workspace)/workspaces/static" | "/(workspace)/workspaces/static/[id]" | "/(workspace)/workspaces/[id]" | "/(workspace)/workspaces/[id]/settings" | "/(workspace)/workspaces/[id]/settings/[key]" | "/(workspace)/workspaces/[id]/tables" | "/(workspace)/workspaces/[id]/tables/[tableId]";
		RouteParams(): {
			"/(workspace)/workspaces/static/[id]": { id: string };
			"/(workspace)/workspaces/[id]": { id: string };
			"/(workspace)/workspaces/[id]/settings": { id: string };
			"/(workspace)/workspaces/[id]/settings/[key]": { id: string; key: string };
			"/(workspace)/workspaces/[id]/tables": { id: string };
			"/(workspace)/workspaces/[id]/tables/[tableId]": { id: string; tableId: string }
		};
		LayoutParams(): {
			"/(workspace)": { id?: string; key?: string; tableId?: string };
			"/(home)": Record<string, never>;
			"/": { id?: string; key?: string; tableId?: string };
			"/(workspace)/workspaces": { id?: string; key?: string; tableId?: string };
			"/(workspace)/workspaces/static": { id?: string };
			"/(workspace)/workspaces/static/[id]": { id: string };
			"/(workspace)/workspaces/[id]": { id: string; key?: string; tableId?: string };
			"/(workspace)/workspaces/[id]/settings": { id: string; key?: string };
			"/(workspace)/workspaces/[id]/settings/[key]": { id: string; key: string };
			"/(workspace)/workspaces/[id]/tables": { id: string; tableId?: string };
			"/(workspace)/workspaces/[id]/tables/[tableId]": { id: string; tableId: string }
		};
		Pathname(): "/" | `/workspaces/static/${string}` & {} | `/workspaces/${string}` & {} | `/workspaces/${string}/settings/${string}` & {} | `/workspaces/${string}/tables/${string}` & {};
		ResolvedPathname(): `${"" | `/${string}`}${ReturnType<AppTypes['Pathname']>}`;
		Asset(): string & {};
	}
}