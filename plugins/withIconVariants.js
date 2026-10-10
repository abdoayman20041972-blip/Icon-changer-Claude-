const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const VARIANTS = ['gold', 'navy', 'cream', 'coral'];

const LAUNCHER_INTENT_FILTER = {
  action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
  category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
};

function withIconVariants(config) {
  // 1. Copy variant launcher icons into the Android resources.
  config = withDangerousMod(config, [
    'android',
    (dangerousConfig) => {
      const projectRoot = dangerousConfig.modRequest.projectRoot;
      const destination = path.join(projectRoot, 'android', 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi');
      fs.mkdirSync(destination, { recursive: true });
      const assetsDir = path.join(projectRoot, 'plugins', 'withIconVariants');
      for (const variant of VARIANTS) {
        const source = path.join(assetsDir, `icon_variant_${variant}.png`);
        fs.copyFileSync(source, path.join(destination, `icon_variant_${variant}.png`));
      }
      return dangerousConfig;
    },
  ]);

  // 2. Declare one disabled activity-alias per variant so the native module can
  //    switch the real launcher icon at runtime via setComponentEnabledSetting.
  config = withAndroidManifest(config, (manifestConfig) => {
    const manifest = manifestConfig.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) return manifestConfig;
    const mainActivity = application.activity?.find(
      (activity) => activity.$['android:name'] === '.MainActivity',
    );
    const existing = application['activity-alias'] ?? [];
    const aliases = VARIANTS.map((variant) => ({
      $: {
        'android:name': `.MainActivity${variant.charAt(0).toUpperCase()}${variant.slice(1)}`,
        'android:enabled': 'false',
        'android:exported': 'true',
        'android:icon': `@mipmap/icon_variant_${variant}`,
        'android:label': mainActivity?.$['android:label'] ?? '@string/app_name',
        'android:targetActivity': '.MainActivity',
      },
      'intent-filter': [LAUNCHER_INTENT_FILTER],
    }));
    application['activity-alias'] = [
      ...existing.filter(
        (alias) => !VARIANTS.some((variant) => alias.$['android:name'] === `.MainActivity${variant.charAt(0).toUpperCase()}${variant.slice(1)}`),
      ),
      ...aliases,
    ];
    return manifestConfig;
  });

  return config;
}

module.exports = withIconVariants;
