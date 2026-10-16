package com.r0adkll.drop

/**
 * Where Drop is with an Update, shared by the app and the Update sheet so the app's own hints and
 * the sheet always agree (docs/design.md#sdk).
 */
public sealed interface DropState {
  /** Nothing in progress, and no Update known. */
  public data object Idle : DropState

  /** The last check offered [update]; [result] says how (an Update, a switch after a Channel ended, a reinstall). */
  public data class UpdateAvailable(val update: Update, val result: UpdateCheckResult) : DropState

  /** Downloading [update]; [totalBytes] is its file size. */
  public data class Downloading(val update: Update, val downloadedBytes: Long, val totalBytes: Long) : DropState {
    public val progress: Float get() = if (totalBytes > 0) (downloadedBytes.toFloat() / totalBytes).coerceIn(0f, 1f) else 0f
  }

  /** [update] is downloaded and verified. Installing it needs the app in the foreground. */
  public data class ReadyToInstall(val update: Update) : DropState

  /** Android's install confirmation is showing, or the install is running. */
  public data class Installing(val update: Update) : DropState

  /** Something failed; [update] is what it was for, if anything. */
  public data class Failed(val message: String, val update: Update? = null) : DropState
}
