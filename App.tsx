import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SvgXml } from 'react-native-svg';
import ViewShot, { captureRef, type ViewShotRef } from 'react-native-view-shot';
import {
  buildBackup, buildShareRequest, duplicateDesign, filterDesigns, mergeDesigns, normalizeHex, parseBackup,
  removeDesign, restoreDesigns, serializeDesigns, upsertDesign, type EncodedImage,
} from './designStore';
import { cleanupImages, healMissingImages, persistImage, readImageBase64, writeImageBase64, writeTextFile } from './files';
import { usePackSvgs } from './usePackSvgs';
import { SHAPE_CATEGORIES, ICON_PACKS, contrastColor, fetchShapeBundleCached, searchShapesCached, shapeKey, type IconShape } from './iconApi';
import { STRINGS, type Lang } from './i18n';
import { requireOptionalNativeModule } from 'expo-modules-core';
import * as DocumentPicker from 'expo-document-picker';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, BackHandler, Image, Modal, Pressable, ScrollView, StyleSheet,
  Text, TextInput, useColorScheme, View,
} from 'react-native';

type InstalledApp = { packageName: string; label: string };
type SavedIcon = {
  id: string; title: string; symbol: string; imageUri: string | null;
  background: string; targetPackage: string | null; targetLabel: string | null; updatedAt: number;
};
type Pack = { label: string; color: string; shape: IconShape };
type NativeBridge = {
  getLaunchableApps(): Promise<InstalledApp[]>;
  // Added in 0.2.0; older native builds do not have it, so it is optional.
  getAppIcon?(packageName: string): Promise<string | null>;
  isShortcutSupported(): Promise<boolean>;
  getLauncherIcon(): Promise<string | null>;
  setLauncherIcon(variant: string): Promise<boolean>;
  pinAppShortcut(input: {
    id: string; label: string; targetPackage: string; iconUri?: string | null;
    symbol: string; backgroundColor: string;
  }): Promise<boolean>;
  renderIconToFile(input: { iconUri?: string | null; symbol: string; backgroundColor: string }): Promise<string>;
};
type Screen = 'home' | 'editor' | 'library' | 'settings';
type ThemeMode = 'system' | 'light' | 'dark';

const native = requireOptionalNativeModule<NativeBridge>('IconChangerNative');
const STORAGE_KEY = 'icon-changer.saved-icons.v1';
const DARK_MODE_KEY = 'icon-changer.dark-mode.v1';
const DEFAULT_COLOR_KEY = 'icon-changer.default-color.v1';
const LANG_KEY = 'icon-changer.lang.v1';
const COLORS = ['#F4C542', '#E8B832', '#FFE27A', '#F8EBC5', '#A8B89A', '#E8A06A', '#D6C6A5', '#31352D'];
const ICON_VARIANTS = [
  { id: 'gold', color: '#F4C542' },
  { id: 'navy', color: '#1F2A44' },
  { id: 'cream', color: '#FBF8F0' },
  { id: 'coral', color: '#E8A06A' },
];

function IconGlyph({ size, bg, glyph, photo, shape, retryLabel, onShapeReady }: {
  size: number; bg: string; glyph: string; photo: string | null; shape: IconShape | null;
  retryLabel?: string; onShapeReady?: (ready: boolean) => void;
}) {
  return (
    <View style={[styles.iconPreview, { width: size, height: size, borderRadius: size * 0.27, backgroundColor: bg }]}>
      {photo ? <Image source={{ uri: photo }} style={styles.previewImage} resizeMode="cover" />
        : shape ? <ShapeIcon shape={shape} color={contrastColor(bg)} size={size * 0.52} retryLabel={retryLabel} onReady={onShapeReady} />
        : <Text style={[styles.previewSymbol, { fontSize: size * 0.49 }]}>{glyph}</Text>}
    </View>
  );
}

// Loads one shape through the cached bundle API (one request, works offline once seen).
function ShapeIcon({ shape, color, size, testID, retryLabel = 'Retry', onReady }: {
  shape: IconShape; color: string; size: number; testID?: string; retryLabel?: string; onReady?: (ready: boolean) => void;
}) {
  const { prefix, name } = shape;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let active = true;
    setSvg(null);
    setFailed(false);
    onReady?.(false);
    fetchShapeBundleCached([{ prefix, name }], color)
      .then(({ bundle }) => {
        if (!active) return;
        const found = bundle[shapeKey({ prefix, name })];
        if (found) {
          setSvg(found);
          onReady?.(true);
        } else {
          setFailed(true);
        }
      })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [prefix, name, color, nonce, onReady]);
  if (failed) {
    return (
      <Pressable onPress={() => setNonce((n) => n + 1)} accessibilityRole="button" accessibilityLabel={retryLabel} testID={testID}>
        <Ionicons name="refresh" size={size * 0.6} color="#B0836A" />
      </Pressable>
    );
  }
  if (!svg) return <ActivityIndicator size="small" color="#C8B68A" />;
  return <SvgXml xml={svg} width={size} height={size} testID={testID} />;
}

function PackGlyph({ svg }: { svg?: string }) {
  return svg ? <SvgXml xml={svg} width={20} height={20} /> : <ActivityIndicator size="small" color="#C8B68A" />;
}

// Real launcher icon of an installed app (needs the 0.2.0 native module; falls back to `fallback`).
const appIconCache = new Map<string, string | null>();

function AppIcon({ packageName, size, fallback }: { packageName: string; size: number; fallback: React.ReactNode }) {
  const [base64, setBase64] = useState<string | null>(appIconCache.get(packageName) ?? null);
  useEffect(() => {
    if (appIconCache.has(packageName)) {
      setBase64(appIconCache.get(packageName) ?? null);
      return;
    }
    const bridge = native;
    if (!bridge?.getAppIcon) return;
    let active = true;
    bridge.getAppIcon(packageName)
      .then((value) => {
        appIconCache.set(packageName, value);
        if (active) setBase64(value);
      })
      .catch(() => { appIconCache.set(packageName, null); });
    return () => { active = false; };
  }, [packageName]);
  if (!base64) return <>{fallback}</>;
  return <Image source={{ uri: `data:image/png;base64,${base64}` }} style={{ width: size, height: size, borderRadius: size * 0.26 }} />;
}

function PageHeader({ titleText, textColor, onBack, trailing, backLabel = 'Back', rtl = false }: {
  titleText: string; textColor: string; onBack?: () => void; trailing?: React.ReactNode; backLabel?: string; rtl?: boolean;
}) {
  return (
    <View style={styles.pageHeader}>
      {onBack ? (
        <Pressable onPress={onBack} style={styles.backButton} accessibilityRole="button" accessibilityLabel={backLabel}>
          <Ionicons name={rtl ? 'arrow-forward' : 'arrow-back'} size={20} color={textColor} />
        </Pressable>
      ) : <View style={styles.headerSpacer} />}
      <Text style={[styles.pageTitle, { color: textColor }]}>{titleText}</Text>
      {trailing ?? <View style={styles.headerSpacer} />}
    </View>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [editorReturnTo, setEditorReturnTo] = useState<'home' | 'library'>('home');
  const [lang, setLang] = useState<Lang>('ar');
  const t = STRINGS[lang];
  const [title, setTitle] = useState('لمستي الخاصة');
  const [symbol, setSymbol] = useState('✦');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [background, setBackground] = useState(COLORS[0]);
  const [savedIcons, setSavedIcons] = useState<SavedIcon[]>([]);
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [shortcutSupported, setShortcutSupported] = useState<boolean | null>(null);
  const [selectedApp, setSelectedApp] = useState<InstalledApp | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [appSearch, setAppSearch] = useState('');
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const systemScheme = useColorScheme();
  const darkMode = themeMode === 'dark' || (themeMode === 'system' && systemScheme === 'dark');
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [shapeReady, setShapeReady] = useState(false);
  const [defaultBackground, setDefaultBackground] = useState(COLORS[0]);
  const [shapeQuery, setShapeQuery] = useState('');
  const [shapeSvgs, setShapeSvgs] = useState<Record<string, string>>({});
  const [shapeBundleError, setShapeBundleError] = useState(false);
  const [shapesFromCache, setShapesFromCache] = useState(false);
  const [shapeBundleNonce, setShapeBundleNonce] = useState(0);
  const [shapeResults, setShapeResults] = useState<IconShape[]>([]);
  const [shapeLoading, setShapeLoading] = useState(false);
  const [shapeError, setShapeError] = useState(false);
  const [selectedShape, setSelectedShape] = useState<IconShape | null>(null);
  const [appIconVariant, setAppIconVariant] = useState<string | null>(null);
  const [packSheetVisible, setPackSheetVisible] = useState(false);
  const [packApply, setPackApply] = useState<{ color: string; svg: string } | null>(null);
  const shotRef = useRef<ViewShotRef | null>(null);
  const offscreenShotRef = useRef<ViewShotRef | null>(null);

  const palette = darkMode
    ? { screen: '#131620', surface: '#1C2233', surfaceAlt: '#232B40', text: '#F1EDE2', muted: '#9BA0B0', border: '#2C3550', accent: '#E8C15A', accentText: '#1E2A44', soft: '#262F48' }
    : { screen: '#FBF8F0', surface: '#FFFFFF', surfaceAlt: '#F7F1DF', text: '#1F2A44', muted: '#8D8A7B', border: '#EDE7D3', accent: '#E8B832', accentText: '#221A04', soft: '#F8ECC8' };

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [stored, storedDarkMode, storedDefaultColor, storedLang] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY),
          AsyncStorage.getItem(DARK_MODE_KEY),
          AsyncStorage.getItem(DEFAULT_COLOR_KEY),
          AsyncStorage.getItem(LANG_KEY),
        ]);
        if (active) {
          setSavedIcons(healMissingImages(restoreDesigns(stored)));
          setThemeMode(storedDarkMode === 'true' ? 'dark' : storedDarkMode === 'false' ? 'light' : 'system');
          if (storedLang === 'ar' || storedLang === 'en') setLang(storedLang);
          if (storedDefaultColor && COLORS.includes(storedDefaultColor)) setDefaultBackground(storedDefaultColor);
          native?.getLauncherIcon().then((variant) => { if (active) setAppIconVariant(variant); }).catch(() => {});
        }
      } catch {
        Alert.alert(STRINGS.ar.libLoadFailT, STRINGS.ar.libLoadFailM);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const toggleLanguage = () => {
    const next: Lang = lang === 'ar' ? 'en' : 'ar';
    setLang(next);
    void AsyncStorage.setItem(LANG_KEY, next).catch(() => {});
  };

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (packSheetVisible) {
        setPackSheetVisible(false);
        return true;
      }
      if (screen === 'editor') {
        setScreen(editorReturnTo);
        return true;
      }
      if (screen !== 'home') {
        setScreen('home');
        return true;
      }
      return false;
    });
    return () => subscription.remove();
  }, [screen, editorReturnTo, packSheetVisible]);

  useEffect(() => {
    const query = shapeQuery.trim();
    const timer = setTimeout(() => {
      if (!query) {
        setShapeResults([]);
        setShapeError(false);
        setShapeLoading(false);
        return;
      }
      let active = true;
      setShapeLoading(true);
      setShapeError(false);
      searchShapesCached(query)
        .then(({ results, fromCache }) => {
          if (!active) return;
          setShapeResults(results);
          setShapeError(false);
          setShapesFromCache(fromCache);
        })
        .catch(() => { if (active) setShapeError(true); })
        .finally(() => { if (active) setShapeLoading(false); });
    }, 350);
    return () => { clearTimeout(timer); };
  }, [shapeQuery]);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      if (!active) return;
      if (shapeResults.length === 0) {
        setShapeSvgs({});
        setShapeBundleError(false);
        setShapesFromCache(false);
        return;
      }
      setShapeBundleError(false);
      fetchShapeBundleCached(shapeResults, darkMode ? '#F1EDE2' : '#1F2A44')
        .then(({ bundle, fromCache }) => {
          if (!active) return;
          setShapeSvgs(bundle);
          setShapesFromCache(fromCache);
        })
        .catch(() => { if (active) setShapeBundleError(true); });
    }, 0);
    return () => { active = false; clearTimeout(timer); };
  }, [shapeResults, shapeBundleNonce, darkMode]);

  const persistIcons = async (items: SavedIcon[]) => {
    await AsyncStorage.setItem(STORAGE_KEY, serializeDesigns(items));
    setSavedIcons(items);
  };

  useEffect(() => {
    if (!packApply) return;
    let active = true;
    const timer = setTimeout(() => {
      captureRef(offscreenShotRef, { format: 'png', quality: 1, result: 'tmpfile' })
        .then(async (png) => {
          if (!active) return;
          if (!png) throw new Error('capture failed');
          const stored = await persistImage(png, 'png');
          const next = savedIcons.map((item) => ({ ...item, background: packApply.color, imageUri: stored, updatedAt: Date.now() }));
          await persistIcons(next);
          cleanupImages(savedIcons, next);
          Alert.alert(t.packAppliedTitle, t.packAppliedMsg);
        })
        .catch(() => { if (active) Alert.alert(t.packFailedTitle, t.packFailedMsg); })
        .finally(() => { if (active) { setPackApply(null); setBusy(false); } });
    }, 400);
    return () => { active = false; clearTimeout(timer); };
  }, [packApply, savedIcons, t]);

  const filteredApps = useMemo(() => {
    const query = appSearch.trim().toLocaleLowerCase();
    return apps.filter((item) => !query || item.label.toLocaleLowerCase().includes(query) || item.packageName.toLowerCase().includes(query)).slice(0, 60);
  }, [apps, appSearch]);

  const visibleIcons = useMemo(() => filterDesigns(savedIcons, libraryQuery), [savedIcons, libraryQuery]);
  const packSvgs = usePackSvgs();

  const chooseThemeMode = async (mode: ThemeMode) => {
    try {
      if (mode === 'system') await AsyncStorage.removeItem(DARK_MODE_KEY);
      else await AsyncStorage.setItem(DARK_MODE_KEY, String(mode === 'dark'));
      setThemeMode(mode);
    } catch {
      Alert.alert(t.themeFailT, t.themeFailM);
    }
  };

  const chooseDefaultColor = async (color: string) => {
    setDefaultBackground(color);
    setBackground(color);
    try {
      await AsyncStorage.setItem(DEFAULT_COLOR_KEY, color);
    } catch {
      Alert.alert(t.colorFailT, t.colorFailM);
    }
  };

  const changeAppIcon = async (variant: string) => {
    if (!native) {
      Alert.alert(t.needAndroidT, t.needIconM);
      return;
    }
    if (variant === appIconVariant) return;
    setBusy(true);
    try {
      await native.setLauncherIcon(variant);
      setAppIconVariant(variant);
      Alert.alert(t.iconChangedT, t.iconChangedM);
    } catch (error) {
      Alert.alert(t.iconChangeFailT, error instanceof Error ? error.message : t.unknownError);
    } finally {
      setBusy(false);
    }
  };

  const exportBackup = async () => {
    if (savedIcons.length === 0) {
      Alert.alert(t.backupEmptyT, t.backupEmptyM);
      return;
    }
    setBusy(true);
    try {
      const images: Record<string, EncodedImage> = {};
      let skipped = 0;
      for (const item of savedIcons) {
        if (!item.imageUri) continue;
        const encoded = await readImageBase64(item.imageUri);
        if (encoded) images[item.id] = encoded;
        else skipped += 1;
      }
      const backupFile = new File(Paths.cache, `icon-changer-backup-${Date.now()}.json`);
      writeTextFile(backupFile, buildBackup(savedIcons, images, Date.now()));
      if (!(await Sharing.isAvailableAsync())) throw new Error('sharing unavailable');
      await Sharing.shareAsync(backupFile.uri, { mimeType: 'application/json', dialogTitle: t.backupShareTitle });
      if (skipped > 0) Alert.alert(t.backupPartialT, t.backupPartialM(skipped));
    } catch {
      Alert.alert(t.backupExportFailT, t.backupExportFailM);
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (mode: 'replace' | 'merge') => {
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: false });
      if (result.canceled || !result.assets[0]) return;
      setBusy(true);
      const content = await new File(result.assets[0].uri).text();
      const parsed = parseBackup(content);
      const restored = parsed.designs.map((design, index) => {
        const image = parsed.images[design.id];
        return { ...design, imageUri: image ? writeImageBase64(image, index) : design.imageUri };
      });
      const healed = healMissingImages(restored);
      if (mode === 'merge') {
        const merged = mergeDesigns(savedIcons, healed);
        await persistIcons(merged.designs);
        Alert.alert(t.backupImportedT, t.backupMergedM(merged.added));
      } else {
        await persistIcons(healed);
        cleanupImages(savedIcons, healed);
        Alert.alert(t.backupImportedT, t.backupImportedM(healed.length));
      }
    } catch {
      Alert.alert(t.backupInvalidT, t.backupInvalidM);
    } finally {
      setBusy(false);
    }
  };

  const importBackup = () => {
    Alert.alert(t.backupImportT, t.backupImportM, [
      { text: t.cancel, style: 'cancel' },
      { text: t.merge, onPress: () => { void runImport('merge'); } },
      { text: t.replaceAll, style: 'destructive', onPress: () => { void runImport('replace'); } },
    ]);
  };

  const clearLibrary = () => Alert.alert(t.clearT, t.clearM, [
    { text: t.cancel, style: 'cancel' },
    { text: t.clearBtn, style: 'destructive', onPress: () => { void persistIcons([]).then(() => { cleanupImages(savedIcons, []); Alert.alert(t.clearedT, t.clearedM); }).catch(() => Alert.alert(t.clearFailT, t.clearFailM)); } },
  ]);

  const startNewDesign = (from: 'home' | 'library' = 'home') => {
    setEditingId(null);
    setTitle(t.newDesignTitle);
    setSymbol('✦');
    setImageUri(null);
    setSelectedShape(null);
    setBackground(defaultBackground);
    setHexDraft(null);
    setSelectedApp(null);
    setEditorReturnTo(from);
    setScreen('editor');
  };

  const pickImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.92,
      });
      if (result.canceled || !result.assets[0]) return;
      setBusy(true);
      const asset = result.assets[0];
      const ext = asset.fileName?.match(/\.(png|jpe?g|webp)$/i)?.[1]?.toLowerCase() || 'jpg';
      const stored = await persistImage(asset.uri, ext);
      setImageUri(stored);
      setSelectedShape(null);
    } catch {
      Alert.alert(t.pickImageFailT, t.pickImageFailM);
    } finally {
      setBusy(false);
    }
  };

  // A selected shape is only a live view; turn it into a real image before saving, pinning or sharing.
  const ensureDesignImage = async (): Promise<{ ok: true; uri: string | null } | { ok: false }> => {
    if (!selectedShape || imageUri) return { ok: true, uri: imageUri };
    if (!shapeReady) {
      Alert.alert(t.shapeNotReadyT, t.shapeNotReadyM);
      return { ok: false };
    }
    setBusy(true);
    try {
      const captured = await captureRef(shotRef, { format: 'png', quality: 1, result: 'tmpfile' });
      if (!captured) throw new Error('capture failed');
      const stored = await persistImage(captured, 'png');
      setImageUri(stored);
      return { ok: true, uri: stored };
    } catch {
      Alert.alert(t.shapeCaptureFailT, t.shapeCaptureFailM);
      return { ok: false };
    } finally {
      setBusy(false);
    }
  };

  const saveDesign = async () => {
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      Alert.alert(t.nameNeededT, t.nameNeededM);
      return;
    }
    const prepared = await ensureDesignImage();
    if (!prepared.ok) return;
    const finalImage = prepared.uri;
    const item: SavedIcon = {
      id: editingId ?? `icon-${Date.now()}`, title: cleanTitle, symbol, imageUri: finalImage, background,
      targetPackage: selectedApp?.packageName ?? null, targetLabel: selectedApp?.label ?? null,
      updatedAt: Date.now(),
    };
    try {
      const nextIcons = upsertDesign(savedIcons, item, editingId);
      await persistIcons(nextIcons);
      cleanupImages(savedIcons, nextIcons);
      setEditingId(item.id);
      Alert.alert(t.savedT, editingId ? t.savedUpdateM : t.savedNewM);
      setScreen('library');
    } catch {
      Alert.alert(t.saveFailT, t.saveFailM);
    }
  };

  const loadDesign = (item: SavedIcon) => {
    setEditingId(item.id);
    setTitle(item.title);
    setSymbol(item.symbol);
    setImageUri(item.imageUri);
    setSelectedShape(null);
    setBackground(item.background);
    setHexDraft(null);
    const target = item.targetPackage
      ? apps.find((entry) => entry.packageName === item.targetPackage) ?? {
          packageName: item.targetPackage,
          label: item.targetLabel ?? item.targetPackage,
        }
      : null;
    setSelectedApp(target);
    setShowAppPicker(false);
    setEditorReturnTo('library');
    setScreen('editor');
  };

  const deleteDesign = (id: string) => {
    Alert.alert(t.deleteT, t.deleteM, [
      { text: t.cancel, style: 'cancel' },
      { text: t.deleteBtn, style: 'destructive', onPress: () => {
        const next = removeDesign(savedIcons, id);
        void persistIcons(next).then(() => cleanupImages(savedIcons, next)).catch(() => Alert.alert(t.deleteFailT, t.deleteFailM));
      }},
    ]);
  };

  const loadApps = async () => {
    if (!native) {
      Alert.alert(t.needAndroidT, t.needAppsM);
      return;
    }
    setBusy(true);
    try {
      const [items, supported] = await Promise.all([native.getLaunchableApps(), native.isShortcutSupported()]);
      setApps(items);
      setShortcutSupported(supported);
      setAppSearch('');
      setShowAppPicker(true);
      if (items.length === 0) {
        Alert.alert(t.noAppsT, t.noAppsM);
      } else if (!supported) {
        Alert.alert(t.launcherLimitT, t.launcherLimitM);
      }
    } catch {
      Alert.alert(t.readAppsFailT, t.readAppsFailM);
    } finally {
      setBusy(false);
    }
  };

  const requestPin = async (target: { packageName: string; label: string; iconUri: string | null; symbol: string; background: string }) => {
    if (!native) {
      Alert.alert(t.needAndroidT, t.needPinM);
      return;
    }
    setBusy(true);
    try {
      const supported = await native.isShortcutSupported();
      setShortcutSupported(supported);
      if (!supported) {
        Alert.alert(t.pinUnsupportedT, t.pinUnsupportedM);
        return;
      }
      const accepted = await native.pinAppShortcut({
        id: `${target.packageName}-${Date.now()}`,
        label: target.label.trim().slice(0, 40) || target.packageName, targetPackage: target.packageName,
        iconUri: target.iconUri, symbol: target.symbol, backgroundColor: target.background,
      });
      Alert.alert(accepted ? t.pinReadyT : t.pinNotAcceptedT, accepted ? t.pinReadyM : t.pinNotAcceptedM);
    } catch (error) {
      Alert.alert(t.pinFailT, error instanceof Error ? error.message : t.unknownError);
    } finally {
      setBusy(false);
    }
  };

  const pinShortcut = async () => {
    if (!selectedApp) {
      Alert.alert(t.appFirstT, t.appFirstM);
      return;
    }
    const prepared = await ensureDesignImage();
    if (!prepared.ok) return;
    await requestPin({ packageName: selectedApp.packageName, label: title, iconUri: prepared.uri, symbol, background });
  };

  const pinFromLibrary = async (item: SavedIcon) => {
    if (!item.targetPackage) {
      Alert.alert(t.appFirstT, t.appFirstM);
      return;
    }
    await requestPin({ packageName: item.targetPackage, label: item.title, iconUri: item.imageUri, symbol: item.symbol, background: item.background });
  };

  const copyDesign = (item: SavedIcon) => {
    const next = duplicateDesign(savedIcons, item.id, `icon-${Date.now()}`, Date.now(), t.copySuffix);
    void persistIcons(next).catch(() => Alert.alert(t.saveFailT, t.saveFailM));
  };

  const shareImage = async () => {
    try {
      if (!native) {
        Alert.alert(t.needAndroidT, t.needShareM);
        return;
      }
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert(t.shareUnavailableT, t.shareUnavailableM);
        return;
      }
      const prepared = await ensureDesignImage();
      if (!prepared.ok) return;
      setBusy(true);
      const fileUri = await native.renderIconToFile(buildShareRequest(prepared.uri, symbol, background));
      await Sharing.shareAsync(fileUri, { mimeType: 'image/png', dialogTitle: t.shareTitle });
    } catch {
      Alert.alert(t.shareFailT, t.shareFailM);
    } finally {
      setBusy(false);
    }
  };

  const applyPackToLibrary = (pack: Pack) => {
    if (savedIcons.length === 0) {
      Alert.alert(t.backupEmptyT, t.backupEmptyM);
      return;
    }
    Alert.alert(t.applyPackTitle, t.applyPackMsg, [
      { text: t.cancel, style: 'cancel' },
      { text: t.apply, style: 'default', onPress: () => {
        void (async () => {
          setBusy(true);
          try {
            const { bundle } = await fetchShapeBundleCached([pack.shape], contrastColor(pack.color));
            const svg = bundle[shapeKey(pack.shape)];
            if (!svg) throw new Error('missing shape svg');
            setPackApply({ color: pack.color, svg });
          } catch {
            setBusy(false);
            Alert.alert(t.packFailedTitle, t.packFailedMsg);
          }
        })();
      }},
    ]);
  };

  const textAlign = lang === 'ar' ? ('right' as const) : ('left' as const);
  const stepNumbers = lang === 'ar' ? ['١', '٢', '٣'] : ['1', '2', '3'];

  const navItems: { id: Screen; glyph: keyof typeof Ionicons.glyphMap; label: string }[] = [
    { id: 'home', glyph: 'home', label: t.navHome },
    { id: 'library', glyph: 'grid', label: t.navLibrary },
    { id: 'settings', glyph: 'settings-outline', label: t.navSettings },
  ];

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: palette.screen }]} edges={['top', 'bottom']}>
      <StatusBar style={darkMode ? 'light' : 'dark'} />
      <ScrollView contentContainerStyle={[styles.content, screen === 'editor' && { paddingBottom: 40 }]} showsVerticalScrollIndicator={false}>
        {screen === 'home' && (
          <>
            <View style={styles.topRow}>
              <View style={styles.brandMark}><Text style={styles.brandMarkText}>✳</Text></View>
              <View style={styles.brandCopy}>
                <Text style={[styles.brandName, { color: palette.text }]}>ICON CHANGER</Text>
                <Text style={[styles.brandSubtitle, { color: palette.muted }]}>{t.brandSubtitle}</Text>
              </View>
            </View>
            <View style={[styles.hero, { backgroundColor: palette.surfaceAlt, borderColor: palette.border }]}>
              <View style={styles.heroDecor} />
              {savedIcons[0] ? (
                <Pressable onPress={() => loadDesign(savedIcons[0])} accessibilityRole="button" accessibilityLabel={t.editNamed(savedIcons[0].title)}>
                  <IconGlyph size={148} bg={savedIcons[0].background} glyph={savedIcons[0].symbol} photo={savedIcons[0].imageUri} shape={null} />
                </Pressable>
              ) : (
                <IconGlyph size={148} bg={background} glyph={symbol} photo={null} shape={null} />
              )}
              <Text style={[styles.heroIconName, { color: palette.text }]}>{savedIcons[0]?.title ?? t.myTouch}</Text>
              <Text style={[styles.heroCaption, { color: palette.muted }]}>{savedIcons.length ? t.tapToEdit : t.startFirst}</Text>
              <Text style={[styles.heroHint, { color: palette.muted }]}>{t.heroHint}</Text>
              <Pressable onPress={() => startNewDesign('home')} style={styles.newButton}>
                <Ionicons name="add" size={19} color={palette.accentText} />
                <Text style={[styles.newButtonText, { color: palette.accentText }]}>{t.newDesign}</Text>
              </Pressable>
            </View>
            {loading ? (
              <ActivityIndicator color={palette.accent} style={{ marginVertical: 25 }} />
            ) : savedIcons.length > 0 && (
              <>
                <View style={styles.sectionHeading}>
                  <Text style={[styles.sectionTitle, { color: palette.text }]}>{t.yourDesigns}</Text>
                  <Text style={[styles.sectionCount, { color: palette.muted }]}>{savedIcons.length}</Text>
                </View>
                <View style={styles.designGrid}>
                  {savedIcons.slice(0, 4).map((item) => (
                    <Pressable key={item.id} style={[styles.designCard, { backgroundColor: palette.surface, borderColor: palette.border }]} onPress={() => loadDesign(item)} accessibilityRole="button" accessibilityLabel={t.editNamed(item.title)}>
                      <View style={[styles.smallIcon, { backgroundColor: item.background }]}>
                        {item.imageUri ? <Image source={{ uri: item.imageUri }} style={styles.previewImage} resizeMode="cover" /> : <Text style={styles.smallIconSymbol}>{item.symbol}</Text>}
                      </View>
                      <Text style={[styles.designName, { color: palette.text }]} numberOfLines={1}>{item.title}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            )}
            <View style={[styles.howCard, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              <Text style={[styles.howTitle, { color: palette.text }]}>{t.howTitle}</Text>
              <View style={styles.howStep}><View style={styles.stepNumber}><Text style={styles.stepNumberText}>{stepNumbers[0]}</Text></View><View style={styles.stepCopy}><Text style={[styles.stepTitle, { color: palette.text }]}>{t.how1t}</Text><Text style={[styles.stepDescription, { color: palette.muted }]}>{t.how1d}</Text></View><Ionicons name="color-palette-outline" size={22} color={palette.accent} /></View>
              <View style={styles.howStep}><View style={styles.stepNumber}><Text style={styles.stepNumberText}>{stepNumbers[1]}</Text></View><View style={styles.stepCopy}><Text style={[styles.stepTitle, { color: palette.text }]}>{t.how2t}</Text><Text style={[styles.stepDescription, { color: palette.muted }]}>{t.how2d}</Text></View><Ionicons name="apps-outline" size={22} color={palette.accent} /></View>
              <View style={[styles.howStep, { borderBottomWidth: 0 }]}><View style={styles.stepNumber}><Text style={styles.stepNumberText}>{stepNumbers[2]}</Text></View><View style={styles.stepCopy}><Text style={[styles.stepTitle, { color: palette.text }]}>{t.how3t}</Text><Text style={[styles.stepDescription, { color: palette.muted }]}>{t.how3d}</Text></View><Ionicons name="phone-portrait-outline" size={22} color={palette.accent} /></View>
              <Text style={[styles.howNote, { color: palette.muted }]}>{t.howNote}</Text>
            </View>
          </>
        )}

        {screen === 'editor' && (
          <>
            <PageHeader titleText={t.editorTitle} textColor={palette.text} onBack={() => setScreen(editorReturnTo)} backLabel={t.back} rtl={lang === 'ar'} />
            <View style={[styles.editorPreview, { backgroundColor: palette.surfaceAlt }]}>
              <ViewShot ref={shotRef} style={styles.shotArea}>
                <IconGlyph size={138} bg={background} glyph={symbol} photo={imageUri} shape={selectedShape} retryLabel={t.retry} onShapeReady={setShapeReady} />
              </ViewShot>
              <Text style={[styles.previewTitle, { color: palette.text }]}>{title.trim() || t.previewPlaceholder}</Text>
              <Text style={[styles.previewCaption, { color: palette.muted }]}>{selectedApp?.label ?? t.previewCaption}</Text>
            </View>
            <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              <Text style={[styles.fieldLabel, { color: palette.text }]}>{t.iconName}</Text>
              <TextInput value={title} onChangeText={setTitle} placeholder={t.namePlaceholder} placeholderTextColor={palette.muted} maxLength={40} style={[styles.textInput, { borderColor: palette.border, color: palette.text }]} textAlign={textAlign} returnKeyType="done" />
              <Text style={[styles.fieldLabel, { color: palette.text }]}>{t.fromDevice}</Text>
              <View style={styles.actionRow}>
                <Pressable style={[styles.secondaryButton, { backgroundColor: palette.soft }]} onPress={pickImage} disabled={busy}>
                  <Ionicons name="image-outline" size={17} color={palette.text} />
                  <Text style={[styles.secondaryButtonText, { color: palette.text }]}>  {t.pickImage}</Text>
                </Pressable>
                {imageUri && (
                  <Pressable onPress={() => setImageUri(null)} disabled={busy}>
                    <Text style={[styles.linkText, { color: palette.muted }]}>{t.removeImage}</Text>
                  </Pressable>
                )}
              </View>
              <Text style={[styles.fieldLabel, { color: palette.text }]}>{t.symbolLabel}</Text>
              <TextInput value={symbol} onChangeText={(text: string) => { setSymbol(text); setImageUri(null); setSelectedShape(null); }} placeholder={t.symbolPlaceholder} placeholderTextColor={palette.muted} maxLength={4} autoCorrect={false} style={[styles.textInput, { borderColor: palette.border, color: palette.text }]} textAlign={textAlign} returnKeyType="done" />
              <Text style={[styles.fieldLabel, { color: palette.text }]}>{t.packs}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {ICON_PACKS.map((pack) => (
                  <Pressable key={pack.label} onPress={() => { setSelectedShape(pack.shape); setBackground(pack.color); setImageUri(null); }} style={[styles.packCard, { borderColor: palette.border }]} accessibilityRole="button" accessibilityLabel={t.packNamed(t.packNames[pack.label])}>
                    <View style={[styles.packIcon, { backgroundColor: pack.color }]}>
                      <PackGlyph svg={packSvgs[pack.label]} />
                    </View>
                    <Text style={[styles.packLabel, { color: palette.text }]}>{t.packNames[pack.label]}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Text style={[styles.fieldLabel, { color: palette.text }]}>{t.shapes}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
                {SHAPE_CATEGORIES.map((category) => (
                  <Pressable key={category.query} onPress={() => setShapeQuery(category.query)} style={[styles.chip, { borderColor: palette.border }, shapeQuery === category.query && { backgroundColor: palette.accent, borderColor: palette.accent }]}>
                    <Text style={[styles.chipText, { color: palette.text }, shapeQuery === category.query && { color: palette.accentText }]}>{t.categoryNames[category.label]}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              <TextInput value={shapeQuery} onChangeText={setShapeQuery} placeholder={t.shapesSearch} placeholderTextColor={palette.muted} style={[styles.textInput, { borderColor: palette.border, color: palette.text }]} textAlign={textAlign} returnKeyType="search" />
              {shapeLoading ? <ActivityIndicator color={palette.accent} style={{ marginVertical: 14 }} />
                : shapeError ? <Text style={[styles.mutedText, { color: palette.muted }]}>{t.shapesError}</Text>
                : shapeResults.length > 0 ? (
                  <>
                    {shapesFromCache && <Text style={[styles.cacheHint, { color: palette.muted }]}>{t.shapesOffline}</Text>}
                    <View style={styles.shapeGrid}>
                      {shapeResults.map((shape) => {
                        const active = selectedShape?.prefix === shape.prefix && selectedShape?.name === shape.name;
                        const svg = shapeSvgs[shapeKey(shape)];
                        return (
                          <Pressable key={shapeKey(shape)} onPress={() => { setSelectedShape(shape); setImageUri(null); }} style={[styles.shapeOption, { borderColor: palette.border }, active && { borderColor: palette.accent, borderWidth: 2.5 }]} accessibilityRole="button" accessibilityLabel={shape.name}>
                            {svg ? <SvgXml xml={svg} width={24} height={24} /> : <ActivityIndicator size="small" color="#C8B68A" />}
                          </Pressable>
                        );
                      })}
                    </View>
                    {shapeBundleError && (
                      <Pressable onPress={() => setShapeBundleNonce((n) => n + 1)} style={styles.bundleRetry} accessibilityRole="button" accessibilityLabel={t.reloadShapes}>
                        <Ionicons name="refresh" size={15} color={palette.text} />
                        <Text style={[styles.bundleRetryText, { color: palette.text }]}>{t.bundleRetry}</Text>
                      </Pressable>
                    )}
                  </>
                ) : <Text style={[styles.mutedText, { color: palette.muted }]}>{t.shapesHint}</Text>}
              <Text style={[styles.fieldLabel, { color: palette.text }]}>{t.bgColor}</Text>
              <View style={styles.colorRow}>{COLORS.map((color) => <Pressable key={color} onPress={() => { setBackground(color); setHexDraft(null); }} style={[styles.colorOption, { backgroundColor: color }, background === color && styles.colorSelected]}>{background === color ? <Text style={styles.colorCheck}>✓</Text> : null}</Pressable>)}</View>
              <Text style={[styles.fieldLabel, { color: palette.text, marginTop: 14 }]}>{t.customColor}</Text>
              <TextInput value={hexDraft ?? background} onChangeText={(text: string) => { setHexDraft(text); const normalized = normalizeHex(text); if (normalized) setBackground(normalized); }} onBlur={() => setHexDraft(null)} placeholder="#RRGGBB" placeholderTextColor={palette.muted} maxLength={7} autoCapitalize="characters" autoCorrect={false} style={[styles.textInput, { borderColor: palette.border, color: palette.text, textAlign: 'left', writingDirection: 'ltr' }]} />
            </View>
            <View style={styles.sectionHeading}><Text style={[styles.sectionTitle, { color: palette.text }]}>{t.targetApp}</Text></View>
            <View style={[styles.panel, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              {selectedApp ? <View style={styles.selectedAppRow}><View style={[styles.appMonogram, { backgroundColor: palette.soft }]}><AppIcon packageName={selectedApp.packageName} size={42} fallback={<Ionicons name="apps-outline" size={21} color={palette.text} />} /></View><View style={styles.selectedAppCopy}><Text style={[styles.selectedAppName, { color: palette.text }]}>{selectedApp.label}</Text><Text style={[styles.selectedAppPackage, { color: palette.muted }]} numberOfLines={1}>{selectedApp.packageName}</Text></View><Pressable onPress={() => setSelectedApp(null)}><Text style={[styles.linkText, { color: palette.accent }]}>{t.changeApp}</Text></Pressable></View> : <Text style={[styles.mutedText, { color: palette.muted }]}>{t.noApp}</Text>}
              {shortcutSupported === false ? <Text style={styles.warningText}>{t.launcherWarning}</Text> : shortcutSupported === true ? <Text style={styles.successHint}>{t.launcherOk}</Text> : null}
              <Pressable style={[styles.outlineButton, { borderColor: palette.border }]} onPress={loadApps} disabled={busy}><Text style={[styles.outlineButtonText, { color: palette.text }]}>{busy ? t.loading : t.loadApps}</Text></Pressable>
              {showAppPicker && <View style={styles.appPicker}><TextInput value={appSearch} onChangeText={setAppSearch} placeholder={t.searchApp} placeholderTextColor={palette.muted} style={[styles.textInput, { borderColor: palette.border, color: palette.text }]} textAlign={textAlign} />{filteredApps.slice(0, 15).map((item) => <Pressable key={item.packageName} onPress={() => { setSelectedApp(item); setShowAppPicker(false); }} style={styles.appChoice}><AppIcon packageName={item.packageName} size={34} fallback={<Text style={[styles.appChoiceGlyph, { backgroundColor: palette.soft, color: palette.text }]}>{item.label.slice(0, 1)}</Text>} /><Text style={[styles.appChoiceName, { color: palette.text }]}>{item.label}</Text><Text style={[styles.appChoiceArrow, { color: palette.muted }]}>←</Text></Pressable>)}{filteredApps.length === 0 && <Text style={[styles.mutedText, { color: palette.muted }]}>{t.noResults}</Text>}</View>}
            </View>
            <Pressable style={[styles.primaryButton, { backgroundColor: palette.accent }]} onPress={saveDesign} disabled={busy}><Text style={[styles.primaryButtonText, { color: palette.accentText }]}>{editingId ? t.saveEdits : t.save}</Text></Pressable>
            <View style={styles.actionRow}>
              <Pressable style={[styles.secondaryButtonWide, { backgroundColor: palette.surface, borderColor: palette.border }]} onPress={pinShortcut} disabled={busy}>
                <Ionicons name="phone-portrait-outline" size={17} color={palette.text} />
                <Text style={[styles.secondaryButtonText, { color: palette.text }]}>  {t.pin}</Text>
              </Pressable>
              <Pressable style={[styles.shareButton, { backgroundColor: palette.surface, borderColor: palette.border }]} onPress={shareImage} disabled={busy} accessibilityRole="button" accessibilityLabel={t.shareDesign}>
                <Ionicons name="share-social-outline" size={21} color={palette.text} />
              </Pressable>
            </View>
          </>
        )}

        {screen === 'library' && (
          <>
            <PageHeader titleText={t.libraryTitle} textColor={palette.text} trailing={
              <Pressable onPress={() => setPackSheetVisible(true)} style={styles.backButton} accessibilityRole="button" accessibilityLabel={t.applyPack}>
                <Ionicons name="color-palette-outline" size={20} color={palette.text} />
              </Pressable>
            } />
            {loading ? <ActivityIndicator color={palette.accent} style={{ marginVertical: 30 }} />
              : savedIcons.length === 0 ? (
                <View style={[styles.emptyCard, { backgroundColor: palette.surface, borderColor: palette.border }]}>
                  <View style={styles.emptyPlus}><Text style={styles.emptyPlusText}>＋</Text></View>
                  <Text style={[styles.emptyTitle, { color: palette.text }]}>{t.emptyLibrary}</Text>
                  <Pressable onPress={() => startNewDesign('library')} style={styles.newButton}>
                    <Ionicons name="add" size={19} color={palette.accentText} />
                    <Text style={[styles.newButtonText, { color: palette.accentText }]}>{t.newDesign}</Text>
                  </Pressable>
                </View>
              ) : (
                <>
                {savedIcons.length > 5 && (
                  <TextInput value={libraryQuery} onChangeText={setLibraryQuery} placeholder={t.searchLibrary} placeholderTextColor={palette.muted} style={[styles.textInput, { borderColor: palette.border, color: palette.text }]} textAlign={textAlign} returnKeyType="search" />
                )}
                <View style={styles.libraryGrid}>
                  {visibleIcons.length === 0 ? <Text style={[styles.mutedText, { color: palette.muted }]}>{t.noMatches}</Text> : visibleIcons.map((item) => (
                    <View key={item.id} style={[styles.libraryCard, { backgroundColor: palette.surface, borderColor: palette.border }]}>
                      <Pressable onPress={() => loadDesign(item)} style={styles.libraryOpen} accessibilityRole="button" accessibilityLabel={t.editNamed(item.title)}>
                        <View style={[styles.libraryIcon, { backgroundColor: item.background }]}>
                          {item.imageUri ? <Image source={{ uri: item.imageUri }} style={styles.previewImage} resizeMode="cover" /> : <Text style={styles.librarySymbol}>{item.symbol}</Text>}
                        </View>
                        <Text style={[styles.libraryTitle, { color: palette.text }]} numberOfLines={1}>{item.title}</Text>
                        <Text style={[styles.libraryTarget, { color: palette.muted }]} numberOfLines={1}>{item.targetLabel ?? t.noAppLabel}</Text>
                      </Pressable>
                      <View style={styles.libraryActions}>
                        {item.targetPackage ? (
                          <Pressable onPress={() => { void pinFromLibrary(item); }} style={styles.libraryAction} accessibilityRole="button" accessibilityLabel={t.pinNamed(item.title)}>
                            <Ionicons name="phone-portrait-outline" size={17} color={palette.text} />
                          </Pressable>
                        ) : null}
                        <Pressable onPress={() => copyDesign(item)} style={styles.libraryAction} accessibilityRole="button" accessibilityLabel={t.duplicateNamed(item.title)}>
                          <Ionicons name="copy-outline" size={17} color={palette.text} />
                        </Pressable>
                        <Pressable onPress={() => deleteDesign(item.id)} style={styles.libraryAction} accessibilityRole="button" accessibilityLabel={t.deleteNamed(item.title)}>
                          <Ionicons name="trash-outline" size={17} color="#A64D43" />
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </View>
                </>
              )}
          </>
        )}

        {screen === 'settings' && (
          <>
            <PageHeader titleText={t.settingsTitle} textColor={palette.text} />
            <View style={[styles.settingsHero, { backgroundColor: palette.surfaceAlt }]}>
              <View style={styles.brandMark}><Text style={styles.brandMarkText}>✳</Text></View>
              <Text style={[styles.settingsTitle, { color: palette.text }]}>Icon Changer</Text>
              <Text style={[styles.settingsSubtitle, { color: palette.muted }]}>{t.versionValue}</Text>
            </View>
            <View style={[styles.settingsGroup, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              <Text style={[styles.groupTitle, { color: palette.muted }]}>{t.appearance}</Text>
              <View style={styles.settingRow}>
                <View style={[styles.settingGlyph, { backgroundColor: palette.soft }]}><Ionicons name={darkMode ? 'moon' : 'sunny-outline'} size={19} color={palette.text} /></View>
                <View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: palette.text }]}>{t.darkMode}</Text><Text style={[styles.settingSubtitle, { color: palette.muted }]}>{t.themeSub}</Text></View>
              </View>
              <View style={styles.themeRow}>
                {(['system', 'light', 'dark'] as ThemeMode[]).map((mode) => (
                  <Pressable key={mode} onPress={() => { void chooseThemeMode(mode); }} accessibilityRole="button" accessibilityState={{ selected: themeMode === mode }} style={[styles.chip, { borderColor: palette.border }, themeMode === mode && { backgroundColor: palette.accent, borderColor: palette.accent }]}>
                    <Text style={[styles.chipText, { color: palette.text }, themeMode === mode && { color: palette.accentText }]}>{mode === 'system' ? t.themeSystem : mode === 'dark' ? t.themeDark : t.themeLight}</Text>
                  </Pressable>
                ))}
              </View>
              <Pressable style={styles.settingRow} onPress={toggleLanguage} accessibilityRole="button">
                <View style={[styles.settingGlyph, { backgroundColor: palette.soft }]}><Ionicons name="language-outline" size={19} color={palette.text} /></View>
                <View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: palette.text }]}>{t.language}</Text><Text style={[styles.settingSubtitle, { color: palette.muted }]}>{t.languageSub}</Text></View>
                <Text style={[styles.langValue, { color: palette.accent }]}>{lang === 'ar' ? 'English' : 'العربية'}</Text>
              </Pressable>
              <View style={styles.settingRow}>
                <View style={[styles.settingGlyph, { backgroundColor: palette.soft }]}><Ionicons name="color-palette-outline" size={19} color={palette.text} /></View>
                <View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: palette.text }]}>{t.defaultColor}</Text><Text style={[styles.settingSubtitle, { color: palette.muted }]}>{t.defaultColorSub}</Text></View>
              </View>
              <View style={[styles.paletteDots, { justifyContent: 'space-between', paddingVertical: 10 }]}>
                {COLORS.map((color) => <Pressable key={color} accessibilityRole="button" accessibilityLabel={t.pickColor(color)} onPress={() => { void chooseDefaultColor(color); }} style={[styles.paletteDot, { backgroundColor: color, width: 28, height: 28, borderRadius: 14 }, defaultBackground === color && { borderWidth: 3, borderColor: palette.accent }]} />)}
              </View>
            </View>
            <View style={[styles.settingsGroup, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              <View style={styles.settingRow}>
                <View style={[styles.settingGlyph, { backgroundColor: palette.soft }]}><Ionicons name="swap-horizontal-outline" size={19} color={palette.text} /></View>
                <View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: palette.text }]}>{t.realIcon}</Text><Text style={[styles.settingSubtitle, { color: palette.muted }]}>{t.realIconSub}</Text></View>
              </View>
              <View style={[styles.paletteDots, { justifyContent: 'space-between', paddingVertical: 10 }]}>
                {ICON_VARIANTS.map((variant) => (
                  <Pressable key={variant.id} accessibilityRole="button" accessibilityLabel={t.iconNamed(t.variantLabels[variant.id as keyof typeof t.variantLabels])} onPress={() => { void changeAppIcon(variant.id); }} style={[styles.paletteDot, { backgroundColor: variant.color, width: 34, height: 34, borderRadius: 12 }, (appIconVariant ?? 'gold') === variant.id && { borderWidth: 3, borderColor: palette.accent }]}>
                    {(appIconVariant ?? 'gold') === variant.id ? <Ionicons name="checkmark" size={16} color={contrastColor(variant.color)} /> : null}
                  </Pressable>
                ))}
              </View>
              <Text style={[styles.settingNote, { color: palette.muted }]}>{t.realIconNote}</Text>
            </View>
            <View style={[styles.settingsGroup, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              <Text style={[styles.groupTitle, { color: palette.muted }]}>{t.backup}</Text>
              <Pressable style={styles.settingRow} onPress={() => { void exportBackup(); }}>
                <View style={[styles.settingGlyph, { backgroundColor: palette.soft }]}><Ionicons name="cloud-upload-outline" size={19} color={palette.text} /></View>
                <View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: palette.text }]}>{t.exportFile}</Text><Text style={[styles.settingSubtitle, { color: palette.muted }]}>{t.exportSub(savedIcons.length)}</Text></View>
                <Ionicons name={lang === 'ar' ? 'chevron-back' : 'chevron-forward'} size={18} color={palette.muted} />
              </Pressable>
              <Pressable style={styles.settingRow} onPress={importBackup}>
                <View style={[styles.settingGlyph, { backgroundColor: palette.soft }]}><Ionicons name="cloud-download-outline" size={19} color={palette.text} /></View>
                <View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: palette.text }]}>{t.importFile}</Text><Text style={[styles.settingSubtitle, { color: palette.muted }]}>{t.importSub}</Text></View>
                <Ionicons name={lang === 'ar' ? 'chevron-back' : 'chevron-forward'} size={18} color={palette.muted} />
              </Pressable>
            </View>
            <View style={[styles.settingsGroup, { backgroundColor: palette.surface, borderColor: palette.border }]}>
              <Text style={[styles.groupTitle, { color: palette.muted }]}>{t.about}</Text>
              <View style={styles.settingRow}>
                <View style={[styles.settingGlyph, { backgroundColor: palette.soft }]}><Ionicons name="shield-checkmark-outline" size={19} color={palette.text} /></View>
                <View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: palette.text }]}>{t.privacy}</Text><Text style={[styles.settingSubtitle, { color: palette.muted }]}>{t.privacySub}</Text></View>
              </View>
              <Pressable style={styles.dangerAction} onPress={clearLibrary}><Ionicons name="trash-outline" size={18} color="#A64D43" /><Text style={styles.dangerActionText}>{t.clearAll}</Text></Pressable>
            </View>
          </>
        )}
      </ScrollView>
      {screen !== 'editor' && (
        <View style={[styles.bottomNav, { backgroundColor: palette.surface, borderColor: palette.border }]}>
          {navItems.map((item) => (
            <Pressable key={item.id} onPress={() => setScreen(item.id)} style={styles.navItem} accessibilityRole="button" accessibilityLabel={item.label}>
              <View style={[styles.navIconWrap, screen === item.id && { backgroundColor: palette.soft }]}>
                <Ionicons name={item.glyph} size={21} color={screen === item.id ? palette.accent : palette.muted} />
              </View>
              <Text style={[styles.navLabel, { color: palette.muted }, screen === item.id && { color: palette.text, fontWeight: '800' }]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Modal visible={packSheetVisible} transparent animationType="slide" onRequestClose={() => setPackSheetVisible(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setPackSheetVisible(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: palette.surface }]}>
            <Text style={[styles.sheetTitle, { color: palette.text }]}>{t.applyPackTitle}</Text>
            <Text style={[styles.sheetMsg, { color: palette.muted }]}>{t.applyPackMsg}</Text>
            <View style={styles.sheetPacks}>
              {ICON_PACKS.map((pack) => (
                <Pressable key={pack.label} onPress={() => { setPackSheetVisible(false); applyPackToLibrary(pack); }} style={[styles.packCard, { borderColor: palette.border }]} accessibilityRole="button" accessibilityLabel={t.packNamed(t.packNames[pack.label])}>
                  <View style={[styles.packIcon, { backgroundColor: pack.color }]}>
                    <PackGlyph svg={packSvgs[pack.label]} />
                  </View>
                  <Text style={[styles.packLabel, { color: palette.text }]}>{t.packNames[pack.label]}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable onPress={() => setPackSheetVisible(false)} style={styles.sheetCancel}>
              <Text style={[styles.sheetCancelText, { color: palette.muted }]}>{t.cancel}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
      {packApply && (
        <ViewShot ref={offscreenShotRef} style={styles.offscreenShot}>
          <SvgXml xml={packApply.svg} width={432} height={432} />
        </ViewShot>
      )}
      {busy ? <View style={styles.busyOverlay} pointerEvents="none"><ActivityIndicator color={palette.accent} size="large" /></View> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FBF8F0' },
  content: { paddingHorizontal: 20, paddingTop: 22, paddingBottom: 120, maxWidth: 680, width: '100%', alignSelf: 'center' },
  topRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 22 },
  brandMark: { width: 46, height: 46, borderRadius: 16, backgroundColor: '#F4C542', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  brandMarkText: { color: '#1F2A44', fontSize: 25, fontWeight: '800' },
  brandCopy: { flex: 1 },
  brandName: { fontSize: 13, fontWeight: '900', letterSpacing: 1.6 },
  brandSubtitle: { fontSize: 11, marginTop: 4 },
  hero: { borderRadius: 28, padding: 24, alignItems: 'center', overflow: 'hidden', borderWidth: 1, marginBottom: 26 },
  heroDecor: { position: 'absolute', top: -55, right: -35, width: 170, height: 170, borderRadius: 90, borderWidth: 26, borderColor: '#F4C54240' },
  iconPreview: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  previewImage: { width: '100%', height: '100%' },
  previewSymbol: { color: '#FFFFFF', fontSize: 59, fontWeight: '600' },
  heroIconName: { fontSize: 17, fontWeight: '800', marginTop: 15 },
  heroCaption: { fontSize: 11, marginTop: 4 },
  heroHint: { fontSize: 11, lineHeight: 18, textAlign: 'center', marginTop: 9, paddingHorizontal: 6 },
  newButton: { backgroundColor: '#E8B832', borderRadius: 15, paddingHorizontal: 18, paddingVertical: 12, marginTop: 16, flexDirection: 'row', alignItems: 'center' },
  newButtonText: { fontSize: 13, fontWeight: '800' },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 13, marginTop: 4 },
  sectionTitle: { fontSize: 16, fontWeight: '900' },
  sectionCount: { fontSize: 12, fontWeight: '700', backgroundColor: '#E8B83222', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, overflow: 'hidden' },
  linkText: { fontSize: 12, fontWeight: '800' },
  designGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 24 },
  designCard: { width: '23%', minWidth: 68, flexGrow: 1, borderWidth: 1, borderRadius: 18, padding: 10, alignItems: 'center' },
  smallIcon: { width: 54, height: 54, borderRadius: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  smallIconSymbol: { color: '#FFFFFF', fontSize: 24 },
  designName: { fontSize: 11, fontWeight: '700', marginTop: 7 },
  howCard: { borderRadius: 24, padding: 18, borderWidth: 1 },
  howTitle: { fontSize: 15, fontWeight: '900', marginBottom: 8 },
  howStep: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#00000010' },
  stepNumber: { width: 30, height: 30, borderRadius: 11, backgroundColor: '#F4C542', alignItems: 'center', justifyContent: 'center' },
  stepNumberText: { color: '#1F2A44', fontWeight: '900', fontSize: 14 },
  stepCopy: { flex: 1 },
  stepTitle: { fontSize: 13, fontWeight: '800' },
  stepDescription: { fontSize: 11, marginTop: 3, lineHeight: 17 },
  howNote: { fontSize: 10.5, lineHeight: 16, marginTop: 10 },
  pageHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, marginTop: 4 },
  headerSpacer: { width: 42 },
  backButton: { width: 42, height: 42, borderRadius: 14, backgroundColor: '#00000008', alignItems: 'center', justifyContent: 'center' },
  pageTitle: { fontSize: 18, fontWeight: '900' },
  editorPreview: { borderRadius: 26, padding: 22, alignItems: 'center', marginBottom: 18 },
  shotArea: { alignItems: 'center', justifyContent: 'center' },
  previewTitle: { fontSize: 15, fontWeight: '800', marginTop: 13 },
  previewCaption: { fontSize: 11, marginTop: 3 },
  panel: { borderRadius: 22, padding: 18, borderWidth: 1, marginBottom: 18 },
  fieldLabel: { fontSize: 12.5, fontWeight: '800', marginBottom: 9, marginTop: 4 },
  textInput: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 11, fontSize: 14, marginBottom: 14 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 14 },
  secondaryButton: { flexDirection: 'row', alignItems: 'center', borderRadius: 13, paddingHorizontal: 15, paddingVertical: 11 },
  secondaryButtonText: { fontSize: 12.5, fontWeight: '800' },
  chipRow: { flexDirection: 'row', gap: 8, paddingVertical: 4, marginBottom: 12 },
  chip: { borderRadius: 20, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 7 },
  chipText: { fontSize: 12, fontWeight: '700' },
  shapeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginBottom: 14 },
  bundleRetry: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 14 },
  bundleRetryText: { fontSize: 11.5, fontWeight: '700' },
  cacheHint: { fontSize: 10.5, marginBottom: 8 },
  packCard: { alignItems: 'center', gap: 6, borderRadius: 16, borderWidth: 1, padding: 10, marginRight: 2 },
  packIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  packLabel: { fontSize: 11, fontWeight: '800' },
  shapeOption: { width: 52, height: 52, borderRadius: 15, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorOption: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  colorSelected: { borderWidth: 3, borderColor: '#1F2A44' },
  colorCheck: { color: '#FFFFFF', fontSize: 13, fontWeight: '900' },
  selectedAppRow: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 12 },
  appMonogram: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  selectedAppCopy: { flex: 1 },
  selectedAppName: { fontSize: 13.5, fontWeight: '800' },
  selectedAppPackage: { fontSize: 10.5, marginTop: 2 },
  mutedText: { fontSize: 12, lineHeight: 18, marginBottom: 8 },
  warningText: { color: '#A66A2C', fontSize: 11, marginBottom: 8 },
  successHint: { color: '#4E7A45', fontSize: 11, marginBottom: 8 },
  outlineButton: { borderRadius: 15, borderWidth: 1.5, paddingVertical: 13, alignItems: 'center', marginBottom: 16 },
  outlineButtonText: { fontSize: 13, fontWeight: '800' },
  appPicker: { borderTopWidth: 1, borderTopColor: '#00000010', paddingTop: 10 },
  appChoice: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  appChoiceGlyph: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: '800' },
  appChoiceName: { flex: 1, fontSize: 13, fontWeight: '600' },
  appChoiceArrow: { fontSize: 15 },
  primaryButton: { borderRadius: 17, paddingVertical: 16, alignItems: 'center', marginBottom: 12 },
  primaryButtonText: { fontSize: 15, fontWeight: '900' },
  secondaryButtonWide: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 15, borderWidth: 1.5, paddingVertical: 13 },
  shareButton: { width: 50, height: 50, borderRadius: 15, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  libraryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  libraryCard: { width: '47%', flexGrow: 1, borderRadius: 20, borderWidth: 1, padding: 12 },
  libraryOpen: { alignItems: 'center' },
  libraryIcon: { width: 72, height: 72, borderRadius: 20, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  librarySymbol: { color: '#FFFFFF', fontSize: 31 },
  libraryTitle: { fontSize: 13, fontWeight: '800', marginTop: 9 },
  libraryTarget: { fontSize: 10.5, marginTop: 3 },
  libraryActions: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 8, paddingTop: 4, borderTopWidth: 1, borderTopColor: '#00000010' },
  libraryAction: { paddingVertical: 6, paddingHorizontal: 10 },
  themeRow: { flexDirection: 'row', gap: 8, paddingVertical: 6 },
  emptyCard: { borderRadius: 24, borderWidth: 1, padding: 26, alignItems: 'center' },
  emptyPlus: { width: 58, height: 58, borderRadius: 19, backgroundColor: '#F4C542', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  emptyPlusText: { color: '#1F2A44', fontSize: 26, fontWeight: '800' },
  emptyTitle: { fontSize: 14, fontWeight: '800', marginBottom: 4 },
  settingsHero: { borderRadius: 24, padding: 22, alignItems: 'center', marginBottom: 16 },
  settingsTitle: { fontSize: 16, fontWeight: '900', marginTop: 10 },
  settingsSubtitle: { fontSize: 11, marginTop: 3 },
  settingsGroup: { borderRadius: 22, borderWidth: 1, padding: 16, marginBottom: 14 },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  settingGlyph: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  settingCopy: { flex: 1 },
  settingTitle: { fontSize: 13.5, fontWeight: '800' },
  settingSubtitle: { fontSize: 11, marginTop: 3, lineHeight: 16 },
  groupTitle: { fontSize: 11, fontWeight: '900', letterSpacing: 0.5, marginBottom: 6, marginTop: 2 },
  settingNote: { fontSize: 10.5, lineHeight: 15, marginTop: 4 },
  langValue: { fontSize: 13, fontWeight: '800' },
  paletteDots: { flexDirection: 'row', paddingHorizontal: 4 },
  paletteDot: {},
  dangerAction: { flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: 14, backgroundColor: '#A64D4312', paddingVertical: 12, paddingHorizontal: 14 },
  dangerActionText: { color: '#A64D43', fontSize: 13, fontWeight: '800' },
  bottomNav: { position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', borderTopWidth: 1, paddingTop: 8, paddingBottom: 10, paddingHorizontal: 10 },
  navItem: { flex: 1, alignItems: 'center', gap: 3 },
  navIconWrap: { width: 44, height: 30, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  navLabel: { fontSize: 10.5, fontWeight: '600' },
  busyOverlay: { position: 'absolute', inset: 0, backgroundColor: '#00000030', alignItems: 'center', justifyContent: 'center' },
  sheetBackdrop: { flex: 1, backgroundColor: '#00000055', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22 },
  sheetTitle: { fontSize: 16, fontWeight: '900' },
  sheetMsg: { fontSize: 12, lineHeight: 18, marginTop: 6 },
  sheetPacks: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 16 },
  sheetCancel: { alignItems: 'center', paddingVertical: 14, marginTop: 6 },
  sheetCancelText: { fontSize: 13, fontWeight: '800' },
  offscreenShot: { position: 'absolute', top: 0, left: -1000, width: 432, height: 432, opacity: 0.99 },
});
