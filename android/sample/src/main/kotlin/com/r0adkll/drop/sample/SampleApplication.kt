package com.r0adkll.drop.sample

import android.app.Application
import android.content.Context
import com.r0adkll.drop.Drop

/** Holds the process's one Drop. */
class SampleApplication : Application() {
  // Reads the server URL and Stamp the Gradle plugin wrote into the manifest.
  val drop: Drop by lazy { Drop(this) }

  companion object {
    fun drop(context: Context): Drop = (context.applicationContext as SampleApplication).drop
  }
}
