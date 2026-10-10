package com.abdoayman.iconchanger.nativebridge

import android.app.PendingIntent
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.net.Uri
import java.io.File
import android.os.Build
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.graphics.drawable.toBitmap
import java.io.ByteArrayOutputStream
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class ShortcutRequest : Record {
  @Field var id: String = ""
  @Field var label: String = ""
  @Field var targetPackage: String = ""
  @Field var iconUri: String? = null
  @Field var symbol: String = "✦"
  @Field var backgroundColor: String = "#6D5DFB"
}

class IconRenderRequest : Record {
  @Field var iconUri: String? = null
  @Field var symbol: String = "✦"
  @Field var backgroundColor: String = "#F4C542"
}

class IconChangerNativeModule : Module() {
  private val iconVariantAliases = listOf("Gold", "Navy", "Cream", "Coral")

  override fun definition() = ModuleDefinition {
    Name("IconChangerNative")

    AsyncFunction("getLaunchableApps") {
      val context = appContext.reactContext ?: return@AsyncFunction emptyList<Map<String, String>>()
      val intent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
      val pm = context.packageManager
      val activities = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pm.queryIntentActivities(intent, PackageManager.ResolveInfoFlags.of(0))
      } else {
        @Suppress("DEPRECATION")
        pm.queryIntentActivities(intent, 0)
      }

      activities
        .filter { it.activityInfo.packageName != context.packageName }
        .distinctBy { it.activityInfo.packageName }
        .map { info ->
          mapOf(
            "packageName" to info.activityInfo.packageName,
            "label" to info.loadLabel(pm).toString()
          )
        }
        .sortedBy { it["label"]?.lowercase() ?: "" }
    }

    // Real launcher icon of an installed app as a base64 PNG (null when it cannot be loaded).
    AsyncFunction("getAppIcon").Coroutine { packageName: String ->
      withContext(Dispatchers.IO) {
        val context = appContext.reactContext ?: return@withContext null
        try {
          val drawable = context.packageManager.getApplicationIcon(packageName)
          val bitmap = drawable.toBitmap(96, 96)
          val stream = ByteArrayOutputStream()
          bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
          android.util.Base64.encodeToString(stream.toByteArray(), android.util.Base64.NO_WRAP)
        } catch (_: Exception) {
          null
        }
      }
    }

      AsyncFunction("getLauncherIcon") {
    val context = appContext.reactContext ?: return@AsyncFunction null
    val pm = context.packageManager
    iconVariantAliases.firstOrNull { alias ->
      pm.getComponentEnabledSetting(ComponentName(context.packageName, "${context.packageName}.MainActivity$alias")) ==
        PackageManager.COMPONENT_ENABLED_STATE_ENABLED
    }
  }

  AsyncFunction("setLauncherIcon").Coroutine { variant: String ->
    withContext(Dispatchers.IO) {
      val context = appContext.reactContext
        ?: throw CodedException("E_NO_CONTEXT", "Android context is unavailable", null)
      val normalized = variant.replaceFirstChar { it.uppercase() }
      if (normalized !in iconVariantAliases) {
        throw CodedException("E_INVALID_VARIANT", "Unknown icon variant: $variant", null)
      }
      val pm = context.packageManager
      for (alias in iconVariantAliases) {
        val component = ComponentName(context.packageName, "${context.packageName}.MainActivity$alias")
        val state = if (alias == normalized) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
        else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        pm.setComponentEnabledSetting(component, state, PackageManager.DONT_KILL_APP)
      }
      pm.setComponentEnabledSetting(
        ComponentName(context.packageName, "${context.packageName}.MainActivity"),
        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
        PackageManager.DONT_KILL_APP
      )
      true
    }
  }

  AsyncFunction("isShortcutSupported") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      ShortcutManagerCompat.isRequestPinShortcutSupported(context)
    }

    AsyncFunction("renderIconToFile").Coroutine { request: IconRenderRequest ->
      withContext(Dispatchers.IO) {
        val context = appContext.reactContext
          ?: throw CodedException("E_NO_CONTEXT", "Android context is unavailable", null)
        val bitmap = renderBitmap(context, request.iconUri, request.symbol, request.backgroundColor)
        val output = File(context.cacheDir, "icon-design-${System.currentTimeMillis()}.png")
        output.outputStream().use { stream ->
          if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) {
            throw CodedException("E_RENDER_FAILED", "Could not encode the icon image", null)
          }
        }
        bitmap.recycle()
        Uri.fromFile(output).toString()
      }
    }

    AsyncFunction("pinAppShortcut").Coroutine { request: ShortcutRequest ->
      withContext(Dispatchers.IO) {
        val context = appContext.reactContext
          ?: throw CodedException("E_NO_CONTEXT", "Android context is unavailable", null)

        if (request.id.isBlank() || request.label.isBlank() || request.targetPackage.isBlank()) {
          throw CodedException("E_INVALID_ARGS", "Shortcut id, label, and target package are required", null)
        }

        if (!ShortcutManagerCompat.isRequestPinShortcutSupported(context)) {
          throw CodedException("E_UNSUPPORTED", "This launcher does not support pinned shortcuts", null)
        }

        val targetIntent = context.packageManager.getLaunchIntentForPackage(request.targetPackage)
          ?: throw CodedException("E_APP_NOT_FOUND", "The selected app has no launchable activity", null)
        targetIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        val shortcutIcon = buildIcon(context, request)
        val shortcut = ShortcutInfoCompat.Builder(context, "custom-${request.id}")
          .setShortLabel(request.label.take(40))
          .setLongLabel(request.label.take(80))
          .setIcon(shortcutIcon)
          .setIntent(targetIntent)
          .setActivity(launcherComponent(context))
          .build()

        ShortcutManagerCompat.requestPinShortcut(context, shortcut, null)
      }
    }
  }

  private fun launcherComponent(context: Context): ComponentName {
    // The launcher entry may be MainActivity itself or one of the icon-variant
    // aliases, depending on the user's icon choice. Shortcut pinning requires
    // the currently enabled main launcher activity.
    val pm = context.packageManager
    pm.getLaunchIntentForPackage(context.packageName)?.component?.let { return it }
    val candidates = listOf("MainActivity") + iconVariantAliases.map { "MainActivity$it" }
    return candidates
      .map { ComponentName(context.packageName, "${context.packageName}.$it") }
      .firstOrNull { component ->
        pm.getComponentEnabledSetting(component) != PackageManager.COMPONENT_ENABLED_STATE_DISABLED
      } ?: ComponentName(context.packageName, "${context.packageName}.MainActivity")
  }

  private fun buildIcon(context: Context, request: ShortcutRequest): IconCompat =
    IconCompat.createWithAdaptiveBitmap(renderBitmap(context, request.iconUri, request.symbol, request.backgroundColor))

  private fun renderBitmap(context: Context, iconUri: String?, symbol: String, backgroundColor: String): Bitmap {
    val size = 432
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val background = try {
      Color.parseColor(backgroundColor)
    } catch (_: Exception) {
      Color.rgb(244, 197, 66)
    }
    canvas.drawColor(background)

    val source = iconUri?.takeIf { it.isNotBlank() }?.let { uriString ->
      try {
        context.contentResolver.openInputStream(Uri.parse(uriString))?.use { BitmapFactory.decodeStream(it) }
      } catch (_: Exception) {
        null
      }
    }

    if (source != null) {
      val padding = 82f
      val target = RectF(padding, padding, size - padding, size - padding)
      val scale = minOf(target.width() / source.width, target.height() / source.height)
      val width = source.width * scale
      val height = source.height * scale
      val destination = RectF(
        (size - width) / 2f,
        (size - height) / 2f,
        (size + width) / 2f,
        (size + height) / 2f
      )
      canvas.drawBitmap(source, null, destination, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
      source.recycle()
    } else {
      val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textAlign = Paint.Align.CENTER
        textSize = 190f
      }
      val baseline = size / 2f - (paint.ascent() + paint.descent()) / 2f
      canvas.drawText(symbol.ifBlank { "✦" }.take(4), size / 2f, baseline, paint)
    }
    return bitmap
  }
}
