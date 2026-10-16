import org.openapitools.generator.gradle.plugin.tasks.GenerateTask

// Platform-free SDK code: the generated API client, the Update check and the state the app and the
// Update sheet share. Kotlin Multiplatform with only an Android target (ADR 0012).

plugins {
  alias(libs.plugins.kotlin.multiplatform)
  alias(libs.plugins.android.kotlin.multiplatform.library)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.openapi.generator)
}

// The Kotlin client, generated on each build from the server's OpenAPI document (ADR 0008).
val generateApiClient = tasks.register<GenerateTask>("generateApiClient") {
  generatorName = "kotlin"
  library = "multiplatform"
  inputSpec = rootProject.layout.projectDirectory.file("../server/openapi.yaml")
  outputDir = layout.buildDirectory.dir("generated/openapi")
  packageName = "com.r0adkll.drop.api"
  // Only what apps call; the upload and webhook operations belong to CI and GitHub.
  openapiNormalizer = mapOf("FILTER" to "operationId:checkForUpdate|getHealth")
  configOptions = mapOf("dateLibrary" to "kotlinx-datetime")
  // Error codes, statuses and reasons added later decode as an unknown case instead of failing
  // older SDKs.
  additionalProperties = mapOf("enumUnknownDefaultCase" to "true")
  generateApiDocumentation = false
  generateModelDocumentation = false
  generateApiTests = false
  generateModelTests = false
}

kotlin {
  android {
    namespace = "com.r0adkll.drop.core"
    compileSdk = 37
    minSdk = 26
    withHostTest {}
  }

  sourceSets {
    commonMain {
      kotlin.srcDir(generateApiClient.map { layout.buildDirectory.dir("generated/openapi/src/commonMain/kotlin").get() })
      dependencies {
        api(libs.kotlinx.coroutines.core)
        api(libs.kotlinx.serialization.json)
        implementation(libs.ktor.client.core)
        implementation(libs.ktor.client.content.negotiation)
        implementation(libs.ktor.serialization.kotlinx.json)
      }
    }
    commonTest {
      dependencies {
        implementation(kotlin("test"))
        implementation(libs.kotlinx.coroutines.test)
        implementation(libs.ktor.client.mock)
      }
    }
  }
}
