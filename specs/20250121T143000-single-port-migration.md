# Single Port Migration

## Overview
Migrate from separate private/public port configuration to a single port configuration. This simplifies the setup by removing the Caddy proxy layer and using OpenCode's built-in CORS support directly. Additionally, remove username field and keep only password for authentication.

## Current Architecture
- **privatePort**: The port OpenCode runs on internally (e.g., 4096)
- **publicPort**: The port Caddy proxy exposes publicly (e.g., 8080)
- **username**: Basic auth username
- **password**: Basic auth password
- **Caddy**: Used as a proxy layer to add CORS headers and handle authentication

## New Architecture
- **port**: Single port for OpenCode server (default: 4096)
- **password**: Authentication password (username removed)
- **No Caddy proxy**: OpenCode now has built-in CORS support
- **ngrok**: Optional, for internet exposure without --basic-auth (authentication handled by OpenCode)

## Todo Items

### 1. Update workspace-configs.svelte.ts
- [ ] Update WorkspaceConfig type to use single `port` field
- [ ] Remove `username` field from WorkspaceConfig type
- [ ] Update generateRandomPort function to start from 4096
- [ ] Add port availability checking
- [ ] Update helper functions to use single port
- [ ] Update createWorkspaceConfig to not accept username

### 2. Update CreateWorkspaceConfigModal.svelte
- [ ] Replace privatePort/publicPort with single port field
- [ ] Remove username input field
- [ ] Keep password field only
- [ ] Update port generation to check availability starting from 4096
- [ ] Remove Caddy command section
- [ ] Update ngrok command to remove --basic-auth
- [ ] Add option for combined command with process kill
- [ ] Update auto-detect logic (keep optional Caddy for ngrok API only)
- [ ] Update explanatory text about the setup
- [ ] Update form validation to not require username

### 3. Update EditWorkspaceConfigButton.svelte
- [ ] Replace privatePort/publicPort inputs with single port input
- [ ] Remove username input field
- [ ] Keep password field only
- [ ] Remove validation for different ports
- [ ] Update labels and descriptions
- [ ] Update form validation to not require username

### 4. Update workspaces/+page.svelte
- [ ] Remove separate Git and Ports columns
- [ ] Add new unnamed column after folder name column
- [ ] In this column, display:
  - Git icon (GitBranch from @lucide/svelte) if Git is enabled
  - Port number in a badge (e.g., "4096" styled as a badge)
- [ ] Keep remaining columns: URL, Status, Last Used, Actions
- [ ] Update column visibility logic for the new column structure

### 5. Update client.gen.ts
- [ ] Update createWorkspaceClient to handle authentication without username
- [ ] Use password-only authentication or remove auth if not implemented

### 6. Check for other references
- [ ] Search for any other components using privatePort/publicPort
- [ ] Update any API calls or configurations that use username

### 7. Update documentation
- [ ] Update workspace-setup-guide.md to reflect single port
- [ ] Remove references to Caddy proxy for OpenCode
- [ ] Update command examples

## Technical Details

### Port Generation Logic
```typescript
// Start from 4096 and increment until finding available port
async function generateAvailablePort(): Promise<number> {
  let port = 4096;
  const maxPort = 65535;
  
  while (port <= maxPort) {
    if (await isPortAvailable(port)) {
      return port;
    }
    port++;
  }
  
  // Fallback to random if no ports available in range
  return Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152;
}
```

### Command Options
1. **Separate commands**:
   - `opencode serve -p 4096`
   - `ngrok http 4096`

2. **Combined command**:
   - `opencode serve -p 4096 & ngrok http 4096; kill $!`

### UI Design for Workspaces Table
The table will have the following columns:
1. **Folder Name** (no header): Shows the current working directory name
2. **[Unnamed]** (no header): Combined Git status and port info
   - Git icon if Git is enabled (using GitBranch from @lucide/svelte)
   - Port number in a badge (e.g., styled as a small badge showing "4096")
3. **URL**: The ngrok URL
4. **Status**: Connection status badge
5. **Last Used**: Time since last access
6. **Actions**: Connect, Edit, Delete buttons

### Migration Strategy
- Keep backward compatibility by checking if workspace has privatePort/publicPort
- On first load, migrate old configs to use port = privatePort
- Remove publicPort field from persisted data

## Review

### Completed Changes

1. **workspace-configs.svelte.ts**
   - Updated WorkspaceConfig type to use single `port` field
   - Removed `username` field
   - Added port availability checking with `isPortAvailable()`
   - Added `generateAvailablePort()` starting from 4096
   - Added migration logic for old configs with privatePort/publicPort

2. **CreateWorkspaceConfigModal.svelte**
   - Replaced privatePort/publicPort with single port field
   - Removed username input field
   - Updated port generation to check availability
   - Moved Caddy command to optional accordion
   - Updated ngrok command to remove --basic-auth
   - Added tabs for separate vs combined commands
   - Updated explanation text

3. **EditWorkspaceConfigButton.svelte**
   - Replaced two port inputs with single port input
   - Removed username field
   - Updated validation logic
   - Simplified form

4. **workspaces/+page.svelte**
   - Removed separate Git and Ports columns
   - Added combined gitPort column with no header
   - Displays Git icon (if enabled) and port badge
   - Removed Username column
   - Updated column visibility logic

5. **client.gen.ts**
   - Removed basic auth header generation
   - Added TODO comment for future authentication
   - Simplified client creation

6. **workspace-setup-guide.md**
   - Updated to reflect single port configuration
   - Added combined command option
   - Removed references to username/password auth
   - Updated migration instructions
   - Clarified Caddy is only for ngrok auto-detection

### Key Improvements
- Simpler configuration with single port
- Cleaner UI with combined Git/Port display
- Removed username requirement
- Better port availability checking
- More flexible command options
- Automatic migration for existing configs