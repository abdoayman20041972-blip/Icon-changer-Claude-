import { File, Paths } from 'expo-file-system';
import { base64ToBytes, unusedImageUris, type EncodedImage, type SavedDesign } from './designStore';

// Everything the library keeps lives in Paths.document. Files in the cache directory
// (image-picker results, view-shot captures) can be deleted by Android at any time.

function extensionOf(uri: string, fallback: string): string {
  const match = /\.(png|jpe?g|webp)(\?.*)?$/i.exec(uri);
  return (match?.[1] ?? fallback).toLowerCase();
}

function uniqueName(ext: string, salt = ''): string {
  return `icon-${Date.now()}-${salt}${Math.random().toString(36).slice(2, 8)}.${ext}`;
}

function ensureFile(file: File) {
  try {
    if (!file.exists) file.create();
  } catch {
    // write() below reports the real error if the file really cannot be created
  }
}

export function isManagedImage(uri: string | null): boolean {
  return !!uri && uri.startsWith(Paths.document.uri);
}

/** Copies an image into the app's document directory (no-op when it is already there). */
export async function persistImage(uri: string, fallbackExt = 'png'): Promise<string> {
  if (isManagedImage(uri)) return uri;
  const destination = new File(Paths.document, uniqueName(extensionOf(uri, fallbackExt)));
  await new File(uri).copy(destination);
  return destination.uri;
}

export function imageExists(uri: string): boolean {
  try {
    return new File(uri).exists;
  } catch {
    return false;
  }
}

/** Designs whose image file disappeared (for example cleared cache) fall back to their symbol. */
export function healMissingImages(items: SavedDesign[]): SavedDesign[] {
  return items.map((item) => (item.imageUri && !imageExists(item.imageUri) ? { ...item, imageUri: null } : item));
}

/** Deletes image files that were referenced `before` the change and are no longer used `after` it. */
export function cleanupImages(before: SavedDesign[], after: SavedDesign[]) {
  for (const uri of unusedImageUris(before, after)) {
    if (!isManagedImage(uri)) continue;
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
    } catch {
      // a leftover file is harmless
    }
  }
}

export async function readImageBase64(uri: string): Promise<EncodedImage | null> {
  try {
    const file = new File(uri);
    if (!file.exists) return null;
    return { base64: await file.base64(), ext: extensionOf(uri, 'png') };
  } catch {
    return null;
  }
}

/** Writes a backed-up image into the document directory and returns its URI, or null on failure. */
export function writeImageBase64(image: EncodedImage, index: number): string | null {
  try {
    const file = new File(Paths.document, uniqueName(image.ext, `${index}-`));
    ensureFile(file);
    file.write(base64ToBytes(image.base64));
    return file.uri;
  } catch {
    return null;
  }
}

export function writeTextFile(file: File, content: string) {
  ensureFile(file);
  file.write(content);
}
