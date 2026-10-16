// The SDK for internal variants: Update checks, downloads through DownloadManager and installs
// through PackageInstaller. The only module that declares REQUEST_INSTALL_PACKAGES, which Google
// Play restricts; store variants get drop-noop instead.

plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.kotlin.serialization)
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
