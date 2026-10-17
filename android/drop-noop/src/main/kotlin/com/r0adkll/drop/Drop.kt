package com.r0adkll.drop

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * drop-android's `Drop` for store variants, with the same API: it never checks, downloads or
 * installs, and its state stays idle. Keep its public API identical to drop-android's.
 */
@Suppress("UNUSED_PARAMETER")
public class Drop(context: Context, config: DropConfig) {
  /** Matches drop-android's constructor, without reading the manifest, so a store build can't fail here. */
  public constructor(context: Context) : this(context, DropConfig(serverUrl = ""))

  private val packageName = context.packageName

  public val state: StateFlow<DropState> = MutableStateFlow<DropState>(DropState.Idle).asStateFlow()

  /** Always up to date: store builds update through the store. */
  public suspend fun check(): UpdateCheckResult = UpdateCheckResult.UpToDate

  public fun download(update: Update) {}

  public fun canInstall(): Boolean = false

  public fun installPermissionIntent(): Intent =
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

  public fun asksToConfirmInstall(): Boolean = true

  public fun install(): Boolean = false

  public fun reset() {}
}
