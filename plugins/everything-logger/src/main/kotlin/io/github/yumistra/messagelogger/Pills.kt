@file:Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")

package io.github.yumistra.messagelogger

import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.view.View
import android.view.ViewGroup
import android.widget.TextSwitcher
import android.widget.TextView
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge

// JS(rows.ts)와 같아야 한다: 반응 이모지 displayName 끝에 붙는 표시  지운수,색,f? 
private const val MARK_START = ''
private const val MARK_END = ''

/** 모두 지운 이모지 버튼의 빨간 상자 (알아보려고 따로 만든 종류) */
internal class RemovedPillBackground : GradientDrawable()

/** 우리가 붙인 빨간 (n) (다음에 다시 그릴 때 알아보고 지우려고 따로 만든 종류) */
internal class RemovedCountSpan(color: Int) : ForegroundColorSpan(color)

/**
 * 채팅 메시지 아래 반응 버튼들 (com.discord.reactions.ShortcutsFlexbox).
 * 디스코드가 버튼들을 다 그린 뒤, 이모지 설명(contentDescription)에 JS 가 넣어 둔 표시가 있는 버튼의 숫자 옆에
 * 빨간 (n) 을 붙인다. 모두 지운 이모지 버튼(f)은 숫자 대신 빨간 (n) 만.
 */
internal object Pills : XC_MethodHook() {
    @Volatile
    var hooked = false
    var unhook: XC_MethodHook.Unhook? = null

    fun start(loader: ClassLoader) {
        val box = loader.loadClass("com.discord.reactions.ShortcutsFlexbox")
        var best: java.lang.reflect.Method? = null
        val ms = box.declaredMethods
        var i = 0
        while (i < ms.size) {
            val m = ms[i++]
            val p = m.parameterTypes
            if (m.returnType != Void.TYPE || p.size < 5 || p[0] != java.util.List::class.java) continue
            if (best == null || p.size > best.parameterTypes.size) best = m
        }
        unhook = XposedBridge.hookMethod(best ?: return, this)
        hooked = true
    }

    fun stop() {
        unhook?.unhook()
        unhook = null
        hooked = false
    }

    override fun afterHookedMethod(param: MethodHookParam) {
        try {
            walk(param.thisObject as? View ?: return, 0)
        } catch (_: Throwable) {
        }
    }

    private fun walk(v: View, depth: Int) {
        if (depth > 6) return
        val d = v.contentDescription
        if (d != null) {
            val s = d.toString()
            val js = s as java.lang.String
            val a = js.indexOf(MARK_START.code)
            if (a >= 0) {
                val b = js.indexOf(MARK_END.code, a)
                if (b > a) {
                    v.contentDescription = s.substring(0, a) + s.substring(b + 1)
                    mark(v, s.substring(a + 1, b))
                    return
                }
            }
            // 예전에 붙인 (n), 빨간 상자가 남아 있으면 지운다 (다시 반응해서 표시가 없어진 경우)
            if (depth > 0) {
                clear(v)
                plainBox(v)
            }
        }
        if (v is ViewGroup) {
            var i = 0
            while (i < v.childCount) walk(v.getChildAt(i++), depth + 1)
        }
    }

    private fun int(s: String, d: Int): Int = try {
        Integer.parseInt(s)
    } catch (_: NumberFormatException) {
        d
    }

    /** "n,색" 또는 "n,색,f" (코틀린 표준 함수 없이) */
    private fun mark(pill: View, body: String) {
        val j = body as java.lang.String
        val c1 = j.indexOf(','.code)
        if (c1 < 0) return
        val c2 = j.indexOf(','.code, c1 + 1)
        val n = int(body.substring(0, c1), -1)
        if (n < 0) return
        val color = int(if (c2 < 0) body.substring(c1 + 1) else body.substring(c1 + 1, c2), 0xfff23f43.toInt())
        val only = c2 >= 0 && body.substring(c2 + 1) == "f"
        val tv = countView(pill) ?: return
        val base = digits(tv.text)
        val out = SpannableStringBuilder()
        if (!only && base.isNotEmpty()) out.append(base).append(' ')
        val start = out.length
        out.append('(').append(n.toString()).append(')')
        out.setSpan(RemovedCountSpan(color), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        tv.text = out
        tv.visibility = View.VISIBLE
        var p: Any? = tv.parent
        while (p is View && p !== pill) {
            p.visibility = View.VISIBLE
            p.requestLayout()
            p = (p as View).parent
        }
        tv.requestLayout()
        if (only) redBox(pill, color) else plainBox(pill)
    }

    /** 원래 상자 (디스코드가 다시 그리지 않고 우리 상자가 남을 때 되돌리려고) */
    private val original = java.util.WeakHashMap<View, Drawable?>()

    /** 지워진 메시지처럼: 옅은 빨간 바탕 + 빨간 테두리, 모서리는 원래 상자와 같게 */
    private fun redBox(pill: View, color: Int) {
        val now = pill.background
        if (now !is RemovedPillBackground) original[pill] = now
        val density = try {
            pill.resources.displayMetrics.density
        } catch (_: Throwable) {
            2f
        }
        var radius = 8f * density
        if (now is GradientDrawable && now !is RemovedPillBackground && android.os.Build.VERSION.SDK_INT >= 24) {
            try {
                if (now.cornerRadius > 0f) radius = now.cornerRadius
            } catch (_: Throwable) {
            }
        }
        val bg = RemovedPillBackground()
        bg.shape = GradientDrawable.RECTANGLE
        bg.cornerRadius = radius
        bg.setColor((0x33 shl 24) or (color and 0xffffff))
        bg.setStroke(Math.max(1, (1.5f * density).toInt()), color)
        pill.background = bg
    }

    private fun plainBox(pill: View) {
        if (pill.background !is RemovedPillBackground) return
        pill.background = original.remove(pill)
    }

    private fun clear(pill: View) {
        val tv = countView(pill) ?: return
        val t = tv.text as? Spanned ?: return
        if (t.getSpans(0, t.length, RemovedCountSpan::class.java).isEmpty()) return
        tv.text = digits(t)
    }

    private fun digits(t: CharSequence?): String {
        if (t == null) return ""
        val s = (t.toString() as java.lang.String).trim()
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (!(Character.isDigit(c) || c == ',' || c == '.' || c == 'K' || c == 'k' || c == 'M')) break
            i++
        }
        return s.substring(0, i)
    }

    /** 버튼 안의 숫자 글자: 숫자 바꿈 상자(TextSwitcher)의 지금 글자, 없으면 숫자만 있는 글자 */
    private fun countView(v: View): TextView? = switcher(v, 0) ?: numberText(v, 0)

    private fun switcher(v: View, depth: Int): TextView? {
        if (v is TextSwitcher) return v.currentView as? TextView
        if (v !is ViewGroup || depth > 5) return null
        var i = 0
        while (i < v.childCount) {
            val r = switcher(v.getChildAt(i++), depth + 1)
            if (r != null) return r
        }
        return null
    }

    private fun numberText(v: View, depth: Int): TextView? {
        if (v is TextView) return if (digits(v.text).isNotEmpty()) v else null
        if (v !is ViewGroup || depth > 5) return null
        var i = 0
        while (i < v.childCount) {
            val r = numberText(v.getChildAt(i++), depth + 1)
            if (r != null) return r
        }
        return null
    }
}
