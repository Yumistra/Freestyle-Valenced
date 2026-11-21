package io.github.yumistra.discordwatch

import android.os.Handler
import android.os.HandlerThread
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 디스코드 게이트웨이 연결 하나 (읽기만 한다: 연결 유지에 필요한 하트비트, 로그인, 이어 붙이기 말고는 아무것도 보내지 않는다).
 * 받은 이벤트는 [onDispatch] 로 넘긴다.
 */
class Gateway(
    private val token: String,
    private val onDispatch: (type: String, d: Any?) -> Unit,
    private val onState: (String) -> Unit,
    /** 토큰이 틀려서 더 해 볼 수 없을 때 */
    private val onFatal: (String) -> Unit,
) {
    private val thread = HandlerThread("gateway").apply { start() }
    private val handler = Handler(thread.looper)
    private val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()

    private var ws: WebSocket? = null
    private var seq: Long? = null
    private var sessionId: String? = null
    private var resumeUrl: String? = null
    private var interval = 41250L
    private var acked = true
    private var backoff = 2000L
    private var stopped = false
    private var generation = 0

    var userId: String? = null
        private set
    var mySession: String? = null
        private set

    fun start() = handler.post { connect() }

    fun stop() {
        handler.post {
            stopped = true
            generation++
            ws?.close(1000, null)
            ws = null
            handler.removeCallbacksAndMessages(null)
            thread.quitSafely()
        }
    }

    private fun connect() {
        if (stopped) return
        val gen = ++generation
        acked = true
        val base = resumeUrl?.takeIf { sessionId != null } ?: "wss://gateway.discord.gg"
        onState("연결하는 중")
        val req = Request.Builder().url("$base/?v=10&encoding=json").build()
        ws = client.newWebSocket(req, Listener(gen))
    }

    private fun reconnect(resume: Boolean, delay: Long = backoff) {
        if (stopped) return
        generation++
        ws?.cancel()
        ws = null
        handler.removeCallbacksAndMessages(null)
        if (!resume) {
            sessionId = null
            seq = null
            resumeUrl = null
        }
        onState("다시 연결 대기 (${delay / 1000}초)")
        handler.postDelayed({ connect() }, delay)
        backoff = (backoff * 2).coerceAtMost(60_000L)
    }

    private fun send(op: Int, d: Any?) {
        val o = JSONObject().put("op", op).put("d", d ?: JSONObject.NULL)
        ws?.send(o.toString())
    }

    private val beat = object : Runnable {
        override fun run() {
            if (stopped) return
            if (!acked) {
                // 대답이 없으면 연결이 죽은 것
                reconnect(resume = true, delay = 1000)
                return
            }
            acked = false
            send(1, seq)
            handler.postDelayed(this, interval)
        }
    }

    private fun identify() {
        val sid = sessionId
        if (sid != null && seq != null) {
            send(6, JSONObject().put("token", token).put("session_id", sid).put("seq", seq))
            return
        }
        val props = JSONObject()
            .put("os", "Android")
            .put("browser", "Discord Android")
            .put("device", android.os.Build.MODEL ?: "Android")
            .put("system_locale", java.util.Locale.getDefault().toLanguageTag())
        val presence = JSONObject().put("status", "unknown").put("since", 0).put("activities", JSONArray()).put("afk", true)
        // 16: 사용자 객체 중복 제거, 512: 설정은 압축된 한 덩어리로 (READY 가 가벼워진다)
        send(2, JSONObject().put("token", token).put("capabilities", 16 or 512).put("properties", props).put("presence", presence).put("compress", false))
    }

    private inner class Listener(private val gen: Int) : WebSocketListener() {
        private fun current() = gen == generation && !stopped

        override fun onMessage(webSocket: WebSocket, text: String) {
            handler.post {
                if (!current()) return@post
                val o = try {
                    JSONObject(text)
                } catch (_: Throwable) {
                    return@post
                }
                if (!o.isNull("s")) seq = o.optLong("s")
                when (o.optInt("op")) {
                    10 -> {
                        interval = o.optJSONObject("d")?.optLong("heartbeat_interval") ?: interval
                        handler.removeCallbacks(beat)
                        // 처음 하트비트는 조금 기다렸다가 (디스코드 권장)
                        handler.postDelayed(beat, (interval * Math.random()).toLong())
                        identify()
                    }
                    11 -> acked = true
                    1 -> send(1, seq)
                    7 -> reconnect(resume = true, delay = 500)
                    9 -> reconnect(resume = o.optBoolean("d"), delay = 1000 + (Math.random() * 4000).toLong())
                    0 -> {
                        val type = o.optString("t")
                        val d = o.optJSONObject("d")
                        if (type == "READY" && d != null) {
                            sessionId = d.optString("session_id")
                            resumeUrl = d.optString("resume_gateway_url").ifBlank { null }
                            userId = d.optJSONObject("user")?.optString("id")
                            mySession = sessionId
                            backoff = 2000L
                            onState("연결됨")
                        } else if (type == "RESUMED") {
                            backoff = 2000L
                            onState("연결됨")
                        }
                        try {
                            onDispatch(type, o.opt("d"))
                        } catch (_: Throwable) {
                        }
                    }
                }
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            closed(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = closed(code, reason)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            handler.post {
                if (current()) reconnect(resume = true)
            }
        }

        private fun closed(code: Int, reason: String) {
            handler.post {
                if (!current()) return@post
                when (code) {
                    // 토큰이 틀림, 다시 해 봐야 소용없다
                    4004 -> {
                        stopped = true
                        onFatal("토큰이 맞지 않아요 (4004)")
                    }
                    4007, 4009 -> reconnect(resume = false)
                    else -> reconnect(resume = true)
                }
            }
        }
    }
}
