// The SDK for store variants: drop-android's API, doing nothing. It declares no permissions and
// makes no network calls, so REQUEST_INSTALL_PACKAGES never reaches a store build.

plugins {
  alias(libs.plugins.android.library)
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
