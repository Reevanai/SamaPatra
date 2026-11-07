package com.samapatra.app.data

import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

object SamaPatraApi {

    suspend fun teacherRegister(
        name: String,
        email: String,
        password: String,
        signupCode: String,
    ): ApiResult<Session> = ApiClient.post(
        "/auth/teacher/register",
        JSONObject()
            .put("name", name)
            .put("email", email)
            .put("password", password)
            .put("signupCode", signupCode),
    ).map { parseSession(it) }

    suspend fun teacherLogin(email: String, password: String): ApiResult<Session> =
        ApiClient.post(
            "/auth/teacher/login",
            JSONObject().put("email", email).put("password", password),
        ).map { parseSession(it) }

    suspend fun classRoster(code: String): ApiResult<ClassRoster> =
        ApiClient.get("/auth/class/$code/students").map { json ->
            val arr = json.optJSONArray("students") ?: JSONArray()
            ClassRoster(
                className = json.getString("className"),
                students = List(arr.length()) { i ->
                    val o = arr.getJSONObject(i)
                    SignInName(o.getString("id"), o.getString("name"))
                },
            )
        }

    suspend fun studentLogin(code: String, studentId: String, pin: String): ApiResult<Session> =
        ApiClient.post(
            "/auth/student/login",
            JSONObject()
                .put("classCode", code)
                .put("studentId", studentId)
                .put("pin", pin),
        ).map { parseSession(it) }

    suspend fun teacherClasses(token: String, teacherId: String): ApiResult<List<ClassItem>> =
        ApiClient.get("/teachers/$teacherId/classes", token).map { json ->
            val arr = json.optJSONArray("classes") ?: JSONArray()
            List(arr.length()) { i ->
                val o = arr.getJSONObject(i)
                ClassItem(
                    id = o.getString("id"),
                    name = o.getString("name"),
                    grade = o.getInt("grade"),
                    subject = o.getString("subject"),
                    joinCode = o.stringOrEmpty("join_code"),
                    // Postgres sends COUNT as text, so read it as text and convert.
                    studentCount = o.optString("student_count").toIntOrNull() ?: 0,
                )
            }
        }

    suspend fun createClass(
        token: String,
        name: String,
        grade: Int,
        subject: String,
    ): ApiResult<String> = ApiClient.post(
        "/classes",
        JSONObject().put("name", name).put("grade", grade).put("subject", subject),
        token,
    ).map { it.getString("joinCode") }
    suspend fun classDetail(token: String, classId: String): ApiResult<ClassDetail> =
        ApiClient.get("/classes/$classId/roster", token).map { json ->
            val c = json.getJSONObject("class")
            val arr = json.optJSONArray("students") ?: JSONArray()
            ClassDetail(
                id = c.getString("id"),
                name = c.getString("name"),
                grade = c.getInt("grade"),
                subject = c.getString("subject"),
                joinCode = c.stringOrEmpty("joinCode"),
                students = List(arr.length()) { i ->
                    val o = arr.getJSONObject(i)
                    StudentItem(
                        id = o.getString("id"),
                        name = o.getString("name"),
                        grade = o.getInt("grade"),
                        language = o.getString("language"),
                        needs = o.optJSONArray("accessibilityNeeds").toStringList(),
                        level = if (o.isNull("level")) null else o.getDouble("level"),
                        classIds = o.optJSONArray("classIds").toStringList(),
                    )
                },
            )
        }

    suspend fun addStudent(
        token: String,
        classId: String,
        name: String,
        grade: Int,
        language: String,
        needs: List<String>,
        alsoClassIds: List<String> = emptyList(),
    ): ApiResult<NewStudent> = ApiClient.post(
        "/classes/$classId/students",
        JSONObject()
            .put("name", name)
            .put("grade", grade)
            .put("language", language)
            .put("accessibilityNeeds", JSONArray(needs))
            .put("alsoClassIds", JSONArray(alsoClassIds)),
        token,
    ).map { NewStudent(it.getString("name"), it.getString("pin")) }

    suspend fun resetPin(token: String, classId: String, studentId: String): ApiResult<String> =
        ApiClient.post("/classes/$classId/students/$studentId/reset-pin", JSONObject(), token)
            .map { it.getString("pin") }

    /** How long reading a paper of this size will probably take. Pages are optional. */
    suspend fun estimatePdfImport(token: String, pages: Int?, bytes: Int): ApiResult<AiEstimate> {
        val query = buildString {
            append("/ai/estimate?operation=pdf_import&bytes=").append(bytes)
            if (pages != null && pages > 0) append("&pages=").append(pages)
        }
        return ApiClient.get(query, token).map { json ->
            AiEstimate(
                seconds = json.getInt("seconds"),
                low = json.optInt("low", json.getInt("seconds")),
                high = json.optInt("high", json.getInt("seconds")),
            )
        }
    }

    suspend fun importPaperPdf(
        token: String,
        grade: Int,
        subject: String,
        pdf: ByteArray,
    ): ApiResult<ImportDraft> = ApiClient.postMultipart(
        path = "/questions/import-pdf",
        fields = listOf("grade" to grade.toString(), "subject" to subject),
        fileField = "file",
        fileName = "paper.pdf",
        fileType = "application/pdf",
        fileBytes = pdf,
        token = token,
    ).map { json ->
        val arr = json.optJSONArray("questions") ?: JSONArray()
        ImportDraft(
            questions = List(arr.length()) { i -> parseDraft(arr.getJSONObject(i)) },
            warnings = json.optJSONArray("warnings").toStringList(),
            totalMarks = json.getJSONObject("summary").getDouble("totalMarks"),
        )
    }

    suspend fun saveQuestions(token: String, paperName: String, questions: List<JSONObject>): ApiResult<Int> =
        ApiClient.post(
            "/questions/bulk-import",
            JSONObject().put("paperName", paperName).put("questions", JSONArray(questions)),
            token,
        ).map { it.getInt("imported") }

    private fun parseDraft(o: JSONObject): DraftQuestion {
        val content = o.getJSONObject("content")
        val meta = o.getJSONObject("metadata")
        return DraftQuestion(
            number = meta.optString("questionNumber"),
            section = meta.optString("section"),
            type = o.getString("type"),
            marks = o.getDouble("marks"),
            chapter = o.optString("chapter"),
            difficulty = o.optInt("difficulty", 3),
            text = content.getString("text"),
            options = content.optJSONArray("options").toStringList(),
            aiAnswer = if (content.isNull("correct_answer")) null else content.getString("correct_answer"),
            answerSource = meta.optString("answerSource", "none"),
            needsFigure = meta.optBoolean("needsFigure", false),
            raw = o,
        )
    }

    suspend fun studentHome(token: String): ApiResult<StudentHome> =
        ApiClient.get("/me/home", token).map { json ->
            val levels = mutableMapOf<String, Double>()
            val levelsJson = json.optJSONObject("levels")
            levelsJson?.keys()?.forEach { key -> levels[key] = levelsJson.getDouble(key) }
            StudentHome(
                subjects = json.optJSONArray("subjects").toStringList(),
                levels = levels,
            )
        }

    suspend fun saveSettings(token: String, patch: JSONObject): ApiResult<StudentSettings> =
        ApiClient.put("/me/preferences", patch, token)
            .map { parseSettings(it.getJSONObject("settings")) }

    suspend fun resetSettings(token: String): ApiResult<StudentSettings> =
        ApiClient.delete("/me/preferences", token)
            .map { parseSettings(it.getJSONObject("settings")) }

    suspend fun startLevelCheck(token: String, subject: String): ApiResult<LevelStart> =
        ApiClient.post("/adaptive-test/start", JSONObject().put("subject", subject), token)
            .map { json ->
                LevelStart(
                    sessionId = json.getString("testSessionId"),
                    number = json.getInt("questionNumber"),
                    total = json.getInt("totalQuestions"),
                    question = parseQuestionView(json.getJSONObject("question")),
                )
            }

    suspend fun answerLevelCheck(
        token: String,
        sessionId: String,
        questionId: String,
        answer: String,
    ): ApiResult<LevelStep> = ApiClient.post(
        "/adaptive-test/answer",
        JSONObject()
            .put("testSessionId", sessionId)
            .put("questionId", questionId)
            .put("answer", answer),
        token,
    ).map { json ->
        LevelStep(
            finished = json.optBoolean("finished", false),
            number = json.optInt("questionNumber", 0),
            total = json.optInt("totalQuestions", 10),
            next = json.optJSONObject("nextQuestion")?.let { parseQuestionView(it) },
        )
    }

    private fun parseQuestionView(o: JSONObject) = QuestionView(
        id = o.getString("id"),
        text = o.getString("text"),
        options = o.optJSONArray("options").toStringList(),
    )

    private fun parseSettings(o: JSONObject) = StudentSettings(
        textScale = o.optDouble("textScale", 1.0).coerceIn(1.0, 2.0),
        lineSpacing = o.optString("lineSpacing", "normal"),
        readableFont = o.optBoolean("readableFont"),
        tintedBackground = o.optBoolean("tintedBackground"),
        highContrast = o.optBoolean("highContrast"),
        reduceMotion = o.optBoolean("reduceMotion"),
        oneQuestionPerScreen = o.optBoolean("oneQuestionPerScreen"),
        readAloudButton = o.optBoolean("readAloudButton"),
        audioFirst = o.optBoolean("audioFirst"),
        voiceAnswers = o.optBoolean("voiceAnswers"),
        largeTouchTargets = o.optBoolean("largeTouchTargets"),
        plainLanguage = o.optBoolean("plainLanguage"),
        conciseText = o.optBoolean("conciseText"),
        listenableWording = o.optBoolean("listenableWording"),
    )

    suspend fun generatePaper(
        token: String,
        classId: String,
        studentId: String,
        subject: String,
        grade: Int,
        totalMarks: Double,
        title: String,
        durationMinutes: Int?,
    ): ApiResult<PaperMade> {
        val body = JSONObject()
            .put("studentId", studentId)
            .put("classId", classId)
            .put("subject", subject)
            .put("grade", grade)
            .put("totalMarks", totalMarks)
            .put("title", title)
        if (durationMinutes != null) body.put("durationMinutes", durationMinutes)
        return ApiClient.postLong("/papers/generate", body, token).map { json ->
            val paper = json.getJSONObject("paper")
            PaperMade(
                totalMarks = paper.getDouble("totalMarks"),
                warnings = paper.optJSONArray("warnings").toStringList(),
                questionCount = paper.getJSONArray("questions").length(),
            )
        }
    }

    suspend fun classPaperSets(token: String, classId: String): ApiResult<List<PaperSet>> =
        ApiClient.get("/classes/$classId/papers", token).map { json ->
            val arr = json.optJSONArray("sets") ?: JSONArray()
            List(arr.length()) { i ->
                val o = arr.getJSONObject(i)
                PaperSet(
                    title = o.getString("title"),
                    subject = o.getString("subject"),
                    totalMarks = o.getDouble("totalMarks"),
                    papers = o.getInt("papers"),
                    drafts = o.getInt("drafts"),
                    shared = o.getInt("shared"),
                )
            }
        }

    suspend fun publishPaperSet(token: String, classId: String, title: String): ApiResult<Int> =
        ApiClient.post("/classes/$classId/papers/publish", JSONObject().put("title", title), token)
            .map { it.getInt("published") }

    suspend fun studentPapers(token: String, studentId: String): ApiResult<List<PaperListItem>> =
        ApiClient.get("/papers/student/$studentId", token).map { json ->
            val arr = json.optJSONArray("papers") ?: JSONArray()
            List(arr.length()) { i ->
                val o = arr.getJSONObject(i)
                PaperListItem(
                    id = o.getString("id"),
                    title = o.getString("title"),
                    subject = o.getString("subject"),
                    totalMarks = o.getDouble("totalMarks"),
                    dueAt = if (o.isNull("dueAt")) null else o.getString("dueAt"),
                )
            }
        }

    suspend fun paperView(token: String, paperId: String): ApiResult<PaperView> =
        ApiClient.get("/papers/$paperId", token).map { json ->
            val p = json.getJSONObject("paper")
            val arr = json.optJSONArray("questions") ?: JSONArray()
            PaperView(
                title = p.getString("title"),
                subject = p.getString("subject"),
                totalMarks = p.getDouble("totalMarks"),
                durationMinutes = if (p.isNull("durationMinutes")) null else p.getInt("durationMinutes"),
                questions = List(arr.length()) { i ->
                    val o = arr.getJSONObject(i)
                    val c = o.getJSONObject("content")
                    PaperQuestion(
                        sequence = o.getInt("sequence"),
                        marks = o.getDouble("marks"),
                        type = o.getString("type"),
                        text = c.getString("text"),
                        options = c.optJSONArray("options").toStringList(),
                    )
                },
            )
        }

    suspend fun bankPapers(token: String): ApiResult<List<BankPaper>> =
        ApiClient.get("/bank/papers", token).map { json ->
            val arr = json.optJSONArray("papers") ?: JSONArray()
            List(arr.length()) { i ->
                val o = arr.getJSONObject(i)
                BankPaper(
                    key = o.getString("key"),
                    name = o.stringOrEmpty("name"),
                    subject = o.getString("subject"),
                    grade = o.getInt("grade"),
                    questions = o.getInt("questions"),
                    totalMarks = o.getDouble("totalMarks"),
                    levelCheckReady = o.getInt("levelCheckReady"),
                    unchecked = o.getInt("unchecked"),
                    createdAt = o.stringOrEmpty("createdAt"),
                    mine = o.optBoolean("mine"),
                )
            }
        }

    suspend fun bankPaper(token: String, key: String): ApiResult<BankPaperDetail> =
        ApiClient.get("/bank/papers/${Uri.encode(key)}", token).map { json ->
            val p = json.getJSONObject("paper")
            val arr = json.optJSONArray("questions") ?: JSONArray()
            BankPaperDetail(
                name = p.stringOrEmpty("name"),
                subject = p.getString("subject"),
                grade = p.getInt("grade"),
                mine = p.optBoolean("mine"),
                unsharedPapers = p.optInt("unsharedPapers"),
                sharedPapers = p.optInt("sharedPapers"),
                questions = List(arr.length()) { i ->
                    val o = arr.getJSONObject(i)
                    BankQuestion(
                        id = o.getString("id"),
                        number = o.stringOrEmpty("number"),
                        type = o.getString("type"),
                        marks = o.getDouble("marks"),
                        chapter = o.stringOrEmpty("chapter"),
                        difficulty = o.optInt("difficulty", 3),
                        text = o.getString("text"),
                        options = o.optJSONArray("options").toStringList(),
                        correctAnswer = if (o.isNull("correctAnswer")) null else o.getString("correctAnswer"),
                        checked = o.optBoolean("answerChecked", true),
                        needsFigure = o.optBoolean("needsFigure"),
                    )
                },
            )
        }

    suspend fun deleteBankPaper(token: String, key: String): ApiResult<Unit> =
        ApiClient.delete("/bank/papers/${Uri.encode(key)}", token).map { }

    suspend fun setStudentClasses(token: String, studentId: String, classIds: List<String>): ApiResult<Unit> =
        ApiClient.put(
            "/students/$studentId/classes",
            JSONObject().put("classIds", JSONArray(classIds)),
            token,
        ).map { }

    suspend fun deleteStudent(token: String, studentId: String): ApiResult<Unit> =
        ApiClient.delete("/students/$studentId", token).map { }

    suspend fun classDeletePreview(token: String, classId: String): ApiResult<DeletePreview> =
        ApiClient.get("/classes/$classId/delete-preview", token).map { json ->
            DeletePreview(
                students = json.getInt("students"),
                onlyHere = json.getInt("onlyHere"),
                draftPapers = json.getInt("draftPapers"),
                sharedPapers = json.getInt("sharedPapers"),
            )
        }

    suspend fun deleteClass(token: String, classId: String, alsoDeleteStudents: Boolean): ApiResult<Unit> =
        ApiClient.delete("/classes/$classId?deleteStudents=$alsoDeleteStudents", token).map { }

    private fun parseSession(json: JSONObject): Session {
        val u = json.getJSONObject("user")
        val user = User(u.getString("id"), u.getString("name"), u.getString("role"))
        val student = json.optJSONObject("student")?.let {
            StudentProfile(
                id = it.getString("id"),
                grade = it.getInt("grade"),
                language = it.getString("language"),
                needs = it.optJSONArray("accessibilityNeeds").toStringList(),
                settings = it.optJSONObject("settings")?.let { s -> parseSettings(s) }
                    ?: StudentSettings(),
            )
        }
        return Session(json.getString("token"), user, student)
    }

    private fun JSONObject.stringOrEmpty(key: String): String =
        if (isNull(key)) "" else getString(key)

    private fun JSONArray?.toStringList(): List<String> =
        if (this == null) emptyList() else List(length()) { getString(it) }
}