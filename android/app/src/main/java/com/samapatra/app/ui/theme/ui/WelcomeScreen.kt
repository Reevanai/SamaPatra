package com.samapatra.app.ui

import android.os.SystemClock
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.samapatra.app.data.ApiClient

private enum class ServerStatus { Checking, Online, Offline }

// Five taps on the logo, each within this many milliseconds of the one before, opens the admin door
private const val ADMIN_TAPS = 5
private const val ADMIN_TAP_GAP_MS = 1500L

@Composable
fun WelcomeScreen(onTeacher: () -> Unit, onStudent: () -> Unit, onAdmin: () -> Unit) {
    val reduceMotion = rememberReduceMotion()
    val colors = MaterialTheme.colorScheme

    var status by remember { mutableStateOf(ServerStatus.Checking) }
    var attempt by remember { mutableIntStateOf(0) }

    LaunchedEffect(attempt) {
        status = ServerStatus.Checking
        status = if (ApiClient.isBackendReachable()) ServerStatus.Online else ServerStatus.Offline
    }

    val barProgress = remember { Animatable(if (reduceMotion) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (!reduceMotion) barProgress.animateTo(1f, tween(durationMillis = 700, delayMillis = 200))
    }

    // The hidden admin door
    var taps by remember { mutableIntStateOf(0) }
    var lastTap by remember { mutableLongStateOf(0L) }
    var showAdminLogin by remember { mutableStateOf(false) }

    Box(
        modifier = Modifier.fillMaxSize().then(backdropModifier()).safeDrawingPadding(),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 640.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 32.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Mark(
                progress = { barProgress.value },
                // pointerInput adds no accessibility actions, so screen readers don't announce the door
                modifier = Modifier.pointerInput(Unit) {
                    detectTapGestures(onTap = {
                        val now = SystemClock.elapsedRealtime()
                        taps = if (now - lastTap <= ADMIN_TAP_GAP_MS) taps + 1 else 1
                        lastTap = now
                        if (taps >= ADMIN_TAPS) {
                            taps = 0
                            showAdminLogin = true
                        }
                    })
                },
            )
            Text(
                text = "SamaPatra",
                style = MaterialTheme.typography.displaySmall,
                color = colors.onBackground,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                text = "One question bank. A paper that fits every student.",
                style = MaterialTheme.typography.bodyLarge,
                color = colors.onSurfaceVariant,
            )
            Reveal(delayMillis = 150, reduceMotion = reduceMotion) {
                RoleCard(
                    title = "I’m a teacher",
                    subtitle = "Set up classes, build papers and check answers.",
                    container = colors.surface.copy(alpha = 0.88f),
                    content = colors.onSurface,
                    pill = colors.primary,
                    onPill = colors.onPrimary,
                    onClick = onTeacher,
                )
            }
            Reveal(delayMillis = 300, reduceMotion = reduceMotion) {
                RoleCard(
                    title = "I’m a student",
                    subtitle = "Take your level check, then open your paper.",
                    container = colors.primary,
                    content = colors.onPrimary,
                    pill = colors.onPrimary,
                    onPill = colors.primary,
                    onClick = onStudent,
                )
            }
            StatusRow(status = status, onRetry = { attempt++ })
        }
    }

    if (showAdminLogin) {
        AdminLoginDialog(
            onDismiss = { showAdminLogin = false },
            onUnlocked = {
                showAdminLogin = false
                onAdmin()
            },
        )
    }
}

/** The logo: a paper tile with an equals sign. Sama means equal, patra means paper. */
@Composable
private fun Mark(progress: () -> Float, modifier: Modifier = Modifier) {
    // Brand colours: always marigold yellow with ink bars, whatever the theme (matches the app icon)
    val tile = Color(0xFFF4B13E)
    val bars = Color(0xFF1E2A2B)
    Canvas(modifier.size(88.dp)) {
        drawRoundRect(color = tile, cornerRadius = CornerRadius(size.width * 0.26f))
        val barHeight = size.height * 0.1f
        val barWidth = size.width * 0.5f * progress()
        val left = size.width * 0.25f
        val radius = CornerRadius(barHeight / 2)
        drawRoundRect(
            color = bars,
            topLeft = Offset(left, size.height * 0.34f),
            size = Size(barWidth, barHeight),
            cornerRadius = radius,
        )
        drawRoundRect(
            color = bars,
            topLeft = Offset(left, size.height * 0.56f),
            size = Size(barWidth, barHeight),
            cornerRadius = radius,
        )
    }
}

@Composable
private fun Reveal(delayMillis: Int, reduceMotion: Boolean, content: @Composable () -> Unit) {
    var visible by remember { mutableStateOf(reduceMotion) }
    LaunchedEffect(Unit) { visible = true }
    AnimatedVisibility(
        visible = visible,
        enter = if (reduceMotion) {
            EnterTransition.None
        } else {
            fadeIn(tween(450, delayMillis)) + slideInVertically(tween(450, delayMillis)) { it / 5 }
        },
    ) {
        content()
    }
}

@Composable
private fun RoleCard(
    title: String,
    subtitle: String,
    container: Color,
    content: Color,
    pill: Color,
    onPill: Color,
    onClick: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.large)
            .background(container)
            .border(1.dp, Color.White.copy(alpha = 0.5f), MaterialTheme.shapes.large)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(title, style = MaterialTheme.typography.headlineMedium, color = content)
        Text(subtitle, style = MaterialTheme.typography.bodyLarge, color = content.copy(alpha = 0.78f))
        Spacer(Modifier.size(10.dp))
        Box(
            modifier = Modifier
                .clip(PillShape)
                .background(pill)
                .padding(horizontal = 22.dp, vertical = 12.dp),
        ) {
            Text("Continue  →", style = MaterialTheme.typography.labelLarge, color = onPill)
        }
    }
}

@Composable
private fun StatusRow(status: ServerStatus, onRetry: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val dot = when (status) {
        ServerStatus.Checking -> colors.outline
        ServerStatus.Online -> colors.primary
        ServerStatus.Offline -> colors.tertiary
    }
    val label = when (status) {
        ServerStatus.Checking -> "Looking for the server…"
        ServerStatus.Online -> "Server connected"
        ServerStatus.Offline -> "Can’t reach the server"
    }
    Row(
        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(10.dp).background(dot, CircleShape))
        Spacer(Modifier.width(10.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
        if (status == ServerStatus.Offline) {
            Spacer(Modifier.width(4.dp))
            TextButton(onClick = onRetry) { Text("Try again") }
        }
    }
}