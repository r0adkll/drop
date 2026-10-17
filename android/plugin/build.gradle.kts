import java.util.Properties
import org.gradle.plugin.compatibility.compatibility

plugins {
  `kotlin-dsl`
  alias(libs.plugins.plugin.publish)
  alias(libs.plugins.maven.publish)
}

// One version for the SDK and the plugin (docs/design.md#releases): VERSION_NAME from the command
// line or ORG_GRADLE_PROJECT_VERSION_NAME when releasing, else android/gradle.properties.
val sdkProperties = Properties().apply {
  load(providers.fileContents(layout.projectDirectory.file("../gradle.properties")).asText.get().reader())
}
group = sdkProperties.getProperty("GROUP")
version = providers.gradleProperty("VERSION_NAME").getOrElse(sdkProperties.getProperty("VERSION_NAME"))

dependencies {
  compileOnly(libs.android.gradle.api)
  testImplementation(libs.junit)
}

gradlePlugin {
  website = "https://github.com/r0adkll/drop"
  vcsUrl = "https://github.com/r0adkll/drop"
  plugins {
    create("drop") {
      id = "com.r0adkll.drop"
      implementationClass = "com.r0adkll.drop.gradle.DropPlugin"
      displayName = "Drop"
      description = "Wires the Drop SDK into an Android app: the real SDK or a no-op per variant, its config and its Stamp."
      tags = listOf("android", "distribution", "updates")
      compatibility {
        features {
          configurationCache = true
          isolatedProjects = true
        }
      }
    }
  }
}

// The SDK version the plugin adds, which is always its own.
val generateVersion = tasks.register("generateDropVersion") {
  val output = layout.buildDirectory.dir("generated/version")
  val dropVersion = version.toString()
  inputs.property("version", dropVersion)
  outputs.dir(output)
  doLast {
    val file = output.get().file("com/r0adkll/drop/gradle/DropVersion.kt").asFile
    file.parentFile.mkdirs()
    file.writeText("package com.r0adkll.drop.gradle\n\ninternal const val DROP_VERSION = \"$dropVersion\"\n")
  }
}
sourceSets.main { kotlin.srcDir(generateVersion) }

// Maven Central carries the plugin and its marker too, so snapshots resolve from Central's snapshot
// repository; releases also go to the Gradle Plugin Portal (publishPlugins).
mavenPublishing {
  configure(com.vanniktech.maven.publish.GradlePublishPlugin())
  publishToMavenCentral(automaticRelease = true)
  if (providers.gradleProperty("signingInMemoryKey").isPresent) signAllPublications()
  coordinates(artifactId = "drop-gradle-plugin")
  pom {
    name = "Drop Gradle plugin"
    description = "Wires the Drop SDK into an Android app: the real SDK or a no-op per variant, its config and its Stamp."
    inceptionYear = "2026"
    url = sdkProperties.getProperty("POM_URL")
    licenses { license { name = sdkProperties.getProperty("POM_LICENSE_NAME"); url = sdkProperties.getProperty("POM_LICENSE_URL") } }
    developers { developer { id = sdkProperties.getProperty("POM_DEVELOPER_ID"); name = sdkProperties.getProperty("POM_DEVELOPER_NAME"); url = sdkProperties.getProperty("POM_DEVELOPER_URL") } }
    scm { url = sdkProperties.getProperty("POM_SCM_URL"); connection = sdkProperties.getProperty("POM_SCM_CONNECTION"); developerConnection = sdkProperties.getProperty("POM_SCM_DEV_CONNECTION") }
  }
}
