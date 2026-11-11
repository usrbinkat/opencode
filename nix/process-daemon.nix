{
  lib,
  rustPlatform,
  stdenv,
  callPackage,
  formats,
  ghostty,
  bash,
  coreutils,
  perl,
}:
let
  revision = lib.trim (builtins.readFile ../packages/process-daemon/ghostty-revision);
  manifest = builtins.fromTOML (builtins.readFile ../packages/process-daemon/Cargo.toml);
  native = callPackage "${ghostty}/nix/libghostty-vt.nix" {
    inherit revision;
    optimize = "ReleaseFast";
  };
  cargoConfig = (formats.toml { }).generate "opencode-pty-cargo-config.toml" {
    target.${stdenv.hostPlatform.rust.rustcTarget}.ghostty-vt = {
      rustc-link-lib = [ "static=ghostty-vt" ];
      rustc-link-search = [ "native=${native.dev}/lib" ];
    };
  };
in
assert lib.assertMsg (
  ghostty.rev == revision
) "Ghostty input must match process-daemon/ghostty-revision";
rustPlatform.buildRustPackage {
  pname = "opencode-pty";
  inherit (manifest.package) version;
  src = lib.fileset.toSource {
    root = ../packages/process-daemon;
    fileset = lib.fileset.unions [
      ../packages/process-daemon/Cargo.toml
      ../packages/process-daemon/Cargo.lock
      ../packages/process-daemon/build.rs
      ../packages/process-daemon/ghostty-revision
      ../packages/process-daemon/src
      ../packages/process-daemon/tests
    ];
  };
  cargoLock.lockFile = ../packages/process-daemon/Cargo.lock;
  nativeCheckInputs = [ perl ];

  # Fixtures spawn absolute Unix paths, which do not exist in the build sandbox.
  postPatch = ''
    substituteInPlace src/daemon/server.rs src/service.rs \
      tests/rows.rs tests/playground.rs tests/ownership.rs tests/pipe.rs tests/service.rs \
      --replace-fail /bin/sh ${lib.getExe' bash "sh"}
    substituteInPlace src/daemon/sweep.rs \
      --replace-fail /usr/bin/true ${lib.getExe' coreutils "true"}
    substituteInPlace tests/playground.rs \
      --replace-fail /bin/cat ${lib.getExe' coreutils "cat"}
    substituteInPlace tests/pipe.rs \
      --replace-fail /usr/bin/env ${lib.getExe' coreutils "env"}
    substituteInPlace src/daemon/server.rs tests/ownership.rs \
      --replace-fail 'sleep ' '${lib.getExe' coreutils "sleep"} ' \
      --replace-fail 'exec cat' 'exec ${lib.getExe' coreutils "cat"}'
  '';

  # Cargo's links override uses the pinned Nix-built static library instead of
  # invoking build.rs, which downloads Ghostty and Zig dependencies itself.
  preConfigure = ''
    grep -Fx '// Ghostty revision: ${revision}' src/ghostty/ffi.rs
    mkdir -p .cargo
    cat ${cargoConfig} >> .cargo/config.toml
  '';

  passthru = { inherit native; };
  meta = {
    description = "Persistent PTY service for OpenCode";
    license = lib.licenses.mit;
    mainProgram = "opencode-pty";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
  };
}
