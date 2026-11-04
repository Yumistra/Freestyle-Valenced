package io.github.yumistra.messagelogger

import de.robv.android.xposed.XC_MethodHook
import org.json.JSONObject
import java.io.File

/**
 * 디스코드 푸시 알림으로 온 메시지를 파일에 적어 둔다 (앱이 꺼져 있어도 알림을 받으면 프로세스가 뜬다).
 * 디스코드는 삭제·수정을 푸시하지 않으므로, JS 가 나중에 이걸 서버가 보내 준 메시지와 비교해서 지워졌는지·고쳐졌는지 알아낸다.
 *
 * 걸리는 곳: com.discord.notifications.client.NotificationClient.onNotificationReceived(Context, Map<String, String>, long)
 * (FCM NotificationService.onMessageReceived 가 데이터를 Map 으로 바꿔 넘기는 곳)
 */
internal object Pushes {
    @Volatile
    var file: File? = null

    /** 한 줄에 메시지 하나 (JSON). 너무 커지지 않게 이 이상이면 앞쪽을 버린다 */
    private const val MAX_BYTES = 2L * 1024 * 1024

    private val lock = Any()
    private val recent = ArrayList<String>()

    fun record(data: Map<*, *>) {
        val type = data["type"]?.toString()
        if (type != null && type != "MESSAGE_CREATE") return
        val id = data["message_id"]?.toString() ?: return
        val channel = data["channel_id"]?.toString() ?: return
        synchronized(lock) {
            if (recent.contains(id)) return
            recent.add(id)
            if (recent.size > 300) recent.removeAt(0)
        }
        val o = JSONObject()
        o.put("id", id)
        o.put("channel_id", channel)
        for (key in KEYS) {
            val v = data[key]?.toString() ?: continue
            o.put(key, v)
        }
        o.put("received_at", System.currentTimeMillis())
        append(o.toString())
    }

    private fun append(line: String) {
        val f = file ?: return
        synchronized(lock) {
            try {
                if (f.exists() && f.length() > MAX_BYTES) {
                    // 뒤쪽 절반만 남긴다 (줄 경계에서)
                    val text = read(f)
                    var cut = text.length / 2
                    while (cut < text.length && text[cut] != '\n') cut++
                    write(f, if (cut < text.length) text.substring(cut + 1) else "", false)
                }
                write(f, line + "\n", true)
            } catch (_: Throwable) {
            }
        }
    }

    /** JS 가 가져가면 비운다 */
    fun take(): String {
        val f = file ?: return ""
        synchronized(lock) {
            return try {
                if (!f.exists()) return ""
                val text = read(f)
                write(f, "", false)
                text
            } catch (_: Throwable) {
                ""
            }
        }
    }

    private fun read(f: File): String {
        val input = java.io.FileInputStream(f)
        try {
            val out = java.io.ByteArrayOutputStream()
            val buf = ByteArray(8192)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
            }
            return String(out.toByteArray(), java.nio.charset.StandardCharsets.UTF_8)
        } finally {
            input.close()
        }
    }

    private fun write(f: File, text: String, append: Boolean) {
        val output = java.io.FileOutputStream(f, append)
        try {
            output.write(text.toByteArray(java.nio.charset.StandardCharsets.UTF_8))
        } finally {
            output.close()
        }
    }

    private val KEYS = arrayOf(
        "message_content", "message_flags", "message_type_", "guild_id", "channel_type", "channel_name", "parent_id",
        "user_id", "user_username", "user_global_name", "user_discriminator", "user_avatar",
        "sent_at_ms", "image_url", "image_count", "video_count", "message_reference_type", "is_from_current_user",
    )
}

internal class OnPush(private val mapAt: Int) : XC_MethodHook() {
    override fun beforeHookedMethod(param: MethodHookParam) {
        try {
            Diag.calls++
            val arg = param.args[mapAt] ?: return
            // 예전: Map 그대로. 새 디스코드: FirebaseMessagingService.onMessageReceived(RemoteMessage) → getData()
            val data = (arg as? Map<*, *>) ?: (arg.javaClass.getMethod("getData").invoke(arg) as? Map<*, *>) ?: return
            Pushes.record(data)
        } catch (t: Throwable) {
            Diag.error = t.toString()
        }
    }
}
