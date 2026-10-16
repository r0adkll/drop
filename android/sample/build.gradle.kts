// A small app that checks a Drop deployment for Updates to itself and installs them (test). CI uploads it
// to a deployment when the repository sets the DROP_SERVER variable.

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.compose.compiler)
  id("com.r0adkll.drop")
}

android {
  namespace = "com.r0adkll.drop.sample"
  compileSdk = 37

  defaultConfig {
    applicationId = "com.r0adkll.drop.sample"
    minSdk = 26
    targetSdk = 37
    versionCode = providers.environmentVariable("GITHUB_RUN_NUMBER").orNull?.toInt() ?: 1
    versionName = "1.0"
  }

  // A committed key, so every build of the sample, local or CI, can update every other
  // (ADR 0006). Never do this for a real app.
  signingConfigs {
    getByName("debug") {
      storeFile = file("sample.keystore")
      storePassword = "android"
      keyAlias = "sample"
      keyPassword = "android"
    }
  }

  buildFeatures {
    compose = true
  }
}

drop {
  serverUrl = providers.gradleProperty("drop.serverUrl").orElse(providers.environmentVariable("DROP_SERVER")).orElse("https://drop.example.com")
  // The default: debug gets the SDK, release gets drop-noop.
  enableFor { it.buildType == "debug" }
}

// The plugin adds com.r0adkll.drop:drop-android or drop-noop; this build uses its own modules.
configurations.configureEach {
  resolutionStrategy.dependencySubstitution {
    substitute(module("com.r0adkll.drop:drop-android")).using(project(":drop-android"))
    substitute(module("com.r0adkll.drop:drop-noop")).using(project(":drop-noop"))
  }
}

dependencies {
  implementation(project(":drop-ui"))
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.material3)
}
