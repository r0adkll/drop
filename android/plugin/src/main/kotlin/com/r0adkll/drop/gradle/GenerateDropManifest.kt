package com.r0adkll.drop.gradle

import java.io.ByteArrayOutputStream
import javax.inject.Inject
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.provider.ValueSource
import org.gradle.api.provider.ValueSourceParameters
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.TaskAction
import org.gradle.process.ExecOperations

/**
 * Writes a manifest holding the SDK's config as `<meta-data>`, which AGP merges into the variant's
 * manifest and `Drop(context)` reads (drop-core's DropManifest). Names must match DropManifest.
 */
@CacheableTask
public abstract class GenerateDropManifest : DefaultTask() {
  @get:Input @get:Optional
  public abstract val serverUrl: Property<String>

  @get:Input
  public abstract val channel: Property<String>

  /** Whether the variant gets the real SDK, which needs [serverUrl]. */
  @get:Input
  public abstract val sdkEnabled: Property<Boolean>

  @get:Input
  public abstract val variantName: Property<String>

  // The GitHub Actions environment the Stamp comes from.
  @get:Input @get:Optional public abstract val runId: Property<String>
  @get:Input @get:Optional public abstract val eventName: Property<String>
  @get:Input @get:Optional public abstract val ref: Property<String>
  @get:Input @get:Optional public abstract val refName: Property<String>
  @get:Input @get:Optional public abstract val eventPayload: Property<String>
  @get:Input @get:Optional public abstract val dropChannel: Property<String>

  @get:OutputFile
  public abstract val manifest: RegularFileProperty

  @TaskAction
  public fun generate() {
    if (sdkEnabled.get() && !serverUrl.isPresent) {
      throw GradleException("drop { serverUrl } is required: ${variantName.get()} gets the Drop SDK.")
    }
    val result = stampOf(CiEnvironment(runId.orNull, eventName.orNull, ref.orNull, refName.orNull, eventPayload.orNull, dropChannel.orNull))
    if (result is StampResult.NoChannel) logger.warn("Drop: ${result.reason} ${variantName.get()} won't carry a Stamp.")
    val stamp = (result as? StampResult.Stamped)?.stamp
    val entries = listOfNotNull(
      serverUrl.orNull?.let { "com.r0adkll.drop.SERVER_URL" to it },
      "com.r0adkll.drop.CHANNEL" to channel.get(),
      stamp?.let { "com.r0adkll.drop.STAMP_CHANNEL" to it.channel },
      stamp?.let { "com.r0adkll.drop.STAMP_RUN_ID" to it.runId.toString() },
    )
    val metaData = entries.joinToString("\n") { (name, value) ->
      """    <meta-data android:name="$name" android:value="${xml(value)}" />"""
    }
    manifest.get().asFile.writeText(
      """
      |<?xml version="1.0" encoding="utf-8"?>
      |<manifest xmlns:android="http://schemas.android.com/apk/res/android">
      |  <application>
      |$metaData
      |  </application>
      |</manifest>
      |""".trimMargin(),
    )
  }

  private fun xml(value: String) = value
    .replace("&", "&amp;")
    .replace("<", "&lt;")
    .replace(">", "&gt;")
    .replace("\"", "&quot;")
}

/** The number of first-parent commits in HEAD's history, for [DropExtension.versionCodeFromCommits]. */
internal abstract class CommitCount : ValueSource<Int, CommitCount.Parameters> {
  interface Parameters : ValueSourceParameters {
    val repository: DirectoryProperty
  }

  @get:Inject
  abstract val exec: ExecOperations

  override fun obtain(): Int {
    val output = ByteArrayOutputStream()
    exec.exec {
      workingDir(parameters.repository.get().asFile)
      // First-parent only: on a pull request HEAD is GitHub's merge commit, whose full history (the
      // base plus every PR commit) would out-count the squash-merged main Build that follows it.
      commandLine("git", "rev-list", "--count", "--first-parent", "HEAD")
      standardOutput = output
    }
    return output.toString().trim().toInt()
  }
}
