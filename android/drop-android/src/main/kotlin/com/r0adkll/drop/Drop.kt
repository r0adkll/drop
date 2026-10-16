package com.r0adkll.drop

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import io.ktor.client.engine.okhttp.OkHttp
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Drop's SDK: checks for Updates, downloads them and installs them. It makes no decisions about
 * when to check or how to tell the Tester; the app calls [check] when it wants, shows its own
 * hints from [state], and starts the download and install when the Tester acts
 * (docs/design.md#sdk).
 *
 * Create one per process. Store variants get drop-noop, whose `Drop` has the same API and does
 * nothing.
 */
public class Drop(context: Context, private val config: DropConfig) {
  private val app = context.applicationContext
  private val store = DropStore(app)
  private val checker = UpdateChecker(config.serverUrl, OkHttp.create())
  private val downloads = app.getSystemService(DownloadManager::class.java)
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var watching: Job? = null

  private val mutableState = MutableStateFlow<DropState>(DropState.Idle)

  /** Where Drop is with an Update, for the app's own hints and the Update sheet alike. */
  public val state: StateFlow<DropState> = mutableState.asStateFlow()

  init {
    restore()
    scope.launch {
      InstallResults.results.collect { result ->
        val saved = store.load() ?: return@collect
        mutableState.value = when (result) {
          // Updating another package, or anything that leaves this process running.
          InstallResult.Succeeded -> {
            forget(saved)
            DropState.Idle
          }
          // The file stays, so installing can be tried again.
          is InstallResult.Failed -> DropState.Failed(result.message, saved.update)
        }
      }
    }
  }

  /** Asks the server whether there is an Update for this Build. */
  public suspend fun check(): UpdateCheckResult {
    val result = withContext(Dispatchers.IO) {
      try {
        checker.check(installedBuild(app, config))
      } catch (e: IllegalStateException) {
        UpdateCheckResult.Failed(e.message ?: "Drop couldn't read the installed app.", e)
      }
    }
    // A download or install in progress isn't interrupted by a check.
    val current = mutableState.value
    if (current is DropState.Idle || current is DropState.UpdateAvailable || current is DropState.Failed && store.load() == null) {
      mutableState.value = when (result) {
        is UpdateCheckResult.Available -> DropState.UpdateAvailable(result.update, result)
        is UpdateCheckResult.ReinstallRequired -> DropState.UpdateAvailable(result.update, result)
        is UpdateCheckResult.ChannelEnded -> result.update?.let { DropState.UpdateAvailable(it, result) } ?: DropState.Idle
        is UpdateCheckResult.Failed -> current
        else -> DropState.Idle
      }
    }
    return result
  }

  /**
   * Downloads [update] with Android's DownloadManager, so it continues while the app is in the
   * background or killed. Its SHA-256 is verified before it is offered for install.
   */
  public fun download(update: Update) {
    store.load()?.let(::forget)
    val name = "drop/${update.buildId}.apk"
    val file = File(app.getExternalFilesDir(null), name)
    file.delete()
    val request = DownloadManager.Request(Uri.parse(update.downloadUrl))
      .setTitle(listOfNotNull(update.label, update.versionName).joinToString(" "))
      .setDestinationInExternalFilesDir(app, null, name)
      .setMimeType("application/vnd.android.package-archive")
    val id = downloads.enqueue(request)
    store.save(SavedUpdate(update = update, downloadId = id, path = file.path))
    mutableState.value = DropState.Downloading(update, 0, update.fileSize)
    watch()
  }

  /** Whether Android lets this app install packages; if not, send the Tester to [installPermissionIntent]. */
  public fun canInstall(): Boolean = app.packageManager.canRequestPackageInstalls()

  /** Opens *Install unknown apps* for this app. */
  public fun installPermissionIntent(): Intent =
    Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${app.packageName}"))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

  /**
   * Installs the downloaded Update. Call it while the app is in the foreground: Android shows its
   * install confirmation only then. Returns false when there is nothing ready to install or the app
   * may not install packages yet ([canInstall]).
   */
  public fun install(): Boolean {
    val saved = store.load()?.takeIf { it.verifiedAt != null } ?: return false
    if (!canInstall()) return false
    val file = File(saved.path)
    if (!file.exists()) {
      forget(saved)
      mutableState.value = DropState.Failed("The downloaded Update is gone; download it again.", saved.update)
      return false
    }
    mutableState.value = DropState.Installing(saved.update)
    scope.launch {
      try {
        withContext(Dispatchers.IO) { installApk(app, file) }
      } catch (e: Exception) {
        mutableState.value = DropState.Failed(e.message ?: "The install couldn't start.", saved.update)
      }
    }
    return true
  }

  /** Cancels any download, deletes the downloaded file and goes back to idle. */
  public fun reset() {
    store.load()?.let(::forget)
    mutableState.value = DropState.Idle
  }

  private fun restore() {
    val saved = store.load() ?: return
    when {
      saved.verifiedAt == null -> {
        mutableState.value = DropState.Downloading(saved.update, 0, saved.update.fileSize)
        watch()
      }
      // Android updated the app since the file was verified: the Update went in.
      lastUpdateTime(app) > saved.verifiedAt -> forget(saved)
      File(saved.path).exists() -> mutableState.value = DropState.ReadyToInstall(saved.update)
      else -> forget(saved)
    }
  }

  /** Follows the saved download until it finishes, then verifies it. */
  private fun watch() {
    watching?.cancel()
    watching = scope.launch {
      while (true) {
        val saved = store.load() ?: return@launch
        val progress = withContext(Dispatchers.IO) { query(saved.downloadId) }
        when (progress) {
          null -> {
            forget(saved)
            mutableState.value = DropState.Failed("The download was cancelled.", saved.update)
            return@launch
          }
          is DownloadProgress.Running -> mutableState.value = DropState.Downloading(saved.update, progress.downloaded, progress.total ?: saved.update.fileSize)
          is DownloadProgress.Failed -> {
            forget(saved)
            val expired = System.currentTimeMillis() > saved.update.downloadUrlExpiresAt.toEpochMilliseconds()
            mutableState.value = DropState.Failed(
              if (expired) "The download link expired; check for the Update again." else "The download failed (DownloadManager reason ${progress.reason}).",
              saved.update,
            )
            return@launch
          }
          DownloadProgress.Done -> {
            val file = File(saved.path)
            val matches = withContext(Dispatchers.IO) { file.exists() && sha256Hex(file) == saved.update.fileSha256 }
            if (matches) {
              store.save(saved.copy(verifiedAt = System.currentTimeMillis()))
              mutableState.value = DropState.ReadyToInstall(saved.update)
            } else {
              forget(saved)
              mutableState.value = DropState.Failed("The downloaded file doesn't match the Update's SHA-256.", saved.update)
            }
            return@launch
          }
        }
        delay(500)
      }
    }
  }

  private fun query(id: Long): DownloadProgress? =
    downloads.query(DownloadManager.Query().setFilterById(id))?.use { cursor ->
      if (!cursor.moveToFirst()) return null
      val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
      when (status) {
        DownloadManager.STATUS_SUCCESSFUL -> DownloadProgress.Done
        DownloadManager.STATUS_FAILED -> DownloadProgress.Failed(cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON)))
        else -> DownloadProgress.Running(
          downloaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)),
          total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)).takeIf { it > 0 },
        )
      }
    }

  /** Drops the saved Update: cancels its download if running and deletes its file. */
  private fun forget(saved: SavedUpdate) {
    watching?.cancel()
    if (saved.verifiedAt == null) downloads.remove(saved.downloadId)
    File(saved.path).delete()
    store.clear()
  }
}

private sealed interface DownloadProgress {
  data class Running(val downloaded: Long, val total: Long?) : DownloadProgress
  data class Failed(val reason: Int) : DownloadProgress
  data object Done : DownloadProgress
}

private fun sha256Hex(file: File): String {
  val digest = MessageDigest.getInstance("SHA-256")
  file.inputStream().use { input ->
    val buffer = ByteArray(1 shl 16)
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      digest.update(buffer, 0, read)
    }
  }
  return digest.digest().joinToString("") { "%02x".format(it) }
}
