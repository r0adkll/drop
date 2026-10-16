package com.r0adkll.drop

import com.r0adkll.drop.api.apis.DefaultApi
import com.r0adkll.drop.api.models.UpdateCheck
import io.ktor.client.engine.HttpClientEngine
import io.ktor.serialization.ContentConvertException
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import com.r0adkll.drop.api.models.Update as ApiUpdate

/** Asks a Drop server's Update check (docs/design.md#update-check) about an installed Build. */
public class UpdateChecker(
  serverUrl: String,
  httpClientEngine: HttpClientEngine? = null,
) {
  private val api = DefaultApi(baseUrl = serverUrl.trimEnd('/'), httpClientEngine = httpClientEngine, jsonSerializer = JSON)

  public suspend fun check(installed: InstalledBuild): UpdateCheckResult {
    val response = try {
      api.checkForUpdate(
        applicationId = installed.applicationId,
        channel = installed.channel,
        signer = installed.signerSha256,
        versionCode = installed.versionCode.toInt(),
        runId = installed.runId,
      )
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      return UpdateCheckResult.Failed("The Update check couldn't reach the server.", e)
    }
    when (response.status) {
      404 -> return UpdateCheckResult.UnknownProduct
      403 -> return UpdateCheckResult.SignInRequired
    }
    if (!response.success) return UpdateCheckResult.Failed("The server answered the Update check with HTTP ${response.status}.")
    val body = try {
      response.body()
    } catch (e: SerializationException) {
      return UpdateCheckResult.Failed("The server's answer is newer than this SDK understands.", e)
    } catch (e: ContentConvertException) {
      // Ktor wraps a decode failure in its own exception.
      return UpdateCheckResult.Failed("The server's answer is newer than this SDK understands.", e)
    }
    val update = body.update?.toUpdate()
    return when (body.status) {
      UpdateCheck.Status.up_to_date -> UpdateCheckResult.UpToDate
      UpdateCheck.Status.update -> update?.let(UpdateCheckResult::Available) ?: missingUpdate()
      UpdateCheck.Status.reinstall_required -> update?.let(UpdateCheckResult::ReinstallRequired) ?: missingUpdate()
      UpdateCheck.Status.channel_ended -> UpdateCheckResult.ChannelEnded(update)
      UpdateCheck.Status.unknown_default_open_api -> UpdateCheckResult.Failed("The server's answer is newer than this SDK understands.")
    }
  }

  private fun missingUpdate() = UpdateCheckResult.Failed("The server's answer has no Update.")

  private companion object {
    // An unknown requiresReinstall reason decodes as null (coerceInputValues) rather than failing.
    // The generated enums carry an unknown case but no serializer that falls back to it.
    val JSON = Json {
      ignoreUnknownKeys = true
      coerceInputValues = true
    }
  }
}

private fun ApiUpdate.toUpdate() = Update(
  buildId = buildId,
  channel = channel,
  label = label,
  versionName = versionName,
  versionCode = versionCode.toLong(),
  uploadedAt = uploadedAt,
  headline = headline,
  commitSha = commitSha,
  pullRequest = pullRequest,
  buildUrl = buildUrl,
  fileSize = fileSize,
  fileSha256 = fileSha256,
  downloadUrl = downloadUrl,
  downloadUrlExpiresAt = downloadUrlExpiresAt,
  requiresReinstall = when (requiresReinstall) {
    null -> null
    ApiUpdate.RequiresReinstall.version_code -> ReinstallReason.VersionCode
    ApiUpdate.RequiresReinstall.signer -> ReinstallReason.Signer
    ApiUpdate.RequiresReinstall.unknown_default_open_api -> ReinstallReason.Unknown
  },
)
