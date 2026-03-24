
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
		RouteId(): "/" | "/api" | "/api/vault" | "/api/vault/counts" | "/api/vault/export" | "/api/vault/import" | "/api/vault/ingest" | "/dashboard" | "/entities" | "/entities/[id]" | "/import-export" | "/import-export/export" | "/notes" | "/notes/new" | "/notes/[id]" | "/reddit-upload";
		RouteParams(): {
			"/entities/[id]": { id: string };
			"/notes/[id]": { id: string }
		};
		LayoutParams(): {
			"/": { id?: string };
			"/api": Record<string, never>;
			"/api/vault": Record<string, never>;
			"/api/vault/counts": Record<string, never>;
			"/api/vault/export": Record<string, never>;
			"/api/vault/import": Record<string, never>;
			"/api/vault/ingest": Record<string, never>;
			"/dashboard": Record<string, never>;
			"/entities": { id?: string };
			"/entities/[id]": { id: string };
			"/import-export": Record<string, never>;
			"/import-export/export": Record<string, never>;
			"/notes": { id?: string };
			"/notes/new": Record<string, never>;
			"/notes/[id]": { id: string };
			"/reddit-upload": Record<string, never>
		};
		Pathname(): "/" | "/api/vault/counts" | "/api/vault/export" | "/api/vault/import" | "/api/vault/ingest" | "/dashboard" | "/entities" | `/entities/${string}` & {} | "/import-export" | "/import-export/export" | "/notes" | "/notes/new" | `/notes/${string}` & {} | "/reddit-upload";
		ResolvedPathname(): `${"" | `/${string}`}${ReturnType<AppTypes['Pathname']>}`;
		Asset(): "/robots.txt" | string & {};
	}
}