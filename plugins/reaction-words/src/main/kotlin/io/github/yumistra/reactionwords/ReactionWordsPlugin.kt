@file:JvmName("ReactionWordsPlugin")

package io.github.yumistra.reactionwords

import android.os.SystemClock
import android.graphics.Typeface
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.widget.TextView
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeMethod
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import de.robv.android.xposed.XposedHelpers
import java.lang.reflect.Method
import java.util.WeakHashMap
import kotlin.math.abs

/**
 * Reaction Words 의 네이티브 부분: 반응 줄 끝의 "반응 추가" 버튼에 꾹 누르기를 붙인다.
 *
 * 디스코드는 이 버튼에 누르기만 있고 꾹 누르기가 없어서 JS 로는 알 수 없다.
 * 디스코드의 터치 처리(스크롤과 겹치지 않게 하는 리스너)에 기대지 않으려고, 버튼으로 들어오는 터치
 * (ViewGroup.dispatchTouchEvent)를 직접 보고 꾹 누르기를 알아낸다. 알아내면
 *  - 진동, "반응 추가 버튼이다" 표시
 *  - 반응 줄(ShortcutsFlexbox.setReactions)이 받은 "반응 꾹 누르기" 함수를 첫 번째 반응으로 불러 디스코드가 JS 에 메시지를 알리게 한다
 *  - 손을 뗄 때의 누르기(이모지 창 열기)는 막는다
 * JS 는 takeAddLongPress 로 표시를 확인해 반응 목록 대신 달린 이모지 전부로 반응한다.
 */

private const val FLEXBOX = "com.discord.reactions.ShortcutsFlexbox"
private const val ADD_VIEW = "com.discord.reactions.AddReactionView"
private const val REACTION_VIEW = "com.discord.reactions.ReactionView"
/**
 * 표시가 살아 있는 시간 (진동부터, ms). 흉내 낸 꾹 누르기(꾹 누르기 시간 + 150ms 뒤 취소)에서 오는 신호를 잡을 만큼.
 * 그 뒤에 사용자가 누르는 반응은 평소대로 된다. 설정에서 바꾼다 (setIgnoreMs)
 */
@Volatile private var ignoreMs = 1000L
private fun pendingTtl() = ignoreMs

private class Row(val first: Any, val longPress: Any)

private class Press(val view: View, val x: Float, val y: Float, val run: Runnable) {
    var fired = false
}

private fun invoke1(fn: Any, arg: Any?) {
    val m: Method = fn.javaClass.methods.first { it.name == "invoke" && it.parameterTypes.size == 1 }
    m.isAccessible = true
    m.invoke(fn, arg)
}

val reactionWordsPlugin = plugin {
    var unhooks = emptyList<XC_MethodHook.Unhook>()

    start {
        val cl = classLoader
        val rows = WeakHashMap<View, Row>()
        var pendingAt = 0L
        /** 꾹 누를 때마다 1씩 오르는 번호 (JS 가 같은 꾹 누르기를 두 번 처리하지 않게) */
        var pendingSeq = 0
        /** 무엇을 할지: all (전부 반응), word (단어로 반응 창) */
        var pendingKind = "all"
        var press: Press? = null
        // 상태 (설정 화면에 보여 준다)
        var rowHook = false
        var touchHook = false
        var rowsSeen = 0
        var touches = 0
        var fires = 0
        var lastError = ""

        val addViewClass: Class<*>? = try {
            cl.loadClass(ADD_VIEW)
        } catch (e: Throwable) {
            lastError = "AddReactionView: $e"
            null
        }

        /** 버튼이 들어 있는 반응 줄 */
        fun rowOf(v: View): Row? {
            var p: Any? = v.parent
            while (p is View) {
                rows[p]?.let { return it }
                p = p.parent
            }
            return null
        }

        val reactionViewClass: Class<*>? = try {
            cl.loadClass(REACTION_VIEW)
        } catch (e: Throwable) {
            null
        }

        /** 버튼 근처(같은 줄)에서 보이는 첫 반응. 이름이 바뀐 버전도 있어서, 못 찾으면 꾹 누를 수 있는 옆 칸을 쓴다 */
        var seenNear = ""
        fun firstReactionNear(v: View): View? {
            var p: Any? = v.parent
            var self: View = v
            var depth = 0
            val names = ArrayList<String>()
            while (p is android.view.ViewGroup && depth < 3) {
                var fallback: View? = null
                for (i in 0 until p.childCount) {
                    val c = p.getChildAt(i)
                    if (c === self || c.visibility != View.VISIBLE) continue
                    if (names.size < 6) names.add("${c.javaClass.simpleName}${if (c.isLongClickable) "*" else ""}")
                    if (reactionViewClass?.isInstance(c) == true) return c
                    if (fallback == null && c.isLongClickable && addViewClass?.isInstance(c) != true) fallback = c
                }
                if (fallback != null) return fallback
                self = p
                p = p.parent
                depth++
            }
            seenNear = names.joinToString(", ")
            return null
        }

        /** 버튼과 같은 줄의 첫 칸 (첫 반응). 버튼이 한 겹 감싸져 있을 수 있어서 위로 몇 단계 올라가며 찾는다 */
        fun firstSibling(v: View): View? {
            var self: View = v
            var p: Any? = v.parent
            var depth = 0
            while (p is android.view.ViewGroup && depth < 3) {
                for (i in 0 until p.childCount) {
                    val c = p.getChildAt(i)
                    if (c !== self && c.visibility == View.VISIBLE && c.width > 0 && addViewClass?.isInstance(c) != true) return c
                }
                self = p
                p = p.parent
                depth++
            }
            return null
        }

        /** 칸 가운데를 꾹 누르고 있다가 취소한다 (손 떼기가 아니라 취소라 누르기는 안 된다) */
        fun simulateLongPress(target: View) {
            val t0 = SystemClock.uptimeMillis()
            val x = target.width / 2f
            val y = target.height / 2f
            val down = MotionEvent.obtain(t0, t0, MotionEvent.ACTION_DOWN, x, y, 0)
            target.dispatchTouchEvent(down)
            down.recycle()
            target.postDelayed({
                val now = SystemClock.uptimeMillis()
                val cancel = MotionEvent.obtain(t0, now, MotionEvent.ACTION_CANCEL, x, y, 0)
                target.dispatchTouchEvent(cancel)
                cancel.recycle()
                target.isPressed = false
            }, ViewConfiguration.getLongPressTimeout() + 150L)
        }

        fun fire(v: View, kind: String = "all") {
            try {
                pendingAt = SystemClock.uptimeMillis()
                pendingSeq++
                pendingKind = kind
                fires++
                if (kind == "all") v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                // 1) 반응 줄을 기억해 뒀으면 그 꾹 누르기 함수로
                val row = rowOf(v)
                if (row != null) {
                    invoke1(row.longPress, row.first)
                    return
                }
                // 2) 아니면 옆의 첫 반응을 꾹 누른 것처럼 (디스코드가 같은 일을 한다)
                val first = firstReactionNear(v)
                if (first != null && first.performLongClick()) return
                // 3) 반응 칸이 꾹 누르기를 터치로 직접 알아내는 버전: 옆 반응 칸에 손가락을 대고 있는 것처럼 터치를 보낸다
                val sib = firstSibling(v)
                if (sib != null) {
                    simulateLongPress(sib)
                    lastError = ""
                    return
                }
                pendingAt = 0L
                lastError = "No reaction next to the button (sibling=${firstSibling(v) != null}, reactionView=${reactionViewClass != null}, found=${first != null}, near: $seenNear)"
            } catch (e: Throwable) {
                pendingAt = 0L
                lastError = "long press: $e"
                log.e(lastError)
            }
        }

        // ── 반응 추가 버튼 크기 맞추기 + 옆에 "단어로 반응" 버튼 ─────────────
        val wordButtons = WeakHashMap<View, View>()
        val scheduled = WeakHashMap<View, Boolean>()
        var fitSize = true
        var showWord = true
        var buttonsMade = 0

        fun firstTextView(v: View?): TextView? {
            if (v is TextView) return v
            if (v is android.view.ViewGroup) for (i in 0 until v.childCount) firstTextView(v.getChildAt(i))?.let { return it }
            return null
        }

        fun copyLp(lp: android.view.ViewGroup.LayoutParams?): android.view.ViewGroup.LayoutParams? {
            if (lp == null) return null
            return try {
                lp.javaClass.getConstructor(lp.javaClass).newInstance(lp)
            } catch (e: Throwable) {
                try {
                    lp.javaClass.getConstructor(android.view.ViewGroup.MarginLayoutParams::class.java).newInstance(lp)
                } catch (e2: Throwable) {
                    null
                }
            }
        }

        fun makeButton(add: View, sample: View?): View {
            val ctx = add.context
            val tv = TextView(ctx)
            tv.text = "Aa"
            tv.gravity = Gravity.CENTER
            tv.typeface = Typeface.DEFAULT_BOLD
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            val sampleText = firstTextView(sample)
            tv.setTextColor(sampleText?.currentTextColor ?: 0xFFB5BAC1.toInt())
            add.background?.constantState?.newDrawable()?.mutate()?.let { tv.background = it }
            tv.contentDescription = "React with a word"
            tv.isClickable = true
            tv.setOnClickListener { b -> fire(b, "word") }
            buttonsMade++
            return tv
        }

        fun ensure(v: View) {
            if (!v.isAttachedToWindow) return
            val sib = firstSibling(v)
            // 1) 반응 칸과 같은 높이
            if (fitSize && sib != null && sib.height > 0) {
                val lp = v.layoutParams
                if (lp != null && lp.height != sib.height) {
                    lp.height = sib.height
                    v.layoutParams = lp
                }
            }
            val btn0 = wordButtons[v]
            if (!showWord) {
                (btn0?.parent as? android.view.ViewGroup)?.removeView(btn0)
                return
            }
            // 2) 단어 버튼: 버튼을 감싼 줄(LinearLayout)이면 그 안, 아니면 반응들이 있는 곳에 버튼 바로 뒤로
            val parent = v.parent as? android.view.ViewGroup ?: return
            val inner = parent is android.widget.LinearLayout && (sib == null || sib.parent !== parent)
            val container: android.view.ViewGroup
            val anchor: View
            if (inner || (sib != null && sib.parent === parent)) {
                container = parent
                anchor = v
            } else {
                container = parent.parent as? android.view.ViewGroup ?: return
                anchor = parent
            }
            val btn = btn0 ?: makeButton(v, sib).also { wordButtons[v] = it }
            val want = container.indexOfChild(anchor) + 1
            if (btn.parent !== container || container.indexOfChild(btn) != want) {
                (btn.parent as? android.view.ViewGroup)?.removeView(btn)
                val lp = copyLp(if (anchor === v) v.layoutParams else anchor.layoutParams) ?: android.view.ViewGroup.LayoutParams(-2, -2)
                if (lp is android.view.ViewGroup.MarginLayoutParams && anchor === v) lp.marginStart = (6 * v.resources.displayMetrics.density).toInt()
                container.addView(btn, container.indexOfChild(anchor) + 1, lp)
            }
            // 크기는 반응 추가 버튼과 같게
            val blp = btn.layoutParams
            if (blp != null && v.width > 0 && (blp.width != v.width || blp.height != v.height)) {
                blp.width = v.width
                blp.height = v.height
                btn.layoutParams = blp
            }
            val vis = if (anchor.visibility == View.VISIBLE && v.visibility == View.VISIBLE) View.VISIBLE else View.GONE
            if (btn.visibility != vis) btn.visibility = vis
        }

        fun schedule(v: View) {
            if (scheduled[v] == true) return
            scheduled[v] = true
            v.post {
                scheduled.remove(v)
                try {
                    ensure(v)
                } catch (e: Throwable) {
                    lastError = "button: $e"
                }
            }
        }

        val hooks = ArrayList<XC_MethodHook.Unhook>()

        // 1. 반응 줄이 그려질 때 첫 반응과 "꾹 누르기" 함수를 기억한다
        try {
            val flexbox = cl.loadClass(FLEXBOX)
            hooks.addAll(
                XposedBridge.hookAllMethods(
                    flexbox,
                    "setReactions",
                    object : XC_MethodHook() {
                        override fun afterHookedMethod(param: MethodHookParam) {
                            try {
                                val box = param.thisObject as? View ?: return
                                val list = param.args.firstOrNull { it is List<*> } as? List<*>
                                // 매개변수 중 Function1 두 개: 누르기, 꾹 누르기 순서
                                val types = (param.method as Method).parameterTypes
                                val fns = types.indices.filter { types[it].name == "kotlin.jvm.functions.Function1" }.mapNotNull { param.args[it] }
                                val first = list?.firstOrNull()
                                if (first == null || fns.size < 2) {
                                    rows.remove(box)
                                    return
                                }
                                rows[box] = Row(first, fns[1])
                                rowsSeen++
                            } catch (e: Throwable) {
                                lastError = "setReactions: $e"
                            }
                        }
                    },
                ),
            )
            rowHook = true
        } catch (e: Throwable) {
            lastError = "ShortcutsFlexbox: $e"
            log.e(lastError)
        }

        // 2. 버튼으로 들어오는 터치를 직접 보고 꾹 누르기를 알아낸다
        if (addViewClass != null) {
            try {
                hooks.add(
                    XposedHelpers.findAndHookMethod(
                        // 버튼은 LinearLayout 이라 ViewGroup 의 것을 잡는다
                        android.view.ViewGroup::class.java,
                        "dispatchTouchEvent",
                        MotionEvent::class.java,
                        object : XC_MethodHook() {
                            override fun beforeHookedMethod(param: MethodHookParam) {
                                val v = param.thisObject as View
                                if (!addViewClass.isInstance(v)) return
                                val ev = param.args[0] as MotionEvent
                                val cur = press
                                when (ev.actionMasked) {
                                    MotionEvent.ACTION_DOWN -> {
                                        cur?.let { it.view.removeCallbacks(it.run) }
                                        touches++
                                        lateinit var p: Press
                                        val run = Runnable {
                                            if (press === p) {
                                                p.fired = true
                                                fire(v)
                                                // 눌림 표시를 지운다
                                                v.isPressed = false
                                            }
                                        }
                                        p = Press(v, ev.rawX, ev.rawY, run)
                                        press = p
                                        v.postDelayed(run, ViewConfiguration.getLongPressTimeout().toLong())
                                    }
                                    MotionEvent.ACTION_MOVE -> {
                                        if (cur == null || cur.view !== v || cur.fired) return
                                        val slop = ViewConfiguration.get(v.context).scaledTouchSlop
                                        if (abs(ev.rawX - cur.x) > slop || abs(ev.rawY - cur.y) > slop) {
                                            v.removeCallbacks(cur.run)
                                            press = null
                                        }
                                    }
                                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                                        if (cur == null || cur.view !== v) return
                                        v.removeCallbacks(cur.run)
                                        press = null
                                        if (cur.fired && ev.actionMasked == MotionEvent.ACTION_UP) {
                                            // 꾹 누른 뒤 손을 떼면 이모지 창이 열리지 않게, 손 떼기 대신 취소를 보낸다
                                            val cancel = MotionEvent.obtain(ev)
                                            cancel.action = MotionEvent.ACTION_CANCEL
                                            try {
                                                XposedBridge.invokeOriginalMethod(param.method, v, arrayOf<Any>(cancel))
                                            } catch (e: Throwable) {
                                            } finally {
                                                cancel.recycle()
                                            }
                                            param.result = true
                                        }
                                    }
                                }
                            }
                        },
                    ),
                )
                touchHook = true
            } catch (e: Throwable) {
                lastError = "touch: $e"
                log.e(lastError)
            }
        }
        // 3. 반응 추가 버튼이 자리를 잡을 때마다 크기를 맞추고 옆에 단어 버튼을 둔다
        if (addViewClass != null) {
            try {
                hooks.add(
                    XposedHelpers.findAndHookMethod(
                        android.widget.LinearLayout::class.java,
                        "onLayout",
                        Boolean::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        object : XC_MethodHook() {
                            override fun afterHookedMethod(param: MethodHookParam) {
                                val v = param.thisObject as View
                                if (addViewClass.isInstance(v)) schedule(v)
                            }
                        },
                    ),
                )
            } catch (e: Throwable) {
                lastError = "layout: $e"
            }
        }
        unhooks = hooks
        log.i("rowHook=$rowHook touchHook=$touchHook")

        /** 방금 반응 추가 버튼을 꾹 눌렀는지 (한 번 읽으면 지운다) */
        registerNativeMethod("${manifest.id}.takeAddLongPress") {
            val ok = pendingAt != 0L && SystemClock.uptimeMillis() - pendingAt < pendingTtl()
            pendingAt = 0L
            ok
        }
        /** 방금(3초 안) 반응 추가 버튼을 꾹 눌렀으면 그 번호, 아니면 0 (지우지 않는다) */
        registerNativeMethod("${manifest.id}.addPending") {
            if (pendingAt != 0L && SystemClock.uptimeMillis() - pendingAt < pendingTtl()) "$pendingSeq:$pendingKind" else ""
        }
        registerNativeMethod("${manifest.id}.setLook") { args ->
            fitSize = args.getOrNull(0) != false
            showWord = args.getOrNull(1) != false
            true
        }
        registerNativeMethod("${manifest.id}.setIgnoreMs") { args ->
            val ms = (args.getOrNull(0) as? Number)?.toLong() ?: return@registerNativeMethod false
            ignoreMs = ms.coerceIn(100L, 5000L)
            true
        }
        registerNativeMethod("${manifest.id}.ping") { "pong" }
        registerNativeMethod("${manifest.id}.status") {
            mapOf(
                "rowHook" to rowHook,
                "touchHook" to touchHook,
                "rows" to rowsSeen,
                "touches" to touches,
                "fires" to fires,
                "buttons" to buttonsMade,
                "error" to lastError,
            )
        }
    }

    stop {
        for (u in unhooks) try {
            u.unhook()
        } catch (e: Throwable) {
        }
        unhooks = emptyList()
    }
}
