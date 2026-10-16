package com.r0adkll.drop

import android.content.Context
import android.content.pm.PackageManager

/**
 * The manifest meta-data the Gradle plugin writes for each variant (docs/design.md#gradle-plugin).
 * A value aapt2 can read as a number is stored as one, so every value is read with toString().
 */
public object DropManifest {
  public const val SERVER_URL: String = "com.r0adkll.drop.SERVER_URL"
  public const val CHANNEL: String = "com.r0adkll.drop.CHANNEL"
  public const val STAMP_CHANNEL: String = "com.r0adkll.drop.STAMP_CHANNEL"
  public const val STAMP_RUN_ID: String = "com.r0adkll.drop.STAMP_RUN_ID"

  /** The config the plugin wrote into the app's manifest. */
  public fun read(context: Context): DropConfig {
    val metaData = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData
    fun value(name: String): String? = metaData?.get(name)?.toString()?.takeIf { it.isNotEmpty() }
    val serverUrl = value(SERVER_URL)
      ?: error("The manifest has no $SERVER_URL. Apply the com.r0adkll.drop Gradle plugin and set drop { serverUrl }, or pass a DropConfig.")
    val stampChannel = value(STAMP_CHANNEL)
    val stampRunId = value(STAMP_RUN_ID)?.toLongOrNull()
    return DropConfig(
      serverUrl = serverUrl,
      channel = value(CHANNEL) ?: "main",
      stamp = if (stampChannel != null && stampRunId != null) Stamp(stampChannel, stampRunId) else null,
    )
  }
}
