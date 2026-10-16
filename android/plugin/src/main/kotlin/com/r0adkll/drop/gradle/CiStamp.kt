package com.r0adkll.drop.gradle

import groovy.json.JsonSlurper

/** The Stamp written into a Build: the Channel it is uploaded to and the GitHub Actions run (ADR 0013). */
internal data class Stamp(val channel: String, val runId: Long)

/** What the plugin reads from the GitHub Actions environment. */
internal data class CiEnvironment(
  val runId: String?,
  val eventName: String?,
  /** `GITHUB_REF`, such as `refs/heads/main` or `refs/pull/142/merge`. */
  val ref: String?,
  val refName: String?,
  /** The contents of the event payload at `GITHUB_EVENT_PATH`. */
  val eventPayload: String?,
  /** A job-level Channel that the upload Action also honours. */
  val dropChannel: String?,
)

internal sealed interface StampResult {
  data class Stamped(val stamp: Stamp) : StampResult

  /** Not a GitHub Actions run: a local build, which follows the configured Channel. */
  data object NotCi : StampResult

  /** A CI run whose Channel can't be told, as the upload Action would refuse it too. */
  data class NoChannel(val reason: String) : StampResult
}

/**
 * The Stamp for this build, choosing the Channel exactly as the upload Action does
 * (action/src/run-context.ts): `DROP_CHANNEL` when set, else `pr/<number>` for pull requests, else
 * `main` for runs on the default branch.
 */
internal fun stampOf(env: CiEnvironment): StampResult {
  val runId = env.runId?.toLongOrNull() ?: return StampResult.NotCi
  env.dropChannel?.takeIf { it.isNotBlank() }?.let { return StampResult.Stamped(Stamp(it, runId)) }
  val ref = env.ref.orEmpty()
  if (env.eventName == "pull_request") {
    Regex("^refs/pull/(\\d+)/merge$").find(ref)?.let { return StampResult.Stamped(Stamp("pr/${it.groupValues[1]}", runId)) }
  }
  if (ref.startsWith("refs/heads/")) {
    // Scheduled workflows always run on the default branch, and their payload doesn't name it.
    val onDefault = env.eventName == "schedule" ||
      (env.eventName in setOf("push", "workflow_dispatch") && defaultBranch(env.eventPayload) == env.refName)
    if (onDefault) return StampResult.Stamped(Stamp("main", runId))
  }
  return StampResult.NoChannel("A ${env.eventName} run on $ref has no default Channel; set DROP_CHANNEL for the job.")
}

private fun defaultBranch(payload: String?): String? {
  if (payload.isNullOrBlank()) return null
  val root = runCatching { JsonSlurper().parseText(payload) }.getOrNull() as? Map<*, *> ?: return null
  return (root["repository"] as? Map<*, *>)?.get("default_branch") as? String
}
