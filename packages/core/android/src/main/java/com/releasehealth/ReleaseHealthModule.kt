package com.releasehealth

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Bundle
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.atomic.AtomicInteger

private const val PREFS_NAME = "release_health_prefs"
private const val KEY_CLEAN_EXIT = "clean_exit"
private const val KEY_PENDING_UPDATE_ID = "pending_update_id"
private const val KEY_PENDING_UPDATE_DOWNLOADED_AT = "pending_update_downloaded_at"
private const val KEY_LAUNCH_COUNT = "launch_count_since_update"

class ReleaseHealthModule(reactContext: ReactApplicationContext) :
  NativeReleaseHealthSpec(reactContext) {

  private val prefs =
    reactContext.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

  // Captured once, before this launch resets the persisted flag below.
  // Defaults to true so a first-ever launch is never flagged abnormal.
  private val previousCleanExit: Boolean = prefs.getBoolean(KEY_CLEAN_EXIT, true)

  private val startedActivityCount = AtomicInteger(0)

  init {
    prefs.edit().putBoolean(KEY_CLEAN_EXIT, false).apply()
    registerLifecycleCallbacks()
  }

  // No activity visible ⇒ the app is backgrounding gracefully, without
  // requiring the host app to wire up its own Application/Activity classes.
  private fun registerLifecycleCallbacks() {
    val application = reactApplicationContext.applicationContext as? Application ?: return

    application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
      override fun onActivityStarted(activity: Activity) {
        startedActivityCount.incrementAndGet()
      }

      override fun onActivityStopped(activity: Activity) {
        if (startedActivityCount.decrementAndGet() <= 0) {
          prefs.edit().putBoolean(KEY_CLEAN_EXIT, true).apply()
        }
      }

      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
      override fun onActivityResumed(activity: Activity) {}
      override fun onActivityPaused(activity: Activity) {}
      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
      override fun onActivityDestroyed(activity: Activity) {}
    })
  }

  override fun getBuildInfo(): WritableMap {
    val context = reactApplicationContext
    val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
    val buildNumber = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageInfo.longVersionCode.toString()
    } else {
      @Suppress("DEPRECATION")
      packageInfo.versionCode.toString()
    }

    val map = Arguments.createMap()
    map.putString("version", packageInfo.versionName ?: "")
    map.putString("buildNumber", buildNumber)
    map.putString("bundleIdentifier", context.packageName)
    return map
  }

  override fun getPreviousCleanExit(): Boolean = previousCleanExit

  override fun getPendingUpdate(): WritableMap? {
    val updateId = prefs.getString(KEY_PENDING_UPDATE_ID, null) ?: return null
    val downloadedAt = prefs.getLong(KEY_PENDING_UPDATE_DOWNLOADED_AT, 0L)

    val map = Arguments.createMap()
    map.putString("updateId", updateId)
    map.putDouble("downloadedAt", downloadedAt.toDouble())
    return map
  }

  override fun setPendingUpdate(updateId: String, downloadedAt: Double) {
    prefs.edit()
      .putString(KEY_PENDING_UPDATE_ID, updateId)
      .putLong(KEY_PENDING_UPDATE_DOWNLOADED_AT, downloadedAt.toLong())
      .apply()
  }

  override fun clearPendingUpdate() {
    prefs.edit()
      .remove(KEY_PENDING_UPDATE_ID)
      .remove(KEY_PENDING_UPDATE_DOWNLOADED_AT)
      .apply()
  }

  override fun getLaunchCountSinceUpdate(): Double =
    prefs.getInt(KEY_LAUNCH_COUNT, 0).toDouble()

  override fun incrementLaunchCountSinceUpdate(): Double {
    val next = prefs.getInt(KEY_LAUNCH_COUNT, 0) + 1
    prefs.edit().putInt(KEY_LAUNCH_COUNT, next).apply()
    return next.toDouble()
  }

  override fun resetLaunchCountSinceUpdate() {
    prefs.edit().putInt(KEY_LAUNCH_COUNT, 0).apply()
  }

  companion object {
    const val NAME = NativeReleaseHealthSpec.NAME
  }
}
