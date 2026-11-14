@file:JvmName("BetterFontScalePlugin")

package io.github.yumistra.betterfontscale

import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeMethod
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedHelpers
import org.json.JSONObject
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Better Font Scale (Aliucord 의 RazerTexz/BetterFontScale 를 Valenced 로 옮김).
 * 디스코드 채팅 화면의 안드로이드 텍스트 칸(TextView)을 ID 이름으로 알아보고, 고른 글자 크기(sp)로 바꾼다.
 * 원본처럼 TextView.setRawTextSize 를 가로채고, 붙을 때와 설정이 바뀔 때도 다시 맞춘다 (재시작 없이).
 */

private val main = Handler(Looper.getMainLooper())

/** 종류 → 글자 크기(sp). 0 이면 디스코드 기본 */
private val sizes = ConcurrentHashMap<String, Float>()

/** 리소스 ID → 이름 (매번 찾지 않게) */
private val names = ConcurrentHashMap<Int, String>()

/** 디스코드가 원래 정한 크기(px). 0 으로 되돌릴 때 쓴다 */
private val original = WeakHashMap<TextView, Float>()

/** 우리가 바꾸는 중 (원래 크기로 기록하지 않게) */
private var applying = false

@Volatile private var lastError = ""
@Volatile private var hits = 0

private fun nameOf(v: View): String {
    val id = v.id
    if (id == View.NO_ID || id == 0) return ""
    return names.getOrPut(id) {
        try {
            v.resources.getResourceEntryName(id)
        } catch (e: Throwable) {
            ""
        }
    }
}

/** 메시지 안에 있는 칸인지 (위로 올라가며 메시지 뷰를 찾는다) */
private fun inMessage(v: View): Boolean {
    var p = v.parent
    var i = 0
    while (p is View && i < 16) {
        val n = nameOf(p)
        if (n == "message_view" || n == "content_container") return true
        if (p.javaClass.name.contains("MessageView")) return true
        p = p.parent
        i++
    }
    return false
}

/** 이 텍스트 칸이 어느 종류인지. 모르면 null */
private fun categoryOf(tv: TextView): String? =
    when (nameOf(tv)) {
        "author_name", "username_text", "userName", "chat_list_adapter_item_text_name" -> "username"
        "timestamp_view", "chat_list_adapter_item_text_timestamp" -> "timestamp"
        "reply_text", "reply_author_name" -> "reply"
        "chat_input_edit_text", "text_input" -> "chatbox"
        "chat_list_adapter_item_text", "message_content" -> "messages"
        // "content" 는 여러 곳에 쓰여서 메시지 안일 때만
        "content" -> if (tv.parent != null && inMessage(tv)) "messages" else null
        else -> null
    }

private fun spToPx(tv: TextView, sp: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sp, tv.resources.displayMetrics)

/** 지금 설정대로 맞춘다 (붙을 때, 설정이 바뀔 때) */
private fun fit(tv: TextView) {
    val cat = categoryOf(tv) ?: return
    val sp = sizes[cat] ?: 0f
    val want = if (sp > 0f) spToPx(tv, sp) else synchronized(original) { original[tv] } ?: return
    if (tv.textSize == want) return
    applying = true
    try {
        tv.setTextSize(TypedValue.COMPLEX_UNIT_PX, want)
    } finally {
        applying = false
    }
}

/** 화면에 있는 모든 창의 뿌리 뷰 */
private fun rootViews(): List<View> =
    try {
        val wmg = Class.forName("android.view.WindowManagerGlobal")
        val inst = wmg.getMethod("getInstance").invoke(null)
        val f = wmg.getDeclaredField("mViews").apply { isAccessible = true }
        @Suppress("UNCHECKED_CAST")
        (f.get(inst) as? List<View>)?.toList() ?: emptyList()
    } catch (e: Throwable) {
        lastError = "roots: $e"
        emptyList()
    }

private fun walk(v: View, each: (View) -> Unit) {
    each(v)
    if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i), each)
}

private fun fitAll() {
    for (r in rootViews()) walk(r) { if (it is TextView) fit(it) }
}

/** 화면에 보이는 텍스트 칸 목록 (새 종류를 찾을 때 쓴다) */
private fun scan(): String {
    val out = StringBuilder()
    var n = 0
    for (r in rootViews()) walk(r) { v ->
        if (v is TextView && v.isShown && n < 200) {
            val dm = v.resources.displayMetrics
            val sp = v.textSize / (TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 1f, dm))
            val text = v.text?.toString().orEmpty().replace('\n', ' ').take(24)
            out.append(nameOf(v).ifEmpty { "-" }).append(" | ").append(v.javaClass.simpleName)
                .append(" | ").append("%.1f".format(sp)).append("sp | ").append(categoryOf(v) ?: "-")
                .append(" | ").append(text).append('\n')
            n++
        }
    }
    return out.toString()
}

val betterFontScalePlugin = plugin {
    var unhooks = emptyList<XC_MethodHook.Unhook>()

    start {
        val hooks = mutableListOf<XC_MethodHook.Unhook>()
        // 원본과 같은 곳: 글자 크기를 정할 때 우리 크기로 바꿔 넣는다
        try {
            hooks += XposedHelpers.findAndHookMethod(
                TextView::class.java,
                "setRawTextSize",
                Float::class.javaPrimitiveType,
                Boolean::class.javaPrimitiveType,
                object : XC_MethodHook() {
                    override fun beforeHookedMethod(param: MethodHookParam) {
                        val tv = param.thisObject as? TextView ?: return
                        val cat = categoryOf(tv) ?: return
                        if (!applying) synchronized(original) { original[tv] = param.args[0] as Float }
                        val sp = sizes[cat] ?: 0f
                        if (sp > 0f) {
                            param.args[0] = spToPx(tv, sp)
                            hits++
                        }
                    }
                },
            )
        } catch (e: Throwable) {
            lastError = "setRawTextSize: $e"
        }
        // 화면에 붙을 때 (이때야 메시지 안인지 알 수 있다)
        try {
            hooks += XposedHelpers.findAndHookMethod(
                View::class.java,
                "onAttachedToWindow",
                object : XC_MethodHook() {
                    override fun afterHookedMethod(param: MethodHookParam) {
                        val tv = param.thisObject as? TextView ?: return
                        if (sizes.isEmpty()) return
                        try {
                            fit(tv)
                        } catch (e: Throwable) {
                        }
                    }
                },
            )
        } catch (e: Throwable) {
            lastError = "attach: $e"
        }
        unhooks = hooks

        registerNativeMethod("${manifest.id}.config") { args ->
            try {
                val o = JSONObject(args.getOrNull(0) as? String ?: "{}")
                for (k in o.keys()) {
                    val v = o.optDouble(k, 0.0).toFloat()
                    if (v > 0f) sizes[k] = v.coerceIn(4f, 80f) else sizes.remove(k)
                }
                main.post {
                    try {
                        fitAll()
                    } catch (e: Throwable) {
                        lastError = "apply: $e"
                    }
                }
                true
            } catch (e: Throwable) {
                lastError = "config: $e"
                false
            }
        }
        registerNativeMethod("${manifest.id}.scan") {
            var result = ""
            val done = CountDownLatch(1)
            main.post {
                try {
                    result = scan()
                } catch (e: Throwable) {
                    result = "scan failed: $e"
                }
                done.countDown()
            }
            done.await(3, TimeUnit.SECONDS)
            result
        }
        registerNativeMethod("${manifest.id}.status") {
            mapOf("sizes" to sizes.toString(), "changed" to hits, "error" to lastError)
        }
    }

    stop {
        for (u in unhooks) try {
            u.unhook()
        } catch (e: Throwable) {
        }
        unhooks = emptyList()
        sizes.clear()
        main.post {
            try {
                fitAll()
            } catch (e: Throwable) {
            }
        }
    }
}
