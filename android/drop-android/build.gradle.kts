// The SDK for internal variants: Update checks, downloads through DownloadManager and installs
// through PackageInstaller. The only module that declares REQUEST_INSTALL_PACKAGES, which Google
// Play restricts; store variants get drop-noop instead.

plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.maven.publish)
}

android {
  namespace = "com.r0adkll.drop.android"
  compileSdk = 37
  defaultConfig {
    minSdk = 26
  }
  testOptions {
    unitTests.isIncludeAndroidResources = true
  }
}

dependencies {
  api(project(":drop-core"))
  implementation(libs.kotlinx.coroutines.android)
  implementation(libs.ktor.client.okhttp)

  testImplementation(libs.junit)
  testImplementation(libs.robolectric)
  testImplementation(libs.androidx.test.core)
  testImplementation(libs.kotlinx.coroutines.test)
}

mavenPublishing {
  configure(com.vanniktech.maven.publish.AndroidSingleVariantLibrary(variant = "release", sourcesJar = true, publishJavadocJar = true))
  publishToMavenCentral(automaticRelease = true)
  // Snapshots go unsigned; releases are signed with the key the release workflow provides.
  if (providers.gradleProperty("signingInMemoryKey").isPresent) signAllPublications()
  pom {
    name = "Drop for Android"
    description = "The Drop SDK: checks a Drop deployment for Updates, downloads and installs them."
    inceptionYear = "2026"
  }
}
