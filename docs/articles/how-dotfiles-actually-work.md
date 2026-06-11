# How dotfiles actually work

There is no authority that manages `~/` namespace. Anyone can create `~/.anything/`. The conventions are:

- `~/.config/`: XDG Base Directory spec (freedesktop.org standard, widely adopted on Linux, optional on macOS)
- `~/.local/share/`: XDG for data
- `~/.cache/`: XDG for cache
- `~/Library/Application Support/`: Apple's official answer for macOS

But outside of those, every tool just squats on a name:

- `~/.docker/`
- `~/.cargo/`
- `~/.bun/`
- `~/.npm/`
- `~/.aws/`
- `~/.ssh/`
- `~/.gitconfig`
- `~/.zshrc`

There is no collision protection. If two apps both want `~/.epicenter/`, whoever writes first wins and the other one corrupts it or crashes.

## Has this ever been a problem in practice?

Rarely, because:

- Most tools pick distinctive names (`.cargo`, `.bun`, `.docker`)
- The name usually matches the tool exactly, so collisions are obvious
- It's mostly developer tools: regular users don't install things that create dotfiles

But it does happen. Some real examples:

- Multiple Node version managers fighting over `~/.node/` or `~/.nvm/`
- Different tools writing conflicting `~/.config/git/config`
- Python virtual envs and conda both trying to own `~/.local/`
