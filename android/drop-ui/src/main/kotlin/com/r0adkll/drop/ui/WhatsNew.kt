package com.r0adkll.drop.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.dp

private const val COLLAPSED_LINES = 3

/** An Update's What's new: three lines with More, opening in place and scrolling past a few more. */
@Composable
internal fun WhatsNew(text: String) {
  var expanded by rememberSaveable(text) { mutableStateOf(false) }
  var overflows by remember(text) { mutableStateOf(false) }
  val linkColor = MaterialTheme.colorScheme.primary
  val content = remember(text, linkColor) { linkified(text, linkColor) }
  Column {
    Text(
      content,
      style = MaterialTheme.typography.bodyMedium,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
      maxLines = if (expanded) Int.MAX_VALUE else COLLAPSED_LINES,
      overflow = TextOverflow.Ellipsis,
      onTextLayout = { if (!expanded) overflows = it.hasVisualOverflow },
      modifier = if (expanded) Modifier.heightIn(max = 200.dp).verticalScroll(rememberScrollState()) else Modifier,
    )
    if (overflows || expanded) {
      TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(horizontal = 0.dp, vertical = 4.dp)) {
        Text(stringResource(if (expanded) R.string.drop_whats_new_less else R.string.drop_whats_new_more))
      }
    }
  }
}

private val WEB_ADDRESS = Regex("""https?://[^\s<>"]+""")
private val TRAILING_PUNCTUATION = Regex("""[.,;:!?)\]'’]+$""")

/** [text] with its web addresses linked, as the Build page shows them. */
internal fun linkified(text: String, linkColor: Color): AnnotatedString = buildAnnotatedString {
  val styles = TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline))
  var at = 0
  for (match in WEB_ADDRESS.findAll(text)) {
    val url = match.value.replace(TRAILING_PUNCTUATION, "")
    append(text, at, match.range.first)
    withLink(LinkAnnotation.Url(url, styles)) { append(url) }
    at = match.range.first + url.length
  }
  append(text, at, text.length)
}
