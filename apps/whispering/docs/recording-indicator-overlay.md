# Recording Indicator Overlay - Spécification Technique

## Vue d'ensemble

Créer un bandeau flottant minimaliste qui apparaît en haut au centre de l'écran Windows quand l'enregistrement est actif, visible même quand l'application principale est en arrière-plan.

## Comportement Utilisateur

### Scénario d'utilisation
1. L'utilisateur travaille dans une autre application (Bloc-notes, Word, VS Code...)
2. Il appuie sur sa touche de raccourci pour commencer l'enregistrement
3. Un petit bandeau apparaît en haut au centre de l'écran
4. Le bandeau montre une visualisation audio en temps réel (waveform)
5. Il appuie à nouveau sur la touche pour arrêter
6. Le bandeau disparaît

### États visuels
| État | Apparence |
|------|-----------|
| `IDLE` | Bandeau caché |
| `RECORDING` | Bandeau visible avec waveform animée |
| `LISTENING` (VAD) | Bandeau visible, couleur différente |
| `SPEECH_DETECTED` | Bandeau visible, animation plus intense |

## Design Visuel

### Dimensions
- **Largeur**: 200-280px (adaptatif selon contenu)
- **Hauteur**: 36-44px
- **Position**: Centré horizontalement, 16-24px du bord supérieur
- **Border-radius**: 20px (pilule)

### Couleurs (Dark Mode par défaut)
```css
/* Fond */
background: rgba(24, 24, 27, 0.95);  /* zinc-900 semi-transparent */
backdrop-filter: blur(12px);

/* Bordure subtile */
border: 1px solid rgba(63, 63, 70, 0.5);  /* zinc-700 */

/* Indicateur d'enregistrement */
--recording-dot: #ef4444;  /* red-500 */
--recording-glow: rgba(239, 68, 68, 0.4);

/* Waveform */
--waveform-color: #a1a1aa;  /* zinc-400 */
--waveform-active: #fafafa;  /* zinc-50 */
```

### Composition du bandeau
```
┌────────────────────────────────────────────┐
│  ●  ││││││││││││││││││  REC 0:05  │
│     └── waveform ──┘              │
└────────────────────────────────────────────┘
     ↑
  Point rouge
  pulsant
```

### Éléments
1. **Point d'enregistrement** (gauche)
   - Cercle rouge 8x8px
   - Animation pulse (opacité 0.5 → 1.0, 1s ease-in-out)
   - Glow subtil

2. **Waveform** (centre)
   - 15-20 barres verticales
   - Hauteur variable selon niveau audio
   - Animation fluide (60fps)
   - Espacement: 3px entre barres
   - Largeur barre: 3px
   - Border-radius: 2px

3. **Timer** (droite, optionnel)
   - Format: `0:00` ou `REC`
   - Police: monospace, 12px
   - Couleur: zinc-400

## Architecture Technique

### Nouvelle fenêtre Tauri
Créer un fichier similaire à `transformClipboardWindow.tauri.ts`:

```typescript
// apps/whispering/src/routes/recording-indicator/recordingIndicatorWindow.tauri.ts

const WINDOW_LABEL = 'recording-indicator';

export async function show(): Promise<void> {
  const existingWindow = await WebviewWindow.getByLabel(WINDOW_LABEL);

  if (existingWindow) {
    await existingWindow.show();
    return;
  }

  new WebviewWindow(WINDOW_LABEL, {
    url: '/recording-indicator',
    title: '',
    width: 260,
    height: 44,
    x: (screenWidth - 260) / 2,  // Centré
    y: 20,  // 20px du haut
    alwaysOnTop: true,
    decorations: false,  // Pas de barre de titre
    transparent: true,   // Fond transparent
    resizable: false,
    skipTaskbar: true,   // Pas dans la taskbar
    focus: false,        // Ne pas voler le focus
    visible: true,
  });
}

export async function hide(): Promise<void> {
  const existingWindow = await WebviewWindow.getByLabel(WINDOW_LABEL);
  if (existingWindow) {
    await existingWindow.hide();
  }
}
```

### Page Svelte
```
apps/whispering/src/routes/recording-indicator/+page.svelte
```

```svelte
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';

  let isRecording = $state(false);
  let audioLevel = $state(0);
  let elapsedSeconds = $state(0);
  let waveformBars = $state<number[]>(new Array(18).fill(0.1));

  // Écouter les événements de l'app principale
  let unlisten: UnlistenFn[] = [];

  onMount(async () => {
    unlisten.push(
      await listen('recording-state-change', (event) => {
        isRecording = event.payload.state === 'RECORDING';
      }),
      await listen('audio-level-update', (event) => {
        audioLevel = event.payload.level;
        updateWaveform(audioLevel);
      })
    );
  });

  onDestroy(() => {
    unlisten.forEach(fn => fn());
  });

  function updateWaveform(level: number) {
    waveformBars = waveformBars.map((_, i) => {
      const variance = Math.random() * 0.3;
      return Math.min(1, level + variance);
    });
  }
</script>

<div class="indicator">
  <div class="recording-dot"></div>
  <div class="waveform">
    {#each waveformBars as height}
      <div class="bar" style="height: {height * 100}%"></div>
    {/each}
  </div>
  <span class="timer">REC</span>
</div>
```

### Communication avec l'app principale

L'app principale doit émettre des événements Tauri :

```typescript
// Dans le service d'enregistrement
import { emit } from '@tauri-apps/api/event';

// Quand l'état change
await emit('recording-state-change', { state: 'RECORDING' });

// Pendant l'enregistrement (via AudioContext AnalyserNode)
const analyser = audioContext.createAnalyser();
// ...
requestAnimationFrame(function update() {
  const dataArray = new Uint8Array(analyser.fftSize);
  analyser.getByteFrequencyData(dataArray);
  const level = average(dataArray) / 255;
  emit('audio-level-update', { level });
  if (isRecording) requestAnimationFrame(update);
});
```

### Intégration avec le raccourci global

Dans `global-shortcut-manager.ts`, ajouter:

```typescript
import * as recordingIndicator from '$routes/recording-indicator/recordingIndicatorWindow.tauri';

// Dans la fonction de toggle recording
if (newState === 'RECORDING') {
  await recordingIndicator.show();
} else {
  await recordingIndicator.hide();
}
```

## Fichiers à créer/modifier

### Nouveaux fichiers
1. `apps/whispering/src/routes/recording-indicator/+page.svelte`
2. `apps/whispering/src/routes/recording-indicator/recordingIndicatorWindow.tauri.ts`

### Fichiers à modifier
1. `apps/whispering/src/lib/services/desktop/global-shortcut-manager.ts`
   - Importer et appeler show/hide sur l'indicateur
2. Service d'enregistrement (à identifier)
   - Ajouter AudioContext AnalyserNode pour les niveaux audio
   - Émettre événements `audio-level-update`

### Configuration Tauri
Vérifier que `tauri.conf.json` autorise les fenêtres transparentes:
```json
{
  "app": {
    "windows": [
      // ... existing windows
    ]
  }
}
```

## Animations CSS

```css
/* Pulse du point rouge */
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(0.9); }
}

.recording-dot {
  animation: pulse 1.5s ease-in-out infinite;
  box-shadow: 0 0 8px var(--recording-glow);
}

/* Barres waveform */
.bar {
  transition: height 50ms ease-out;
}
```

## Accessibilité

- Le bandeau ne doit pas être focusable (pas de tabindex)
- Pas d'interaction clavier requise (tout se fait via le raccourci global)
- Couleurs avec contraste suffisant
- Animation respectueuse (`prefers-reduced-motion`)

## Performance

- Fenêtre légère (~50KB)
- Mise à jour waveform: 20-30fps max (pas besoin de 60fps)
- Throttle sur les événements audio (max 30 émissions/seconde)
- `requestAnimationFrame` pour les animations

## Tests

1. Vérifier que le bandeau apparaît au bon endroit sur différentes résolutions
2. Tester avec plusieurs moniteurs
3. Vérifier que le bandeau reste visible avec toutes les applications
4. Tester la réactivité de la waveform
5. Vérifier l'absence de fuite mémoire sur des sessions longues

## Notes d'implémentation

### Ordre de priorité
1. Créer la fenêtre overlay basique (sans waveform)
2. Intégrer avec le raccourci global (show/hide)
3. Ajouter le timer
4. Implémenter la capture de niveau audio
5. Ajouter la visualisation waveform
6. Polish: animations, transitions

### Risques identifiés
- **Windows**: Les fenêtres transparentes peuvent nécessiter des flags spécifiques
- **Multi-écrans**: Calculer le centre sur l'écran actif
- **DPI Scaling**: Adapter les dimensions pour différents DPI
