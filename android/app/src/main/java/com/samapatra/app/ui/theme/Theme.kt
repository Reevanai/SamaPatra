package com.samapatra.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Surface
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import androidx.compose.ui.unit.sp
import com.samapatra.app.data.StudentSettings

// Soft, airy palette: cool grey-blue canvas, white cards, ink-black pill buttons, blue and pink accents.
private val LightColors = lightColorScheme(
    primary = Color(0xFF111114),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE3EAFF),
    onPrimaryContainer = Color(0xFF0D1B4D),
    secondary = Color(0xFF3D6BFF),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFDDE6FF),
    onSecondaryContainer = Color(0xFF0D1B4D),
    tertiary = Color(0xFFD6336C),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFDDE8),
    onTertiaryContainer = Color(0xFF4A0820),
    background = Color(0xFFEEF1F6),
    onBackground = Color(0xFF0F1117),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF0F1117),
    surfaceVariant = Color(0xFFF6F8FB),
    onSurfaceVariant = Color(0xFF545B6B),
    outline = Color(0xFF8A91A2),
    outlineVariant = Color(0xFFDDE1EA),
    error = Color(0xFFB3261E),
    onError = Color.White,
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFFF4F5F8),
    onPrimary = Color(0xFF0B0D14),
    primaryContainer = Color(0xFF1E2A55),
    onPrimaryContainer = Color(0xFFDCE4FF),
    secondary = Color(0xFF8AA8FF),
    onSecondary = Color(0xFF0A1440),
    secondaryContainer = Color(0xFF223066),
    onSecondaryContainer = Color(0xFFDCE4FF),
    tertiary = Color(0xFFFF8FB4),
    onTertiary = Color(0xFF4A0820),
    tertiaryContainer = Color(0xFF5C1630),
    onTertiaryContainer = Color(0xFFFFDDE8),
    background = Color(0xFF0A0C13),
    onBackground = Color(0xFFF1F3F8),
    surface = Color(0xFF161A24),
    onSurface = Color(0xFFF1F3F8),
    surfaceVariant = Color(0xFF1E2330),
    onSurfaceVariant = Color(0xFFAAB1C2),
    outline = Color(0xFF6C7488),
    outlineVariant = Color(0xFF2E3445),
    error = Color(0xFFF2B8B5),
    onError = Color(0xFF601410),
)

// Maximum contrast: pure white or black, black or white text, strong outlines
private val HighContrastLight = lightColorScheme(
    primary = Color(0xFF0A3D3C),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD6EFEA),
    onPrimaryContainer = Color.Black,
    secondary = Color(0xFFFFC857),
    onSecondary = Color.Black,
    secondaryContainer = Color(0xFFFFE08A),
    onSecondaryContainer = Color.Black,
    tertiary = Color(0xFF9A1B00),
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFD0C4),
    onTertiaryContainer = Color.Black,
    background = Color.White,
    onBackground = Color.Black,
    surface = Color.White,
    onSurface = Color.Black,
    surfaceVariant = Color(0xFFE6E6E6),
    onSurfaceVariant = Color.Black,
    outline = Color.Black,
    error = Color(0xFF8C0009),
    onError = Color.White,
)

private val HighContrastDark = darkColorScheme(
    primary = Color(0xFFA8F0E4),
    onPrimary = Color.Black,
    primaryContainer = Color(0xFF003F3A),
    onPrimaryContainer = Color.White,
    secondary = Color(0xFFFFD166),
    onSecondary = Color.Black,
    secondaryContainer = Color(0xFF4D3A00),
    onSecondaryContainer = Color.White,
    tertiary = Color(0xFFFFB4A2),
    onTertiary = Color.Black,
    tertiaryContainer = Color(0xFF5A1507),
    onTertiaryContainer = Color.White,
    background = Color.Black,
    onBackground = Color.White,
    surface = Color.Black,
    onSurface = Color.White,
    surfaceVariant = Color(0xFF262626),
    onSurfaceVariant = Color.White,
    outline = Color.White,
    error = Color(0xFFFFB4AB),
    onError = Color.Black,
)

private val AppShapes = Shapes(
    small = RoundedCornerShape(14.dp),
    medium = RoundedCornerShape(22.dp),
    large = RoundedCornerShape(30.dp),
)

/** The settings of the signed-in student. Screens read this to adapt themselves. */
val LocalStudentSettings = staticCompositionLocalOf { StudentSettings() }

@Composable
fun SamaPatraTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        typography = AppTypography,
        shapes = AppShapes,
        content = content,
    )
}

private fun Typography.forLook(spacing: Float, tracking: TextUnit?): Typography {
    fun TextStyle.fix(): TextStyle = copy(
        lineHeight = if (lineHeight.isSpecified) lineHeight * spacing else lineHeight,
        letterSpacing = tracking ?: letterSpacing,
    )
    return copy(
        displayLarge = displayLarge.fix(),
        displayMedium = displayMedium.fix(),
        displaySmall = displaySmall.fix(),
        headlineLarge = headlineLarge.fix(),
        headlineMedium = headlineMedium.fix(),
        headlineSmall = headlineSmall.fix(),
        titleLarge = titleLarge.fix(),
        titleMedium = titleMedium.fix(),
        titleSmall = titleSmall.fix(),
        bodyLarge = bodyLarge.fix(),
        bodyMedium = bodyMedium.fix(),
        bodySmall = bodySmall.fix(),
        labelLarge = labelLarge.fix(),
        labelMedium = labelMedium.fix(),
        labelSmall = labelSmall.fix(),
    )
}

/** Dresses everything inside it the way this student has asked for. */
@Composable
fun StudentLook(settings: StudentSettings, content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val colors: ColorScheme = when {
        settings.highContrast -> if (dark) HighContrastDark else HighContrastLight
        settings.tintedBackground && !dark -> LightColors.copy(
            background = Color(0xFFF7EBC8),
            surface = Color(0xFFF7EBC8),
            surfaceVariant = Color(0xFFEBDDB0),
        )
        dark -> DarkColors
        else -> LightColors
    }

    val spacing = if (settings.lineSpacing == "wide") 1.3f else 1f
    val tracking = if (settings.readableFont) 0.6.sp else null
    val typography = AppTypography.forLook(spacing, tracking)

    val density = LocalDensity.current
    val scaled = Density(density.density, density.fontScale * settings.textScale.toFloat())

    CompositionLocalProvider(
        LocalStudentSettings provides settings,
        LocalDensity provides scaled,
    ) {
        MaterialTheme(colorScheme = colors, typography = typography, shapes = AppShapes) {
            Surface(
                modifier = Modifier.fillMaxSize(),
                color = MaterialTheme.colorScheme.background,
                content = content,
            )
        }
    }
}