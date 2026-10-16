// The com.r0adkll.drop Gradle plugin, an included build of android/ (docs/design.md#gradle-plugin).

dependencyResolutionManagement {
  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
  versionCatalogs {
    create("libs") { from(files("../gradle/libs.versions.toml")) }
  }
}

rootProject.name = "drop-gradle-plugin"
