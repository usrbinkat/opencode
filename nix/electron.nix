# Electron binary for the desktop app.
#
# Purpose-built instead of callPackage generic.nix because generic.nix
# assumes Electron bundles libEGL.so/libGLESv2.so (lib*GL*). Electron ≥44
# loads ANGLE through the system libGL via dlopen and no longer ships those
# files. The unguarded glob in generic.nix's postFixup passes patchelf
# flags with no filename, which fails the build.
#
# This derivation provides the four things desktop.nix consumes:
#   - version         (string, from packages/desktop/package.json)
#   - passthru.headers (fetchzip of node headers for @electron/rebuild)
#   - passthru.dist    (unpacked Electron for electron-builder --electronDist)
#   - lib.getExe       (patched binary with rpaths for the Linux runtime wrapper)
{
  lib,
  stdenv,
  fetchurl,
  fetchzip,
  makeWrapper,
  wrapGAppsHook3,
  unzip,
  glib,
  gtk3,
  gtk4,
  at-spi2-atk,
  libdrm,
  libgbm,
  libxkbcommon,
  libxshmfence,
  libGL,
  vulkan-loader,
  alsa-lib,
  cairo,
  cups,
  dbus,
  expat,
  gdk-pixbuf,
  nss,
  nspr,
  libxrandr,
  libxfixes,
  libxext,
  libxdamage,
  libxcomposite,
  libx11,
  libxkbfile,
  libxcb,
  pango,
  systemd,
  pciutils,
  libnotify,
  pipewire,
  libsecret,
  libpulseaudio,
  speechd-minimal,
}:
let
  version =
    (builtins.fromJSON (builtins.readFile ../packages/desktop/package.json)).devDependencies.electron;

  hashes = {
    # Electron 44.4.3 SHASUMS256.txt from github.com/electron/electron/releases/download/v44.4.3/
    aarch64-linux = "61f084a5ac0f1835efc12b9db17042d92c8c617b03578f96a888acd4a05a0b10";
    x86_64-linux = "fe880a7e37160cfd4e00193bc4c713ead7a778abfe74860a2d36d86fd0be48a8";
    aarch64-darwin = "6b728f5dcfae74f3f936f2bca5b3cd9b9659ffea464f67939f004acb55425a85";
    x86_64-darwin = "015b52631d92187b552ff4e047255f596a7af4707e388a5890951f0b2645764e";
    headers = "sha256-QPkX+99kArlQhhbgOZe+Hsk28G5cadkUy0G0cIDtEh8=";
  };

  tags = {
    x86_64-linux = "linux-x64";
    aarch64-linux = "linux-arm64";
    aarch64-darwin = "darwin-arm64";
  };

  src = fetchurl {
    url = "https://github.com/electron/electron/releases/download/v${version}/electron-v${version}-${
      tags.${stdenv.hostPlatform.system}
    }.zip";
    sha256 = hashes.${stdenv.hostPlatform.system};
  };

  headers = fetchzip {
    name = "electron-${version}-headers";
    url = "https://artifacts.electronjs.org/headers/dist/v${version}/node-v${version}-headers.tar.gz";
    sha256 = hashes.headers;
  };

  electronLibPath = lib.makeLibraryPath [
    alsa-lib
    at-spi2-atk
    cairo
    cups
    dbus
    expat
    gdk-pixbuf
    glib
    gtk3
    gtk4
    nss
    nspr
    libx11
    libxcb
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxrandr
    libxkbfile
    pango
    pciutils
    stdenv.cc.cc
    systemd
    libnotify
    pipewire
    libsecret
    libpulseaudio
    speechd-minimal
    libdrm
    libgbm
    libxkbcommon
    libxshmfence
    libGL
    vulkan-loader
  ];
in
stdenv.mkDerivation (
  finalAttrs:
  if stdenv.hostPlatform.isDarwin then
    {
      pname = "electron";
      inherit version src;

      nativeBuildInputs = [
        makeWrapper
        unzip
      ];

      buildCommand = ''
        mkdir -p $out/Applications
        unzip $src
        mv Electron.app $out/Applications
        mkdir -p $out/bin
        makeWrapper $out/Applications/Electron.app/Contents/MacOS/Electron $out/bin/electron
      '';

      passthru = {
        inherit headers;
        dist = finalAttrs.finalPackage + "/Applications";
      };

      meta = {
        mainProgram = "electron";
        platforms = [ "aarch64-darwin" ];
      };
    }
  else
    {
      pname = "electron";
      inherit version src;

      __structuredAttrs = true;
      strictDeps = true;

      nativeBuildInputs = [
        unzip
        makeWrapper
        wrapGAppsHook3
      ];
      buildInputs = [
        glib
        gtk3
        gtk4
      ];

      dontUnpack = true;
      dontBuild = true;

      installPhase = ''
        mkdir -p $out/libexec/electron
        unzip -d $out/libexec/electron $src
        chmod u-x $out/libexec/electron/*.so*
      '';

      dontWrapGApps = true;

      preFixup = ''
        makeWrapper "$out/libexec/electron/electron" $out/bin/electron \
          "''${gappsWrapperArgs[@]}"
      '';

      # Skip the automatic patchelf --shrink-rpath pass; the explicit calls below
      # handle every binary that needs rpaths.
      dontPatchELF = true;

      postFixup = ''
        patchelf \
          --set-interpreter "$(cat $NIX_CC/nix-support/dynamic-linker)" \
          --set-rpath "${electronLibPath}:$out/libexec/electron" \
          $out/libexec/electron/electron \
          $out/libexec/electron/chrome_crashpad_handler

        # Replace the bundled vulkan stub with the system vulkan-loader so the app
        # uses the host GPU driver's Vulkan ICD.
        rm "$out/libexec/electron/libvulkan.so.1"
        ln -s -t "$out/libexec/electron" "${lib.getLib vulkan-loader}/lib/libvulkan.so.1"
      '';

      passthru = {
        inherit headers;
        dist = finalAttrs.finalPackage + "/libexec/electron";
      };

      meta = {
        mainProgram = "electron";
        platforms = [
          "x86_64-linux"
          "aarch64-linux"
        ];
      };
    }
)
