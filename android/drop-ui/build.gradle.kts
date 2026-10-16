// The Update sheet (docs/design.md#update-sheet): a Compose bottom sheet that inherits the app's
// MaterialTheme, and a launcher for View-based apps.

plugins {
  alias(libs.plugins.android.library)
  alias(libs.plugins.compose.compiler)
}

android {
  namespace = "com.r0adkll.drop.ui"
  compileSdk = 37
  defaultConfig {
    minSdk = 26
  }
  buildFeatures {
    compose = true
  }
}

dependencies {
  // The app supplies drop-android or drop-noop (the Gradle plugin picks per variant); both have
  // the same Drop API, so the sheet compiles against one and runs with either.
  compileOnly(project(":drop-android"))
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.material3)
}
