// A small app that checks a Drop deployment for Updates to itself and installs them. CI uploads it
// to a deployment when the repository sets the DROP_SERVER variable.
//
// Until the Gradle plugin exists, it stamps itself here from the GitHub Actions environment
// (docs/implementation-notes.md#gradle-plugin).

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.compose.compiler)
}

val serverUrl = providers.gradleProperty("drop.serverUrl").orElse(providers.environmentVariable("DROP_SERVER")).getOrElse("https://drop.example.com")
val runId = providers.environmentVariable("GITHUB_RUN_ID").orNull
val runNumber = providers.environmentVariable("GITHUB_RUN_NUMBER").orNull
// pull_request runs check out refs/pull/<n>/merge and upload to pr/<n>; everything else to main.
val stampChannel = providers.environmentVariable("GITHUB_REF").orNull
  ?.let { Regex("^refs/pull/(\\d+)/merge$").find(it)?.groupValues?.get(1) }
  ?.let { "pr/$it" }
  ?: "main"

android {
  namespace = "com.r0adkll.drop.sample"
  compileSdk = 37

  defaultConfig {
    applicationId = "com.r0adkll.drop.sample"
    minSdk = 26
    targetSdk = 37
    versionCode = runNumber?.toInt() ?: 1
    versionName = "1.0"
    buildConfigField("String", "DROP_SERVER_URL", "\"$serverUrl\"")
    buildConfigField("String", "DROP_STAMP_CHANNEL", if (runId != null) "\"$stampChannel\"" else "null")
    buildConfigField("long", "DROP_STAMP_RUN_ID", runId ?: "0L")
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
    buildConfig = true
    compose = true
  }
}

dependencies {
  implementation(project(":drop-android"))
  implementation(libs.androidx.activity.compose)
  implementation(libs.androidx.compose.ui)
  implementation(libs.androidx.compose.material3)
}
