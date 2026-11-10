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
 * Reaction+ (예전 이름 Reaction Words) 의 네이티브 부분: 반응 줄 끝의 "반응 추가" 버튼에 꾹 누르기를 붙인다.
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
/** 반응 추가 버튼과 Aa 버튼 크기 (반응 칸 높이에 대한 비율, 정사각형) */
private const val SIZE_RATIO = 0.86f
/**
 * 표시가 살아 있는 시간 (진동부터, ms). 흉내 낸 꾹 누르기(꾹 누르기 시간 + 150ms 뒤 취소)에서 오는 신호를 잡을 만큼.
 * 그 뒤에 사용자가 누르는 반응은 평소대로 된다. 설정에서 바꾼다 (setIgnoreMs)
 */
@Volatile private var ignoreMs = 1000L
private fun pendingTtl() = ignoreMs

private class Row(val first: Any, val longPress: Any)

/** 원래 배경을 왼쪽 정사각형과 오른쪽 정사각형에 한 번씩 그린다 (반응 추가 + Aa 두 버튼처럼 보이게) */
private class Twin(val orig: android.graphics.drawable.Drawable, val gap: Int) : android.graphics.drawable.Drawable() {
    override fun draw(canvas: android.graphics.Canvas) {
        val b = bounds
        // 폭이 두 칸만큼 안 되면(크기가 아직 안 맞음) 원래 배경을 그대로 그린다 (부서져 보이지 않게)
        if (b.width() < b.height() * 2 + gap - 2) {
            orig.bounds = b
            orig.draw(canvas)
            return
        }
        val side = b.height()
        val top = b.top + (b.height() - side) / 2
        val save = android.graphics.Rect(orig.bounds)
        orig.setBounds(b.left, top, b.left + side, top + side)
        orig.draw(canvas)
        orig.setBounds(b.left + side + gap, top, b.left + side * 2 + gap, top + side)
        orig.draw(canvas)
        orig.bounds = save
    }
    override fun setAlpha(alpha: Int) {
        orig.alpha = alpha
    }
    override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) {
        orig.colorFilter = colorFilter
    }
    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = android.graphics.PixelFormat.TRANSLUCENT
    override fun isStateful(): Boolean = orig.isStateful
    override fun onStateChange(state: IntArray): Boolean = orig.setState(state)
}

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
        /** 최근 일 (로그 복사용) */
        val nlog = java.util.ArrayDeque<String>()
        fun note(msg: String) {
            val t = java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.US).format(java.util.Date())
            synchronized(nlog) {
                nlog.addLast("$t $msg")
                while (nlog.size > 120) nlog.removeFirst()
            }
        }

        // ── 자세한 로그: 버튼마다 일어난 일을 따로 쌓는다 (설정의 Copy log 로 복사) ──
        val t0 = SystemClock.uptimeMillis()
        val seenButtons = WeakHashMap<View, Boolean>()
        val traces = WeakHashMap<View, ArrayList<String>>()
        fun bid(v: View) = Integer.toHexString(System.identityHashCode(v))
        val repRe = Regex(" \\(x(\\d+)\\)$")
        fun trace(v: View, msg: String) {
            seenButtons[v] = true
            val q = traces.getOrPut(v) { ArrayList() }
            val ms = SystemClock.uptimeMillis() - t0
            synchronized(q) {
                // 같은 일이 이어지면 횟수만 늘린다
                val last = q.lastOrNull()
                if (last != null) {
                    val body = last.substringAfter(' ').replace(repRe, "")
                    if (body == msg) {
                        val n = repRe.find(last)?.groupValues?.get(1)?.toInt() ?: 1
                        q[q.size - 1] = "+$ms $msg (x${n + 1})"
                        return
                    }
                }
                q.add("+$ms $msg")
                // 처음 12줄(처음 붙을 때)은 남기고 중간을 버린다
                while (q.size > 90) q.removeAt(12)
            }
        }
        fun specStr(s: Int): String {
            val m = when (View.MeasureSpec.getMode(s)) {
                View.MeasureSpec.EXACTLY -> "E"
                View.MeasureSpec.AT_MOST -> "A"
                else -> "U"
            }
            return "$m${View.MeasureSpec.getSize(s)}"
        }
        fun lpStr(lp: android.view.ViewGroup.LayoutParams?): String {
            if (lp == null) return "lp=null"
            fun d(x: Int) = when (x) {
                -1 -> "MATCH"
                -2 -> "WRAP"
                else -> x.toString()
            }
            val sb = StringBuilder("lp=${lp.javaClass.simpleName}(${d(lp.width)}x${d(lp.height)}")
            (lp as? android.view.ViewGroup.MarginLayoutParams)?.let { sb.append(" m=${it.leftMargin},${it.topMargin},${it.rightMargin},${it.bottomMargin}") }
            (lp as? android.widget.LinearLayout.LayoutParams)?.let { if (it.weight != 0f) sb.append(" weight=${it.weight}") }
            for (f in listOf("FlexGrow", "FlexShrink", "FlexBasisPercent", "AlignSelf")) {
                try {
                    val x = lp.javaClass.getMethod("get$f").invoke(lp)
                    sb.append(" $f=$x")
                } catch (e: Throwable) {
                }
            }
            sb.append(")")
            return sb.toString()
        }
        fun viewStr(c: View): String {
            val a = IntArray(2)
            try {
                c.getLocationOnScreen(a)
            } catch (e: Throwable) {
            }
            val vis = when (c.visibility) {
                View.VISIBLE -> ""
                View.INVISIBLE -> " INVISIBLE"
                else -> " GONE"
            }
            val kids = (c as? android.view.ViewGroup)?.let { " kids=${it.childCount}" } ?: ""
            return "${c.javaClass.name}@${bid(c)} ${c.width}x${c.height} at(${a[0]},${a[1]}) frame(${c.left},${c.top},${c.right},${c.bottom}) measured=${c.measuredWidth}x${c.measuredHeight}$vis$kids ${lpStr(c.layoutParams)}"
        }

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
                    // 반응 칸만 (가는 구분선 같은 건 빼고): 어느 정도 높고, 옆으로 넓은 칸
                    val minH = 16 * c.resources.displayMetrics.density
                    if (c !== self && c.visibility == View.VISIBLE && c.width > 0 && c.height >= minH && c.width >= c.height * 0.8f && addViewClass?.isInstance(c) != true) return c
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
                note("fire kind=$kind seq=$pendingSeq view=${v.javaClass.simpleName} w=${v.width} h=${v.height}")
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
                    note("simulated long press on ${sib.javaClass.simpleName} w=${sib.width} h=${sib.height}")
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

        fun screenX(v: View): Int {
            val a = IntArray(2)
            v.getLocationOnScreen(a)
            return a[0]
        }

        /** 반응 추가 버튼(을 감싼 칸) 바로 앞의 보이는 반응 */
        fun lastReactionBefore(v: View): View? {
            var self: View = v
            var p: Any? = v.parent
            var depth = 0
            while (p is android.view.ViewGroup && depth < 3) {
                val i = p.indexOfChild(self)
                for (k in i - 1 downTo 0) {
                    val c = p.getChildAt(k)
                    if (c.visibility == View.VISIBLE && c.width > 0) return c
                }
                self = p
                p = p.parent
                depth++
            }
            return null
        }

        /** 반응 추가 버튼 아이콘 색 (없으면 반응 숫자 색을 흐리게) */
        fun iconColor(add: View, sample: View?): Int {
            fun find(v: View?): android.widget.ImageView? {
                if (v is android.widget.ImageView) return v
                if (v is android.view.ViewGroup) for (i in 0 until v.childCount) find(v.getChildAt(i))?.let { return it }
                return null
            }
            find(add)?.imageTintList?.defaultColor?.let { return it }
            val t = firstTextView(sample)?.currentTextColor ?: return 0xFFB5BAC1.toInt()
            return (t and 0x00FFFFFF) or (0xB3 shl 24)
        }

        /**
         * 반응 추가 버튼(LinearLayout) "안"에 Aa 를 넣는다. 반응들이 있는 줄에 직접 끼우면 디스코드가 반응 칸을
         * 순서대로 다시 쓰면서 Aa 가 반응 사이로 들어가거나 앱이 멈췄다.
         * 버튼 칸과 아이콘은 그대로 두고, 버튼을 [정사각형][간격][정사각형] 폭으로 늘린 뒤
         * 원래 배경을 두 번 그리는 배경(Twin)으로 바꿔서 두 개의 버튼처럼 보이게 한다.
         */
        /** 처음 본 왼쪽 여백 (줄이 바뀌면 이걸로 되돌린다) */
        val baseMargin = WeakHashMap<View, Int>()

        fun makeButton(add: View): TextView {
            val tv = TextView(add.context)
            tv.text = "Aa"
            tv.gravity = Gravity.CENTER
            tv.typeface = Typeface.DEFAULT_BOLD
            tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            tv.includeFontPadding = false
            tv.contentDescription = "React with a word"
            tv.isClickable = true
            // 어느 메시지인지는 반응 추가 버튼 옆의 반응으로 알아낸다
            tv.setOnClickListener { fire(add, "word") }
            buttonsMade++
            return tv
        }

        // 앞에서 잰 값 (새 버튼이 생기자마자, 재기 전에 바로 적용해서 한발 늦게 바뀌지 않게)
        var knownSize = 0
        var knownGap = 0
        var knownIconW = 0
        var knownT = Float.NaN

        /** 처음 본 모양 (채팅 반응 줄이 아니면 이걸로 되돌린다) */
        class Orig(val w: Int, val h: Int, val pl: Int, val pt: Int, val pr: Int, val pb: Int, val gravity: Int)
        val origLook = WeakHashMap<View, Orig>()

        /** 크기가 맞지 않고 늘어나 버리는 곳(포럼 글 머리 등)의 버튼. 이런 곳은 원래대로 둔다 */
        val skipped = WeakHashMap<View, Boolean>()
        val stretchCount = WeakHashMap<View, Int>()
        /** 버튼이 잴 때 써야 하는 크기 (폭, 높이) */
        val targetSize = WeakHashMap<View, Pair<Int, Int>>()
        val flexboxClass: Class<*>? = try {
            cl.loadClass(FLEXBOX)
        } catch (e: Throwable) {
            null
        }
        fun inChatRow(v: View): Boolean {
            var p: Any? = v.parent
            var depth = 0
            while (p is View && depth < 3) {
                if (flexboxClass?.isInstance(p) == true) return true
                p = p.parent
                depth++
            }
            return flexboxClass == null
        }

        /** 줄 폭이 모자라도 줄이지 말고(다음 줄로 넘어가게), 남는다고 늘리지도 않게 */
        fun noFlex(x: View?) {
            val lp = x?.layoutParams ?: return
            try {
                val shrink = lp.javaClass.getMethod("getFlexShrink").invoke(lp) as? Float
                val grow = lp.javaClass.getMethod("getFlexGrow").invoke(lp) as? Float
                if (shrink != 0f || grow != 0f) {
                    lp.javaClass.getMethod("setFlexShrink", Float::class.javaPrimitiveType).invoke(lp, 0f)
                    lp.javaClass.getMethod("setFlexGrow", Float::class.javaPrimitiveType).invoke(lp, 0f)
                    x.layoutParams = lp
                }
            } catch (e: Throwable) {
            }
        }

        /** 반응 추가 버튼 오른쪽에 Aa 한 칸이 들어갈 자리가 있는지 (오른쪽에 붙은 다른 버튼과 겹치지 않게) */
        fun roomForAa(v: View): Boolean {
            val size = if (knownSize > 0) knownSize else v.height
            val gap = if (knownGap > 0) knownGap else (6 * v.resources.displayMetrics.density).toInt()
            if (size <= 0 || !v.isLaidOut) return false
            val a = IntArray(2)
            v.getLocationOnScreen(a)
            val left = a[0]
            val top = a[1] - v.translationY.toInt()
            val bottom = top + v.height
            // Aa 까지 들어간 오른쪽 끝
            val need = left + size * 2 + gap * 2
            var limit = Int.MAX_VALUE
            fun scan(g: android.view.ViewGroup, depth: Int) {
                for (i in 0 until g.childCount) {
                    val c = g.getChildAt(i)
                    if (c.visibility != View.VISIBLE || c === v || c.width <= 0) continue
                    // 버튼을 품고 있는 칸은 건너뛰고 그 안을 본다
                    var inside: Any? = v.parent
                    var holds = false
                    while (inside is View) {
                        if (inside === c) {
                            holds = true
                            break
                        }
                        inside = inside.parent
                    }
                    if (holds) {
                        if (c is android.view.ViewGroup && depth < 3) scan(c, depth + 1)
                        continue
                    }
                    val b = IntArray(2)
                    c.getLocationOnScreen(b)
                    val overlapsRow = b[1] < bottom && b[1] + c.height > top
                    if (overlapsRow && b[0] > left) limit = minOf(limit, b[0])
                }
            }
            var root: Any? = v.parent
            repeat(3) { if (root is View) root = (root as View).parent }
            (root as? android.view.ViewGroup)?.let { scan(it, 0) }
            // 화면 오른쪽 끝도 넘지 않게
            val screenRight = v.resources.displayMetrics.widthPixels
            val ok = need <= minOf(limit, screenRight)
            trace(v, "room for Aa: $ok (left=$left need=$need nextOnRight=${if (limit == Int.MAX_VALUE) "none" else limit} screen=$screenRight)")
            return ok
        }

        fun parents(v: View): String {
            val out = ArrayList<String>()
            var p: Any? = v.parent
            while (p is View && out.size < 3) {
                out.add(p.javaClass.name)
                p = p.parent
            }
            return out.joinToString(" < ")
        }

        fun restore(v: android.widget.LinearLayout) {
            trace(v, "restore: target=${targetSize[v]} now=${v.width}x${v.height}")
            if (targetSize.remove(v) != null) v.requestLayout()
            (wordButtons[v] as? View)?.let { v.removeView(it) }
            (v.background as? Twin)?.let { v.background = it.orig }
            origLook[v]?.let { o ->
                v.layoutParams?.let { lp ->
                    if (lp.width != o.w || lp.height != o.h) {
                        lp.width = o.w
                        lp.height = o.h
                        v.layoutParams = lp
                    }
                }
                if (v.paddingLeft != o.pl || v.paddingTop != o.pt || v.paddingRight != o.pr || v.paddingBottom != o.pb) v.setPadding(o.pl, o.pt, o.pr, o.pb)
                if (v.gravity != o.gravity) v.gravity = o.gravity
            }
            if (v.alpha != 1f) v.alpha = 1f
            if (v.translationY != 0f) v.translationY = 0f
        }

        fun ensure(v: View) {
            if (!v.isAttachedToWindow || v !is android.widget.LinearLayout) return
            if (!origLook.containsKey(v)) {
                val lp = v.layoutParams
                origLook[v] = Orig(lp?.width ?: -2, lp?.height ?: -2, v.paddingLeft, v.paddingTop, v.paddingRight, v.paddingBottom, v.gravity)
            }
            // 채팅 반응 줄(ShortcutsFlexbox)이 아니면(포럼 글 머리 등) 해 보되, 크기가 안 맞고 늘어나면 원래대로 둔다
            val loose = !inChatRow(v)
            // 채팅 반응 줄이 아닌 곳(포럼 글 머리)은 줄이 넘어가지 않는다: 오른쪽 버튼(팔로우 등)까지 자리가 있을 때만 Aa
            val wantWord = showWord && (!loose || roomForAa(v))
            if (skipped[v] == true) {
                trace(v, "ensure: skipped earlier, restore")
                restore(v)
                return
            }
            val sib = firstSibling(v)
            if (loose && (sib == null || sib.height <= 0)) {
                trace(v, "ensure: loose and no reaction next to it (sib=${sib?.let { "${it.javaClass.simpleName} ${it.width}x${it.height}" }}), restore, now ${v.width}x${v.height}")
                restore(v)
                return
            }
            var aa = wordButtons[v] as? TextView
            // 원래 배경 (디스코드가 다시 넣으면 그게 새 원본)
            val cur = v.background
            val orig = if (cur is Twin) cur.orig else cur
            if (!fitSize && !wantWord) {
                trace(v, "ensure: fit and Aa both off")
                if (targetSize.remove(v) != null) v.requestLayout()
                aa?.let { v.removeView(it) }
                if (cur is Twin) v.background = cur.orig
                return
            }
            val size = if (sib != null && sib.height > 0) {
                if (fitSize) (sib.height * SIZE_RATIO).toInt() else sib.height
            } else if (knownSize > 0) {
                knownSize
            } else {
                v.height.takeIf { it > 0 } ?: run {
                    trace(v, "ensure: no size yet (no sib, no known size, h=0)")
                    return
                }
            }
            var gap = if (knownGap > 0) knownGap else (6 * v.resources.displayMetrics.density).toInt()
            if (sib != null) {
                val sp = sib.parent as? android.view.ViewGroup
                val i = sp?.indexOfChild(sib) ?: -1
                val next = if (sp != null && i >= 0 && i + 1 < sp.childCount) sp.getChildAt(i + 1) else null
                if (next != null && next.visibility == View.VISIBLE && next.left > sib.right) gap = next.left - sib.right
            }
            // 버튼 크기: 정사각형 하나, Aa 가 있으면 둘 + 간격
            val width = if (wantWord) size * 2 + gap else size
            // 크기가 맞기 전(첫 순간)에는 숨겨서 뭉개진 모양이 보이지 않게
            // 줄이 버튼을 늘리거나 줄이지 못하게 (포럼 글 머리에서는 남는 폭만큼 커다랗게 늘어났다).
            // 감싼 칸까지 손대는 건 채팅 반응 줄에서만
            noFlex(v)
            if (!loose) noFlex(v.parent as? View)
            // 줄이 우리가 정한 크기를 무시하고 늘릴 때만 포기한다. 우리가 전에 넣은 크기(Aa 가 있던 폭)를
            // 늘어난 걸로 착각해 원래대로 두면, Aa 만 빠지고 긴 버튼이 남았다
            val cl0 = v.layoutParams
            val ourW = cl0 != null && cl0.width > 0
            val ourH = cl0 != null && cl0.height > 0
            if (loose && v.height > 0 && v.width > 0 && ((ourW && v.width > cl0!!.width * 1.6f) || (ourH && v.height > cl0!!.height * 1.6f))) {
                val n = (stretchCount[v] ?: 0) + 1
                stretchCount[v] = n
                // 원래대로 돌리면 디스코드도 똑같이 크게 늘려 버린다. 자리 잡는 단계에서 크기를 고정하니 기록만
                if (n == 3) note("still stretched outside the chat row: w=${v.width} h=${v.height} set=${cl0!!.width}x${cl0.height} in ${parents(v)}")
                v.requestLayout()
            } else {
                stretchCount.remove(v)
            }
            val ready = abs(v.width - width) <= 1 && abs(v.height - size) <= 1
            trace(v, "ensure: ${if (loose) "LOOSE" else "chat"} want=${width}x$size now=${v.width}x${v.height} ready=$ready word=$wantWord gap=$gap sib=${sib?.let { "${it.javaClass.simpleName} ${it.width}x${it.height}" }} alpha=${v.alpha} ty=${v.translationY} ${lpStr(v.layoutParams)}")
            val alpha = if (ready) 1f else 0f
            if (v.alpha != alpha) v.alpha = alpha
            // 버튼을 감싼 칸이 폭을 고정해 두면 늘어나지 못한다: 내용만큼으로
            (v.parent as? View)?.takeIf { !loose && it !== sib?.parent }?.layoutParams?.let { plp ->
                if (plp.width >= 0 && plp.width < width) {
                    plp.width = android.view.ViewGroup.LayoutParams.WRAP_CONTENT
                    (v.parent as View).layoutParams = plp
                }
                if (plp.height >= 0 && plp.height < size) {
                    plp.height = android.view.ViewGroup.LayoutParams.WRAP_CONTENT
                    (v.parent as View).layoutParams = plp
                }
            }
            val tgt = Pair(width, size)
            if (targetSize[v] != tgt) {
                targetSize[v] = tgt
                v.requestLayout()
            }
            v.layoutParams?.let { lp ->
                if (lp.width != width || lp.height != size) {
                    lp.width = width
                    lp.height = size
                    v.layoutParams = lp
                }
            }
            // 배경
            if (wantWord) {
                if (orig != null && (cur !is Twin || cur.gap != gap)) v.background = Twin(orig, gap)
            } else if (cur is Twin) {
                v.background = cur.orig
            }
            // 아이콘은 왼쪽 정사각형 가운데로 (아이콘 칸 자체는 건드리지 않고 왼쪽 여백만)
            var iconW = 0
            for (i in 0 until v.childCount) {
                val c = v.getChildAt(i)
                if (c === aa || c.visibility == View.GONE) continue
                val m = c.layoutParams as? android.view.ViewGroup.MarginLayoutParams
                iconW += c.measuredWidth + (m?.leftMargin ?: 0) + (m?.rightMargin ?: 0)
            }
            if (iconW <= 0 && knownIconW > 0) iconW = knownIconW
            // 기억해 두는 값은 채팅 반응 줄에서만 (포럼 글 머리의 큰 값이 채팅 버튼 크기를 망쳤다)
            if (!loose && sib != null && sib.height > 0) {
                knownSize = size
                knownGap = gap
            }
            if (!loose && iconW > 0) knownIconW = iconW
            val padL = ((size - iconW) / 2).coerceAtLeast(0)
            if (v.gravity != (Gravity.START or Gravity.CENTER_VERTICAL)) v.gravity = Gravity.START or Gravity.CENTER_VERTICAL
            if (v.paddingLeft != padL || v.paddingRight != 0 || v.paddingTop != 0 || v.paddingBottom != 0) v.setPadding(padL, 0, 0, 0)
            // Aa: 오른쪽 정사각형
            if (wantWord) {
                if (aa == null) {
                    aa = makeButton(v)
                    wordButtons[v] = aa
                }
                if (aa.parent !== v) {
                    (aa.parent as? android.view.ViewGroup)?.removeView(aa)
                    v.addView(aa, android.widget.LinearLayout.LayoutParams(size, size))
                }
                val start = (size + gap - padL - iconW).coerceAtLeast(0)
                (aa.layoutParams as? android.widget.LinearLayout.LayoutParams)?.let { lp ->
                    if (lp.width != size || lp.height != size || lp.leftMargin != start) {
                        lp.width = size
                        lp.height = size
                        lp.leftMargin = start
                        lp.marginStart = start
                        aa.layoutParams = lp
                    }
                }
                val c = iconColor(v, sib)
                if (aa.currentTextColor != c) aa.setTextColor(c)
            } else if (aa != null) {
                v.removeView(aa)
            }
            // 왼쪽 간격을 반응 사이 간격과 같게 (화면에서 잰다)
            val lastReaction = lastReactionBefore(v)
            val vlp = v.layoutParams as? android.view.ViewGroup.MarginLayoutParams
            if (vlp != null && !baseMargin.containsKey(v)) baseMargin[v] = vlp.marginStart
            if (lastReaction != null && vlp != null && v.width > 0 && lastReaction.width > 0) {
                // 같은 줄일 때만 (반응이 두 줄이 되어 버튼이 다음 줄 맨 앞으로 가면 앞 반응은 윗줄 끝이다)
                val a = IntArray(2)
                val b = IntArray(2)
                lastReaction.getLocationOnScreen(a)
                v.getLocationOnScreen(b)
                val sameLine = abs((a[1] + lastReaction.height / 2f) - (b[1] - v.translationY + v.height / 2f)) < lastReaction.height
                if (sameLine) {
                    val g = screenX(v) - (screenX(lastReaction) + lastReaction.width)
                    if (abs(g - gap) > 1) {
                        vlp.marginStart = (vlp.marginStart + gap - g).coerceAtLeast(0)
                        v.layoutParams = vlp
                    }
                } else {
                    val base = baseMargin[v] ?: 0
                    if (vlp.marginStart != base) {
                        vlp.marginStart = base
                        v.layoutParams = vlp
                    }
                }
            }
            // 세로 가운데: 같은 줄의 반응(바로 앞 반응)에 맞춘다. 반응이 두 줄이 되면 첫 반응은 윗줄이라
            // 거기에 맞추면 버튼이 윗줄로 올라가 가려졌다. 옮기기 전 위치로 재고, 한 줄 넘게 차이 나면 옮기지 않는다
            val ref = lastReaction ?: sib
            if ((ref == null || ref.height <= 0 || v.height <= 0) && !knownT.isNaN()) v.translationY = knownT
            if (ref != null && ref.height > 0 && v.height > 0) {
                val p = IntArray(2)
                ref.getLocationOnScreen(p)
                val refCenter = p[1] + ref.height / 2f
                v.getLocationOnScreen(p)
                val vCenterNoShift = p[1] - v.translationY + v.height / 2f
                val want = refCenter - vCenterNoShift
                val t = if (abs(want) < ref.height) want else 0f
                if (abs(v.translationY - t) > 1f) v.translationY = t
                if (!loose && t != 0f) knownT = t
            }
        }

        val tries = WeakHashMap<View, Int>()
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
                if (v.alpha == 0f) {
                    // 아직 크기가 안 맞으면 다시 재게 하고 몇 번 더 맞춰 본다
                    val n = (tries[v] ?: 0) + 1
                    tries[v] = n
                    if (n <= 6) {
                        trace(v, "retry $n: still hidden, now=${v.width}x${v.height} target=${targetSize[v]}")
                        v.requestLayout()
                        v.postDelayed({ schedule(v) }, 16L)
                    } else {
                        // 끝내 안 맞으면 보여는 준다 (배경은 Twin 이 알아서 원래 모양으로 그린다)
                        v.alpha = 1f
                        lastError = "button size did not apply (w=${v.width}, h=${v.height})"
                        note("$lastError [${bid(v)}]")
                        trace(v, "gave up after retries: now=${v.width}x${v.height} target=${targetSize[v]} ${lpStr(v.layoutParams)} parent=${(v.parent as? View)?.let { viewStr(it) }}")
                    }
                } else {
                    tries.remove(v)
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
                                        // Aa 칸을 누른 거면 꾹 누르기를 보지 않는다 (Aa 가 알아서 받는다)
                                        val aa = wordButtons[v]
                                        if (aa != null && aa.parent === v && ev.x >= aa.left && ev.x <= aa.right) {
                                            press = null
                                            return
                                        }
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
            // 화면에 붙자마자(처음 그리기 전) 앞에서 잰 값으로 바로 바꾼다
            try {
                hooks.add(
                    XposedHelpers.findAndHookMethod(
                        View::class.java,
                        "onAttachedToWindow",
                        object : XC_MethodHook() {
                            override fun afterHookedMethod(param: MethodHookParam) {
                                val v = param.thisObject as View
                                if (!addViewClass.isInstance(v)) return
                                trace(v, "attach: in ${parents(v)}")
                                try {
                                    ensure(v)
                                } catch (e: Throwable) {
                                    lastError = "attach: $e"
                                    trace(v, "attach error: $e")
                                }
                            }
                        },
                    ),
                )
            } catch (e: Throwable) {
                lastError = "attach hook: $e"
            }
            // 줄(포럼 글 머리 등)이 크기 지정을 무시하고 남는 폭만큼 늘리므로, 잴 때 아예 정한 크기로 재게 한다
            try {
                hooks.add(
                    XposedHelpers.findAndHookMethod(
                        android.widget.LinearLayout::class.java,
                        "onMeasure",
                        Int::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        object : XC_MethodHook() {
                            override fun beforeHookedMethod(param: MethodHookParam) {
                                val v = param.thisObject as View
                                if (!addViewClass.isInstance(v)) return
                                val inW = param.args[0] as Int
                                val inH = param.args[1] as Int
                                val t = targetSize[v]
                                if (t != null) {
                                    param.args[0] = View.MeasureSpec.makeMeasureSpec(t.first, View.MeasureSpec.EXACTLY)
                                    param.args[1] = View.MeasureSpec.makeMeasureSpec(t.second, View.MeasureSpec.EXACTLY)
                                }
                                param.setObjectExtra("in", "${specStr(inW)} x ${specStr(inH)}")
                            }

                            override fun afterHookedMethod(param: MethodHookParam) {
                                val v = param.thisObject as View
                                if (!addViewClass.isInstance(v)) return
                                trace(v, "measure: parent asked ${param.getObjectExtra("in")}, target=${targetSize[v]}, result=${v.measuredWidth}x${v.measuredHeight}")
                            }
                        },
                    ),
                )
            } catch (e: Throwable) {
                lastError = "measure hook: $e"
            }
            // 포럼 글 머리 줄은 잰 크기도 무시하고 자리를 크게 준다: 받은 자리 안에서 정한 크기로 (세로는 가운데)
            try {
                hooks.add(
                    XposedHelpers.findAndHookMethod(
                        View::class.java,
                        "layout",
                        Int::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        Int::class.javaPrimitiveType,
                        object : XC_MethodHook() {
                            override fun beforeHookedMethod(param: MethodHookParam) {
                                val v = param.thisObject as View
                                if (!addViewClass.isInstance(v)) return
                                val l = param.args[0] as Int
                                val top = param.args[1] as Int
                                val r = param.args[2] as Int
                                val b = param.args[3] as Int
                                val t = targetSize[v]
                                if (t == null) {
                                    trace(v, "layout: given ${r - l}x${b - top} at ($l,$top), no target")
                                    return
                                }
                                if (r - l == t.first && b - top == t.second) {
                                    trace(v, "layout: given ${r - l}x${b - top} at ($l,$top), matches target")
                                    return
                                }
                                trace(v, "layout: given ${r - l}x${b - top} at ($l,$top), clamped to ${t.first}x${t.second}")
                                val nt = top + ((b - top) - t.second) / 2
                                param.args[1] = nt
                                param.args[2] = l + t.first
                                param.args[3] = nt + t.second
                            }
                        },
                    ),
                )
            } catch (e: Throwable) {
                lastError = "frame hook: $e"
            }
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
                                if (!addViewClass.isInstance(v)) return
                                // 바로 고친다 (레이아웃 중에 다시 재기를 부르면 안드로이드가 같은 프레임에서 한 번 더 잰다)
                                try {
                                    ensure(v)
                                } catch (e: Throwable) {
                                    lastError = "layout: $e"
                                }
                                // 다 그려진 뒤 위치를 한 번 더 맞춘다
                                schedule(v)
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
        /** 지금 알고 있는 반응 추가 버튼 전부의 자세한 상태 (화면에 붙은 것부터) */
        registerNativeMethod("${manifest.id}.dump") {
            val sb = StringBuilder()
            val list = seenButtons.keys.toList().sortedByDescending { it.isAttachedToWindow }
            sb.append("buttons known: ${list.size}, attached: ${list.count { it.isAttachedToWindow }}\n")
            for ((n, v) in list.withIndex()) {
                if (n >= 16) {
                    sb.append("... ${list.size - n} more\n")
                    break
                }
                try {
                    sb.append("\n=== button ${n + 1} [${bid(v)}] ${if (v.isAttachedToWindow) "ON SCREEN" else "detached"} ${if (inChatRow(v)) "chat row" else "LOOSE (not chat row)"} ===\n")
                    sb.append("self: ${viewStr(v)}\n")
                    sb.append("  alpha=${v.alpha} ty=${v.translationY} pad=${v.paddingLeft},${v.paddingTop},${v.paddingRight},${v.paddingBottom} gravity=${(v as? android.widget.LinearLayout)?.gravity} bg=${v.background?.javaClass?.simpleName} target=${targetSize[v]} skipped=${skipped[v] == true} orig=${origLook[v]?.let { "${it.w}x${it.h}" }}\n")
                    (v as? android.view.ViewGroup)?.let { g -> for (i in 0 until g.childCount) sb.append("  child $i: ${viewStr(g.getChildAt(i))}\n") }
                    var p: Any? = v.parent
                    var d = 1
                    var self: View = v
                    while (p is View && d <= 5) {
                        sb.append("parent $d: ${viewStr(p)}\n")
                        if (d <= 2 && p is android.view.ViewGroup) {
                            for (i in 0 until minOf(p.childCount, 12)) {
                                val c = p.getChildAt(i)
                                sb.append("    ${if (c === self) "*" else " "}[$i] ${viewStr(c)}\n")
                            }
                        }
                        self = p
                        p = p.parent
                        d++
                    }
                    sb.append("trace:\n")
                    traces[v]?.let { q -> synchronized(q) { for (line in q) sb.append("  $line\n") } }
                } catch (e: Throwable) {
                    sb.append("dump error: $e\n")
                }
            }
            sb.toString()
        }
        registerNativeMethod("${manifest.id}.status") {
            mapOf(
                "rowHook" to rowHook,
                "touchHook" to touchHook,
                "rows" to rowsSeen,
                "touches" to touches,
                "fires" to fires,
                "buttons" to buttonsMade,
                "error" to lastError,
                "knownSize" to knownSize,
                "knownGap" to knownGap,
                "knownIconW" to knownIconW,
                "knownT" to (if (knownT.isNaN()) "none" else knownT.toString()),
                "ignoreMs" to ignoreMs,
                "fitSize" to fitSize,
                "showWord" to showWord,
                "pendingSeq" to pendingSeq,
                "pendingKind" to pendingKind,
                "pendingAgeMs" to (if (pendingAt == 0L) -1L else SystemClock.uptimeMillis() - pendingAt),
                "addView" to (addViewClass?.name ?: "missing"),
                "reactionView" to (reactionViewClass?.name ?: "missing"),
                "longPressTimeout" to ViewConfiguration.getLongPressTimeout(),
                "density" to android.content.res.Resources.getSystem().displayMetrics.density,
                "liveButtons" to wordButtons.size,
                "log" to nlog.joinToString("\n"),
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
