package com.r0adkll.drop.gradle

import org.gradle.api.provider.Property
import org.gradle.api.specs.Spec
import org.gradle.api.Transformer

/**
 * The `drop {}` block:
 *
 * ```
 * drop {
 *   serverUrl = "https://drop.example.com"
 *   enableFor { it.flavorName == "alpha" }
 * }
 * ```
 */
public abstract class DropExtension {
  /** The deployment's URL. Required for variants that get the real SDK. */
  public abstract val serverUrl: Property<String>

  /**
   * The Channel a Build without a Stamp follows, such as a local build. Defaults to `main`;
   * [channelFor] chooses one per variant instead.
   */
  public abstract val channel: Property<String>

  /**
   * Sets each variant's version code to the number of first-parent commits in HEAD's history, so a
   * pull request's Build never out-counts the main Build its merge produces. Off by default; Drop
   * orders Builds by run ID, not version code (ADR 0009). CI needs `fetch-depth: 0`.
   */
  public abstract val versionCodeFromCommits: Property<Boolean>

  internal var enabled: Spec<DropVariant> = Spec { it.buildType == "debug" }

  internal var channelFor: Transformer<String?, DropVariant>? = null

  /**
   * The Channel each variant's local (unstamped) Builds follow, such as `beta` for a beta flavor;
   * null falls back to [channel]. CI Builds follow their Stamp whatever this says.
   */
  public fun channelFor(transformer: Transformer<String?, DropVariant>) {
    channelFor = transformer
  }

  /**
   * Which variants get the real SDK (drop-android); every other variant gets drop-noop, so
   * REQUEST_INSTALL_PACKAGES never reaches a store build. Defaults to the debug build type.
   */
  public fun enableFor(spec: Spec<DropVariant>) {
    enabled = spec
  }
}

/** What [DropExtension.enableFor] decides on: one Android variant. */
public data class DropVariant(
  /** The variant's name, such as `alphaRelease`. */
  val name: String,
  val buildType: String?,
  /** The combined flavor name, such as `alpha`, or null without flavors. */
  val flavorName: String?,
  /** Each flavor dimension's flavor. */
  val productFlavors: Map<String, String>,
)
