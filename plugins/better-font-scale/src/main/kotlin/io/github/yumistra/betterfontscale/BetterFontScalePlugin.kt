@file:JvmName("BetterFontScalePlugin")

package io.github.yumistra.betterfontscale

import android.app.Activity
import android.app.AndroidAppHelper
import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
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

/** 디스코드 전체 글자 배율 (폰 글자 크기에 곱한다). 1 이면 그대로 */
@Volatile private var allScale = 1f
private const val PREFS = "yumistra.better-font-scale"

/** 폰 설정의 글자 배율 */
private fun systemFontScale() = Resources.getSystem().configuration.fontScale

/** 이 화면(Activity)이 쓸 컨텍스트를 글자 배율만 바꿔서 */
private fun scaled(base: Context): Context {
    if (allScale == 1f) return base
    val cfg = Configuration(base.resources.configuration)
    cfg.fontScale = systemFontScale() * allScale
    return base.createConfigurationContext(cfg)
}

/** 앱 전체 리소스의 글자 배율 (React Native 가 여기서 글자 배율을 읽는다) */
@Suppress("DEPRECATION")
private fun scaleResources(res: Resources?) {
    if (res == null) return
    val cfg = Configuration(res.configuration)
    val want = systemFontScale() * allScale
    if (cfg.fontScale == want) return
    cfg.fontScale = want
    res.updateConfiguration(cfg, res.displayMetrics)
}

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

/** 위 칸들 중 이름이나 종류에 낱말이 든 것이 있는지 */
private fun underAny(v: View, vararg words: String): Boolean {
    var p = v.parent
    var i = 0
    while (p is View && i < 16) {
        val n = nameOf(p).lowercase()
        val c = p.javaClass.name.lowercase()
        if (words.any { n.contains(it) || c.contains(it) }) return true
        p = p.parent
        i++
    }
    return false
}

/** 이 텍스트 칸이 어느 종류인지. 모르면 null */
private fun categoryOf(tv: TextView): String? {
    when (nameOf(tv)) {
        "author_name", "username_text", "userName", "chat_list_adapter_item_text_name" -> return "username"
        "timestamp_view", "chat_list_adapter_item_text_timestamp" -> return "timestamp"
        "reply_text", "reply_author_name" -> return "reply"
        "chat_input_edit_text", "text_input" -> return "chatbox"
        "message_tag_view", "reply_message_tag_view" -> return "tags"
        "chat_list_adapter_item_text", "message_content" -> return "messages"
    }
    // 나머지는 어디 안에 있는지로 (붙기 전에는 모른다)
    if (tv.parent == null || !inMessage(tv)) return null
    if (underAny(tv, "embed")) return "embeds"
    if (underAny(tv, "reaction")) return "reactions"
    if (nameOf(tv) == "content") return "messages"
    return "chatOther"
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
        // 디스코드 전체 글자 배율: 저장해 둔 값으로 앱 리소스와 새로 만드는 화면에 적용 (바꾸면 다시 시작해야 전부 맞는다)
        try {
            val app = AndroidAppHelper.currentApplication()
            allScale = app?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.getFloat("all", 1f) ?: 1f
            scaleResources(app?.resources)
        } catch (e: Throwable) {
            lastError = "scale: $e"
        }
        try {
            hooks += XposedHelpers.findAndHookMethod(
                Activity::class.java,
                "attachBaseContext",
                Context::class.java,
                object : XC_MethodHook() {
                    override fun beforeHookedMethod(param: MethodHookParam) {
                        val base = param.args[0] as? Context ?: return
                        try {
                            param.args[0] = scaled(base)
                        } catch (e: Throwable) {
                            lastError = "activity scale: $e"
                        }
                    }
                },
            )
        } catch (e: Throwable) {
            lastError = "attachBaseContext: $e"
        }
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
                // 전체 배율(%)은 따로: 저장해서 다음 시작 때 처음부터 쓴다
                val all = (o.optDouble("all", 100.0).toFloat() / 100f).let { if (it <= 0f) 1f else it.coerceIn(0.5f, 3f) }
                o.remove("all")
                if (all != allScale) {
                    allScale = all
                    try {
                        AndroidAppHelper.currentApplication()?.getSharedPreferences(PREFS, Context.MODE_PRIVATE)?.edit()?.putFloat("all", all)?.apply()
                    } catch (e: Throwable) {
                        lastError = "save: $e"
                    }
                }
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
            mapOf("sizes" to sizes.toString(), "changed" to hits, "all" to allScale, "systemFontScale" to systemFontScale(), "error" to lastError)
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
