const { withAndroidManifest } = require("@expo/config-plugins");

module.exports = function withIconChangerQueries(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    manifest.queries = manifest.queries || [];
    const queries = manifest.queries;
    const hasLauncherQuery = queries.some((query) =>
      (query.intent || []).some((intent) =>
        (intent.action || []).some((action) => action.$?.["android:name"] === "android.intent.action.MAIN") &&
        (intent.category || []).some((category) => category.$?.["android:name"] === "android.intent.category.LAUNCHER")
      )
    );

    if (!hasLauncherQuery) {
      const launcherIntent = {
        action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
        category: [{ $: { "android:name": "android.intent.category.LAUNCHER" } }]
      };
      if (queries.length > 0) {
        queries[0].intent = [...(queries[0].intent || []), launcherIntent];
      } else {
        queries.push({ intent: [launcherIntent] });
      }
    }
    return mod;
  });
};
