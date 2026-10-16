package com.r0adkll.drop

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow

/** The outcome of an install session, as Android reports it. */
internal sealed interface InstallResult {
  data object Succeeded : InstallResult
  data class Failed(val message: String) : InstallResult
}

/** Install results, from the receiver to whichever Drop is waiting. */
internal object InstallResults {
  private val flow = MutableSharedFlow<InstallResult>(extraBufferCapacity = 4)
  val results: SharedFlow<InstallResult> = flow
  fun emit(result: InstallResult) {
    flow.tryEmit(result)
  }
}

/**
 * Installs an APK through a PackageInstaller session. Android then asks the Tester to confirm,
 * which it can show only while the app is in the foreground (docs/implementation-notes.md#android).
 */
internal fun installApk(context: Context, apk: File) {
  val installer = context.packageManager.packageInstaller
  val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
    setSize(apk.length())
  }
  val sessionId = installer.createSession(params)
  installer.openSession(sessionId).use { session ->
    apk.inputStream().use { input ->
      session.openWrite("app.apk", 0, apk.length()).use { output ->
        input.copyTo(output)
        session.fsync(output)
      }
    }
    // Android fills in the result's extras, so the PendingIntent must be mutable.
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
    val intent = Intent(context, InstallResultReceiver::class.java).setPackage(context.packageName)
    session.commit(PendingIntent.getBroadcast(context, sessionId, intent, flags).intentSender)
  }
}

/** Receives a session's status: shows Android's confirmation when asked, and reports the result. */
internal class InstallResultReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirm = if (Build.VERSION.SDK_INT >= 33) {
          intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
          @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }
        if (confirm == null) {
          InstallResults.emit(InstallResult.Failed("Android didn't provide its install confirmation."))
        } else {
          context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
      }
      PackageInstaller.STATUS_SUCCESS -> InstallResults.emit(InstallResult.Succeeded)
      else -> {
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        InstallResults.emit(InstallResult.Failed(installFailure(status, message)))
      }
    }
  }
}

private fun installFailure(status: Int, message: String?): String = when (status) {
  PackageInstaller.STATUS_FAILURE_ABORTED -> "The install was cancelled."
  PackageInstaller.STATUS_FAILURE_CONFLICT -> "The Update conflicts with the installed app; uninstall it first."
  PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "The Update isn't compatible with this device."
  PackageInstaller.STATUS_FAILURE_STORAGE -> "There isn't enough storage to install the Update."
  PackageInstaller.STATUS_FAILURE_BLOCKED -> "Installing was blocked on this device."
  PackageInstaller.STATUS_FAILURE_INVALID -> "The downloaded APK is invalid."
  else -> message ?: "The install failed."
}
