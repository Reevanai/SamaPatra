package com.samapatra.app.ui
import com.samapatra.app.ui.theme.LocalStudentSettings
import androidx.compose.material3.OutlinedButton
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp

/** Pill shape for buttons. */
val PillShape = RoundedCornerShape(percent = 50)

/**
 * The soft sky gradient behind every screen. Off for high contrast and tinted backgrounds,
 * so those students keep a flat, plain background.
 */
@Composable
fun backdropModifier(): Modifier {
    val settings = LocalStudentSettings.current
    if (settings.highContrast || settings.tintedBackground) return Modifier
    val bg = MaterialTheme.colorScheme.background
    val dark = bg.luminance() < 0.5f
    val top = if (dark) Color(0xFF1A2A6C) else Color(0xFFB7CBE3)
    val middle = if (dark) Color(0xFF111833) else Color(0xFFDCE5F1)
    return Modifier.background(Brush.verticalGradient(0f to top, 0.35f to middle, 0.7f to bg))
}

/** A frosted white card, like glass over the gradient. */
@Composable
fun GlassCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val colors = MaterialTheme.colorScheme
    val settings = LocalStudentSettings.current
    val plain = settings.highContrast
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.large)
            .background(if (plain) colors.surface else colors.surface.copy(alpha = 0.86f))
            .border(
                width = if (plain) 2.dp else 1.dp,
                color = if (plain) colors.outline else Color.White.copy(alpha = if (colors.background.luminance() < 0.5f) 0.08f else 0.7f),
                shape = MaterialTheme.shapes.large,
            )
            .padding(22.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}

/** Standard page: optional Back button, a heading, then your content. Scrolls for big text sizes. */
@Composable
fun ScreenFrame(
    title: String,
    onBack: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Box(
        modifier = Modifier.fillMaxSize().then(backdropModifier()).safeDrawingPadding(),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 640.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            if (onBack != null) {
                TextButton(
                    onClick = onBack,
                    shape = PillShape,
                    modifier = Modifier
                        .clip(PillShape)
                        .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.7f)),
                ) { Text("‹  Back", color = MaterialTheme.colorScheme.onSurface) }
            }
            Text(
                text = title,
                style = MaterialTheme.typography.headlineMedium,
                color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier.semantics { heading() },
            )
            content()
        }
    }
}

@Composable
fun ErrorText(message: String?) {
    if (message != null) {
        Text(
            text = message,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
        )
    }
}

@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
) {
    val large = LocalStudentSettings.current.largeTouchTargets
    Button(
        onClick = onClick,
        enabled = enabled && !loading,
        modifier = modifier.fillMaxWidth().heightIn(min = if (large) 72.dp else 56.dp),
        shape = PillShape,
    ) {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                strokeWidth = 2.dp,
                color = LocalContentColor.current,
            )
            Spacer(Modifier.width(12.dp))
            Text("Please wait…")
        } else {
            Text(text)
        }
    }
}

@Composable
fun Field(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    keyboardType: KeyboardType = KeyboardType.Text,
    imeAction: ImeAction = ImeAction.Next,
    isPassword: Boolean = false,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.None,
    onDone: (() -> Unit)? = null,
) {
    var shown by remember { mutableStateOf(false) }
    val trailing: (@Composable () -> Unit)? = if (isPassword) {
        { TextButton(onClick = { shown = !shown }) { Text(if (shown) "Hide" else "Show") } }
    } else {
        null
    }
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        singleLine = true,
        modifier = modifier.fillMaxWidth(),
        textStyle = MaterialTheme.typography.bodyLarge,
        keyboardOptions = KeyboardOptions(
            capitalization = capitalization,
            keyboardType = if (isPassword) KeyboardType.Password else keyboardType,
            imeAction = imeAction,
        ),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
        visualTransformation = if (isPassword && !shown) {
            PasswordVisualTransformation()
        } else {
            VisualTransformation.None
        },
        trailingIcon = trailing,
        shape = MaterialTheme.shapes.small,
        colors = OutlinedTextFieldDefaults.colors(
            focusedContainerColor = MaterialTheme.colorScheme.surface,
            unfocusedContainerColor = MaterialTheme.colorScheme.surface,
            unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant,
        ),
    )
}

/** A group of radio buttons. Large touch rows, read out properly by TalkBack. */
@Composable
fun ChoiceGroup(options: List<String>, selectedIndex: Int, onSelect: (Int) -> Unit) {
    val large = LocalStudentSettings.current.largeTouchTargets
    Column(Modifier.selectableGroup()) {
        options.forEachIndexed { index, label ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = if (large) 64.dp else 48.dp)
                    .selectable(
                        selected = index == selectedIndex,
                        onClick = { onSelect(index) },
                        role = Role.RadioButton,
                    )
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                RadioButton(selected = index == selectedIndex, onClick = null)
                Spacer(Modifier.width(12.dp))
                Text(
                    text = label,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onBackground,
                )
            }
        }
    }
}

/** Big on-screen number pad, so students don’t need the system keyboard. */
@Composable
fun PinPad(pin: String, onChange: (String) -> Unit, length: Int = 4) {
    val colors = MaterialTheme.colorScheme
    Column(
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier
                .padding(vertical = 8.dp)
                .semantics {
                    contentDescription = "${pin.length} of $length digits entered"
                    liveRegion = LiveRegionMode.Polite
                },
        ) {
            repeat(length) { index ->
                Box(
                    Modifier
                        .size(20.dp)
                        .clip(CircleShape)
                        .background(if (index < pin.length) colors.primary else colors.surfaceVariant)
                        .border(2.dp, colors.primary, CircleShape),
                )
            }
        }
        listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9")).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { digit ->
                    PinKey(digit) { if (pin.length < length) onChange(pin + digit) }
                }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Spacer(Modifier.size(width = 88.dp, height = 72.dp))
            PinKey("0") { if (pin.length < length) onChange(pin + "0") }
            PinKey("Delete", small = true) { if (pin.isNotEmpty()) onChange(pin.dropLast(1)) }
        }
    }
}

@Composable
private fun PinKey(label: String, small: Boolean = false, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .size(width = 88.dp, height = 72.dp)
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.85f))
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.medium)
            .clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = if (small) MaterialTheme.typography.bodyMedium else MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground,
        )
    }
}

@Composable
fun SecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val large = LocalStudentSettings.current.largeTouchTargets
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().heightIn(min = if (large) 72.dp else 56.dp),
        shape = PillShape,
    ) {
        Text(text)
    }
}