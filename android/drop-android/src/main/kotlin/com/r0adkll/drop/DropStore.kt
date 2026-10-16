package com.r0adkll.drop

import android.content.Context
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The download or downloaded Update, saved so it survives process death: a download that finishes
 * in the background is what `state` starts from on the next launch (docs/design.md#sdk).
 */
@Serializable
internal data class SavedUpdate(
  val update: Update,
  /** DownloadManager's ID for the download. */
  val downloadId: Long,
  /** Where the APK is saved, under the app's external files directory. */
  val path: String,
  /** Set once the file is downloaded and its SHA-256 verified. */
  val verifiedAt: Long? = null,
)

internal class DropStore(context: Context) {
  private val preferences = context.getSharedPreferences("com.r0adkll.drop", Context.MODE_PRIVATE)

  fun load(): SavedUpdate? = preferences.getString(KEY, null)?.let { json ->
    runCatching { JSON.decodeFromString(SavedUpdate.serializer(), json) }.getOrNull()
  }

  fun save(saved: SavedUpdate) {
    preferences.edit().putString(KEY, JSON.encodeToString(SavedUpdate.serializer(), saved)).apply()
  }

  fun clear() {
    preferences.edit().remove(KEY).apply()
  }

  private companion object {
    const val KEY = "saved_update"
    val JSON = Json { ignoreUnknownKeys = true }
  }
}
