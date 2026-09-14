{
  description = "OpenCode — The open source AI coding agent";

  nixConfig = {
    extra-substituters = [ "https://nix-community.cachix.org" ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  inputs = {
    # nixpkgs: usrbinkat fork with bun 1.4.2 (matches packageManager field)
    # Switch to NixOS/nixpkgs/nixpkgs-unstable once bun >= 1.4.2 lands upstream
    nixpkgs.url = "github:usrbinkat/nixpkgs/gssproxy-package-and-module";

    bun2nix = {
      url = "github:usrbinkat/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      bun2nix,
      ...
    }:
    let
      lib = nixpkgs.lib;

      # x86_64-darwin removed: nixpkgs 26.05 dropped x86_64-darwin support.
      # Re-evaluate when nixpkgs input moves to a channel that restores it.
      supportedSystems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
      ];

      # Flake source metadata
      rev = self.shortRev or self.dirtyShortRev or "dirty";

      # Per-system bindings computed once, shared across all outputs
      forEachSystem =
        f:
        lib.genAttrs supportedSystems (
          system:
          f (
            import nixpkgs {
              inherit system;
              overlays = [ bun2nix.overlays.default ];
            }
          )
        );
    in

    # Per-system outputs
    {
      # nix build .#opencode
      # nix build .#opencode-desktop
      packages = forEachSystem (pkgs: rec {
        default = opencode;
        opencode = pkgs.callPackage ./nix/opencode.nix { inherit rev; };
        opencode-desktop = pkgs.callPackage ./nix/desktop.nix { inherit opencode; };
      });

      # nix develop
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.nodejs
            pkgs.pkg-config
            pkgs.openssl
            pkgs.git
            pkgs.bun2nix
          ];
        };
      });

      # nix flake check
      checks = forEachSystem (
        pkgs:
        let
          opencode = pkgs.callPackage ./nix/opencode.nix { inherit rev; };
        in
        {
          # Build succeeds and version string matches
          inherit opencode;

          # Runtime version check
          opencode-version =
            pkgs.runCommand "opencode-version-check"
              {
                nativeBuildInputs = [
                  opencode
                  pkgs.writableTmpDirAsHomeHook
                ];
                OPENCODE_DISABLE_MODELS_FETCH = true;
                meta.timeout = 30;
              }
              ''
                opencode2 --version > /dev/null && touch $out
              '';
        }
      );

      # nix fmt
      formatter = forEachSystem (pkgs: pkgs.nixfmt-tree);
    }

    # Cross-system outputs
    // {
      # Composable overlay for downstream consumers
      # Usage: overlays = [ opencode.overlays.default ];
      overlays.default = final: _prev: rec {
        opencode = final.callPackage ./nix/opencode.nix { inherit rev; };
        opencode-desktop = final.callPackage ./nix/desktop.nix { inherit opencode; };
      };

      # Home Manager module — user-level opencode installation
      # Usage: imports = [ opencode.homeManagerModules.default ];
      homeManagerModules.default =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.programs.opencode;
          systemPkgs = self.packages.${pkgs.stdenv.hostPlatform.system};
          jsonFormat = pkgs.formats.json { };
        in
        {
          options.programs.opencode = {
            enable = lib.mkEnableOption "OpenCode AI coding agent";

            package = lib.mkOption {
              type = lib.types.package;
              default = systemPkgs.opencode;
              defaultText = lib.literalExpression "opencode.packages.\${system}.opencode";
              description = "The opencode package to install.";
            };

            desktopPackage = lib.mkOption {
              type = lib.types.nullOr lib.types.package;
              default = null;
              defaultText = lib.literalExpression "null";
              description = ''
                The opencode-desktop Electron app package to install.
                Electron requires GPU driver access for hardware-accelerated
                rendering. The integration method depends on the system type.

                ## NixOS (all GPU vendors)

                No wrapping or driver config needed. hardware.graphics
                provides drivers via /run/opengl-driver. Set directly:

                    desktopPackage = opencode.packages.''${system}.opencode-desktop;

                ## Non-NixOS — recommended: targets.genericLinux.gpu

                Creates /run/opengl-driver on the host, matching NixOS
                behavior. Pure eval, no --impure. No per-app wrapping.
                Requires sudo once after first home-manager switch.

                Intel/AMD (zero GPU config):

                    targets.genericLinux.enable = true;
                    # targets.genericLinux.gpu auto-enables when nixGL is not set
                    programs.opencode.desktopPackage =
                      opencode.packages.''${system}.opencode-desktop;

                NVIDIA proprietary (pin host driver version):

                    targets.genericLinux.gpu.nvidia.enable = true;
                    targets.genericLinux.gpu.nvidia.version = "565.77";
                    targets.genericLinux.gpu.nvidia.sha256 = "sha256-...";
                    programs.opencode.desktopPackage =
                      opencode.packages.''${system}.opencode-desktop;

                Then run: sudo /nix/store/HASH-non-nixos-gpu/bin/non-nixos-gpu-setup
                (home-manager switch prints the exact path)

                Find your NVIDIA version: cat /proc/driver/nvidia/version
                Get the hash: nix store prefetch-file \
                  https://download.nvidia.com/XFree86/Linux-x86_64/VERSION/NVIDIA-Linux-x86_64-VERSION.run

                ## Non-NixOS — fallback: targets.genericLinux.nixGL

                No sudo required. Per-app wrapping via config.lib.nixGL.wrap.
                Requires nixGL flake input.

                Intel/AMD (pure eval):

                    targets.genericLinux.nixGL.packages = nixgl.packages;
                    targets.genericLinux.nixGL.defaultWrapper = "mesa";
                    programs.opencode.desktopPackage = config.lib.nixGL.wrap
                      opencode.packages.''${system}.opencode-desktop;

                NVIDIA (requires --impure or pinned nvidiaVersion in nixGL input):

                    targets.genericLinux.nixGL.packages = nixgl.packages;
                    targets.genericLinux.nixGL.defaultWrapper = "nvidia";
                    programs.opencode.desktopPackage = config.lib.nixGL.wrap
                      opencode.packages.''${system}.opencode-desktop;

                Hybrid Intel+NVIDIA: defaultWrapper = "nvidia"
                PRIME offload render:  defaultWrapper = "nvidiaPrime"

                config.lib.nixGL.wrap is a no-op when nixGL.packages is
                null, so the same expression works on NixOS (unwrapped)
                and non-NixOS (wrapped).

                ## macOS

                No wrapping needed. Metal is system-provided.
                Use darwinModules.default instead.
              '';
            };

            settings = lib.mkOption {
              type = jsonFormat.type;
              default = { };
              example = lib.literalExpression ''
                {
                  provider = "anthropic";
                  model = "claude-sonnet-4-20250514";
                  theme = "catppuccin";
                }
              '';
              description = ''
                OpenCode configuration. Written to
                `$XDG_CONFIG_HOME/opencode/config.json`.
              '';
            };
          };

          config = lib.mkIf cfg.enable {
            home.packages = [ cfg.package ] ++ lib.optional (cfg.desktopPackage != null) cfg.desktopPackage;

            xdg.configFile."opencode/config.json" = lib.mkIf (cfg.settings != { }) {
              source = jsonFormat.generate "opencode-config" cfg.settings;
            };
          };
        };

      # NixOS module — system-level opencode service (placeholder)
      # Usage: imports = [ opencode.nixosModules.default ];
      nixosModules.default =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.programs.opencode;
        in
        {
          options.programs.opencode = {
            enable = lib.mkEnableOption "OpenCode AI coding agent (system-wide)";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.opencode;
              defaultText = lib.literalExpression "opencode.packages.\${system}.opencode";
              description = "The opencode package to install system-wide.";
            };
          };

          config = lib.mkIf cfg.enable {
            environment.systemPackages = [ cfg.package ];
          };
        };

      # nix-darwin module
      # Usage: imports = [ opencode.darwinModules.default ];
      darwinModules.default =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.programs.opencode;
        in
        {
          options.programs.opencode = {
            enable = lib.mkEnableOption "OpenCode AI coding agent (darwin system-wide)";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.opencode;
              defaultText = lib.literalExpression "opencode.packages.\${system}.opencode";
              description = "The opencode package to install.";
            };

            desktopPackage = lib.mkOption {
              type = lib.types.nullOr lib.types.package;
              default = null;
              description = "The opencode-desktop .app bundle to install.";
            };
          };

          config = lib.mkIf cfg.enable {
            environment.systemPackages = [
              cfg.package
            ]
            ++ lib.optional (cfg.desktopPackage != null) cfg.desktopPackage;
          };
        };

      # nix flake init -t github:anomalyco/opencode
      templates = {
        default = {
          path = ./templates/default;
          description = "Project with OpenCode AI agent configured";
          welcomeText = ''
            # OpenCode Project

            Run `nix develop` or `direnv allow` to enter the development shell
            with OpenCode available.

            Start the agent: `opencode2`
          '';
        };
      };
    };
}
