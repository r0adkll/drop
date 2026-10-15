# The SDK is Kotlin Multiplatform with only an Android target

The SDK is built as Kotlin Multiplatform modules even though Android is its only target today, and
its shared logic uses only multiplatform libraries. iOS is deferred, not abandoned
([ADR 0002](0002-android-only.md)), and this way adding it means adding a target rather than
extracting a shared core from an Android library.
