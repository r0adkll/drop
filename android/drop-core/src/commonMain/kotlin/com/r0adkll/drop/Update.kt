package com.r0adkll.drop

import kotlin.time.Instant
import kotlinx.serialization.Serializable

/**
 * What Drop knows about the installed Build: its Product, the Channel it follows, the run ID from its
 * Stamp (null for a Build with no Stamp), its Signer and its version code.
 */
public data class InstalledBuild(
  val applicationId: String,
  val channel: String,
  val runId: Long?,
  /** SHA-256 of the installed app's signing certificate, in lowercase hex. */
  val signerSha256: String,
  val versionCode: Long,
)

/** A newer Build offered to the installed Build by an Update check. */
@Serializable
public data class Update(
  val buildId: String,
  val channel: String,
  /** The app's name as Drop shows it. */
  val label: String,
  val versionName: String?,
  val versionCode: Long,
  val uploadedAt: Instant,
  /**
   * What changed: the first line of the Build's release notes, else the pull request title, else the
   * commit message's first line, else the app's name.
   */
  val headline: String,
  val commitSha: String,
  /** The pull request number, for a Build on a Pull request channel. */
  val pullRequest: Int?,
  val buildUrl: String,
  val fileSize: Long,
  /** The APK's SHA-256 in lowercase hex, verified before installing. */
  val fileSha256: String,
  val downloadUrl: String,
  /** When [downloadUrl] stops working; check again for a fresh one after this. */
  val downloadUrlExpiresAt: Instant,
  /** Why it can't install over the installed Build, which means uninstalling first; null when it can. */
  val requiresReinstall: ReinstallReason?,
  /** The rest of the Build's release notes after [headline], as plain text; null when there are none. */
  val whatsNew: String? = null,
)

@Serializable
public enum class ReinstallReason {
  /** Its version code is lower, and Android refuses a downgrade. */
  VersionCode,

  /** It is signed with a different certificate. */
  Signer,

  /** A reason this SDK doesn't know yet. */
  Unknown,
}

/** The answer to an Update check. */
public sealed interface UpdateCheckResult {
  /** No newer Build on the Channel. */
  public data object UpToDate : UpdateCheckResult

  /** A newer Build with the installed Signer. */
  public data class Available(val update: Update) : UpdateCheckResult

  /**
   * The Channel's pull request has closed. [update] is the default Channel's newest Build to switch
   * to, or null when it has none; the app asks the Tester whether to switch.
   */
  public data class ChannelEnded(val update: Update?) : UpdateCheckResult

  /** Every newer Build is signed differently; [update] is the newest, installable only after uninstalling. */
  public data class ReinstallRequired(val update: Update) : UpdateCheckResult

  /** The Product's Builds need sign-in, which this server doesn't offer yet. */
  public data object SignInRequired : UpdateCheckResult

  /** The server has no such Product: nothing has been uploaded for this application ID. */
  public data object UnknownProduct : UpdateCheckResult

  /** The check couldn't be answered: no network, a server error, or an answer this SDK is too old for. */
  public data class Failed(val message: String, val cause: Throwable? = null) : UpdateCheckResult
}
