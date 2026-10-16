plugins {
  `kotlin-dsl`
}

group = "com.r0adkll.drop"
version = libs.versions.drop.get()

dependencies {
  compileOnly(libs.android.gradle.api)
  testImplementation(libs.junit)
}

gradlePlugin {
  plugins {
    create("drop") {
      id = "com.r0adkll.drop"
      implementationClass = "com.r0adkll.drop.gradle.DropPlugin"
      displayName = "Drop"
      description = "Wires the Drop SDK into an Android app: the real SDK or a no-op per variant, its config and its Stamp."
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
