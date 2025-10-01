<script>
  import { onMount } from 'svelte';
  
  let stars = $state(null);
  let show = $state(false);
  
  onMount(async () => {
    try {
      const response = await fetch('https://api.github.com/repos/epicenter-md/epicenter');
      const data = await response.json();
      
      // Format the star count
      const count = data.stargazers_count;
      if (count >= 1000) {
        stars = `${(count / 1000).toFixed(1)}k`;
      } else {
        stars = count.toString();
      }
      
      // Show with animation after data loads
      setTimeout(() => {
        show = true;
      }, 100);
    } catch (error) {
      console.error('Failed to fetch GitHub stars:', error);
      stars = '100+';
      show = true;
    }
  });
</script>

{#if show && stars}
  <!-- Small inline badge for the text link -->
  <span class="ml-2 inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-muted/60 text-muted-foreground rounded-full text-[10px] font-normal align-middle">
    <svg class="w-2.5 h-2.5 opacity-60" fill="currentColor" viewBox="0 0 20 20">
      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
    </svg>
    <span class="opacity-70">{stars}</span>
  </span>
{/if}

