package com.samapatra.app.data
import org.json.JSONObject


data class User(val id: String, val name: String, val role: String)

data class StudentProfile(
    val id: String,
    val grade: Int,
    val language: String,
    val needs: List<String>,
    val settings: StudentSettings = StudentSettings(),
)

data class StudentSettings(
    val textScale: Double = 1.0,
    val lineSpacing: String = "normal",
    val readableFont: Boolean = false,
    val tintedBackground: Boolean = false,
    val highContrast: Boolean = false,
    val reduceMotion: Boolean = false,
    val oneQuestionPerScreen: Boolean = false,
    val readAloudButton: Boolean = false,
    val audioFirst: Boolean = false,
    val voiceAnswers: Boolean = false,
    val largeTouchTargets: Boolean = false,
    val plainLanguage: Boolean = false,
    val conciseText: Boolean = false,
    val listenableWording: Boolean = false,
)

data class StudentHome(val subjects: List<String>, val levels: Map<String, Double>)

data class QuestionView(val id: String, val text: String, val options: List<String>)

data class LevelStart(
    val sessionId: String,
    val number: Int,
    val total: Int,
    val question: QuestionView,
)

data class LevelStep(
    val finished: Boolean,
    val number: Int,
    val total: Int,
    val next: QuestionView?,
)


data class Session(val token: String, val user: User, val student: StudentProfile? = null)

data class ClassItem(
    val id: String,
    val name: String,
    val grade: Int,
    val subject: String,
    val joinCode: String,
    val studentCount: Int,
)

data class SignInName(val id: String, val name: String)

data class ClassRoster(val className: String, val students: List<SignInName>)
data class StudentItem(
    val id: String,
    val name: String,
    val grade: Int,
    val language: String,
    val needs: List<String>,
    val level: Double? = null,
    val classIds: List<String> = emptyList(),
)

data class PaperMade(val totalMarks: Double, val warnings: List<String>, val questionCount: Int)

data class PaperSet(
    val title: String,
    val subject: String,
    val totalMarks: Double,
    val papers: Int,
    val drafts: Int,
    val shared: Int,
)

data class ClassDetail(
    val id: String,
    val name: String,
    val grade: Int,
    val subject: String,
    val joinCode: String,
    val students: List<StudentItem>,
)

data class DraftQuestion(
    val number: String,
    val section: String,
    val type: String,
    val marks: Double,
    val chapter: String,
    val difficulty: Int,
    val text: String,
    val options: List<String>,
    val aiAnswer: String?,
    val answerSource: String,
    val needsFigure: Boolean,
    val raw: JSONObject,
)

data class ImportDraft(
    val questions: List<DraftQuestion>,
    val warnings: List<String>,
    val totalMarks: Double,
)

/** How long the server expects an AI job to take, learned from past jobs. In seconds. */
data class AiEstimate(val seconds: Int, val low: Int, val high: Int)

data class NewStudent(val name: String, val pin: String)

data class PaperListItem(
    val id: String,
    val title: String,
    val subject: String,
    val totalMarks: Double,
    val dueAt: String?,
)

data class PaperQuestion(
    val sequence: Int,
    val marks: Double,
    val type: String,
    val text: String,
    val options: List<String>,
)

data class PaperView(
    val title: String,
    val subject: String,
    val totalMarks: Double,
    val durationMinutes: Int?,
    val questions: List<PaperQuestion>,
)

data class BankPaper(
    val key: String,
    val name: String,
    val subject: String,
    val grade: Int,
    val questions: Int,
    val totalMarks: Double,
    val levelCheckReady: Int,
    val unchecked: Int,
    val createdAt: String,
    val mine: Boolean,
)

data class BankQuestion(
    val id: String,
    val number: String,
    val type: String,
    val marks: Double,
    val chapter: String,
    val difficulty: Int,
    val text: String,
    val options: List<String>,
    val correctAnswer: String?,
    val checked: Boolean,
    val needsFigure: Boolean,
)

data class BankPaperDetail(
    val name: String,
    val subject: String,
    val grade: Int,
    val mine: Boolean,
    val unsharedPapers: Int,
    val sharedPapers: Int,
    val questions: List<BankQuestion>,
)

data class DeletePreview(
    val students: Int,
    val onlyHere: Int,
    val draftPapers: Int,
    val sharedPapers: Int,
)