package io.github.yumistra.betteranimations

import android.animation.ValueAnimator
import android.graphics.Matrix
import android.os.Build
import android.os.Looper
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.animation.LinearInterpolator
import android.widget.EdgeEffect
import java.lang.reflect.Field
import java.lang.reflect.Modifier
import java.util.WeakHashMap
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.sign

/**
 * 목록 끝에서 iOS 처럼 고무줄로 늘어났다가 튕겨 돌아오기. 채팅뿐 아니라 스크롤되는 모든 목록에서.
 *
 *  - 끌기: 목록이 끝(맨 아래·맨 위, 가로 목록은 왼쪽·오른쪽)에서 더 끌리면 손가락을 따라가되 멀수록 덜 따라간다
 *    (UIScrollView 의 rubber band: offset = (1 - 1 / (x * 0.55 / d + 1)) * d, d = 목록 길이).
 *    되돌아 끌면 늘어난 만큼 먼저 줄어든 뒤 스크롤된다.
 *  - 놓기: 임계 감쇠 스프링으로 제자리로.
 *  - 빠르게 스크롤하다 끝에 부딪히면: 그 속도로 살짝 넘어갔다가 돌아온다 (EdgeEffect.onAbsorb 로 알 수 있다).
 * 안드로이드의 늘어나는·빛나는 효과(EdgeEffect)는 튕기는 목록에서만 끈다.
 *
 * 대상: RecyclerView (디스코드 채팅·네이티브 목록), ScrollView·HorizontalScrollView (React Native 의 모든 스크롤 목록).
 * UIScrollView 처럼 내용이 화면보다 길어서 스크롤할 수 있는 목록만 튕긴다.
 *
 * 움직임은 목록의 animationMatrix(안드로이드 10+)로 그린다. 위치 값(translation)을 건드리지 않아 다른 효과와 겹치지 않는다.
 * 끄는 동안 쓴(늘어나는 데 들어간) 손가락 이동은 터치 좌표에서 빼서 목록이 그만큼 스크롤하지 않게 한다.
 */
internal class Bounce(private val recycler: Recycler?, private val enabled: (View) -> Boolean) {
    val supported = Build.VERSION.SDK_INT >= 29

    private class State {
        /** 0 = 아직 모름·튕기지 않음, 1 = 세로, 2 = 가로 */
        var axis = 0
        /** 끝을 넘어 끈 손가락 거리 (부호: + 앞쪽 끝(위·왼쪽)에서 뒤로, - 뒤쪽 끝에서 앞으로) */
        var pull = 0f
        /** 지금 그려진 위치 (px) */
        var offset = 0f
        /** 이번 손가락에서 늘어나는 데 쓴 이동량 (터치 좌표에서 뺀다) */
        var shift = 0f
        var last = 0f
        var downX = 0f
        var downY = 0f
        /** 목록이 끌기를 시작했는지 (RecyclerView 가 아닌 목록은 손가락이 일정 거리 움직이면) */
        var dragging = false
        var lastTime = -1L
        var lastAction = -1
        var lastPos = 0f
        var anim: ValueAnimator? = null
    }

    private val states = WeakHashMap<View, State>()
    private val lists = WeakHashMap<View, Boolean>()
    /** EdgeEffect → 그걸 쓰는 목록 (못 찾은 것도 NONE 으로 기억해서 다시 안 찾는다) */
    private val owners = WeakHashMap<EdgeEffect, Any>()
    private val NONE = Any()
    private val matrix = Matrix()

    /** RecyclerView 의 EdgeEffect 필드들 (앱 클래스라 리플렉션으로 읽을 수 있다) */
    private val edgeFields: List<Field> by lazy {
        val out = ArrayList<Field>()
        var c: Class<*>? = recycler?.rv
        while (c != null && c != ViewGroup::class.java) {
            for (f in c.declaredFields) {
                if (!Modifier.isStatic(f.modifiers) && f.type == EdgeEffect::class.java) {
                    f.isAccessible = true
                    out.add(f)
                }
            }
            c = c.superclass
        }
        out
    }

    private fun isRecycler(v: View) = recycler?.rv?.isInstance(v) == true

    fun register(list: View) {
        if (!supported || lists.containsKey(list)) return
        lists[list] = true
        // 끝에 부딪힌 속도를 받으려면 넘침 효과가 켜져 있어야 한다 (그려지는 건 아래에서 막는다)
        if (enabled(list) && list.overScrollMode == View.OVER_SCROLL_NEVER) list.overScrollMode = View.OVER_SCROLL_ALWAYS
    }

    private fun state(list: View) = states.getOrPut(list) { State() }

    // ── 방향 ────────────────────────────────────────────────────────

    private fun axisOf(list: View): Int = when {
        list.canScrollVertically(1) || list.canScrollVertically(-1) -> 1
        list.canScrollHorizontally(1) || list.canScrollHorizontally(-1) -> 2
        else -> 0
    }

    private fun canScroll(list: View, axis: Int, dir: Int) = if (axis == 2) list.canScrollHorizontally(dir) else list.canScrollVertically(dir)

    private fun lengthOf(list: View, axis: Int) = (if (axis == 2) list.width else list.height).toFloat()

    private fun posOf(ev: MotionEvent, axis: Int) = if (axis == 2) ev.x else ev.y

    // ── 고무줄 ──────────────────────────────────────────────────────

    private fun rubber(x: Float, d: Float): Float {
        if (d <= 0f) return 0f
        val a = abs(x)
        return sign(x) * (1f - 1f / (a * RUBBER / d + 1f)) * d
    }

    /** rubber 의 반대 (그려진 위치 → 끈 거리) */
    private fun unrubber(o: Float, d: Float): Float {
        if (d <= 0f) return 0f
        val a = min(abs(o), d * 0.98f)
        return sign(o) * (d / RUBBER) * (1f / (1f - a / d) - 1f)
    }

    private fun draw(list: View, s: State, offset: Float) {
        s.offset = offset
        if (abs(offset) < 0.5f) {
            s.offset = 0f
            list.animationMatrix = null
        } else {
            if (s.axis == 2) matrix.setTranslate(offset, 0f) else matrix.setTranslate(0f, offset)
            list.animationMatrix = matrix
        }
        list.invalidate()
    }

    private fun stop(s: State) {
        s.anim?.cancel()
        s.anim = null
    }

    /**
     * 임계 감쇠 스프링으로 0 까지 (x0: 시작 위치, v0: 시작 속도 px/s).
     * x(t) = (x0 + (v0 + ω·x0)·t)·e^(−ωt)
     */
    private fun spring(list: View, s: State, x0: Float, v0: Float, omega: Float) {
        stop(s)
        val durationMs = ((SETTLE / omega) * 1000f).toLong().coerceIn(250L, 1500L)
        val a = ValueAnimator.ofFloat(0f, 1f)
        a.duration = durationMs
        a.interpolator = LinearInterpolator()
        a.addUpdateListener {
            if (s.anim !== it) return@addUpdateListener
            val t = it.animatedFraction * durationMs / 1000f
            val x = if (it.animatedFraction >= 1f) 0f else (x0 + (v0 + omega * x0) * t) * exp(-omega * t)
            draw(list, s, x)
            if (it.animatedFraction >= 1f) s.anim = null
        }
        s.anim = a
        a.start()
    }

    // ── 끌기 ────────────────────────────────────────────────────────

    /**
     * 목록이 이 터치를 처리하기 전에 (onInterceptTouchEvent·onTouchEvent 둘 다).
     * 돌려준 만큼 터치 좌표를 옮겼다 (처리 뒤 restore 로 되돌린다)
     */
    fun before(list: ViewGroup, ev: MotionEvent): Float {
        if (!supported || !enabled(list)) return 0f
        val s = state(list)
        // 같은 터치가 onInterceptTouchEvent → onTouchEvent 로 두 번 올 수 있어서 한 번만 계산
        val action = ev.actionMasked
        val pos = if (s.axis == 2) ev.x else ev.y
        val fresh = ev.eventTime != s.lastTime || action != s.lastAction || (action == MotionEvent.ACTION_MOVE && pos != s.lastPos)
        if (fresh) {
            s.lastTime = ev.eventTime
            s.lastAction = action
            track(list, s, ev)
            s.lastPos = if (s.axis == 2) ev.x else ev.y
        }
        // UP 까지 같은 만큼 옮긴다 (속도 계산이 튀지 않게). 다음 DOWN 에서 0 으로
        val shift = s.shift
        if (shift != 0f) {
            if (s.axis == 2) ev.offsetLocation(-shift, 0f) else ev.offsetLocation(0f, -shift)
        }
        return shift
    }

    /** 이 목록이 가로로 튕기는지 (restore 에 넘긴다) */
    fun horizontal(list: View) = states[list]?.axis == 2

    fun restore(ev: MotionEvent, shift: Float, horizontal: Boolean) {
        if (shift == 0f) return
        if (horizontal) ev.offsetLocation(shift, 0f) else ev.offsetLocation(0f, shift)
    }

    private fun startedDragging(list: ViewGroup, s: State, ev: MotionEvent): Boolean {
        if (s.dragging) return true
        if (isRecycler(list) && recycler != null) {
            s.dragging = recycler.scrollState(list) == DRAGGING
            return s.dragging
        }
        // ScrollView 등: 스크롤 방향으로 손가락이 터치 기준 거리보다 많이 움직이면 끌기 시작
        val slop = ViewConfiguration.get(list.context).scaledTouchSlop
        val along = if (s.axis == 2) ev.x - s.downX else ev.y - s.downY
        val across = if (s.axis == 2) ev.y - s.downY else ev.x - s.downX
        s.dragging = abs(along) > slop && abs(along) > abs(across)
        return s.dragging
    }

    private fun track(list: ViewGroup, s: State, ev: MotionEvent) {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                s.shift = 0f
                s.dragging = false
                s.downX = ev.x
                s.downY = ev.y
                // 튕기는 중이면 그 방향 그대로, 아니면 지금 스크롤할 수 있는 방향
                if (s.anim == null && s.offset == 0f) s.axis = axisOf(list)
                s.last = posOf(ev, s.axis)
                // 튕기는 중에 잡으면 그 자리에서 이어서 끈다
                if (s.anim != null || s.offset != 0f) {
                    stop(s)
                    s.pull = unrubber(s.offset, lengthOf(list, s.axis))
                    // 늘어난 그림(animationMatrix)은 터치 위치 계산에 안 들어간다. 그대로 두면 튕기는 중에 누른 줄이 아니라
                    // 그 자리에 원래 있던 줄이 눌린다 → 그린 만큼 터치 좌표를 옮겨서 보이는 줄이 눌리게
                    s.shift = s.offset
                } else {
                    s.pull = 0f
                }
            }
            MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_POINTER_UP -> s.last = posOf(ev, s.axis)
            MotionEvent.ACTION_MOVE -> {
                if (s.axis == 0) return
                val p = posOf(ev, s.axis)
                val d = p - s.last
                s.last = p
                if (d == 0f) return
                // 목록이 실제로 끌기를 시작한 뒤에만 (그전엔 눌림·길게 누르기가 그대로 가게)
                if (s.pull == 0f && !startedDragging(list, s, ev)) return
                // 끝에서 늘이는 중에 그쪽으로 내용이 더 생겼다 (예: 위로 계속 올리다 옛 메시지가 로드됨).
                // 계속 늘이고 있으면 손가락이 고무줄에만 쓰여 목록이 막힌 것처럼 된다 → 목록에 넘겨준다
                if (s.pull != 0f && canScroll(list, s.axis, if (s.pull > 0f) -1 else 1)) {
                    handOff(list, s)
                    return
                }
                var used: Float
                if (s.pull == 0f) {
                    // 손가락이 앞쪽으로(+) 가면 앞쪽 끝, 뒤쪽으로(−) 가면 뒤쪽 끝
                    val atEdge = if (d > 0f) !canScroll(list, s.axis, -1) else !canScroll(list, s.axis, 1)
                    if (!atEdge) return
                    s.pull = d
                    used = d
                } else {
                    val next = s.pull + d
                    if (next == 0f || sign(next) == sign(s.pull)) {
                        s.pull = next
                        used = d
                    } else {
                        // 제자리를 지나 반대로: 남는 만큼은 목록이 스크롤한다
                        used = -s.pull
                        s.pull = 0f
                    }
                }
                s.shift += used
                draw(list, s, rubber(s.pull, lengthOf(list, s.axis)))
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                s.dragging = false
                if (s.pull != 0f || s.offset != 0f) {
                    s.pull = 0f
                    spring(list, s, s.offset, 0f, OMEGA_RELEASE)
                }
            }
        }
    }

    /**
     * 늘어난 만큼을 실제 스크롤로 바꾼다: 그림 위치를 0 으로 하고 목록을 같은 거리만큼 그 끝 쪽으로 스크롤해서
     * 화면의 내용은 제자리에 있고, 이어지는 손가락 이동은 목록이 스크롤한다.
     * 새로 생긴 내용이 늘어난 거리보다 짧으면 남은 만큼만 스프링으로 돌아온다.
     */
    private fun handOff(list: ViewGroup, s: State) {
        val offset = s.offset
        s.pull = 0f
        stop(s)
        if (offset == 0f) return
        var moved = 0f
        try {
            moved = scrollKeeping(list, s.axis, offset)
        } catch (t: Throwable) {
        }
        // 남은 거리 (넘치거나 반대로 가면 0, 하나도 못 움직였으면 그대로)
        val left = (offset - moved).let { if (sign(it) != sign(offset) || abs(it) < 0.5f) 0f else it }
        draw(list, s, left)
        if (left != 0f) spring(list, s, left, 0f, OMEGA_RELEASE)
    }

    /** 목록을 offset 만큼 그 끝 쪽으로 스크롤하고, 내용이 실제로 움직인 거리 (+ = 아래·오른쪽으로) */
    private fun scrollKeeping(list: ViewGroup, axis: Int, offset: Float): Float {
        val amount = -offset.toInt()
        if (amount == 0) return 0f
        val vertical = axis != 2
        if (!isRecycler(list)) {
            val before = if (vertical) list.scrollY else list.scrollX
            if (vertical) list.scrollBy(0, amount) else list.scrollBy(amount, 0)
            return -((if (vertical) list.scrollY else list.scrollX) - before).toFloat()
        }
        // RecyclerView 는 scrollY 가 늘 0 이라 끝 쪽 줄의 위치로 잰다 (안쪽으로 움직이니 떨어져 나가지 않는다)
        var edge: View? = null
        for (i in 0 until list.childCount) {
            val c = list.getChildAt(i)
            val start = if (vertical) c.top else c.left
            if (edge == null) {
                edge = c
                continue
            }
            val best = if (vertical) edge.top else edge.left
            if (if (offset > 0f) start < best else start > best) edge = c
        }
        val before = edge?.let { if (vertical) it.top else it.left }
        if (vertical) list.scrollBy(0, amount) else list.scrollBy(amount, 0)
        if (edge == null || before == null || edge.parent !== list) return offset
        return ((if (vertical) edge.top else edge.left) - before).toFloat()
    }

    // ── 끝에 부딪힘 (EdgeEffect) ───────────────────────────────────────

    /**
     * 지금 EdgeEffect 를 쓰고 있는 ScrollView 들 (그 목록의 터치·그리기·스크롤 계산 중에만 쌓인다).
     * 안드로이드 ScrollView 의 EdgeEffect 필드는 숨은 API 라 읽지 않고, "누가 부르는 중인지"로 주인을 찾는다.
     */
    private val frames = ArrayList<View>()

    fun enter(v: View) {
        if (Looper.myLooper() == Looper.getMainLooper()) frames.add(v)
    }

    fun exit(v: View) {
        if (Looper.myLooper() != Looper.getMainLooper()) return
        val i = frames.lastIndexOf(v)
        if (i >= 0) frames.removeAt(i)
    }

    /** 이 빛의 주인 목록 (튕기는 목록이 아니면 null) */
    fun ownerOf(e: EdgeEffect): View? {
        if (!supported) return null
        val known = owners[e]
        if (known is View) return known.takeIf { enabled(it) }
        if (known == null && lists.isNotEmpty()) {
            // RecyclerView: 필드로 확인
            for (list in lists.keys.toList()) {
                if (!isRecycler(list)) continue
                for (f in edgeFields) {
                    val v = try {
                        f.get(list)
                    } catch (t: Throwable) {
                        null
                    }
                    if (v is EdgeEffect) owners[v] = list
                }
            }
            (owners[e] as? View)?.let { return it.takeIf { v -> enabled(v) } }
        }
        // ScrollView: 지금 부르는 중인 목록
        val top = frames.lastOrNull() ?: run {
            if (known == null) owners[e] = NONE
            return null
        }
        owners[e] = top
        return top.takeIf { enabled(it) }
    }

    /** 빠르게 스크롤하다 끝에 닿음 (velocity: px/s, 크기만) */
    fun absorb(list: View, velocity: Int) {
        if (!enabled(list)) return
        val s = state(list)
        if (s.pull != 0f) return
        if (s.axis == 0) s.axis = axisOf(list)
        if (s.axis == 0) return
        // 뒤쪽 끝이면 내용이 앞으로(−), 앞쪽 끝이면 뒤로(+)
        val dir = if (!canScroll(list, s.axis, 1)) -1f else 1f
        val len = lengthOf(list, s.axis)
        // 최대로 넘어가는 거리: v / (ω·e). 너무 멀리 가지 않게 길이 비율로 묶는다
        val maxV = MAX_OVERSHOOT * len * OMEGA_ABSORB * E
        val v = min(abs(velocity).toFloat(), maxV)
        if (v < 50f) return
        spring(list, s, s.offset, dir * v, OMEGA_ABSORB)
    }

    /** 설정을 끄거나 플러그인을 멈출 때 */
    fun reset() {
        for ((list, s) in states) {
            stop(s)
            s.pull = 0f
            s.shift = 0f
            try {
                draw(list, s, 0f)
            } catch (t: Throwable) {
            }
        }
    }

    companion object {
        /** UIScrollView 의 고무줄 계수 */
        const val RUBBER = 0.55f
        /** 놓았을 때 돌아오는 스프링 (rad/s). 클수록 빨리 */
        const val OMEGA_RELEASE = 13f
        /** 끝에 부딪혀 튕길 때 */
        const val OMEGA_ABSORB = 10.5f
        /** 거의 멈출 때까지 (ω·t) */
        const val SETTLE = 7f
        /** 부딪혀 넘어가는 최대 거리 (목록 길이 비율) */
        const val MAX_OVERSHOOT = 0.14f
        const val E = 2.7182817f
        const val DRAGGING = 1
    }
}
