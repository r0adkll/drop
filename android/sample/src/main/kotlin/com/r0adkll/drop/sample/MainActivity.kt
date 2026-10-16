package com.r0adkll.drop.sample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.r0adkll.drop.Drop
import com.r0adkll.drop.DropConfig
import com.r0adkll.drop.DropState
import com.r0adkll.drop.ReinstallReason
import com.r0adkll.drop.Stamp
import com.r0adkll.drop.Update
import com.r0adkll.drop.UpdateCheckResult
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val drop = SampleApplication.drop(this)
    setContent {
      MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
        Surface(Modifier.fillMaxSize()) { SampleScreen(drop) }
      }
    }
  }
}

@Composable
private fun SampleScreen(drop: Drop) {
  val state by drop.state.collectAsState()
  val scope = rememberCoroutineScope()
  var lastCheck by remember { mutableStateOf<UpdateCheckResult?>(null) }
  var checking by remember { mutableStateOf(false) }

  Column(
    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Text("Drop Sample", style = MaterialTheme.typography.headlineSmall)
    Card(Modifier.fillMaxWidth()) {
      Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("This Build", style = MaterialTheme.typography.titleMedium)
        Text("Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        Text(if (BuildConfig.DROP_STAMP_CHANNEL != null) "Stamp: ${BuildConfig.DROP_STAMP_CHANNEL}, run ${BuildConfig.DROP_STAMP_RUN_ID}" else "No Stamp: follows main")
        Text("Server: ${BuildConfig.DROP_SERVER_URL}", style = MaterialTheme.typography.bodySmall)
      }
    }

    Button(
      onClick = {
        checking = true
        scope.launch {
          lastCheck = drop.check()
          checking = false
        }
      },
      enabled = !checking,
    ) { Text(if (checking) "Checking…" else "Check for an Update") }
    lastCheck?.let { Text(describe(it), style = MaterialTheme.typography.bodyMedium) }

    Card(Modifier.fillMaxWidth()) {
      Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("State", style = MaterialTheme.typography.titleMedium)
        when (val s = state) {
          DropState.Idle -> Text("Idle")
          is DropState.UpdateAvailable -> {
            UpdateSummary(s.update)
            Button(onClick = { drop.download(s.update) }) { Text("Download") }
          }
          is DropState.Downloading -> {
            UpdateSummary(s.update)
            LinearProgressIndicator(progress = { s.progress }, modifier = Modifier.fillMaxWidth())
            Text("${s.downloadedBytes / 1024} of ${s.totalBytes / 1024} KB")
            OutlinedButton(onClick = drop::reset) { Text("Cancel") }
          }
          is DropState.ReadyToInstall -> {
            UpdateSummary(s.update)
            InstallButtons(drop)
          }
          is DropState.Installing -> {
            UpdateSummary(s.update)
            Text("Installing…")
          }
          is DropState.Failed -> {
            Text(s.message, color = MaterialTheme.colorScheme.error)
            s.update?.let { UpdateSummary(it) }
            InstallButtons(drop)
            OutlinedButton(onClick = drop::reset) { Text("Start over") }
          }
        }
      }
    }
  }
}

@Composable
private fun InstallButtons(drop: Drop) {
  val context = androidx.compose.ui.platform.LocalContext.current
  if (drop.canInstall()) {
    Button(onClick = { drop.install() }) { Text("Install") }
  } else {
    Button(onClick = { context.startActivity(drop.installPermissionIntent()) }) { Text("Allow installs from this app") }
  }
}

@Composable
private fun UpdateSummary(update: Update) {
  Text("${update.label} ${update.versionName ?: ""} (${update.versionCode}) on ${update.channel}", style = MaterialTheme.typography.bodyLarge)
  Text(update.headline, style = MaterialTheme.typography.bodyMedium)
  when (update.requiresReinstall) {
    ReinstallReason.VersionCode -> Text("Its version code is lower, so it needs an uninstall first.", color = MaterialTheme.colorScheme.error)
    ReinstallReason.Signer -> Text("It's signed differently, so it needs an uninstall first.", color = MaterialTheme.colorScheme.error)
    ReinstallReason.Unknown -> Text("It needs an uninstall first.", color = MaterialTheme.colorScheme.error)
    null -> {}
  }
}

private fun describe(result: UpdateCheckResult): String = when (result) {
  UpdateCheckResult.UpToDate -> "Up to date."
  is UpdateCheckResult.Available -> "An Update is available."
  is UpdateCheckResult.ReinstallRequired -> "Every newer Build is signed differently."
  is UpdateCheckResult.ChannelEnded -> if (result.update != null) "This Channel has ended; the default Channel's newest is offered." else "This Channel has ended, with nothing to switch to."
  UpdateCheckResult.SignInRequired -> "This Product needs sign-in."
  UpdateCheckResult.UnknownProduct -> "The server has no Builds of this app yet."
  is UpdateCheckResult.Failed -> "The check failed: ${result.message}"
}

internal fun sampleConfig() = DropConfig(
  serverUrl = BuildConfig.DROP_SERVER_URL,
  channel = "main",
  stamp = BuildConfig.DROP_STAMP_CHANNEL?.let { Stamp(channel = it, runId = BuildConfig.DROP_STAMP_RUN_ID) },
)
