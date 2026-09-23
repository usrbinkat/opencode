{
  lib,
  stdenvNoCC,
  bun2nix,
  bun,
  nodejs,
  sysctl,
  makeBinaryWrapper,
  models-dev,
  ripgrep,
  wayland,
  installShellFiles,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  rev ? "dirty",
}:
let
  packageJson = lib.pipe ../packages/cli/package.json [
    builtins.readFile
    builtins.fromJSON
  ];
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "opencode";
  version = "${packageJson.version}+${lib.replaceStrings [ "-" ] [ "." ] rev}";

  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.intersection (lib.fileset.fromSource (lib.sources.cleanSource ../.)) (
      lib.fileset.unions [
        ../packages
        ../services
        ../bun.lock
        ../package.json
        ../patches
        ../install
        ../.github/TEAM_MEMBERS
      ]
    );
  };

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./bun.nix;
  };

  nativeBuildInputs = [
    bun2nix.hook
    bun
    nodejs
    installShellFiles
    makeBinaryWrapper
    models-dev
    writableTmpDirAsHomeHook
  ];

  bunInstallFlags = [
    "--frozen-lockfile"
    "--no-progress"
  ];

  env.MODELS_DEV_API_JSON = "${models-dev}/dist/_api.json";
  env.OPENCODE_DISABLE_MODELS_FETCH = true;
  env.OPENCODE_VERSION = finalAttrs.version;
  env.OPENCODE_CHANNEL = "latest";
  env.NODE_OPTIONS = "--max-old-space-size=4096";

  # bun2nix hook auto-registers:
  #   bunSetInstallCacheDirPhase — copies bunDeps into BUN_INSTALL_CACHE_DIR
  #   bunPatchPhase — patchShebangs + writable HOME
  #   bunNodeModulesInstallPhase — bun install from cache (offline)
  #   bunLifecycleScriptsPhase — runs lifecycle scripts
  # No configurePhase override needed.

  buildPhase = ''
    runHook preBuild

    cd ./packages/cli
    bun --bun ./script/build.ts --single --skip-install

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 dist/cli-*/bin/opencode $out/bin/opencode

    # OpenTUI dlopens Wayland for clipboard images.
    wrapProgram $out/bin/opencode \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            ripgrep
          ]
          ++ lib.optional stdenvNoCC.hostPlatform.isDarwin sysctl
        )
      } ${lib.optionalString stdenvNoCC.hostPlatform.isLinux ''
        --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ wayland ]}
      ''}

    ln -s opencode $out/bin/opencode2

    runHook postInstall
  '';

  nativeInstallCheckInputs = [
    versionCheckHook
    writableTmpDirAsHomeHook
  ];
  doInstallCheck = true;
  versionCheckKeepEnvironment = [
    "HOME"
    "OPENCODE_DISABLE_MODELS_FETCH"
  ];
  versionCheckProgramArg = "--version";

  passthru = {
    inherit (finalAttrs) bunDeps;
    env = finalAttrs.env;
  };

  meta = {
    description = "The open source coding agent";
    homepage = "https://opencode.ai";
    license = lib.licenses.mit;
    mainProgram = "opencode";
    platforms = [
      "aarch64-linux"
      "x86_64-linux"
      "aarch64-darwin"
    ];
  };
})
