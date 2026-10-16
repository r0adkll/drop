// The SDK modules and the sample app (docs/design.md#repository-layout). The Kotlin API client is
// generated from ../server/openapi.yaml; edit the document, not the client.

pluginManagement {
  includeBuild("plugin")
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "drop-android"

include(":drop-core", ":drop-android", ":drop-noop", ":sample")
