package com.samapatra.app.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Where the app finds the server. An admin can change it from inside the app. */
object ApiConfig {
    /**
     * Used until an admin sets another address in the app.
     * For a server on your laptop, an Android emulator reaches it at http://10.0.2.2:3000.
     */
    const val DEFAULT_URL = "https://samapatra-api.vercel.app"

    private const val PREFS = "samapatra_server"
    private const val KEY_URL = "base_url"

    @Volatile
    var baseUrl: String = DEFAULT_URL
        private set

    /** Call once when the app starts. */
    fun init(context: Context) {
        val saved = context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getString(KEY_URL, null)
        if (!saved.isNullOrBlank()) baseUrl = saved
    }

    fun save(context: Context, url: String) {
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putString(KEY_URL, url).apply()
        baseUrl = url
    }

    fun reset(context: Context) {
        context.applicationContext
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().remove(KEY_URL).apply()
        baseUrl = DEFAULT_URL
    }

    /** Tidies what an admin typed. Returns null if it can't be a server address. */
    fun clean(input: String): String? {
        var text = input.trim()
        if (text.isEmpty()) return null
        if (!text.startsWith("http://", ignoreCase = true) && !text.startsWith("https://", ignoreCase = true)) {
            // Real servers use https. Plain http only for a laptop or local network address.
            val host = text.substringBefore('/').substringBefore(':').lowercase()
            val local = host == "localhost" || host.matches(Regex("""\d{1,3}(\.\d{1,3}){3}""")) || host.endsWith(".local")
            text = (if (local) "http://" else "https://") + text
        }
        val url = text.toHttpUrlOrNull() ?: return null
        val defaultPort = if (url.isHttps) 443 else 80
        val port = if (url.port == defaultPort) "" else ":${url.port}"
        return "${url.scheme}://${url.host}$port"
    }
}

sealed interface ApiResult<out T> {
    data class Ok<T>(val value: T) : ApiResult<T>
    data class Failure(val message: String, val code: Int = 0) : ApiResult<Nothing>
}

/** Converts a successful result. A reply in an unexpected shape becomes a Failure, not a crash. */
fun <A, B> ApiResult<A>.map(transform: (A) -> B): ApiResult<B> = when (this) {
    is ApiResult.Ok -> try {
        ApiResult.Ok(transform(value))
    } catch (e: JSONException) {
        ApiResult.Failure("The server sent a reply the app didn’t understand.")
    }
    is ApiResult.Failure -> this
}

object ApiClient {
    private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

    val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    // Reading a whole paper or making a student's paper with AI can take a few minutes
    private val longClient: OkHttpClient = http.newBuilder()
        .callTimeout(5, TimeUnit.MINUTES)
        .readTimeout(5, TimeUnit.MINUTES)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    /** True only if the server at this address answers /health with a success code. */
    suspend fun isReachable(baseUrl: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val client = http.newBuilder().callTimeout(6, TimeUnit.SECONDS).build()
            val request = Request.Builder().url("$baseUrl/health").build()
            client.newCall(request).execute().use { it.isSuccessful }
        } catch (e: IOException) {
            false
        } catch (e: IllegalArgumentException) {
            false
        }
    }

    suspend fun isBackendReachable(): Boolean = isReachable(ApiConfig.baseUrl)

    suspend fun get(path: String, token: String? = null): ApiResult<JSONObject> =
        call(path, token, http) { it.get() }

    suspend fun post(path: String, body: JSONObject, token: String? = null): ApiResult<JSONObject> =
        call(path, token, http) { it.post(body.toString().toRequestBody(JSON_TYPE)) }

    suspend fun put(path: String, body: JSONObject, token: String? = null): ApiResult<JSONObject> =
        call(path, token, http) { it.put(body.toString().toRequestBody(JSON_TYPE)) }

    suspend fun delete(path: String, token: String? = null): ApiResult<JSONObject> =
        call(path, token, http) { it.delete() }

    /** Like post, but waits up to five minutes for the reply. */
    suspend fun postLong(path: String, body: JSONObject, token: String? = null): ApiResult<JSONObject> =
        call(path, token, longClient) { it.post(body.toString().toRequestBody(JSON_TYPE)) }

    /** Sends text fields and then one file. The server needs the text fields first. */
    suspend fun postMultipart(
        path: String,
        fields: List<Pair<String, String>>,
        fileField: String,
        fileName: String,
        fileType: String,
        fileBytes: ByteArray,
        token: String?,
    ): ApiResult<JSONObject> {
        val body = MultipartBody.Builder().setType(MultipartBody.FORM).apply {
            fields.forEach { (name, value) -> addFormDataPart(name, value) }
            addFormDataPart(fileField, fileName, fileBytes.toRequestBody(fileType.toMediaType()))
        }.build()
        return call(path, token, longClient) { it.post(body) }
    }

    private suspend fun call(
        path: String,
        token: String?,
        client: OkHttpClient,
        build: (Request.Builder) -> Request.Builder,
    ): ApiResult<JSONObject> = withContext(Dispatchers.IO) {
        try {
            val builder = Request.Builder().url("${ApiConfig.baseUrl}/api$path")
            if (token != null) builder.header("Authorization", "Bearer $token")
            client.newCall(build(builder).build()).execute().use { response ->
                val text = response.body?.string().orEmpty()
                val json = try {
                    JSONObject(text)
                } catch (e: JSONException) {
                    JSONObject()
                }
                if (response.isSuccessful) {
                    ApiResult.Ok(json)
                } else {
                    if (response.code == 401 && token != null) signOutExpired(token)
                    ApiResult.Failure(errorMessage(response.code, json), response.code)
                }
            }
        } catch (e: IOException) {
            ApiResult.Failure("Can’t reach the server. Check your connection and try again.")
        }
    }

    /**
     * The server no longer accepts this sign-in (it expired, or the password changed).
     * Signing out sends every screen back to the start instead of showing errors forever.
     */
    private suspend fun signOutExpired(token: String) = withContext(Dispatchers.Main) {
        if (SessionStore.session?.token == token) SessionStore.signOut()
    }

    private fun errorMessage(status: Int, json: JSONObject): String {
        val serverMessage = json.optString("message")
        return when {
            // 502 to 504 come from our own routes, with a message written for the user
            status == 413 -> "That file is too big. Use a PDF under 4 MB."
            status in 502..504 && serverMessage.isNotBlank() -> serverMessage
            status >= 500 -> "Something went wrong on our side. Please try again."
            serverMessage.isNotBlank() -> serverMessage
            status == 401 -> "Please sign in again."
            else -> "Something went wrong. Please try again."
        }
    }
}