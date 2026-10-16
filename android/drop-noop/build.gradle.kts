// The SDK for store variants: drop-android's API, doing nothing. It declares no permissions and
// makes no network calls, so REQUEST_INSTALL_PACKAGES never reaches a store build.

plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.maven.publish)
}

android {
  namespace = "com.r0adkll.drop.noop"
  compileSdk = 37
  defaultConfig {
    minSdk = 26
  }
}

dependencies {
  // The shared types only; the generated client and Ktor stay out of store builds' code paths.
  api(project(":drop-core"))
}

mavenPublishing {
  configure(com.vanniktech.maven.publish.AndroidSingleVariantLibrary(variant = "release", sourcesJar = true, publishJavadocJar = true))
  publishToMavenCentral(automaticRelease = true)
  // Snapshots go unsigned; releases are signed with the key the release workflow provides.
  if (providers.gradleProperty("signingInMemoryKey").isPresent) signAllPublications()
  pom {
    name = "Drop (no-op)"
    description = "The Drop SDK's API for store builds, doing nothing."
    inceptionYear = "2026"
  }
}
