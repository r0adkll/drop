package com.r0adkll.drop.sample

import android.app.Application
import android.content.Context
import com.r0adkll.drop.Drop

/** Holds the process's one Drop. */
class SampleApplication : Application() {
  val drop: Drop by lazy { Drop(this, sampleConfig()) }

  companion object {
    fun drop(context: Context): Drop = (context.applicationContext as SampleApplication).drop
  }
}
