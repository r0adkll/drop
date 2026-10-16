package com.r0adkll.drop

import androidx.test.core.app.ApplicationProvider
import kotlin.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DropStoreTest {
  private val update = Update(
    buildId = "Rt4wN8cZ",
    channel = "main",
    label = "Trailhead",
    versionName = "2.9.0",
    versionCode = 4130,
    uploadedAt = Instant.parse("2026-10-16T01:20:29.786Z"),
    headline = "Offline map tiles",
    commitSha = "9496dd5",
    pullRequest = null,
    buildUrl = "https://drop.example.com/b/Rt4wN8cZ",
    fileSize = 18_497_955,
    fileSha256 = "b".repeat(64),
    downloadUrl = "https://drop.example.com/b/Rt4wN8cZ/download",
    downloadUrlExpiresAt = Instant.parse("2026-10-16T02:20:29.786Z"),
    requiresReinstall = ReinstallReason.VersionCode,
  )

  @Test
  fun keepsTheSavedUpdateAcrossInstances() {
    val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    val saved = SavedUpdate(update, downloadId = 42, path = "/files/drop/Rt4wN8cZ.apk", verifiedAt = 1_000)
    DropStore(context).save(saved)
    assertEquals(saved, DropStore(context).load())
    DropStore(context).clear()
    assertNull(DropStore(context).load())
  }

  @Test
  fun hashesLikeTheServer() {
    assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", sha256Hex(ByteArray(0)))
  }
}
