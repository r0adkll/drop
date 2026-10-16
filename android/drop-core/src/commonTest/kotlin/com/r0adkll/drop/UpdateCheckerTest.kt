package com.r0adkll.drop

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlinx.coroutines.test.runTest

class UpdateCheckerTest {
  private val installed = InstalledBuild(
    applicationId = "com.example.trailhead",
    channel = "pr/142",
    runId = 38_829_996_658,
    signerSha256 = "3a".repeat(32),
    versionCode = 13_772,
  )

  private fun updateJson(requiresReinstall: String? = null) = """
    {"buildId":"Rt4wN8cZ","channel":"main","label":"Trailhead","versionName":"2.9.0","versionCode":718,
     "uploadedAt":"2026-10-16T01:20:29.786Z","headline":"Offline map tiles","commitSha":"9496dd5","pullRequest":null,
     "buildUrl":"https://drop.example.com/b/Rt4wN8cZ","fileSize":18497955,"fileSha256":"${"b".repeat(64)}",
     "downloadUrl":"https://drop.example.com/b/Rt4wN8cZ/download","downloadUrlExpiresAt":"2026-10-16T02:20:29.786Z"
     ${requiresReinstall?.let { ""","requiresReinstall":"$it"""" } ?: ""}}
  """.trimIndent()

  private fun checker(status: HttpStatusCode = HttpStatusCode.OK, body: String, onRequest: (String) -> Unit = {}) =
    UpdateChecker(
      serverUrl = "https://drop.example.com/",
      httpClientEngine = MockEngine { request ->
        onRequest(request.url.toString())
        respond(body, status, headersOf(HttpHeaders.ContentType, "application/json"))
      },
    )

  @Test
  fun sendsTheInstalledBuildAndReadsAnUpdate() = runTest {
    var url = ""
    val result = checker(body = """{"status":"update","update":${updateJson()}}""") { url = it }.check(installed)
    assertEquals(
      "https://drop.example.com/api/v1/update?applicationId=com.example.trailhead&channel=pr%2F142&runId=38829996658&signer=${"3a".repeat(32)}&versionCode=13772",
      url,
    )
    val update = assertIs<UpdateCheckResult.Available>(result).update
    assertEquals("Rt4wN8cZ", update.buildId)
    assertEquals(18_497_955, update.fileSize)
    assertNull(update.requiresReinstall)
  }

  @Test
  fun readsAnEndedChannelWithAReinstall() = runTest {
    val result = checker(body = """{"status":"channel_ended","update":${updateJson("signer")}}""").check(installed)
    assertEquals(ReinstallReason.Signer, assertIs<UpdateCheckResult.ChannelEnded>(result).update?.requiresReinstall)
    assertEquals(UpdateCheckResult.ChannelEnded(null), checker(body = """{"status":"channel_ended","update":null}""").check(installed))
  }

  @Test
  fun mapsUpToDateAndRefusals() = runTest {
    assertEquals(UpdateCheckResult.UpToDate, checker(body = """{"status":"up_to_date"}""").check(installed))
    assertEquals(UpdateCheckResult.UnknownProduct, checker(HttpStatusCode.NotFound, """{"code":"product_not_found","message":"x"}""").check(installed))
    assertEquals(UpdateCheckResult.SignInRequired, checker(HttpStatusCode.Forbidden, """{"code":"sign_in_required","message":"x"}""").check(installed))
    assertIs<UpdateCheckResult.Failed>(checker(HttpStatusCode.InternalServerError, """{"code":"internal","message":"x"}""").check(installed))
  }

  @Test
  fun survivesWhatANewerServerMightSay() = runTest {
    // An unknown reinstall reason drops to null rather than failing the whole answer.
    val result = checker(body = """{"status":"update","update":${updateJson("new_reason")},"extra":true}""").check(installed)
    assertNull(assertIs<UpdateCheckResult.Available>(result).update.requiresReinstall)
    assertIs<UpdateCheckResult.Failed>(checker(body = """{"status":"brand_new"}""").check(installed))
  }
}
