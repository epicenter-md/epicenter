# Epicenter CLI

The unified command-line interface for the [epicenter.sh](https://epicenter.sh) ecosystem.

## Requirements

This CLI requires [Bun](https://bun.sh). Install it first:

```bash
curl -fsSL https://bun.sh/install | bash
```

## Usage

No installation needed! Just use `bunx`:

```bash
bunx @epicenter/cli sh
```

### Start OpenCode Server with Smart Defaults

The `sh` command provides intelligent opencode integration with automatic configuration:

```bash
# Simple usage with all smart defaults
bunx @epicenter/cli sh

# The CLI automatically:
# - Discovers an available port (starting from 4096)
# - Sets CORS origins to https://epicenter.sh
# - Opens epicenter.sh assistant in your browser when using a tunnel
```

### Tunnel Providers

The CLI supports multiple tunnel providers: cloudflare and ngrok. Cloudflare is used by default due to its , but you can explicitly specify which provider to use:

```bash
# Cloudflare tunnel (recommended for better protection)
bunx @epicenter/cli sh --tunnel=cloudflare

# ngrok tunnel (anonymous mode)
bunx @epicenter/cli sh --tunnel=ngrok

# Short form
bunx @epicenter/cli sh -t cloudflare
bunx @epicenter/cli sh -t ngrok
```

**Note**: ngrok free accounts are limited to one active tunnel at a time. If you encounter an error about tunnel limits, you'll need to kill any existing ngrok processes or upgrade your ngrok account.

### Customize Settings

You can override any of the smart defaults:

```bash
# Use a specific port
bunx @epicenter/cli sh --port 8080

# Disable tunnel
bunx @epicenter/cli sh --no-tunnel

# Add additional CORS origins
bunx @epicenter/cli sh --cors-origins https://epicenter.sh https://custom.domain.com

# Disable auto-opening browser
bunx @epicenter/cli sh --no-open
```

### Examples

```bash
# Auto port discovery, no tunnel
bunx @epicenter/cli sh

# Use ngrok tunnel instead of Cloudflare
bunx @epicenter/cli sh --tunnel=ngrok

# Custom port with tunnel disabled
bunx @epicenter/cli sh --port 3000 --no-tunnel

# Multiple CORS origins with ngrok
bunx @epicenter/cli sh --tunnel=ngrok --cors-origins https://epicenter.sh https://localhost:3000
```

## How It Works

The Epicenter CLI uses a custom fork of the [sst/opencode](https://github.com/sst/opencode) project, maintained at [`@epicenter/opencode`](https://github.com/epicenter-md/opencode). This fork adds essential CORS (Cross-Origin Resource Sharing) support, allowing epicenter.sh to communicate with your local OpenCode server from the browser without a middleman proxy server.

### Key Features

1. **Port Discovery**: Automatically finds an available port starting from 4096
2. **Smart Defaults**: Pre-configures tunnel, CORS, and browser opening for epicenter.sh
3. **Override Flexibility**: All defaults can be customized via command-line flags

## Technical Details

- **Port Range**: Searches for available ports from 4096-4196
- **Default CORS**: `https://epicenter.sh`
- **Tunnel Providers**: 
  - **Cloudflare** (default): Better protection, no authentication required
  - **ngrok**: Anonymous mode, limited to one tunnel per free account
- **Auto-open**: Opens epicenter.sh assistant automatically when tunnel is active

### Installing Tunnel Providers

**Cloudflare** (cloudflared):
```bash
# macOS
brew install cloudflared

# Linux (Debian/Ubuntu)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install cloudflared

# Windows
winget install --id=Cloudflare.cloudflared -e
```

**ngrok**:
```bash
# macOS
brew install ngrok

# Linux (Snap)
sudo snap install ngrok

# Windows
choco install ngrok

# Or download from https://ngrok.com/download
```

## Development

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev

# Build for production
bun run build

# Type checking
bun run typecheck
```

## Architecture

- **CLI Framework**: Built with `yargs` for robust command-line handling
- **Port Discovery**: Uses Node.js `net` module to test port availability
- **OpenCode Integration**: Imports and wraps functionality from `@epicenter/opencode`

## Related Projects

- [`@epicenter/opencode`](https://github.com/epicenter-md/opencode) - Our fork of OpenCode with CORS support for browser integration
- [`sst/opencode`](https://github.com/sst/opencode) - Original OpenCode project by SST team
