package com.r0adkll.drop

/**
 * How an app reaches its Drop deployment. The Gradle plugin will generate this; until then apps
 * build it themselves.
 */
public data class DropConfig(
  /** The deployment's URL, such as https://drop.example.com. */
  val serverUrl: String,
  /** The Channel to follow when the Build has no [stamp], such as a local build. */
  val channel: String = "main",
  /** The Stamp written into the Build at build time, or null for a Build without one (ADR 0013). */
  val stamp: Stamp? = null,
)

/** The Channel and GitHub Actions run a Build was built for, by which Drop recognises it. */
public data class Stamp(
  val channel: String,
  val runId: Long,
)
