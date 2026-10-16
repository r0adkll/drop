package com.r0adkll.drop.gradle

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CiStampTest {
  private val push = CiEnvironment(
    runId = "38836125518",
    eventName = "push",
    ref = "refs/heads/main",
    refName = "main",
    eventPayload = """{"ref":"refs/heads/main","repository":{"default_branch":"main"}}""",
    dropChannel = null,
  )

  @Test
  fun stampsDefaultBranchRunsOnMain() {
    assertEquals(StampResult.Stamped(Stamp("main", 38_836_125_518)), stampOf(push))
    assertEquals(StampResult.Stamped(Stamp("main", 38_836_125_518)), stampOf(push.copy(eventName = "schedule", eventPayload = null)))
  }

  @Test
  fun stampsPullRequestsOnTheirChannel() {
    val pr = push.copy(eventName = "pull_request", ref = "refs/pull/142/merge", refName = "142/merge")
    assertEquals(StampResult.Stamped(Stamp("pr/142", 38_836_125_518)), stampOf(pr))
  }

  @Test
  fun prefersDropChannel() {
    assertEquals(StampResult.Stamped(Stamp("beta", 38_836_125_518)), stampOf(push.copy(dropChannel = "beta")))
    assertEquals(StampResult.Stamped(Stamp("main", 38_836_125_518)), stampOf(push.copy(dropChannel = " ")))
  }

  @Test
  fun leavesLocalBuildsUnstamped() {
    assertEquals(StampResult.NotCi, stampOf(push.copy(runId = null)))
  }

  @Test
  fun refusesRunsWithNoChannelLikeTheAction() {
    val branch = push.copy(ref = "refs/heads/feature", refName = "feature")
    assertTrue(stampOf(branch) is StampResult.NoChannel)
    assertTrue(stampOf(push.copy(eventName = "workflow_run")) is StampResult.NoChannel)
  }
}
