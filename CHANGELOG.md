# Changelog

## 0.2.0

### Fixes
- Images made from shapes/packs were saved in the cache directory, which Android can clear, so designs and shortcuts silently lost their image. They are now copied into the app's document directory (`files.ts`), and designs whose image file is missing fall back to their symbol on load.
- The Android hardware back button left the app from any screen; it now goes back (editor → previous screen, other screens → home, closes the pack sheet first).
- Pinning a shortcut or sharing from the editor ignored a selected shape (only the symbol was used). The shape is now rendered to an image first (`ensureDesignImage`), and saving while the shape is still loading no longer captures a spinner.
- Backups only held metadata, so restoring on another phone gave designs without images. Backup v2 embeds the images; old backups (a bare array) still import.
- Importing no longer replaces the library blindly: choose Merge (adds only new designs) or Replace. Malformed files are cleaned (invalid entries dropped) instead of crashing the UI.
- Deleting, replacing or clearing designs now deletes their orphaned image files.
- `plugins/withIconVariants.js`: removed the invalid `android="autoVerify"` attribute from the launcher intent-filter.
- Privacy text now says the app contacts Iconify to fetch shapes.
- Pack icons were fetched one request each; they now load with at most two bundled requests and work offline once cached. Single shapes also use the cached bundle API.
- RTL/LTR: back arrow and chevrons follow the language; accessibility labels (Back/Retry) are localized.
- Removed the unused `expo-clipboard` dependency (`expo-system-ui` stays: Android needs it for `userInterfaceStyle`).

### Features
- Real launcher icons of installed apps in the app picker (new native function `getAppIcon`; older native builds fall back to the first letter).
- Free symbol/letters field (up to 4 characters) and a custom HEX background color.
- Library: search (when more than 5 designs), duplicate a design, and pin a shortcut directly from a card.
- Theme: System / Light / Dark (follows the phone by default).

### Maintenance
- Version bumped to 0.2.0 because the native module changed (`expo-updates` runtime version follows `version`).
- New modules: `files.ts`, `usePackSvgs.ts`; `designStore.ts` gained validation, merge, duplicate, filter, backup v2 and a base64 decoder. 17 unit tests (`npm test`).
- Added `npm run typecheck`.
