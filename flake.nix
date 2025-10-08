{
  description = "Epicenter Whispering - Open source speech-to-text application";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
        };

        # Rust toolchain with specific targets for Tauri
        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [ "rust-src" "rust-analyzer" ];
          targets = [ "x86_64-unknown-linux-gnu" ];
        };

        # Native build inputs (build tools)
        nativeBuildInputs = with pkgs; [
          pkg-config
          gobject-introspection
          rustToolchain
          cargo-tauri
          bun
          nodejs_20
          python3
          gcc
          git
          clang
          llvmPackages.libclang.lib
        ];

        # Runtime dependencies following NixOS Wiki recommendations
        buildInputs = with pkgs; [
          # Tauri GTK dependencies from NixOS Wiki
          at-spi2-atk
          atkmm
          cairo
          gdk-pixbuf
          glib
          gtk3
          harfbuzz
          librsvg
          libsoup_3
          pango
          webkitgtk_4_1
          openssl
          # Audio dependencies for Whispering
          alsa-lib
          # Additional system dependencies
          dbus
          xorg.libX11
          xorg.libXext
          xorg.libXrandr
          xorg.libXi
          xorg.libxcb
          libxkbcommon
          libevdev
          xclip
          wl-clipboard
          cmake
          zlib
        ];

      in
      {
        devShells.default = pkgs.mkShell {
          inherit nativeBuildInputs buildInputs;

          # Set PKG_CONFIG_PATH for all the development packages
          PKG_CONFIG_PATH = with pkgs; lib.makeSearchPath "lib/pkgconfig" [
            glib.dev
            gtk3.dev
            cairo.dev
            gdk-pixbuf.dev
            pango.dev
            atk.dev
            harfbuzz.dev
            librsvg.dev
            at-spi2-atk.dev
            at-spi2-core.dev
            openssl.dev
            alsa-lib.dev
            webkitgtk_4_1.dev
            libsoup_3.dev
          ];

          shellHook = ''
            echo "🎙️  Epicenter Whispering Development Environment"
            echo "================================================"
            echo "Available commands:"
            echo "  bun install                          - Install dependencies"
            echo "  bun run dev                          - Run all apps in development mode"
            echo "  cd apps/whispering && bun run dev    - Run Whispering desktop app"
            echo "  cd apps/whispering && bun run dev:web - Run Whispering web version"
            echo ""
            echo "Or use nix apps directly:"
            echo "  nix run .#dev                        - Run Whispering desktop app"
            echo "  nix run .#web-dev                    - Run Whispering web version"
            echo ""
            echo "Rust version: $(rustc --version)"
            echo "Bun version: $(bun --version)"
            echo "Node version: $(node --version)"
            echo "PKG_CONFIG_PATH: $PKG_CONFIG_PATH"
            echo ""
          '';

          # Environment variables
          RUST_SRC_PATH = "${rustToolchain}/lib/rustlib/src/rust/library";
          RUST_BACKTRACE = "1";
          WEBKIT_DISABLE_COMPOSITING_MODE = "1";
          LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
          LIBRARY_PATH = "${pkgs.zlib}/lib";
        };

        # Package for building the application
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "whispering";
          version = "7.3.1";

          src = ./.;

          nativeBuildInputs = buildInputs;
          inherit buildInputs;

          configurePhase = ''
            export HOME=$TMPDIR
            bun install --frozen-lockfile
          '';

          buildPhase = ''
            cd apps/whispering
            bun tauri build
          '';

          installPhase = ''
            mkdir -p $out/bin
            
            # Install the binary
            if [ -f src-tauri/target/release/whispering ]; then
              cp src-tauri/target/release/whispering $out/bin/
            fi
            
            # Install desktop file if available
            if [ -f src-tauri/target/release/bundle/deb/*/data/usr/share/applications/*.desktop ]; then
              mkdir -p $out/share/applications
              cp src-tauri/target/release/bundle/deb/*/data/usr/share/applications/*.desktop $out/share/applications/
            fi
          '';

          meta = with pkgs.lib; {
            description = "Open source speech-to-text application";
            homepage = "https://github.com/epicenter-so/epicenter";
            license = licenses.mit;
            maintainers = [ ];
            platforms = platforms.linux;
          };
        };

        # Additional development tools
        packages.dev-tools = pkgs.buildEnv {
          name = "whispering-dev-tools";
          paths = with pkgs; [
            # Code quality tools
            biome
            # Database tools (for development)
            sqlite
            # Network debugging
            curl
            # Process monitoring
            htop
          ];
        };

        # Apps for quick access
        apps = {
          default = flake-utils.lib.mkApp {
            drv = self.packages.${system}.default;
            exePath = "/bin/whispering";
          };
          
          dev = flake-utils.lib.mkApp {
            drv = pkgs.writeShellApplication {
              name = "whispering-dev";
              runtimeInputs = nativeBuildInputs ++ buildInputs;
              text = ''
                # Set PKG_CONFIG_PATH for build environment
                export PKG_CONFIG_PATH="${pkgs.lib.makeSearchPath "lib/pkgconfig" (with pkgs; [
                  glib.dev
                  gtk3.dev
                  cairo.dev
                  gdk-pixbuf.dev
                  pango.dev
                  atk.dev
                  harfbuzz.dev
                  librsvg.dev
                  at-spi2-atk.dev
                  at-spi2-core.dev
                  openssl.dev
                  alsa-lib.dev
                  webkitgtk_4_1.dev
                  libsoup_3.dev
                ])}"
                
                # Set LIBCLANG_PATH for whisper-rs bindgen
                export LIBCLANG_PATH="${pkgs.llvmPackages.libclang.lib}/lib"
                
                # Set LIBRARY_PATH for zlib linking
                export LIBRARY_PATH="${pkgs.zlib}/lib"
                
                # Install dependencies if not already installed
                if [ ! -d node_modules ]; then
                  echo "Installing dependencies..."
                  bun install
                fi
                
                cd apps/whispering
                # Install whispering dependencies if needed
                if [ ! -d node_modules ]; then
                  echo "Installing whispering dependencies..."
                  bun install
                fi
                
                exec bun run dev
              '';
            };
          };
          
          web-dev = flake-utils.lib.mkApp {
            drv = pkgs.writeShellApplication {
              name = "whispering-web-dev";
              runtimeInputs = [ pkgs.bun ];
              text = ''
                # Install dependencies if not already installed
                if [ ! -d node_modules ]; then
                  echo "Installing dependencies..."
                  bun install
                fi
                
                cd apps/whispering
                # Install whispering dependencies if needed
                if [ ! -d node_modules ]; then
                  echo "Installing whispering dependencies..."
                  bun install
                fi
                
                exec bun run dev:web
              '';
            };
          };
        };
      });
}