# Icon Changer — Expo Foundation

This directory contains the standalone Expo / React Native Android app. The Macaly workspace root remains the original TanStack web template; do not convert or replace it.

## Identity
- App name: Icon Changer
- Expo slug: `icon-changer`
- Scheme: `iconchanger`
- Android application ID: `com.abdoayman.iconchanger`
- App version: `0.2.0`
- Expo SDK: `57.0.0` (dependency range `~57.0.27`)
- React Native: `0.86.3`
- Package manager: npm
- EAS owner: `abdonawars-team`
- - EAS project ID: `11e433f7-faa3-467e-ae90-b69b1bfe9804`
## What the app does
- Arabic-first (with English) UI for creating icon designs; dark / light / system theme.
- Designs from: a photo, a ready-made pack, a shape from the Iconify library, or free symbol/letters, over a palette or custom HEX color.
- Local library: save, edit, duplicate, delete, search, and pin a shortcut straight from a card.
- Pinned shortcuts use a local Expo native module (`modules/icon-changer-native/`) that lists launchable apps (with their real icons), renders the design to an image and requests a pinned shortcut. The original app icon never changes; Android only allows a new shortcut.
- Experimental: switch Icon Changer's own launcher icon between four variants (`plugins/withIconVariants.js`).
- Backup: export/import a JSON file that embeds the images (merge or replace). Older array-only backups still import.
- Everything is stored on the device. The only network use is fetching shapes from Iconify (cached for offline use).

See `CHANGELOG.md` for the 0.2.0 fixes and additions.

## Platform and verification notes
- The native module, the Android manifest plugins and the launcher behaviour need an EAS/dev-client build to be verified; they do not work in Expo Go.
- Version 0.2.0 changed the native module (`getAppIcon`). Build a new binary before relying on app icons in the picker; JS-only updates keep working on older binaries (the picker falls back to letters).
- File APIs for images and backups (`File.base64()`, `File.write(Uint8Array)`) should be confirmed on a real device after the first build.
- Not tested on a physical Android device. No APK build is started without explicit approval.
- Assets under `assets/` and `plugins/withIconVariants/assets/` in this archive are generated placeholders; replace them with the real artwork if you have it.

## Validation
Run from this directory:
- `npm install` (generates `package-lock.json`)
- `npm test` (unit tests for `designStore.ts`)
- `npm run typecheck`
- `npx expo install --check`
- `npx expo-doctor`
- `npm run lint`

## Next steps
1. Build a preview APK and test on a device: app picker icons, pinning from the editor and from the library, backup export/import (merge and replace), hardware back button.
2. Split `App.tsx` into `screens/` and `hooks/` once the behaviour is verified on a device.
3. Consider cloud sync of the library and a privacy policy page before any store release.
