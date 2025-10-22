<script lang="ts">
	// Minimal layout shell for Vault Demo
</script>

<header style="padding: 1rem; border-bottom: 1px solid #e5e7eb;">
	<nav style="display: flex; gap: 1rem;">
		<a href="/">Home</a>
		<a href="/import-export">Import/Export</a>
		<a href="/reddit-upload">Reddit Upload</a>
		<a href="/dashboard">Dashboard</a>
	</nav>
</header>

<main style="padding: 1rem;">
	<slot />
</main>
