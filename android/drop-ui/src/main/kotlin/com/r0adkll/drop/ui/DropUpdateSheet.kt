package com.r0adkll.drop.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.text.format.DateUtils
import android.text.format.Formatter
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.graphics.drawable.toBitmap
import androidx.lifecycle.compose.LifecycleResumeEffect
import com.r0adkll.drop.Drop
import com.r0adkll.drop.DropManifest
import com.r0adkll.drop.DropState
import com.r0adkll.drop.ReinstallReason
import com.r0adkll.drop.Update
import com.r0adkll.drop.UpdateCheckResult

/**
 * Drop's Update sheet (docs/design.md#update-sheet): offers the Update in [drop]'s state and
 * carries it through the install permission, the download and the install. It shows whatever
 * [Drop.state] holds, so it can be opened at any point, such as after a download that finished in
 * the background. It inherits the app's MaterialTheme.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun DropUpdateSheet(drop: Drop, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
  ModalBottomSheet(
    onDismissRequest = onDismiss,
    sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    modifier = modifier,
  ) {
    DropUpdateSheetContent(drop = drop, onDismiss = onDismiss)
  }
}

@Composable
internal fun DropUpdateSheetContent(drop: Drop, onDismiss: () -> Unit) {
  val context = LocalContext.current
  val state by drop.state.collectAsState()
  // Set when Update was tapped without the install permission; the download starts once the app
  // resumes with it (docs/design.md#update-sheet: ask before downloading).
  var awaitingPermission by rememberSaveable { mutableStateOf(false) }
  var canInstall by remember { mutableStateOf(drop.canInstall()) }
  LifecycleResumeEffect(drop) {
    canInstall = drop.canInstall()
    onPauseOrDispose {}
  }

  val start: (Update) -> Unit = { update ->
    if (drop.canInstall()) {
      drop.download(update)
    } else {
      awaitingPermission = true
    }
  }
  val current = state
  if (awaitingPermission && canInstall && current is DropState.UpdateAvailable) {
    awaitingPermission = false
    drop.download(current.update)
  }

  Column(
    modifier = Modifier.fillMaxWidth().padding(start = 24.dp, end = 24.dp, bottom = 28.dp),
    verticalArrangement = Arrangement.spacedBy(20.dp),
  ) {
    when (current) {
      DropState.Idle -> UpToDate(onDismiss)
      is DropState.UpdateAvailable -> when {
        awaitingPermission -> Permission(current.update, onOpenSettings = { context.startActivity(drop.installPermissionIntent()) }, onDismiss = onDismiss)
        current.result is UpdateCheckResult.ChannelEnded -> ChannelEnded(current.update, onSwitch = { start(current.update) }, onDismiss = onDismiss)
        current.update.requiresReinstall != null -> Reinstall(current.update, onDismiss)
        else -> Offer(current.update, onUpdate = { start(current.update) }, onDismiss = onDismiss)
      }
      is DropState.Downloading -> Downloading(current, onHide = onDismiss, onCancel = { drop.reset(); onDismiss() })
      is DropState.ReadyToInstall -> Ready(current.update, drop.asksToConfirmInstall(), installing = false, onInstall = { drop.install() }, onLater = onDismiss)
      is DropState.Installing -> Ready(current.update, drop.asksToConfirmInstall(), installing = true, onInstall = {}, onLater = onDismiss)
      is DropState.Failed -> Failed(
        current,
        onTryAgain = {
          // The verified file is kept after a cancelled install; without one, download again.
          if (!drop.install()) current.update?.let(start)
        },
        onRemove = { drop.reset(); onDismiss() },
      )
    }
  }
}

@Composable
private fun ColumnScope.Offer(update: Update, onUpdate: () -> Unit, onDismiss: () -> Unit) {
  val context = LocalContext.current
  Header(stringResource(R.string.drop_update_available), versionOf(update))
  Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Text(stringResource(R.string.drop_what_changed).uppercase(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    Text(update.headline, style = MaterialTheme.typography.bodyLarge)
    update.whatsNew?.let { WhatsNew(it) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ChannelChip(update.channel)
      Text(
        stringResource(R.string.drop_update_meta, ago(update), Formatter.formatShortFileSize(context, update.fileSize)),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
  Actions(primary = stringResource(R.string.drop_update), onPrimary = { onUpdate() }, secondary = stringResource(R.string.drop_not_now), onSecondary = onDismiss)
  TextButton(onClick = { openBuildPage(context, update) }, modifier = Modifier.align(Alignment.CenterHorizontally)) {
    Text(stringResource(R.string.drop_open_build_page))
  }
}

@Composable
private fun Reinstall(update: Update, onDismiss: () -> Unit) {
  Header(stringResource(R.string.drop_reinstall_title), "${versionOf(update)} · ${update.channel}")
  Text(update.headline, style = MaterialTheme.typography.bodyLarge)
  ReinstallWarning(update)
  Actions(primary = stringResource(R.string.drop_reinstall_open), onPrimary = { openBuildPage(it, update) }, secondary = stringResource(R.string.drop_not_now), onSecondary = onDismiss)
}

@Composable
private fun ReinstallWarning(update: Update) {
  val context = LocalContext.current
  val reason = when (update.requiresReinstall) {
    ReinstallReason.VersionCode -> stringResource(R.string.drop_reinstall_version_code, update.versionCode, installedVersionCode(context))
    ReinstallReason.Signer -> stringResource(R.string.drop_reinstall_signer)
    else -> stringResource(R.string.drop_reinstall_unknown)
  }
  Text(
    reason,
    style = MaterialTheme.typography.bodyMedium,
    color = MaterialTheme.colorScheme.onErrorContainer,
    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.errorContainer).padding(16.dp),
  )
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text("1. " + stringResource(R.string.drop_reinstall_step_uninstall, appLabel(context)) + " " + stringResource(R.string.drop_reinstall_step_uninstall_cost), style = MaterialTheme.typography.bodyMedium)
    Text("2. " + stringResource(R.string.drop_reinstall_step_install), style = MaterialTheme.typography.bodyMedium)
  }
}

@Composable
private fun ChannelEnded(update: Update?, onSwitch: () -> Unit, onDismiss: () -> Unit) {
  val context = LocalContext.current
  val ended = remember { endedChannel(context) }
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(
      ended?.let { name -> Regex("^pr/(\\d+)$").find(name)?.let { stringResource(R.string.drop_channel_ended_title_pr, it.groupValues[1].toInt()) } }
        ?: stringResource(R.string.drop_channel_ended_title, ended ?: ""),
      style = MaterialTheme.typography.headlineSmall,
    )
    Text(
      if (update != null) stringResource(R.string.drop_channel_ended_body, ended ?: "", update.channel) else stringResource(R.string.drop_channel_ended_nothing, ended ?: ""),
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
  }
  if (update == null) {
    Actions(primary = stringResource(R.string.drop_close), onPrimary = { onDismiss() }, secondary = null, onSecondary = {})
    return
  }
  Row(
    modifier = Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(16.dp)).padding(16.dp),
    horizontalArrangement = Arrangement.spacedBy(14.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    AppIcon(44)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(versionOf(update), style = MaterialTheme.typography.titleSmall)
      Text(update.headline, style = MaterialTheme.typography.bodyMedium)
      Text(
        stringResource(R.string.drop_channel_ended_newest, update.channel, stringResource(R.string.drop_update_meta, ago(update), Formatter.formatShortFileSize(context, update.fileSize))),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
  if (update.requiresReinstall != null) {
    ReinstallWarning(update)
    Actions(primary = stringResource(R.string.drop_reinstall_open), onPrimary = { openBuildPage(it, update) }, secondary = stringResource(R.string.drop_not_now), onSecondary = onDismiss)
  } else {
    Actions(primary = stringResource(R.string.drop_switch_to, update.channel), onPrimary = { onSwitch() }, secondary = stringResource(R.string.drop_not_now), onSecondary = onDismiss)
  }
}

@Composable
private fun Permission(update: Update, onOpenSettings: () -> Unit, onDismiss: () -> Unit) {
  val context = LocalContext.current
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Text(stringResource(R.string.drop_permission_title, appLabel(context)), style = MaterialTheme.typography.headlineSmall)
    Text(stringResource(R.string.drop_permission_body), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
  Text(
    stringResource(R.string.drop_permission_then, versionOf(update), Formatter.formatShortFileSize(context, update.fileSize)),
    style = MaterialTheme.typography.bodySmall,
    color = MaterialTheme.colorScheme.onSurfaceVariant,
  )
  Actions(primary = stringResource(R.string.drop_open_settings), onPrimary = { onOpenSettings() }, secondary = stringResource(R.string.drop_not_now), onSecondary = onDismiss)
}

@Composable
private fun Downloading(state: DropState.Downloading, onHide: () -> Unit, onCancel: () -> Unit) {
  val context = LocalContext.current
  Header(stringResource(R.string.drop_downloading_title), versionOf(state.update))
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    LinearProgressIndicator(progress = { state.progress }, modifier = Modifier.fillMaxWidth())
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      Text(
        stringResource(R.string.drop_downloading_progress, Formatter.formatShortFileSize(context, state.downloadedBytes), Formatter.formatShortFileSize(context, state.totalBytes)),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
      Text("${(state.progress * 100).toInt()}%", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
  Text(stringResource(R.string.drop_downloading_body, appLabel(context)), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    FilledTonalButton(onClick = onHide, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(stringResource(R.string.drop_hide)) }
    TextButton(onClick = onCancel, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(stringResource(R.string.drop_cancel_download)) }
  }
}

@Composable
private fun Ready(update: Update, asksToConfirm: Boolean, installing: Boolean, onInstall: () -> Unit, onLater: () -> Unit) {
  val context = LocalContext.current
  Header(stringResource(R.string.drop_ready_title), stringResource(R.string.drop_ready_subtitle, versionOf(update)))
  Column(
    modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.secondaryContainer).padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    val color = MaterialTheme.colorScheme.onSecondaryContainer
    Text(stringResource(R.string.drop_ready_next), style = MaterialTheme.typography.titleSmall, color = color)
    // Android's confirmation is a step only where it asks (Drop.asksToConfirmInstall).
    val steps = listOfNotNull(
      stringResource(R.string.drop_ready_step_confirm).takeIf { asksToConfirm },
      stringResource(R.string.drop_ready_step_play_protect),
      stringResource(R.string.drop_ready_step_reopen, appLabel(context)),
    )
    steps.forEachIndexed { index, step ->
      Text("${index + 1}. $step", style = MaterialTheme.typography.bodyMedium, color = color)
    }
  }
  Actions(
    primary = stringResource(if (installing) R.string.drop_installing else R.string.drop_install),
    onPrimary = { onInstall() },
    primaryEnabled = !installing,
    secondary = stringResource(R.string.drop_later),
    onSecondary = onLater,
  )
}

@Composable
private fun Failed(state: DropState.Failed, onTryAgain: () -> Unit, onRemove: () -> Unit) {
  val update = state.update
  Header(stringResource(R.string.drop_failed_title), update?.let { versionOf(it) })
  Text(state.message, style = MaterialTheme.typography.bodyMedium)
  if (update != null) {
    Text(stringResource(R.string.drop_failed_kept), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
  }
  Actions(primary = stringResource(R.string.drop_try_again), onPrimary = { onTryAgain() }, primaryEnabled = update != null, secondary = stringResource(R.string.drop_remove_download), onSecondary = onRemove)
}

@Composable
private fun UpToDate(onDismiss: () -> Unit) {
  val context = LocalContext.current
  Header(stringResource(R.string.drop_up_to_date, appLabel(context)), null)
  Actions(primary = stringResource(R.string.drop_close), onPrimary = { onDismiss() }, secondary = null, onSecondary = {})
}

@Composable
private fun Header(title: String, subtitle: String?) {
  Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
    AppIcon(52)
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
      Text(title, style = MaterialTheme.typography.headlineSmall)
      if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
  }
}

@Composable
private fun AppIcon(sizeDp: Int) {
  val context = LocalContext.current
  val icon = remember(sizeDp) {
    context.packageManager.getApplicationIcon(context.packageName).toBitmap(sizeDp * 3, sizeDp * 3).asImageBitmap()
  }
  Image(icon, contentDescription = null, modifier = Modifier.size(sizeDp.dp).clip(RoundedCornerShape((sizeDp / 4).dp)))
}

@Composable
private fun ChannelChip(channel: String) {
  Text(
    channel,
    style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Normal),
    color = MaterialTheme.colorScheme.onSecondaryContainer,
    modifier = Modifier.clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.secondaryContainer).padding(horizontal = 8.dp, vertical = 2.dp),
  )
}

@Composable
private fun Actions(
  primary: String,
  onPrimary: (Context) -> Unit,
  secondary: String?,
  onSecondary: () -> Unit,
  primaryEnabled: Boolean = true,
) {
  val context = LocalContext.current
  Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
    Button(onClick = { onPrimary(context) }, enabled = primaryEnabled, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(primary) }
    if (secondary != null) {
      TextButton(onClick = onSecondary, modifier = Modifier.fillMaxWidth().height(48.dp)) { Text(secondary) }
    }
  }
}

@Composable
private fun versionOf(update: Update): String =
  update.versionName?.let { stringResource(R.string.drop_version, update.label, it, update.versionCode) }
    ?: stringResource(R.string.drop_version_no_name, update.label, update.versionCode)

private fun ago(update: Update): String =
  DateUtils.getRelativeTimeSpanString(update.uploadedAt.toEpochMilliseconds(), System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()

private fun appLabel(context: Context): String = context.applicationInfo.loadLabel(context.packageManager).toString()

private fun installedVersionCode(context: Context): Long {
  val info = context.packageManager.getPackageInfo(context.packageName, 0)
  return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
}

/** The Channel the installed Build was stamped with, which is the one that ended. */
private fun endedChannel(context: Context): String? = runCatching { DropManifest.read(context).stamp?.channel }.getOrNull()

private fun openBuildPage(context: Context, update: Update) {
  context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(update.buildUrl)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}
