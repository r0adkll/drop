package com.r0adkll.drop.gradle

import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import org.gradle.api.Plugin
import org.gradle.api.Project

/**
 * Wires Drop into an Android app (docs/design.md#gradle-plugin): the real SDK for the variants
 * [DropExtension.enableFor] selects and drop-noop for the rest, the SDK's config and the CI Stamp
 * as manifest meta-data, and optionally commit-count version codes. It configures no signing
 * (ADR 0006) and uploads nothing (ADR 0005).
 */
public class DropPlugin : Plugin<Project> {
  override fun apply(project: Project) {
    val drop = project.extensions.create("drop", DropExtension::class.java)
    drop.channel.convention("main")
    drop.versionCodeFromCommits.convention(false)

    project.pluginManager.withPlugin("com.android.application") {
      val providers = project.providers
      val env = { name: String -> providers.environmentVariable(name) }
      val eventPayload = env("GITHUB_EVENT_PATH").flatMap { path: String -> providers.fileContents(project.layout.projectDirectory.file(path)).asText }
      val commitCount = providers.of(CommitCount::class.java) {
        parameters.repository.set(project.rootDir)
      }

      val components = project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java)
      components.onVariants { variant ->
        val selected = drop.enabled.isSatisfiedBy(
          DropVariant(
            name = variant.name,
            buildType = variant.buildType,
            flavorName = variant.flavorName?.takeIf { it.isNotEmpty() },
            productFlavors = variant.productFlavors.toMap(),
          ),
        )
        val module = if (selected) "drop-android" else "drop-noop"
        project.dependencies.add("${variant.name}Implementation", "com.r0adkll.drop:$module:$DROP_VERSION")

        val generate = project.tasks.register("generate${variant.name.replaceFirstChar(Char::uppercase)}DropManifest", GenerateDropManifest::class.java) {
          serverUrl.set(drop.serverUrl)
          channel.set(drop.channel)
          sdkEnabled.set(selected)
          variantName.set(variant.name)
          runId.set(env("GITHUB_RUN_ID"))
          eventName.set(env("GITHUB_EVENT_NAME"))
          ref.set(env("GITHUB_REF"))
          refName.set(env("GITHUB_REF_NAME"))
          this.eventPayload.set(eventPayload)
          dropChannel.set(env("DROP_CHANNEL"))
          manifest.set(project.layout.buildDirectory.file("generated/drop/${variant.name}/AndroidManifest.xml"))
        }
        variant.sources.manifests.addGeneratedManifestFile(generate, GenerateDropManifest::manifest)

        if (drop.versionCodeFromCommits.get()) {
          variant.outputs.forEach { output -> output.versionCode.set(commitCount) }
        }
      }
    }
  }
}
