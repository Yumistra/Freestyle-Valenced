package io.github.yumistra.messagelogger

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Parcelable
import org.json.JSONArray
import org.json.JSONObject

/**
 * 알림 창에 떠 있는 디스코드 알림을 읽는다 (앱이 꺼져 있을 때 온 알림도 남아 있다).
 * 디스코드는 메시지 알림을 MessagingStyle 로 만들고, 메시지마다 글·보낸 사람·시각(= 메시지 ID 의 시각)을 넣는다.
 * 앱은 자기가 띄운 알림을 NotificationManager.getActiveNotifications 로 읽을 수 있다.
 */
internal object Tray {
    @Volatile
    var context: Context? = null

    fun read(): String {
        val ctx = context ?: return "[]"
        val out = JSONArray()
        try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val active = nm.activeNotifications
            var i = 0
            while (i < active.size) {
                val sbn = active[i++]
                val n = sbn.notification ?: continue
                val extras = n.extras ?: continue
                val o = JSONObject()
                o.put("tag", sbn.tag ?: "")
                o.put("key", sbn.key ?: "")
                o.put("posted", sbn.postTime)
                if (Build.VERSION.SDK_INT >= 29) o.put("shortcut", n.shortcutId ?: "")
                o.put("group", n.group ?: "")
                o.put("title", str(extras.getCharSequence(Notification.EXTRA_TITLE)))
                o.put("conversation", str(extras.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)))
                o.put("text", str(extras.getCharSequence(Notification.EXTRA_TEXT)))
                val messages = JSONArray()
                val arr: Array<Parcelable>? = extras.getParcelableArray(Notification.EXTRA_MESSAGES)
                if (arr != null) {
                    var j = 0
                    while (j < arr.size) {
                        val b = arr[j++] as? Bundle ?: continue
                        val m = JSONObject()
                        m.put("text", str(b.getCharSequence("text")))
                        m.put("time", b.getLong("time"))
                        m.put("sender", str(b.getCharSequence("sender")))
                        val person = b.get("sender_person")
                        if (person != null && Build.VERSION.SDK_INT >= 28) {
                            val p = person as? android.app.Person
                            if (p != null) {
                                m.put("sender", str(p.name))
                                m.put("senderKey", p.key ?: "")
                            }
                        }
                        messages.put(m)
                    }
                }
                o.put("messages", messages)
                out.put(o)
            }
        } catch (t: Throwable) {
            Diag.error = t.toString()
        }
        return out.toString()
    }

    private fun str(c: CharSequence?): String = c?.toString() ?: ""
}

/** 설정 화면 상태 표시용 */
internal object Diag {
    @Volatile
    var hooked = ""

    @Volatile
    var calls = 0

    @Volatile
    var error = ""

    @Volatile
    var deco = false

    @Volatile
    var listDraws = 0

    @Volatile
    var bgSet = 0

    @Volatile
    var listName = ""

    private val lists = java.util.LinkedHashSet<String>()

    fun seen(v: Any) {
        if (lists.size >= 8) return
        lists.add(v.javaClass.name + "@" + Integer.toHexString(System.identityHashCode(v)))
    }

    @Volatile
    var marked = 0

    @Volatile
    var drawn = 0

    @Volatile
    var miss = ""

    fun json(): String {
        val o = JSONObject()
        o.put("hooked", hooked)
        o.put("calls", calls)
        o.put("error", if (error.length > 100) error.substring(0, 100) else error)
        o.put("deco", deco)
        o.put("bgSet", bgSet)
        o.put("listName", listName)
        o.put("marked", marked)
        o.put("drawn", drawn)
        o.put("miss", miss)
        o.put("context", Tray.context != null)
        return o.toString()
    }
}
