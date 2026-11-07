package com.samapatra.app.ui

import android.content.Context
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.samapatra.app.data.ApiResult
import com.samapatra.app.data.DraftQuestion
import com.samapatra.app.data.ImportDraft
import com.samapatra.app.data.SamaPatraApi
import com.samapatra.app.data.SessionStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import kotlin.math.exp
import kotlin.math.roundToInt

// The server (Vercel) accepts uploads up to 4.5 MB, including the form around the file
private const val MAX_PDF_BYTES = 4 * 1024 * 1024
private const val LETTERS = "ABCDEFGH"

// ---------------------------------------------------------------------------
// What the teacher has decided about one imported question
// ---------------------------------------------------------------------------

private data class Review(
    val include: Boolean = true,        // keep this question in the bank?
    val chosen: String? = null,         // the answer letter, for multiple-choice questions
    val confirmed: Boolean = false,     // has the teacher checked that answer?
    val difficulty: Int = 3,            // 1 (easy) to 5 (hard)
)

private fun startingReview(q: DraftQuestion) = Review(
    chosen = q.aiAnswer,
    confirmed = q.answerSource == "document", // an answer printed in the paper needs no check
    difficulty = q.difficulty.coerceIn(1, 5),
)

// ---------------------------------------------------------------------------
// Which step the screen is on
// ---------------------------------------------------------------------------

private sealed interface Stage {
    object Setup : Stage                           // choose subject, grade and the PDF
    // the AI is reading the PDF; estimateSeconds is null until the server has answered
    class Reading(val estimateSeconds: Int?, val startedAt: Long) : Stage
    class Reviewing(val draft: ImportDraft) : Stage // the teacher checks every question
    class Saved(val count: Int) : Stage            // done
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

private fun isObjective(q: DraftQuestion) = q.type == "mcq" || q.type == "assertion_reason"

private fun typeLabel(type: String) = when (type) {
    "mcq" -> "Multiple choice"
    "assertion_reason" -> "Assertion and reason"
    "short_answer" -> "Short answer"
    "long_answer" -> "Long answer"
    "case_study" -> "Case study"
    else -> type
}

private fun marksText(marks: Double) =
    if (marks % 1.0 == 0.0) marks.toInt().toString() else marks.toString()

/** The file's name as the picker shows it, for example "CBSE Maths Sample Paper.pdf". */
private fun fileDisplayName(context: Context, uri: Uri): String? =
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
        ?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }

/** Reads the file, or returns null if it can't be opened or is over the size limit. */
private fun readCapped(context: Context, uri: Uri, maxBytes: Int): ByteArray? {
    context.contentResolver.openInputStream(uri)?.use { input ->
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            if (out.size() > maxBytes) return null
        }
        return out.toByteArray()
    }
    return null
}

/** The question as it will be saved, with the teacher's confirmed answer and difficulty. */
private fun buildSaveJson(q: DraftQuestion, review: Review): JSONObject {
    val copy = JSONObject(q.raw.toString())
    copy.put("difficulty", review.difficulty)
    if (isObjective(q) && review.chosen != null) {
        copy.getJSONObject("content").put("correct_answer", review.chosen)
        val meta = copy.getJSONObject("metadata")
        meta.put("answerVerified", true)
        if (review.chosen != q.aiAnswer) meta.put("answerSource", "teacher")
    }
    return copy
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

@Composable
fun ImportPaperScreen(onBack: () -> Unit, onSignOut: () -> Unit) {
    val session = SessionStore.session
    if (session == null) {
        LaunchedEffect(Unit) { onSignOut() }
        return
    }

    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // Chosen on the first step
    var subject by remember { mutableStateOf("Mathematics") }
    var gradeIndex by remember { mutableStateOf(1) } // 0 = Grade 9, 1 = Grade 10

    // Where we are, and the last error to show
    var stage by remember { mutableStateOf<Stage>(Stage.Setup) }
    var error by remember { mutableStateOf<String?>(null) }

    // Used on the review step
    var paperName by remember { mutableStateOf("") }
    val reviews = remember { mutableStateListOf<Review>() }
    var saving by remember { mutableStateOf(false) }
    var confirmLeave by remember { mutableStateOf(false) }

    // Step 1 to 2: read the chosen PDF and ask the AI to find the questions
    fun readPaper(uri: Uri) {
        scope.launch {
            error = null
            stage = Stage.Reading(estimateSeconds = null, startedAt = System.currentTimeMillis())

            paperName = withContext(Dispatchers.IO) { fileDisplayName(context, uri) }
                ?.removeSuffix(".pdf")
                ?.replace('_', ' ')
                ?.trim()
                .orEmpty()

            val bytes = withContext(Dispatchers.IO) { readCapped(context, uri, MAX_PDF_BYTES) }
            if (bytes == null) {
                error = "Couldn’t read that file, or it is over 4 MB. Use a smaller PDF."
                stage = Stage.Setup
                return@launch
            }

            // Ask how long this will probably take, so the wait shows a countdown, not just a spinner
            val pages = withContext(Dispatchers.IO) { countPages(context, uri) }
            val estimate = when (val e = SamaPatraApi.estimatePdfImport(session.token, pages, bytes.size)) {
                is ApiResult.Ok -> e.value.seconds
                is ApiResult.Failure -> null
            }
            stage = Stage.Reading(estimateSeconds = estimate, startedAt = System.currentTimeMillis())

            val grade = if (gradeIndex == 0) 9 else 10
            when (val result = SamaPatraApi.importPaperPdf(session.token, grade, subject.trim(), bytes)) {
                is ApiResult.Ok -> {
                    val draft = result.value
                    if (draft.questions.isEmpty()) {
                        error = "No questions were found in that file."
                        stage = Stage.Setup
                    } else {
                        reviews.clear()
                        reviews.addAll(draft.questions.map { startingReview(it) })
                        stage = Stage.Reviewing(draft)
                    }
                }
                is ApiResult.Failure -> {
                    error = result.message
                    stage = Stage.Setup
                }
            }
        }
    }

    // Step 3: save the questions the teacher kept
    fun save(draft: ImportDraft) {
        if (saving) return
        val kept = draft.questions.indices.filter { reviews[it].include }
        when {
            paperName.isBlank() -> error = "Give this paper a name, so you can find it later."
            kept.isEmpty() -> error = "Keep at least one question."
            kept.size > 150 -> error = "That is more than 150 questions. Leave some out and save again."
            else -> scope.launch {
                saving = true
                error = null
                val items = kept.map { buildSaveJson(draft.questions[it], reviews[it]) }
                when (val result = SamaPatraApi.saveQuestions(session.token, paperName.trim(), items)) {
                    is ApiResult.Ok -> stage = Stage.Saved(result.value)
                    is ApiResult.Failure -> error = result.message
                }
                saving = false
            }
        }
    }

    fun confirmEveryAnswer() {
        for (i in reviews.indices) {
            val r = reviews[i]
            if (r.include && r.chosen != null) reviews[i] = r.copy(confirmed = true)
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri != null) readPaper(uri)
    }

    fun leave() {
        if (stage is Stage.Reviewing) confirmLeave = true else onBack()
    }

    BackHandler(enabled = stage is Stage.Reviewing) { confirmLeave = true }

    val title = when (stage) {
        is Stage.Setup -> "Import a question paper"
        is Stage.Reading -> "Reading your paper"
        is Stage.Reviewing -> "Check the questions"
        is Stage.Saved -> "Saved"
    }

    ScreenFrame(title = title, onBack = { leave() }) {
        when (val current = stage) {
            is Stage.Setup -> SetupStep(
                subject = subject,
                onSubject = { subject = it },
                gradeIndex = gradeIndex,
                onGrade = { gradeIndex = it },
                error = error,
                onChoosePdf = { picker.launch(arrayOf("application/pdf")) },
            )

            is Stage.Reading -> ReadingStep(current.estimateSeconds, current.startedAt)

            is Stage.Reviewing -> ReviewStep(
                draft = current.draft,
                reviews = reviews,
                onChange = { index, review -> reviews[index] = review },
                paperName = paperName,
                onPaperName = { paperName = it },
                error = error,
                saving = saving,
                onConfirmAll = { confirmEveryAnswer() },
                onSave = { save(current.draft) },
            )

            is Stage.Saved -> SavedStep(
                count = current.count,
                onAnother = {
                    error = null
                    stage = Stage.Setup
                },
                onBack = onBack,
            )
        }
    }

    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text("Leave without saving?") },
            text = { Text("The answers you have checked will be lost.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmLeave = false
                    onBack()
                }) { Text("Leave") }
            },
            dismissButton = {
                TextButton(onClick = { confirmLeave = false }) { Text("Stay") }
            },
        )
    }
}

// ---------------------------------------------------------------------------
// The four steps
// ---------------------------------------------------------------------------

@Composable
private fun SetupStep(
    subject: String,
    onSubject: (String) -> Unit,
    gradeIndex: Int,
    onGrade: (Int) -> Unit,
    error: String?,
    onChoosePdf: () -> Unit,
) {
    Text(
        text = "Choose a CBSE question paper as a PDF. The AI reads it, then you check every question and answer before anything is saved.",
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    Field(
        value = subject,
        onValueChange = onSubject,
        label = "Subject",
        imeAction = ImeAction.Done,
    )
    Text("Grade", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onBackground)
    ChoiceGroup(
        options = listOf("Grade 9", "Grade 10"),
        selectedIndex = gradeIndex,
        onSelect = onGrade,
    )
    ErrorText(error)
    PrimaryButton(text = "Choose PDF", onClick = onChoosePdf, enabled = subject.isNotBlank())
}

@Composable
private fun ReadingStep(estimateSeconds: Int?, startedAt: Long) {
    // Ticks twice a second so the countdown moves
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(startedAt) {
        while (true) {
            now = System.currentTimeMillis()
            delay(500)
        }
    }
    val elapsed = ((now - startedAt) / 1000f).coerceAtLeast(0f)

    if (estimateSeconds == null || estimateSeconds <= 0) {
        LinearProgressIndicator(
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = "Reading the paper" },
        )
        Text(
            text = "The AI is reading your paper. This usually takes a minute or two. Please keep this screen open.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onBackground,
        )
        Text(
            text = "${formatDuration(elapsed.roundToInt())} so far",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        return
    }

    val total = estimateSeconds.toFloat()
    // Fills to 95% at the estimate, then creeps on slowly so it never looks stuck
    val fraction = if (elapsed <= total) {
        0.95f * elapsed / total
    } else {
        0.95f + 0.04f * (1f - exp(-(elapsed - total) / total))
    }
    val left = total - elapsed
    val status = when {
        left > 3f -> "About ${formatDuration(left.roundToInt())} left"
        left > -10f -> "Almost done…"
        else -> "Taking a little longer than usual (${formatDuration(elapsed.roundToInt())} so far)…"
    }

    Text(
        text = "The AI is reading your paper. It usually needs about ${formatDuration(estimateSeconds)} for a paper like this. Please keep this screen open.",
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onBackground,
    )
    LinearProgressIndicator(
        progress = { fraction },
        modifier = Modifier
            .fillMaxWidth()
            .semantics { contentDescription = "Reading the paper. $status" },
    )
    Text(
        text = status,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** "45 seconds", "1 min 20 s", "2 minutes". */
private fun formatDuration(seconds: Int): String {
    val s = seconds.coerceAtLeast(0)
    if (s < 60) return if (s == 1) "1 second" else "$s seconds"
    val m = s / 60
    val r = s % 60
    return when {
        r != 0 -> "$m min $r s"
        m == 1 -> "1 minute"
        else -> "$m minutes"
    }
}

/** Number of pages, using Android's own PDF reader. Null if the file can't be opened (for example, password-protected). */
private fun countPages(context: Context, uri: Uri): Int? = try {
    context.contentResolver.openFileDescriptor(uri, "r")?.use { fd ->
        PdfRenderer(fd).use { it.pageCount }
    }
} catch (e: Exception) {
    null
}

@Composable
private fun ReviewStep(
    draft: ImportDraft,
    reviews: List<Review>,
    onChange: (Int, Review) -> Unit,
    paperName: String,
    onPaperName: (String) -> Unit,
    error: String?,
    saving: Boolean,
    onConfirmAll: () -> Unit,
    onSave: () -> Unit,
) {
    val kept = draft.questions.indices.filter { reviews[it].include }
    // Multiple-choice answers the teacher hasn't checked yet
    val unchecked = kept.count { i ->
        isObjective(draft.questions[i]) && !(reviews[i].chosen != null && reviews[i].confirmed)
    }

    Text(
        text = "Found ${draft.questions.size} questions worth ${marksText(draft.totalMarks)} marks.",
        style = MaterialTheme.typography.titleMedium,
        color = MaterialTheme.colorScheme.onBackground,
    )
    draft.warnings.forEach {
        Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    Text(
        text = "Check every answer against the official marking scheme, and pick another option if one is wrong. Marking and the level check only use answers you have confirmed.",
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onBackground,
    )
    SecondaryButton(text = "I’ve checked them all. Confirm every answer", onClick = onConfirmAll)

    draft.questions.forEachIndexed { index, question ->
        ReviewCard(
            q = question,
            review = reviews[index],
            onChange = { onChange(index, it) },
        )
    }

    Field(
        value = paperName,
        onValueChange = onPaperName,
        label = "Name of this paper",
        imeAction = ImeAction.Done,
    )
    ErrorText(error)
    if (unchecked > 0) {
        Text(
            text = if (unchecked == 1) "1 answer still to check." else "$unchecked answers still to check.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.error,
        )
    }
    PrimaryButton(
        text = "Save ${kept.size} questions",
        onClick = onSave,
        enabled = unchecked == 0 && kept.isNotEmpty(),
        loading = saving,
    )
}

@Composable
private fun SavedStep(count: Int, onAnother: () -> Unit, onBack: () -> Unit) {
    Text(
        text = "Saved $count questions to your question bank.",
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onBackground,
    )
    PrimaryButton(text = "Import another paper", onClick = onAnother)
    SecondaryButton(text = "Back to classes", onClick = onBack)
}

// ---------------------------------------------------------------------------
// One question on the review step
// ---------------------------------------------------------------------------

@Composable
private fun ReviewCard(q: DraftQuestion, review: Review, onChange: (Review) -> Unit) {
    val colors = MaterialTheme.colorScheme
    val marksLabel = marksText(q.marks) + if (q.marks == 1.0) " mark" else " marks"

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (review.include) 1f else 0.6f)
            .clip(MaterialTheme.shapes.large)
            .background(colors.surfaceVariant)
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = "Question ${q.number} · ${typeLabel(q.type)} · $marksLabel",
            style = MaterialTheme.typography.labelLarge,
            color = colors.primary,
        )
        if (q.chapter.isNotBlank()) {
            Text(q.chapter, style = MaterialTheme.typography.bodyMedium, color = colors.onSurfaceVariant)
        }
        Text(q.text, style = MaterialTheme.typography.bodyLarge, color = colors.onBackground)
        if (q.needsFigure) {
            Text(
                text = "This question refers to a figure. Papers for students who listen will leave it out.",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.onSurfaceVariant,
            )
        }

        if (isObjective(q)) {
            AnswerChoice(q = q, review = review, onChange = onChange)
        }

        DifficultyRow(review = review, onChange = onChange)

        LabeledCheck(
            checked = review.include,
            label = "Add to question bank",
            onChange = { onChange(review.copy(include = it)) },
        )
    }
}

@Composable
private fun AnswerChoice(q: DraftQuestion, review: Review, onChange: (Review) -> Unit) {
    val colors = MaterialTheme.colorScheme

    if (q.options.isEmpty()) {
        Text(
            text = "No answer options were found for this question. Leave it out of the bank.",
            style = MaterialTheme.typography.bodyMedium,
            color = colors.error,
        )
        return
    }

    Text("Correct answer", style = MaterialTheme.typography.titleMedium, color = colors.onBackground)
    val selected = review.chosen
        ?.let { LETTERS.indexOf(it) }
        ?.takeIf { it in q.options.indices }
        ?: -1
    ChoiceGroup(
        options = q.options,
        selectedIndex = selected,
        onSelect = { index ->
            // Picking an option counts as checking it
            onChange(review.copy(chosen = LETTERS[index].toString(), confirmed = true))
        },
    )
    if (q.answerSource == "ai" && review.chosen == q.aiAnswer && !review.confirmed) {
        Text(
            text = "Chosen by the AI. Please check it.",
            style = MaterialTheme.typography.bodyMedium,
            color = colors.onSurfaceVariant,
        )
    }
    LabeledCheck(
        checked = review.confirmed,
        label = "I’ve checked this answer",
        enabled = review.chosen != null,
        onChange = { onChange(review.copy(confirmed = it)) },
    )
}

@Composable
private fun DifficultyRow(review: Review, onChange: (Review) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(
            enabled = review.difficulty > 1,
            onClick = { onChange(review.copy(difficulty = review.difficulty - 1)) },
            modifier = Modifier.semantics { contentDescription = "Make easier" },
        ) { Text("−") }
        Text(
            text = "Difficulty ${review.difficulty} of 5",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onBackground,
        )
        TextButton(
            enabled = review.difficulty < 5,
            onClick = { onChange(review.copy(difficulty = review.difficulty + 1)) },
            modifier = Modifier.semantics { contentDescription = "Make harder" },
        ) { Text("+") }
    }
}

@Composable
private fun LabeledCheck(
    checked: Boolean,
    label: String,
    enabled: Boolean = true,
    onChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .toggleable(
                value = checked,
                enabled = enabled,
                role = Role.Checkbox,
                onValueChange = onChange,
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
        Spacer(Modifier.width(12.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onBackground,
        )
    }
}