// Proof fixture for the trusted app catalog (ADR-0153). It drives Tauri's
// HTTP plugin over raw IPC, mirroring the first two calls the published
// @tauri-apps/plugin-http `fetch` makes, so the static output needs no build
// step. A response status here proves the app-* window passed the ACL that
// previously failed with "Command plugin:http|fetch not allowed by ACL".
const statusLine = document.getElementById('status');

async function sendNativeRequest() {
	const invoke = globalThis.__TAURI_INTERNALS__?.invoke;
	if (!invoke) {
		statusLine.textContent =
			'No Tauri IPC on this page; open this app through Epicenter.';
		return;
	}
	statusLine.textContent = 'Sending a native request to https://example.com/ …';
	try {
		const rid = await invoke('plugin:http|fetch', {
			clientConfig: {
				method: 'GET',
				url: 'https://example.com/',
				headers: [],
				data: null,
			},
		});
		const response = await invoke('plugin:http|fetch_send', { rid });
		statusLine.textContent = `Native HTTP ${response.status} ${response.statusText} from ${response.url}`;
	} catch (error) {
		statusLine.textContent = `Native HTTP request failed: ${error}`;
	}
}

document.getElementById('retry').addEventListener('click', sendNativeRequest);
sendNativeRequest();
