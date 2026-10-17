package com.r0adkll.drop

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.os.Build
import java.security.MessageDigest

/** What the installed Build is, read from Android and the app's [DropConfig]. */
internal fun installedBuild(context: Context, config: DropConfig): InstalledBuild {
  val info = packageInfo(context)
  return InstalledBuild(
    applicationId = context.packageName,
    channel = config.stamp?.channel ?: config.channel,
    runId = config.stamp?.runId,
    signerSha256 = signerSha256(info),
    versionCode = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong(),
    // Only a watch app runs on a watch, so the device says which Builds to be offered (ADR 0017).
    formFactor = if (context.packageManager.hasSystemFeature(PackageManager.FEATURE_WATCH)) FormFactor.Wear else FormFactor.Mobile,
  )
}

/** When the app was last installed or updated, which tells Drop that a downloaded Update went in. */
internal fun lastUpdateTime(context: Context): Long =
  context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime

private fun packageInfo(context: Context): PackageInfo {
  val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else @Suppress("DEPRECATION") PackageManager.GET_SIGNATURES
  return context.packageManager.getPackageInfo(context.packageName, flags)
}

/**
 * SHA-256 of the signing certificate, as the server records it from apksigner (ADR 0006). With a
 * rotated key this is the current one, the last in the signing history.
 */
internal fun signerSha256(info: PackageInfo): String {
  val signature: Signature? = if (Build.VERSION.SDK_INT >= 28) {
    val signing = info.signingInfo ?: error("Android reported no signing information.")
    if (signing.hasMultipleSigners()) {
      error("The app has more than one signer; Drop supports one signing certificate per Build.")
    }
    signing.signingCertificateHistory.lastOrNull()
  } else {
    @Suppress("DEPRECATION") info.signatures?.singleOrNull()
  }
  checkNotNull(signature) { "Android reported no signing certificate." }
  return sha256Hex(signature.toByteArray())
}

internal fun sha256Hex(bytes: ByteArray): String =
  MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
