{
  description = "OpenCode packages, development environment, and Home Manager integration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    ghostty = {
      url = "github:ghostty-org/ghostty/ab0b9da9e88fcb4b0533a1854e84628f663930af";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      ghostty,
      ...
    }:
    let
      systems = [
        "aarch64-linux"
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forEachSystem = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      rev = self.shortRev or self.dirtyShortRev or "dirty";
      developmentPackages =
        pkgs: with pkgs; [
          bun
          nodejs
          pkg-config
          openssl
          git
          ripgrep
          rustc
          cargo
          clippy
          rustfmt
          zig_0_16
        ];
    in
    {
      devShells = forEachSystem (pkgs: {
        default = pkgs.mkShell {
          packages = developmentPackages pkgs;
        };
      });

      overlays = {
        default =
          final: _prev:
          let
            node_modules = final.callPackage ./nix/node_modules.nix {
              inherit rev;
            };
          in
          rec {
            opencode-pty = final.callPackage ./nix/process-daemon.nix { inherit ghostty; };
            opencode = final.callPackage ./nix/opencode.nix {
              inherit node_modules opencode-pty;
            };
            opencode-desktop = final.callPackage ./nix/desktop.nix {
              inherit opencode;
            };
          };
      };

      packages = forEachSystem (
        pkgs:
        let
          node_modules = pkgs.callPackage ./nix/node_modules.nix {
            inherit rev;
          };
        in
        rec {
          default = opencode;
          opencode-pty = pkgs.callPackage ./nix/process-daemon.nix { inherit ghostty; };
          opencode = pkgs.callPackage ./nix/opencode.nix {
            inherit node_modules opencode-pty;
          };
          opencode-desktop = pkgs.callPackage ./nix/desktop.nix {
            inherit opencode;
          };
          ci = pkgs.symlinkJoin {
            name = "opencode-ci";
            paths = developmentPackages pkgs;
          };
          # Updater derivation with fakeHash - build fails and reveals correct hash
          node_modules_updater = node_modules.override {
            hash = pkgs.lib.fakeHash;
          };
        }
      );

      apps = forEachSystem (
        pkgs:
        let
          package = self.packages.${pkgs.stdenv.hostPlatform.system}.opencode;
          app = {
            type = "app";
            program = nixpkgs.lib.getExe package;
            meta.description = "OpenCode AI coding agent";
          };
        in
        {
          default = app;
          opencode = app;
        }
      );

      checks = forEachSystem (pkgs: {
        inherit (self.packages.${pkgs.stdenv.hostPlatform.system}) opencode opencode-pty;
      });

      formatter = forEachSystem (pkgs: pkgs.nixfmt-tree);

      # Extend Home Manager's maintained programs.opencode module rather than
      # redeclaring its options. Settings and activation retain its semantics.
      homeManagerModules = {
        default = self.homeManagerModules.opencode;
        opencode = { lib, pkgs, ... }: {
          programs.opencode.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.opencode;
        };
      };
    };
}
