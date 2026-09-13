{
  lib,
  stdenv,
  stdenvNoCC,
  bun2nix,
  bun,
  nodejs,
  darwin,
  callPackage,
  makeWrapper,
  writableTmpDirAsHomeHook,
  autoPatchelfHook,
  copyDesktopItems,
  makeDesktopItem,
  opencode,
}:
let
  electron = callPackage ./electron.nix { };
in
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "opencode-desktop";
  inherit (opencode)
    version
    src
    bunDeps
    ;

  __structuredAttrs = true;
  strictDeps = true;

  nativeBuildInputs = [
    bun2nix.hook
    bun
    nodejs
    makeWrapper
    writableTmpDirAsHomeHook
  ]
  ++ lib.optionals stdenvNoCC.hostPlatform.isLinux [
    autoPatchelfHook
    copyDesktopItems
  ]
  ++ lib.optionals stdenvNoCC.hostPlatform.isDarwin [
    darwin.autoSignDarwinBinariesHook
  ];

  buildInputs = lib.optionals stdenvNoCC.hostPlatform.isLinux [
    (lib.getLib stdenv.cc.cc)
  ];

  autoPatchelfIgnoreMissingDeps = [ "libc.musl-*.so.*" ];

  desktopItems = lib.optional stdenvNoCC.hostPlatform.isLinux (makeDesktopItem {
    name = "ai.opencode.desktop";
    desktopName = "OpenCode";
    exec = "opencode-desktop %U";
    icon = "ai.opencode.desktop";
    startupWMClass = "OpenCode";
    categories = [ "Development" ];
  });

  bunInstallFlags = [
    "--frozen-lockfile"
    "--no-progress"
    "--linker=isolated"
    "--filter"
    "'!./'"
    "--filter"
    "'./packages/cli'"
    "--filter"
    "'./packages/desktop'"
    "--filter"
    "'./packages/app'"
  ];

  env = opencode.env // {
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  };

  postPatch =
    # Disable the auto-updater
    ''
      substituteInPlace packages/desktop/src/main/constants.ts \
        --replace-fail 'app.isPackaged && CHANNEL !== "dev"' 'false'
    ''
    # Relax Bun version check
    + ''
      substituteInPlace packages/script/src/index.ts \
        --replace-fail 'throw new Error(`This script requires bun@''${expectedBunVersionRange}' \
                       'console.warn(`Warning: This script requires bun@''${expectedBunVersionRange}'
    ''
    + lib.optionalString stdenvNoCC.hostPlatform.isLinux ''
      substituteInPlace \
        packages/desktop/src/main/windows/appearance.ts \
        packages/desktop/src/main/service/desktop-cli.ts \
        --replace-fail "process.resourcesPath" "'$out/opt/opencode-desktop/resources'"
    '';

  preBuild = lib.optionalString stdenvNoCC.hostPlatform.isDarwin ''
    for f in $(find node_modules -path "*/app-builder-lib/out/codeSign/macCodeSign.js" -type f 2>/dev/null); do
      substituteInPlace "$f" \
        --replace-fail "async function getValidIdentities" \
        "async function getValidIdentities() { return []; }; async function getValidIdentities_DISABLED"
    done
  '';

  # bun2nix hook installs node_modules from cache before buildPhase.
  buildPhase = ''
    runHook preBuild

    cp -r "${electron.dist}" $HOME/.electron-dist
    chmod -R u+w $HOME/.electron-dist

    # Build the opencode node bundle (needed by the desktop sidecar)
    cd packages/cli
    bun --bun ./script/build-node.ts --skip-install
    cd ../..

    # Prepare desktop app
    cd packages/desktop
    cp -R icons/prod resources/icons
    node_modules/.bin/electron-vite build
    node_modules/.bin/electron-builder --dir \
      --config=electron-builder.config.ts \
      --config.electronDist="$HOME/.electron-dist" \
      --config.electronVersion=${electron.version} \
      --config.asarUnpack='**/*.node' \
      ${lib.optionalString stdenvNoCC.hostPlatform.isDarwin "--config.mac.identity=null"}

    cd ../..

    runHook postBuild
  '';

  installPhase =
    let
      appDir = if stdenvNoCC.hostPlatform.isAarch64 then "linux-arm64-unpacked" else "linux-unpacked";
    in
    ''
      runHook preInstall
    ''
    + lib.optionalString stdenvNoCC.hostPlatform.isDarwin ''
      mkdir -p $out/Applications $out/bin
      mv packages/desktop/dist/mac*/OpenCode.app "$out/Applications/OpenCode.app"
      makeWrapper "$out/Applications/OpenCode.app/Contents/MacOS/OpenCode" $out/bin/opencode-desktop
    ''
    + lib.optionalString stdenvNoCC.hostPlatform.isLinux ''
      mkdir -p $out/opt/opencode-desktop
      appDir="packages/desktop/dist/${appDir}"
      [ -d "$appDir" ] || { echo "no electron-builder output dir found: $appDir"; exit 1; }
      cp -r "$appDir/resources" $out/opt/opencode-desktop/

      for size in 32 64 128; do
        install -Dm644 \
          packages/desktop/resources/icons/''${size}x''${size}.png \
          $out/share/icons/hicolor/''${size}x''${size}/apps/ai.opencode.desktop.png
      done

      install -Dm644 packages/desktop/resources/ai.opencode.desktop.metainfo.xml \
        "$out/share/metainfo/ai.opencode.desktop.metainfo.xml"

      makeWrapper ${lib.getExe electron} $out/bin/opencode-desktop \
       --inherit-argv0 \
       --set ELECTRON_FORCE_IS_PACKAGED 1 \
       --add-flags $out/opt/opencode-desktop/resources/app.asar \
       --add-flags "\''${NIXOS_OZONE_WL:+\''${WAYLAND_DISPLAY:+--ozone-platform-hint=auto --enable-features=WaylandWindowDecorations --enable-wayland-ime=true}}"
    ''
    + ''
      runHook postInstall
    '';

  meta = {
    description = "OpenCode Desktop App";
    mainProgram = "opencode-desktop";
    inherit (opencode.meta) homepage license platforms;
  };
})
