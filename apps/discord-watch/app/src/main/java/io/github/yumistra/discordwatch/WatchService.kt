package io.github.yumistra.discordwatch

import android.app.BroadcastOptions
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject

/** 플러그인에 보여 줄 상태 */
object Status {
    @Volatile var running = false
    @Volatile var state = "Off"
    @Volatile var user = ""
    @Volatile var userId = ""
    @Volatile var discordOpen = false
    @Volatile var deleted = 0
    @Volatile var edited = 0
    @Volatile var lastSent = 0L
}

/**
 * 계속 돌면서 게이트웨이 연결을 유지한다 (안드로이드가 끄지 않게 고정 알림을 띄운다).
 *  - 받은 메시지를 기억해 두고, 지워지거나 고쳐지면 기록을 남긴다
 *  - 내 DM 이나 나를 멘션한 메시지가 지워지면 휴대폰 알림 (디스코드 앱이 켜져 있으면 플러그인이 알리니 안 한다)
 *  - 기록은 디스코드(Message Logger 플러그인)에 보낸다. 디스코드가 켜지면 다시 보낸다 (플러그인이 겹치는 건 걸러 낸다)
 */
class WatchService : Service() {
    companion object {
        const val ACTION = "io.github.yumistra.discordwatch.LOGS"
        private const val CH_RUN = "running"
        private const val CH_DEL = "deleted"
        private const val RUN_ID = 1

        fun start(ctx: Context) {
            val i = Intent(ctx, WatchService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
            } catch (t: Throwable) {
                Status.state = "Could not start: ${t.javaClass.simpleName}"
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, WatchService::class.java))
        }

        private val sender = Handler(Looper.getMainLooper())

        /**
         * 쌓인 기록을 디스코드로 보낸다. 작은 조각으로, 0.3초 간격으로.
         * 한 번에 큰 방송 (수백 KB) 을 여러 개 보내면 받는 쪽 안드로이드 통로가 넘쳐서
         * "Can't deliver broadcast" 로 디스코드가 꺼진다.
         * drain: 보낸 줄은 큐에서 뺀다 (디스코드가 화면에 있고 받을 준비가 됐다고 알려 왔을 때만)
         */
        fun deliver(ctx: Context, drain: Boolean = false) {
            val lines = if (drain) Store.takeQueue(ctx) else Store.queue(ctx)
            if (lines.isEmpty()) return
            val target = Store.target(ctx)
            val chunks = ArrayList<String>()
            val chunk = StringBuilder()
            for (line in lines) {
                if (line.length > CHUNK) continue
                if (chunk.length + line.length > CHUNK && chunk.isNotEmpty()) {
                    chunks.add(chunk.toString())
                    chunk.setLength(0)
                }
                chunk.append(line).append('\n')
            }
            if (chunk.isNotEmpty()) chunks.add(chunk.toString())
            val app = ctx.applicationContext ?: ctx
            chunks.forEachIndexed { i, c -> sender.postDelayed({ send(app, target, c) }, i * 300L) }
            Status.lastSent = System.currentTimeMillis()
        }

        /** 방송 하나의 크기 (글자 수). 안드로이드 통로는 앱 전체가 1MB 를 나눠 쓴다 */
        const val CHUNK = 24_000

        private fun send(ctx: Context, target: String, lines: String) {
            val i = Intent(ACTION).setPackage(target).putExtra("lines", lines)
            try {
                if (Build.VERSION.SDK_INT >= 34) {
                    // 받는 쪽이 보낸 앱을 확인할 수 있게
                    ctx.sendBroadcast(i, null, BroadcastOptions.makeBasic().setShareIdentityEnabled(true).toBundle())
                } else ctx.sendBroadcast(i)
            } catch (_: Throwable) {
            }
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var gateway: Gateway? = null
    private val dms = HashSet<String>()
    private val channelNames = HashMap<String, String>()
    private var me: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_RUN, "Running", NotificationManager.IMPORTANCE_MIN))
        nm.createNotificationChannel(NotificationChannel(CH_DEL, "Deleted messages", NotificationManager.IMPORTANCE_HIGH))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Status.running = true
        val n = running("Connecting")
        if (Build.VERSION.SDK_INT >= 34) startForeground(RUN_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(RUN_ID, n)
        if (gateway == null) {
            val token = Store.token(this)
            if (token.isNullOrBlank()) {
                Status.state = "No token"
                stopSelf()
                return START_NOT_STICKY
            }
            gateway = Gateway(token, ::onDispatch, ::onState, ::onFatal).also { it.start() }
            main.postDelayed(tick, 5 * 60_000L)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        gateway?.stop()
        gateway = null
        Store.flushCache(this)
        Status.running = false
        if (!Status.state.contains("token")) Status.state = "Off"
        Control.report(this)
        super.onDestroy()
    }

    private val tick = object : Runnable {
        override fun run() {
            Store.flushCache(this@WatchService)
            main.postDelayed(this, 5 * 60_000L)
        }
    }

    private fun running(text: String): Notification {
        // 누르면 디스코드를 연다 (이 앱은 화면이 없다)
        val launch = packageManager.getLaunchIntentForPackage(Store.target(this)) ?: Intent()
        val open = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this, CH_RUN)
            .setSmallIcon(android.R.drawable.ic_menu_view)
            .setContentTitle("Discord Watch")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }

    private fun onState(s: String) {
        Status.state = s
        main.post {
            Control.reportSoon(this)
            try {
                getSystemService(NotificationManager::class.java).notify(RUN_ID, running("$s, ${Status.deleted} deleted"))
            } catch (_: Throwable) {
            }
        }
    }

    private fun onFatal(reason: String) {
        Status.state = reason
        main.post {
            Store.setEnabled(this, false)
            Control.report(this)
            stopSelf()
        }
    }

    // ── 이벤트 ──────────────────────────────────────────────────────────
    private fun onDispatch(type: String, raw: Any?) {
        if (type == "SESSIONS_REPLACE") return sessions(raw as? JSONArray)
        val d = raw as? JSONObject
        when (type) {
            "READY" -> ready(d ?: return)
            "CHANNEL_CREATE" -> d?.let { c -> if (c.optInt("type") == 1 || c.optInt("type") == 3) dms.add(c.optString("id")) }
            "MESSAGE_CREATE" -> d?.let {
                it.optJSONObject("author")?.let { u -> people(u) }
                Store.remember(this, slim(it))
            }
            "MESSAGE_UPDATE" -> d?.let { updated(it) }
            "MESSAGE_DELETE" -> d?.let { deleted(it.optString("id"), it.optString("channel_id"), it.optString("guild_id")) }
            "MESSAGE_REACTION_REMOVE" -> d?.let { reaction(it, removed = true) }
            "MESSAGE_REACTION_ADD" -> d?.let { r ->
                r.optJSONObject("member")?.optJSONObject("user")?.let { u -> people(u) }
                reaction(r, removed = false)
            }
            "MESSAGE_DELETE_BULK" -> d?.let { b ->
                val ids = b.optJSONArray("ids") ?: return@let
                for (i in 0 until ids.length()) deleted(ids.optString(i), b.optString("channel_id"), b.optString("guild_id"))
            }
        }
    }

    private fun ready(d: JSONObject) {
        me = d.optJSONObject("user")?.optString("id")
        Status.userId = me ?: ""
        Status.user = d.optJSONObject("user")?.let { it.optString("global_name").takeIf { n -> n.isNotBlank() && n != "null" } ?: it.optString("username") } ?: ""
        dms.clear()
        d.optJSONArray("private_channels")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.optString("id")?.let(dms::add) }
        channelNames.clear()
        d.optJSONArray("guilds")?.let { gs ->
            for (i in 0 until gs.length()) {
                val chs = gs.optJSONObject(i)?.optJSONArray("channels") ?: continue
                for (j in 0 until chs.length()) chs.optJSONObject(j)?.let { c -> channelNames[c.optString("id")] = c.optString("name") }
            }
        }
        sessions(d.optJSONArray("sessions"))
        main.post { Control.reportSoon(this) }
    }

    /** 디스코드 앱(휴대폰)이 연결돼 있는지: 우리 말고 다른 모바일 세션 */
    private fun sessions(list: JSONArray?) {
        val arr = list ?: return
        val mine = gateway?.mySession
        var open = false
        for (i in 0 until arr.length()) {
            val s = arr.optJSONObject(i) ?: continue
            if (s.optString("session_id") == mine) continue
            if (s.optJSONObject("client_info")?.optString("client") == "mobile" && s.optString("status") != "offline") open = true
        }
        val was = Status.discordOpen
        Status.discordOpen = open
        // 쌓인 기록은 디스코드(플러그인)가 화면에 돌아와 받을 준비가 됐다고 알려 올 때 보낸다 (DeliverReceiver).
        // 여기서 보내면 디스코드가 화면 뒤에 있을 수 있다
        if (open && !was) main.postDelayed({ Control.reportSoon(this) }, 1500)
    }

    private fun slim(m: JSONObject): JSONObject {
        val a = m.optJSONObject("author") ?: JSONObject()
        val mentions = JSONArray()
        m.optJSONArray("mentions")?.let { ms -> for (i in 0 until ms.length()) ms.optJSONObject(i)?.optString("id")?.let(mentions::put) }
        val files = JSONArray()
        m.optJSONArray("attachments")?.let { fs ->
            for (i in 0 until fs.length()) {
                val f = fs.optJSONObject(i) ?: continue
                files.put(JSONObject().put("id", f.optString("id")).put("filename", f.optString("filename")).put("url", f.optString("url")).put("proxy_url", f.optString("proxy_url")).put("size", f.optLong("size")).put("content_type", f.optString("content_type")))
            }
        }
        val o = JSONObject()
            .put("id", m.optString("id"))
            .put("channel_id", m.optString("channel_id"))
            .put("content", m.optString("content"))
            .put("timestamp", m.optString("timestamp"))
            .put("type", m.optInt("type"))
            .put("flags", m.optInt("flags"))
            .put("author", JSONObject().put("id", a.optString("id")).put("username", a.optString("username")).put("global_name", a.opt("global_name") ?: JSONObject.NULL).put("avatar", a.opt("avatar") ?: JSONObject.NULL).put("bot", a.optBoolean("bot")))
            .put("mentions", mentions)
            .put("attachments", files)
        m.optString("guild_id").takeIf { it.isNotBlank() && it != "null" }?.let { o.put("guild_id", it) }
        return o
    }

    private fun updated(u: JSONObject) {
        val id = u.optString("id")
        if (!u.has("content")) return
        val old = Store.recall(this, id) ?: return
        val before = old.optString("content")
        val after = u.optString("content")
        if (before == after) return
        val next = JSONObject(old.toString()).put("content", after)
        Store.remember(this, next)
        val line = JSONObject().put("t", "edit").put("at", System.currentTimeMillis()).put("g", old.opt("guild_id") ?: JSONObject.NULL).put("m", next).put("before", before)
        Store.enqueue(this, line)
        Status.edited++
        // 디스코드가 켜져 있으면 바로 받는다 (꺼져 있으면 아무도 안 받고, 켤 때 플러그인이 전부 다시 달라고 한다)
        sendNow(line)
        main.post { Control.reportSoon(this) }
    }

    private fun deleted(id: String, channel: String, guild: String) {
        val m = Store.recall(this, id) ?: return
        Store.forget(this, id)
        val g = guild.takeIf { it.isNotBlank() && it != "null" } ?: m.optString("guild_id").takeIf { it.isNotBlank() }
        val line = JSONObject().put("t", "delete").put("at", System.currentTimeMillis()).put("m", m)
        if (g != null) line.put("g", g)
        Store.enqueue(this, line)
        Status.deleted++
        sendNow(line)
        if (!Status.discordOpen) maybeNotify(m, channel, g)
        main.post { Control.reportSoon(this) }
    }

    // ── 반응 ────────────────────────────────────────────────────────────
    /** 최근에 본 사람 (반응을 뺀 사람 이름을 같이 보내려고). 반응 빼기 이벤트에는 사람 정보가 없다 */
    private val users = object : LinkedHashMap<String, JSONObject>(256, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, JSONObject>?) = size > 3000
    }

    /** 뺀 반응 (메시지:사람:이모지 → 시각). 다시 단 것은 뺀 적이 있을 때만 보낸다 (모든 반응을 보내지 않게) */
    private val removedAt = object : LinkedHashMap<String, Long>(256, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?) = size > 5000
    }

    private fun people(u: JSONObject) {
        val id = u.optString("id").takeIf { it.isNotBlank() } ?: return
        users[id] = JSONObject()
            .put("username", u.optString("username"))
            .put("global_name", u.opt("global_name") ?: JSONObject.NULL)
            .put("avatar", u.opt("avatar") ?: JSONObject.NULL)
            .put("bot", u.optBoolean("bot"))
    }

    private fun reaction(r: JSONObject, removed: Boolean) {
        val user = r.optString("user_id").takeIf { it.isNotBlank() } ?: return
        if (user == me) return
        val msg = r.optString("message_id").takeIf { it.isNotBlank() } ?: return
        val e = r.optJSONObject("emoji") ?: return
        val emId = e.optString("id").takeIf { it.isNotBlank() && it != "null" }
        val emName = e.optString("name").takeIf { it.isNotBlank() && it != "null" } ?: "?"
        val key = "$msg:$user:${emId ?: emName}"
        val now = System.currentTimeMillis()
        if (removed) removedAt[key] = now
        else if (removedAt.remove(key) == null) return
        val em = JSONObject().put("name", emName).put("animated", e.optBoolean("animated"))
        if (emId != null) em.put("id", emId)
        val line = JSONObject()
            .put("t", if (removed) "react-" else "react+")
            .put("at", now)
            .put("c", r.optString("channel_id"))
            .put("m", msg)
            .put("u", user)
            .put("em", em)
        r.optString("guild_id").takeIf { it.isNotBlank() && it != "null" }?.let { line.put("g", it) }
        if (removed) users[user]?.let { line.put("un", it) }
        Store.enqueue(this, line)
        sendNow(line)
    }

    private fun sendNow(line: JSONObject) {
        send(this, Store.target(this), line.toString() + "\n")
        Status.lastSent = System.currentTimeMillis()
    }

    private fun maybeNotify(m: JSONObject, channel: String, guild: String?) {
        val myId = me ?: return
        if (!Store.notify(this)) return
        val author = m.optJSONObject("author")
        if (author?.optString("id") == myId) return
        val mentions = m.optJSONArray("mentions")
        var mentioned = false
        if (mentions != null) for (i in 0 until mentions.length()) if (mentions.optString(i) == myId) mentioned = true
        val content = m.optString("content")
        if (content.contains("<@$myId>") || content.contains("<@!$myId>")) mentioned = true
        val dm = guild == null || dms.contains(channel)
        if (!dm && !mentioned) return
        val name = author?.let { it.optString("global_name").takeIf { n -> n.isNotBlank() && n != "null" } ?: it.optString("username") } ?: "Someone"
        val where = if (!dm) channelNames[channel]?.let { " (#$it)" } ?: "" else ""
        val files = m.optJSONArray("attachments")?.length() ?: 0
        val text = content.ifBlank { if (files > 0) "[${files} file(s)]" else "[no text]" }
        val url = "https://discord.com/channels/${guild ?: "@me"}/$channel/${m.optString("id")}"
        val open = Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(Store.target(this)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val id = (System.currentTimeMillis() and 0xffffff).toInt()
        val pi = PendingIntent.getActivity(this, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = Notification.Builder(this, CH_DEL)
            .setSmallIcon(android.R.drawable.ic_menu_delete)
            .setContentTitle("$name deleted a message$where")
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try {
            getSystemService(NotificationManager::class.java).notify("deleted", id, n)
        } catch (_: Throwable) {
        }
    }
}
