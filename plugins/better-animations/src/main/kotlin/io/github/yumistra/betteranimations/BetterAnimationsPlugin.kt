@file:JvmName("BetterAnimationsPlugin")

package io.github.yumistra.betteranimations

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.PixelFormat
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.Shader
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewAnimationUtils
import android.view.ViewGroup
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedHelpers
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeAsyncMethod
import app.valenced.xposed.api.registerNativeMethod
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * Better Animations 의 네이티브 부분: 채팅 메시지 애니메이션.
 *
 * 안드로이드 디스코드의 채팅 목록(ChatListView)은 RecyclerView 라 JS 로는 손댈 수 없다.
 *  - 나타날 때: RecyclerView 가 줄을 붙일 때 부르는 dispatchChildAttached 를 후킹해서 그 줄을 움직인다.
 *  - 지워질 때: 레이아웃 중에 "삭제됨" 표시가 붙은 줄이 떨어지면, 떨어지기 전 모습을 RenderNode 로 떠서
 *    목록 위(overlay)에 띄운 채 사라지는 애니메이션을 재생한다.
 *  - 밀리기: 줄이 추가·삭제된 레이아웃 전후의 위치 차이만큼 남은 줄들을 부드럽게 옮긴다.
 *
 * 설정은 JS 쪽이 jsonStorage 로 저장하는 storage.json 의 modules.messages 를 읽는다.
 * 설정을 바꾸면 JS 가 `<id>.reload` 를 부른다.
 */


/** 지워진 줄 자리에 이 시간 안에 새 줄이 붙으면 같은 메시지가 바뀐 것으로 본다 (ms) */
private const val REPLACE_WINDOW = 400L

/** 한 번에 이보다 많이 붙으면 채널을 연(또는 크게 새로 그린) 것으로 본다 */
private const val OPEN_BATCH = 6

// ── 설정 ────────────────────────────────────────────────────────

private data class Config(
    val enabled: Boolean = true,
    val effect: String = "rise",
    val exit: String = "same",
    val direction: String = "auto",
    val position: String = "auto",
    val duration: Long = 320L,
    val easing: String = "out",
    val stagger: Long = 30L,
    val onOpen: Boolean = true,
    val shift: Boolean = true,
    val shiftDuration: Long = 200L,
    /** 목록 끝에서 iOS 처럼 튕기기 */
    val bounce: Boolean = true,
    /** 채팅뿐 아니라 모든 목록에서 */
    val bounceAll: Boolean = true,
) {
    val enterOn get() = enabled && (Cask.styleOf(effect) != null || hiddenFor(effect) != null)
    val exitEffect get() = if (exit.isEmpty() || exit == "same") effect else exit
    val exitOn get() = enabled && hiddenFor(exitEffect) != null
    val shiftOn get() = enabled && shift
}

private fun loadConfig(dir: File): Config {
    val d = Config()
    try {
        val file = File(dir, "storage.json")
        if (!file.isFile) return d
        val root = JSONObject(file.readText())
        val m = root.optJSONObject("modules")?.optJSONObject("messages") ?: JSONObject()
        return Config(
            enabled = root.optBoolean("enabled", d.enabled),
            effect = m.optString("effect", d.effect),
            exit = m.optString("exit", d.exit),
            direction = m.optString("direction", d.direction),
            position = m.optString("position", d.position),
            duration = m.optLong("duration", d.duration).coerceIn(50L, 3000L),
            easing = m.optString("easing", d.easing),
            stagger = m.optLong("stagger", d.stagger).coerceIn(0L, 300L),
            onOpen = m.optBoolean("onOpen", d.onOpen),
            shift = m.optBoolean("shift", d.shift),
            shiftDuration = m.optLong("shiftDuration", d.shiftDuration).coerceIn(50L, 2000L),
            bounce = m.optBoolean("bounce", d.bounce),
            bounceAll = m.optBoolean("bounceAll", d.bounceAll),
        )
    } catch (e: Throwable) {
        return d
    }
}

// ── 효과 ────────────────────────────────────────────────────────

/** 숨은 상태. 보이는 상태는 항상 원래 모습. JS 쪽 MESSAGE_EFFECTS 와 같은 값 */
private class Hidden(
    val alpha: Float = 0f,
    /** dp. 자동 방향이면 화면 아래쪽 줄은 아래에서, 위쪽 줄은 위에서 */
    val dy: Float = 0f,
    /** dp. 양수면 오른쪽에서 */
    val dx: Float = 0f,
    /** 줄 너비 비율 */
    val dxW: Float = 0f,
    val scale: Float = 1f,
    /** 도 */
    val rotation: Float = 0f,
    val rotationX: Float = 0f,
    val rotationY: Float = 0f,
    /** dp, 안드로이드 12 이상 */
    val blur: Float = 0f,
    /** 원형으로 드러나기 */
    val reveal: Boolean = false,
    /** 차례로 나타나는 간격의 최소값 */
    val minStagger: Long = 0L,
)

private fun hiddenFor(effect: String): Hidden? = when (effect) {
    "rise" -> Hidden(dy = 28f)
    "fade" -> Hidden()
    "slip" -> Hidden(dx = 40f)
    "slide" -> Hidden(alpha = 1f, dxW = 1f)
    "side" -> Hidden(dx = -48f)
    "scale" -> Hidden(scale = 0.9f)
    "pop" -> Hidden(scale = 0.6f)
    "point" -> Hidden(scale = 0.2f)
    "drop" -> Hidden(dy = 40f, scale = 0.92f)
    "flip" -> Hidden(rotationX = 70f)
    "blur" -> Hidden(scale = 1.04f, blur = 24f)
    "circle" -> Hidden(reveal = true)
    "outOfBounds" -> Hidden(alpha = 1f, dxW = 0.9f, scale = 1.25f, rotation = 4f)
    "wave" -> Hidden(dy = 22f, rotation = -5f, minStagger = 45L)
    // Cask 효과는 따로 돌린다. 지워질 땐 페이드로
    else -> if (effect.startsWith("cask.")) Hidden() else null // default, none
}

/** 방향까지 풀어서 px 로 바꾼 값 */
private class Moves(
    val alpha: Float,
    val dx: Float,
    val dy: Float,
    val scale: Float,
    val rotation: Float,
    val rotationX: Float,
    val rotationY: Float,
    val blur: Float,
    val reveal: Boolean,
)

private fun resolve(h: Hidden, direction: String, fromBelow: Boolean, density: Float, rowWidth: Int): Moves {
    var dx = h.dx * density + h.dxW * rowWidth
    var dy = h.dy * density
    var s = h.scale
    var rx = h.rotationX
    var ry = h.rotationY
    val autoSign = if (fromBelow) 1f else -1f
    when (direction) {
        "up", "down", "left", "right" -> {
            val flip = (rx != 0f || ry != 0f) && dx == 0f && dy == 0f
            if (flip) {
                val m = max(abs(rx), abs(ry))
                rx = when (direction) { "up" -> m; "down" -> -m; else -> 0f }
                ry = when (direction) { "left" -> -m; "right" -> m; else -> 0f }
            } else {
                val m = max(abs(dx), abs(dy)).takeIf { it > 0f } ?: (30f * density)
                // "위로" 나타나려면 아래(+)에서 출발
                val sign = if (direction == "up" || direction == "left") 1f else -1f
                if (direction == "up" || direction == "down") {
                    dy = sign * m
                    dx = 0f
                } else {
                    dx = sign * m
                    dy = 0f
                }
            }
        }
        else -> {
            if (direction == "toward" || direction == "away") {
                val d = abs(1f - s).takeIf { it > 0f } ?: 0.15f
                s = if (direction == "toward") max(0.01f, 1f - d) else 1f + d
            }
            dy *= autoSign
            rx *= autoSign
        }
    }
    return Moves(h.alpha, dx, dy, s, h.rotation, rx, ry, h.blur * density, h.reveal)
}

/** 위치 설정 → 기준점 (줄 크기 비율). null 이면 가운데 그대로 */
internal fun pivotOf(position: String): Pair<Float, Float>? = when (position) {
    "tl" -> 0f to 0f
    "t" -> 0.5f to 0f
    "tr" -> 1f to 0f
    "l" -> 0f to 0.5f
    "c" -> 0.5f to 0.5f
    "r" -> 1f to 0.5f
    "bl" -> 0f to 1f
    "b" -> 0.5f to 1f
    "br" -> 1f to 1f
    else -> null
}

// ── 움직임(가속 곡선). JS 의 easingFrom 과 같은 모양 ──────────────────────

private fun bounceOut(t: Float): Float {
    val n = 7.5625f
    return when {
        t < 1f / 2.75f -> n * t * t
        t < 2f / 2.75f -> { val u = t - 1.5f / 2.75f; n * u * u + 0.75f }
        t < 2.5f / 2.75f -> { val u = t - 2.25f / 2.75f; n * u * u + 0.9375f }
        else -> { val u = t - 2.625f / 2.75f; n * u * u + 0.984375f }
    }
}

/** react-native Easing.elastic (끝에서 출렁이는 모양) */
private fun elasticOut(b: Float) = { t: Float -> (1.0 - cos(t * PI / 2).pow(3) * cos(t * b * PI)).toFloat() }

private fun styleIn(style: String): (Float) -> Float = when (style) {
    "sine" -> { t -> (1.0 - cos(t * PI / 2)).toFloat() }
    "quad" -> { t -> t * t }
    "quart" -> { t -> t * t * t * t }
    "quint" -> { t -> t * t * t * t * t }
    "circ" -> { t -> (1.0 - sqrt(max(0.0, 1.0 - t * t))).toFloat() }
    "expo" -> { t -> if (t <= 0f) 0f else 2.0.pow(10.0 * (t - 1)).toFloat() }
    "bounce" -> { t -> 1f - bounceOut(1f - t) }
    else -> { t -> t * t * t }
}

private fun wrap(bezier: String, f: (Float) -> Float): (Float) -> Float = when (bezier) {
    "in" -> f
    "inOut" -> { t -> if (t < 0.5f) f(t * 2f) / 2f else 1f - f((1f - t) * 2f) / 2f }
    else -> { t -> 1f - f(1f - t) }
}

private fun back(s: Float): (Float) -> Float = { t -> t * t * ((s + 1f) * t - s) }

private fun damped(decay: Double, freq: Double): (Float) -> Float = { t -> (1.0 - exp(-decay * t) * cos(freq * t)).toFloat() }

private fun curveFor(easing: String): (Float) -> Float {
    if (easing.startsWith("c:")) {
        val p = easing.split(':')
        val type = p.getOrNull(1) ?: "ease"
        val bezier = p.getOrNull(2) ?: "out"
        val style = p.getOrNull(3) ?: "cubic"
        val amount = p.getOrNull(4)?.toFloatOrNull() ?: 1f
        return when (type) {
            "linear" -> { t -> t }
            "steps" -> {
                val n = max(1, Math.round(amount))
                return { t -> floor(t * n) / n }
            }
            "back" -> wrap(bezier, back(amount))
            "elastic" -> {
                val out = elasticOut(amount)
                wrap(bezier) { t -> 1f - out(1f - t) }
            }
            else -> wrap(bezier, styleIn(style))
        }
    }
    return when (easing) {
        "linear" -> { t -> t }
        "smooth" -> wrap("inOut", styleIn("cubic"))
        "expo" -> wrap("out", styleIn("expo"))
        "back" -> wrap("out", back(1.7f))
        "bounce" -> ::bounceOut
        "elastic" -> elasticOut(1.1f)
        "spring" -> damped(6.0, 12.0)
        else -> wrap("out", styleIn("cubic"))
    }
}

internal fun interpolatorFor(easing: String): TimeInterpolator {
    val f = curveFor(easing)
    return TimeInterpolator { t -> if (t >= 1f) 1f else f(t) }
}

private val SMOOTH = interpolatorFor("c:ease:inOut:quad:1")

// ── 안드로이드 버전별 도우미 ─────────────────────────────────────────

/** 블러 (안드로이드 12 이상) */
private object Blur {
    val supported = Build.VERSION.SDK_INT >= 31
    private val applied = WeakHashMap<View, Boolean>()

    fun set(view: View, radius: Float) {
        if (!supported) return
        if (radius < 0.5f) {
            clear(view)
            return
        }
        view.setRenderEffect(RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP))
        applied[view] = true
        RowFx.blur[view] = radius
    }

    fun clear(view: View) {
        if (!supported) return
        RowFx.blur.remove(view)
        if (applied.remove(view) != null) view.setRenderEffect(null)
    }

    fun node(node: RenderNode, radius: Float) {
        if (!supported) return
        node.setRenderEffect(if (radius < 0.5f) null else RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP))
    }
}

/** 지워진 줄의 떨어지기 전 모습 (안드로이드 10 이상) */
private class Snapshot(
    val node: RenderNode,
    val left: Int,
    val top: Int,
    val width: Int,
    val height: Int,
    val alpha: Float,
    val translationX: Float,
    val translationY: Float,
    val scale: Float,
) {
    fun discard() = node.discardDisplayList()

    companion object {
        val supported = Build.VERSION.SDK_INT >= 29

        fun of(view: View): Snapshot? {
            if (!supported || view.width <= 0 || view.height <= 0) return null
            val node = RenderNode("BetterAnimationsGhost")
            node.setPosition(view.left, view.top, view.right, view.bottom)
            val canvas = node.beginRecording(view.width, view.height)
            try {
                view.draw(canvas)
            } finally {
                node.endRecording()
            }
            node.setAlpha(view.alpha)
            node.setTranslationX(view.translationX)
            node.setTranslationY(view.translationY)
            node.setScaleX(view.scaleX)
            node.setScaleY(view.scaleY)
            return Snapshot(node, view.left, view.top, view.width, view.height, view.alpha, view.translationX, view.translationY, view.scaleX)
        }
    }
}

private class GhostDrawable(private val node: RenderNode) : Drawable() {
    override fun draw(canvas: Canvas) {
        if (canvas.isHardwareAccelerated) canvas.drawRenderNode(node)
    }

    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(colorFilter: ColorFilter?) {}

    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}

// ── 줄 애니메이션 ─────────────────────────────────────────────────

private class Rows(private val config: () -> Config, private val holderOf: (ViewGroup, View) -> Boolean) {
    private val running = WeakHashMap<View, Animator>()
    private val reveals = WeakHashMap<View, Animator>()
    private val pending = WeakHashMap<View, Runnable>()
    private val shifting = WeakHashMap<View, ValueAnimator>()

    // 같은 순간에 붙은 줄 묶음
    private var batchStart = 0L
    private val batch = ArrayList<WeakReference<View>>()
    private var batchSkipped = false

    // 레이아웃 한 번 동안의 기록
    private var layingOut: ViewGroup? = null
    private val tops = HashMap<View, Int>()
    private var attachedInPass = 0
    private var removedInPass = 0
    private val snapshots = ArrayList<Pair<Snapshot, Gone>>()
    /** 이번 배치에서 붙은 줄 */
    private val attachedNow = ArrayList<WeakReference<View>>()

    /**
     * 최근에 지워진 줄의 자리. 같은 자리에 곧바로 새 줄이 붙으면 "같은 메시지가 바뀐 것"으로 본다
     * (보내는 중 메시지 → 서버가 확인한 메시지는 번호가 달라서 목록이 지우고 새로 붙인다).
     * 그때는 나타나고 사라지는 효과를 둘 다 건너뛴다
     */
    private class Gone(val top: Int, val bottom: Int, val at: Long) {
        var used = false
        var cancelExit: (() -> Unit)? = null
    }
    private val gone = ArrayList<Gone>()

    fun onAttached(parent: ViewGroup, child: View) {
        if (layingOut === parent) {
            attachedInPass++
            attachedNow.add(WeakReference(child))
        }
        reset(child)
        val c = config()
        if (!c.enterOn) return
        val hidden = hiddenFor(c.effect) ?: return

        val now = SystemClock.uptimeMillis()
        if (now - batchStart > 48L) {
            batchStart = now
            batch.clear()
            batchSkipped = false
        }
        if (batchSkipped) return
        batch.add(WeakReference(child))
        if (!c.onOpen && batch.size > OPEN_BATCH) {
            // 채널을 연 것: 아직 그려지기 전이니 숨긴 줄들을 바로 되돌린다
            batchSkipped = true
            for (ref in batch) ref.get()?.let(::reset)
            batch.clear()
            return
        }
        val stagger = max(c.stagger, hidden.minStagger)
        val delay = ((batch.size - 1) * stagger).coerceAtMost(stagger * 12L)

        // Cask 효과: 처음 모습을 바로 적용하고 시작한다
        Cask.styleOf(c.effect)?.let { style ->
            running[child] = Cask.start(child, style, c.duration, delay) {
                val a = running[child]
                if (a != null && !a.isRunning) {
                    running.remove(child)
                    clear(child)
                }
            }
            return
        }

        // 레이아웃 전이라 위치를 모른다. 먼저 숨겨 두고, 다음 프레임에 방향을 정해 시작한다
        child.alpha = hidden.alpha
        child.scaleX = hidden.scale
        child.scaleY = hidden.scale
        if (hidden.blur > 0f) Blur.set(child, hidden.blur * child.resources.displayMetrics.density)

        val start = Runnable {
            pending.remove(child)
            try {
                startEnter(parent, child, c, hidden, delay)
            } catch (e: Throwable) {
                reset(child)
            }
        }
        pending[child] = start
        child.post(start)
    }

    private fun startEnter(parent: ViewGroup, child: View, c: Config, hidden: Hidden, delay: Long) {
        val fromBelow = child.top + child.height / 2 >= parent.height / 2
        val density = child.resources.displayMetrics.density
        val m = resolve(hidden, c.direction, fromBelow, density, child.width)
        pivotOf(c.position)?.let { (px, py) ->
            child.pivotX = child.width * px
            child.pivotY = child.height * py
        }
        val interpolator = interpolatorFor(c.easing)

        val animator = ValueAnimator.ofFloat(0f, 1f)
        animator.duration = c.duration
        animator.startDelay = delay
        animator.interpolator = interpolator
        animator.addUpdateListener { a -> frame(child, m, a.animatedValue as Float, a.animatedFraction, true) }
        animator.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
                if (running[child] === animation) {
                    running.remove(child)
                    clear(child)
                }
            }
        })
        frame(child, m, 0f, 0f, false)
        running[child] = animator
        animator.start()

        if (m.reveal && child.isAttachedToWindow && child.width > 0 && child.height > 0) {
            val (px, py) = pivotOf(c.position) ?: (0.5f to 0.5f)
            val cx = (child.width * px).toInt()
            val cy = (child.height * py).toInt()
            val radius = hypot(max(cx, child.width - cx).toFloat(), max(cy, child.height - cy).toFloat())
            val reveal = ViewAnimationUtils.createCircularReveal(child, cx, cy, 0f, radius)
            reveal.duration = c.duration
            reveal.startDelay = delay
            reveal.interpolator = interpolator
            reveals[child] = reveal
            reveal.start()
            RowFx.reveal[child] = RowFx.Reveal(cx.toFloat(), cy.toFloat(), radius, SystemClock.uptimeMillis() + delay, c.duration, interpolator)
        }
    }

    /** p: 곡선을 거친 진행도(튕길 수 있음), f: 시간 비율 */
    private fun frame(child: View, m: Moves, p: Float, f: Float, started: Boolean) {
        RowFx.redraw(child)
        val q = 1f - p
        child.alpha = when {
            m.reveal -> if (started) 1f else 0f
            // 투명도는 튕기지 않게 시간 비율로 0~1 사이에서
            else -> (m.alpha + (1f - m.alpha) * min(1f, f * 1.4f)).coerceIn(0f, 1f)
        }
        child.translationX = m.dx * q
        child.translationY = m.dy * q
        val s = m.scale + (1f - m.scale) * p
        child.scaleX = s
        child.scaleY = s
        child.rotation = m.rotation * q
        child.rotationX = m.rotationX * q
        child.rotationY = m.rotationY * q
        if (m.blur > 0f) Blur.set(child, m.blur * (1f - f))
    }

    // ── 레이아웃 전후 (삭제된 줄, 밀리는 줄) ─────────────────────────────

    fun beforeLayout(parent: ViewGroup) {
        layingOut = parent
        attachedInPass = 0
        removedInPass = 0
        attachedNow.clear()
        tops.clear()
        if (!config().shiftOn) return
        for (i in 0 until parent.childCount) {
            val child = parent.getChildAt(i)
            if (child.isLaidOut) tops[child] = child.top
        }
    }

    fun afterLayout(parent: ViewGroup) {
        if (layingOut !== parent) return
        layingOut = null
        val c = config()
        val replaced = matchReplaced(parent)
        val changes = attachedInPass + removedInPass - replaced * 2
        // 메시지 몇 개가 추가·삭제됐을 때만 (채널을 열거나 크게 새로 그릴 땐 그대로)
        val small = changes in 1..4
        if (c.shiftOn && small && tops.isNotEmpty()) {
            for (i in 0 until parent.childCount) {
                val child = parent.getChildAt(i)
                val old = tops[child] ?: continue
                val delta = old - child.top
                if (delta == 0 || abs(delta) > parent.height) continue
                if (running.containsKey(child) || pending.containsKey(child)) continue
                startShift(child, delta.toFloat(), c)
            }
        }
        tops.clear()
        if (snapshots.isNotEmpty()) {
            val show = c.exitOn && small && removedInPass in 1..3
            for ((snap, g) in snapshots) {
                if (show && !g.used) {
                    try {
                        g.cancelExit = startExit(parent, snap, c)
                    } catch (e: Throwable) {
                        snap.discard()
                    }
                } else snap.discard()
            }
            snapshots.clear()
        }
    }

    /**
     * 이번에 붙은 줄 중 방금 지워진 줄과 같은 자리(위나 아래 끝이 거의 같음)에 붙은 것은 바뀐 메시지로 보고
     * 나타나는 효과를 바로 멈춘다 (그리기 전이라 숨겨진 모습이 보이지 않는다). 짝이 된 지워진 줄의 사라지는 효과도 멈춘다
     */
    private fun matchReplaced(parent: ViewGroup): Int {
        val now = SystemClock.uptimeMillis()
        gone.removeAll { now - it.at > REPLACE_WINDOW || it.used }
        var n = 0
        if (gone.isNotEmpty()) {
            val tol = (8 * parent.resources.displayMetrics.density).toInt()
            for (ref in attachedNow) {
                val child = ref.get() ?: continue
                if (child.parent !== parent) continue
                val slack = max(tol, child.height / 4)
                val g = gone.firstOrNull { !it.used && (abs(it.top - child.top) <= slack || abs(it.bottom - child.bottom) <= slack) } ?: continue
                g.used = true
                g.cancelExit?.invoke()
                g.cancelExit = null
                reset(child)
                n++
            }
        }
        attachedNow.clear()
        return n
    }

    private fun startShift(child: View, delta: Float, c: Config) {
        val from = child.translationY + delta
        shifting.remove(child)?.cancel()
        child.translationY = from
        val animator = ValueAnimator.ofFloat(0f, 1f)
        animator.duration = c.shiftDuration
        animator.interpolator = SMOOTH
        animator.addUpdateListener { a ->
            child.translationY = from * (1f - (a.animatedValue as Float))
            RowFx.redraw(child)
        }
        animator.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
                if (shifting[child] === animation) {
                    shifting.remove(child)
                    if (!running.containsKey(child)) child.translationY = 0f
                }
            }
        })
        shifting[child] = animator
        animator.start()
    }

    /** 돌려주는 값: 효과를 바로 멈추고 치우는 함수 */
    private fun startExit(parent: ViewGroup, snap: Snapshot, c: Config): (() -> Unit)? {
        val hidden = hiddenFor(c.exitEffect)
        if (hidden == null) {
            snap.discard()
            return null
        }
        val density = parent.resources.displayMetrics.density
        val fromBelow = snap.top + snap.height / 2 >= parent.height / 2
        val m = resolve(hidden, c.direction, fromBelow, density, snap.width)
        val node = snap.node
        val (px, py) = pivotOf(c.position) ?: (0.5f to 0.5f)
        node.setPivotX(snap.width * px)
        node.setPivotY(snap.height * py)
        // 원형은 사라질 때 작아지며 흐려지는 것으로
        val endScale = if (m.reveal) 0.6f else m.scale
        val endAlpha = if (m.reveal) 0f else m.alpha

        val ghost = GhostDrawable(node)
        ghost.setBounds(0, 0, max(1, parent.width), max(1, parent.height))
        val overlay = parent.overlay
        overlay.add(ghost)

        val animator = ValueAnimator.ofFloat(0f, 1f)
        animator.duration = c.duration
        animator.interpolator = interpolatorFor(c.easing)
        animator.addUpdateListener { a ->
            val k = a.animatedValue as Float
            val f = a.animatedFraction
            node.setAlpha((snap.alpha + (endAlpha - snap.alpha) * min(1f, f * 1.25f)).coerceIn(0f, 1f))
            node.setTranslationX(snap.translationX + m.dx * k)
            node.setTranslationY(snap.translationY + m.dy * k)
            val s = snap.scale + (endScale - snap.scale) * k
            node.setScaleX(s)
            node.setScaleY(s)
            node.setRotationZ(m.rotation * k)
            node.setRotationX(m.rotationX * k)
            node.setRotationY(m.rotationY * k)
            if (m.blur > 0f) Blur.node(node, m.blur * f)
            ghost.invalidateSelf()
            parent.invalidate()
        }
        animator.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
                overlay.remove(ghost)
                snap.discard()
            }
        })
        animator.start()
        return { animator.cancel() }
    }

    fun onDetached(parent: ViewGroup, child: View) {
        if (layingOut === parent && holderOf(parent, child)) {
            removedInPass++
            val g = Gone(child.top, child.bottom, SystemClock.uptimeMillis())
            if (gone.size < 8) gone.add(g)
            val c = config()
            if (c.exitOn && snapshots.size < 4 && child.width > 0 && child.bottom > 0 && child.top < parent.height) {
                try {
                    Snapshot.of(child)?.let { snapshots.add(it to g) }
                } catch (e: Throwable) {
                    // 그리기에 실패하면 이 줄은 효과 없이
                }
            }
        }
        reset(child)
    }

    /** 다시 쓰이는 줄이 숨은 채로 남지 않게 원래 모습으로 */
    fun reset(child: View) {
        pending.remove(child)?.let { child.removeCallbacks(it) }
        running.remove(child)?.cancel()
        reveals.remove(child)?.cancel()
        shifting.remove(child)?.cancel()
        clear(child)
    }

    private fun clear(child: View) {
        child.alpha = 1f
        child.translationX = 0f
        child.translationY = 0f
        child.scaleX = 1f
        child.scaleY = 1f
        child.rotation = 0f
        child.rotationX = 0f
        child.rotationY = 0f
        Blur.clear(child)
        RowFx.reveal.remove(child)
        Cask.clear(child)
        if (Build.VERSION.SDK_INT >= 28 && child.isPivotSet) child.resetPivot()
    }
}

// ── 플러그인 ──────────────────────────────────────────────────────

@Suppress("UNUSED")
val betterAnimationsPlugin = plugin {
    var unhooks = emptyList<XC_MethodHook.Unhook>()
    var bounceRef: Bounce? = null
    var highlightsRef: Highlights? = null

    start {
        // 무엇이 되고 안 되는지 JS 의 Status 에 보여 주려고 가장 먼저 단다 (아래가 실패해도 ping 은 된다)
        val problems = java.util.Collections.synchronizedList(ArrayList<String>())
        var chatReady = false
        var screens: ScreenTransitions? = null
        var screenHook: List<XC_MethodHook.Unhook>? = null
        registerNativeMethod("${manifest.id}.ping") {
            mapOf(
                "pong" to true,
                "version" to manifest.version.toString(),
                "screens" to (screenHook != null),
                "played" to (screens?.played ?: 0),
                "chat" to chatReady,
                "problems" to problems.joinToString("\n"),
            )
        }

        // 설정은 JS 쪽 스레드에서 다시 읽고, 메인 스레드에서 쓴다
        val config = AtomicReference(loadConfig(storageDir))

        // 하나를 못 찾아도 나머지는 돈다 (디스코드 버전마다 안쪽 이름이 바뀔 수 있다)
        val recycler = try {
            Recycler(classLoader)
        } catch (e: Throwable) {
            log.e("RecyclerView not found; list animations disabled", e)
            problems.add("RecyclerView: $e")
            null
        }
        MediaSiblings.recycler = recycler
        val chatListView = findChatListClass(classLoader)
        if (recycler != null) log.i("RecyclerView: ${recycler.describe()} chat=${chatListView?.name}")
        if (chatListView == null) {
            log.w("Chat list not found; message animations disabled")
            problems.add("Chat list not found")
        }
        if (recycler != null && !recycler.canTellRemoved) {
            log.w("ViewHolder position not found; exit animations disabled")
            problems.add("ViewHolder position not found")
        }
        val removedHolder = { parent: ViewGroup, child: View -> recycler?.isRemoved(parent, child) == true }
        val rows = Rows({ config.get() }, removedHolder)

        fun chat(list: Any?): ViewGroup? =
            if (chatListView != null && chatListView.isInstance(list)) list as? ViewGroup else null

        // 채팅 말고 다른 네이티브 목록 (Cask 효과)
        val listsConfig = AtomicReference(loadListsConfig(storageDir))
        val lists = ListRows { listsConfig.get() }
        fun otherList(list: Any?): ViewGroup? {
            val v = list as? ViewGroup ?: return null
            if (chat(v) != null || v.javaClass.name.contains("MessageAccessories")) return null
            return v
        }

        val hooks = ArrayList<XC_MethodHook.Unhook>()
        fun tryHook(what: String, f: () -> XC_MethodHook.Unhook) {
            try {
                hooks.add(f())
            } catch (e: Throwable) {
                log.e("Failed to hook $what", e)
                problems.add("$what: $e")
            }
        }

        val highlights = recycler?.let { r -> Highlights(r.rv) { msg, e -> if (e != null) log.e(msg, e) else log.i(msg) } }
        highlightsRef = highlights
        val highlightScans = WeakHashMap<ViewGroup, Int>()
        if (recycler != null) {
            val rvClass = recycler.rv
            // 줄이 붙고 떨어지는 건 ViewGroup 의 OnHierarchyChangeListener 로 듣는다.
            // (RecyclerView 의 dispatchChildAttached/Detached 는 버전마다 이름이 줄여지거나 다른 곳에 녹아 들어가지만,
            //  줄을 붙이고 떼는 건 늘 ViewGroup.addView/removeViewAt 라 이 리스너는 그대로 불린다)
            val installed = Collections.newSetFromMap(WeakHashMap<ViewGroup, Boolean>())
            fun install(list: ViewGroup) {
                if (!installed.add(list)) return
                val prev = try {
                    XposedHelpers.getObjectField(list, "mOnHierarchyChangeListener") as? ViewGroup.OnHierarchyChangeListener
                } catch (e: Throwable) {
                    null
                }
                list.setOnHierarchyChangeListener(object : ViewGroup.OnHierarchyChangeListener {
                    override fun onChildViewAdded(parent: View, child: View) {
                        prev?.onChildViewAdded(parent, child)
                        val p = chat(list)
                        if (p == null) {
                            if (listsConfig.get() == null) return
                            val other = otherList(list) ?: return
                            try {
                                lists.onAttached(other, child, recycler.scrollState(other) != 0)
                            } catch (e: Throwable) {
                                log.e("Failed to animate list row", e)
                            }
                            return
                        }
                        try {
                            rows.onAttached(p, child)
                        } catch (e: Throwable) {
                            log.e("Failed to animate row", e)
                        }
                    }

                    override fun onChildViewRemoved(parent: View, child: View) {
                        prev?.onChildViewRemoved(parent, child)
                        val p = chat(list)
                        if (p == null) {
                            if (otherList(list) != null) lists.reset(child)
                            return
                        }
                        try {
                            rows.onDetached(p, child)
                        } catch (e: Throwable) {
                            log.e("Failed to handle removed row", e)
                        }
                    }
                })
            }
            // 처음 재거나 배치할 때(줄을 붙이기 전) 리스너를 단다. 레이아웃 전후 기록도 여기서
            tryHook("onMeasure") {
                XposedHelpers.findAndHookMethod(
                    rvClass,
                    "onMeasure",
                    Integer.TYPE,
                    Integer.TYPE,
                    object : XC_MethodHook() {
                        override fun beforeHookedMethod(param: MethodHookParam) {
                            val list = param.thisObject as? ViewGroup ?: return
                            try {
                                install(list)
                            } catch (e: Throwable) {
                                log.e("Failed to watch list", e)
                            }
                        }
                    },
                )
            }
            tryHook("onLayout") {
                XposedHelpers.findAndHookMethod(
                    rvClass,
                    "onLayout",
                    java.lang.Boolean.TYPE,
                    Integer.TYPE,
                    Integer.TYPE,
                    Integer.TYPE,
                    Integer.TYPE,
                    object : XC_MethodHook() {
                        override fun beforeHookedMethod(param: MethodHookParam) {
                            val list = param.thisObject as? ViewGroup ?: return
                            try {
                                install(list)
                            } catch (e: Throwable) {
                                log.e("Failed to watch list", e)
                            }
                            val parent = chat(list) ?: return
                            bounceRef?.register(parent)
                            // 멘션 배경 같은 목록 장식이 메시지 효과를 따라가게 (장식은 처음 몇 번의 배치 안에 붙는다)
                            val n = highlightScans[parent] ?: 0
                            if (n < 3) {
                                highlightScans[parent] = n + 1
                                try {
                                    highlights?.scan(parent)
                                } catch (e: Throwable) {
                                    log.e("Failed to find chat decorations", e)
                                }
                            }
                            try {
                                rows.beforeLayout(parent)
                            } catch (e: Throwable) {
                                log.e("Failed before layout", e)
                            }
                        }

                        override fun afterHookedMethod(param: MethodHookParam) {
                            val parent = chat(param.thisObject) ?: return
                            try {
                                rows.afterLayout(parent)
                            } catch (e: Throwable) {
                                log.e("Failed after layout", e)
                            }
                        }
                    },
                )
            }
        }
        // 목록 끝에서 iOS 처럼 튕기기 (채팅, 설정에 따라 모든 목록)
        val bounceOn = { list: View -> config.get().let { it.enabled && it.bounce && (it.bounceAll || chat(list) != null) } }
        val bounce = Bounce(recycler, bounceOn)
        bounceRef = bounce
        if (bounce.supported) {
            fun touchHook(frame: Boolean) = object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val list = param.thisObject as? ViewGroup ?: return
                    if (frame) bounce.enter(list)
                    val ev = param.args[0] as? android.view.MotionEvent ?: return
                    try {
                        if (!bounceOn(list)) return
                        bounce.register(list)
                        val shift = bounce.before(list, ev)
                        if (shift != 0f) {
                            param.setObjectExtra("baShift", shift)
                            param.setObjectExtra("baHorizontal", bounce.horizontal(list))
                        }
                    } catch (e: Throwable) {
                        log.e("Bounce touch failed", e)
                    }
                }

                override fun afterHookedMethod(param: MethodHookParam) {
                    if (frame) (param.thisObject as? View)?.let { bounce.exit(it) }
                    val shift = param.getObjectExtra("baShift") as? Float ?: return
                    val ev = param.args[0] as? android.view.MotionEvent ?: return
                    bounce.restore(ev, shift, param.getObjectExtra("baHorizontal") == true)
                }
            }
            /** ScrollView 가 EdgeEffect 를 쓰는 동안만 "지금 이 목록" 표시 */
            val frameHook = object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    (param.thisObject as? View)?.let { bounce.enter(it) }
                }

                override fun afterHookedMethod(param: MethodHookParam) {
                    (param.thisObject as? View)?.let { bounce.exit(it) }
                }
            }
            val motion = android.view.MotionEvent::class.java
            if (recycler != null) {
                val rvClass = recycler.rv
                val touch = touchHook(false)
                tryHook("onInterceptTouchEvent") { XposedHelpers.findAndHookMethod(rvClass, "onInterceptTouchEvent", motion, touch) }
                tryHook("onTouchEvent") { XposedHelpers.findAndHookMethod(rvClass, "onTouchEvent", motion, touch) }
            }
            // React Native 의 스크롤 목록 (ReactScrollView·ReactHorizontalScrollView 가 이걸 물려받는다)
            for (cls in listOf(android.widget.ScrollView::class.java, android.widget.HorizontalScrollView::class.java)) {
                val n = cls.simpleName
                val touch = touchHook(true)
                tryHook("$n.onInterceptTouchEvent") { XposedHelpers.findAndHookMethod(cls, "onInterceptTouchEvent", motion, touch) }
                tryHook("$n.onTouchEvent") { XposedHelpers.findAndHookMethod(cls, "onTouchEvent", motion, touch) }
                tryHook("$n.computeScroll") { XposedHelpers.findAndHookMethod(cls, "computeScroll", frameHook) }
                tryHook("$n.draw") { XposedHelpers.findAndHookMethod(cls, "draw", android.graphics.Canvas::class.java, frameHook) }
            }
            // 튕기는 목록의 늘어나는·빛나는 효과는 끄고, 끝에 부딪힌 속도로 튕긴다
            val edge = android.widget.EdgeEffect::class.java
            fun owner(param: XC_MethodHook.MethodHookParam): View? {
                if (!config.get().let { it.enabled && it.bounce }) return null
                return bounce.ownerOf(param.thisObject as? android.widget.EdgeEffect ?: return null)
            }
            fun skip(name: String, vararg types: Class<*>, result: (XC_MethodHook.MethodHookParam, View) -> Any?) {
                tryHook("EdgeEffect.$name") {
                    XposedHelpers.findAndHookMethod(edge, name, *types, object : XC_MethodHook() {
                        override fun beforeHookedMethod(param: MethodHookParam) {
                            val list = try {
                                owner(param)
                            } catch (e: Throwable) {
                                null
                            } ?: return
                            param.result = result(param, list)
                        }
                    })
                }
            }
            skip("onAbsorb", Integer.TYPE) { p, list ->
                try {
                    bounce.absorb(list, p.args[0] as Int)
                } catch (e: Throwable) {
                    log.e("Bounce absorb failed", e)
                }
                null
            }
            skip("onPull", java.lang.Float.TYPE) { _, _ -> null }
            skip("onPull", java.lang.Float.TYPE, java.lang.Float.TYPE) { _, _ -> null }
            skip("onRelease") { _, _ -> null }
            skip("draw", android.graphics.Canvas::class.java) { _, _ -> false }
            skip("isFinished") { _, _ -> true }
            if (Build.VERSION.SDK_INT >= 31) {
                skip("onPullDistance", java.lang.Float.TYPE, java.lang.Float.TYPE) { _, _ -> 0f }
                skip("getDistance") { _, _ -> 0f }
            }
        }
        unhooks = hooks.toList()
        chatReady = chatListView != null && hooks.size >= 2

        // 큰 화면 전환
        val stack = AtomicReference(loadStackConfig(storageDir))
        val transitions = ScreenTransitions { stack.get() }
        screens = transitions
        screenHook = try {
            transitions.hook()
        } catch (e: Throwable) {
            log.e("Failed to hook screen transitions", e)
            problems.add("Screens: $e")
            null
        }
        screenHook?.let { unhooks = unhooks + it } ?: log.w("Screen transitions stay in JS")

        // JS 설정 화면이 저장한 뒤 부른다
        registerNativeMethod("${manifest.id}.reload") {
            config.set(loadConfig(storageDir))
            stack.set(loadStackConfig(storageDir))
            listsConfig.set(loadListsConfig(storageDir))
            true
        }
        // 서버 바꾸기: 옛 목록을 찍어 덮고 나가는 효과로 치운다 (덮은 뒤에 돌아감)
        registerNativeAsyncMethod("${manifest.id}.guildOut") { args ->
            val opts = try {
                JSONObject(args.getOrNull(0) as? String ?: "{}")
            } catch (e: Throwable) {
                JSONObject()
            }
            val activity = withTimeoutOrNull(100L) {
                suspendCancellableCoroutine<android.app.Activity> { cont -> withAppActivity { if (cont.isActive) cont.resume(it) } }
            } ?: return@registerNativeAsyncMethod "noactivity"
            withContext(Dispatchers.Main) {
                try {
                    GuildOut.play(activity, opts)
                } catch (e: Throwable) {
                    log.e("Failed to play server switch", e)
                    "error"
                }
            }
        }
        // 사진·동영상: 같은 메시지의 다른 사진 썸네일 자리
        registerNativeAsyncMethod("${manifest.id}.mediaSiblings") { args ->
            val o = try {
                JSONObject(args.getOrNull(0) as? String ?: "{}")
            } catch (e: Throwable) {
                JSONObject()
            }
            val activity = withTimeoutOrNull(100L) {
                suspendCancellableCoroutine<android.app.Activity> { cont -> withAppActivity { if (cont.isActive) cont.resume(it) } }
            } ?: return@registerNativeAsyncMethod ""
            withContext(Dispatchers.Main) {
                try {
                    MediaSiblings.find(activity, o.optDouble("x"), o.optDouble("y"), o.optDouble("w"), o.optDouble("h"))?.toString() ?: ""
                } catch (e: Throwable) {
                    log.e("Failed to find media thumbnails", e)
                    ""
                }
            }
        }
        // 사진·동영상 닫기: 다른 플러그인이 건 회전·확대를 같이 되돌린다
        registerNativeAsyncMethod("${manifest.id}.mediaUnwind") { args ->
            val opts = try {
                JSONObject(args.getOrNull(0) as? String ?: "{}")
            } catch (e: Throwable) {
                JSONObject()
            }
            val activity = withTimeoutOrNull(100L) {
                suspendCancellableCoroutine<android.app.Activity> { cont -> withAppActivity { if (cont.isActive) cont.resume(it) } }
            } ?: return@registerNativeAsyncMethod 0
            withContext(Dispatchers.Main) {
                try {
                    MediaUnwind.run(activity, opts.optLong("duration", 300L), opts.optString("easing", "out"))
                } catch (e: Throwable) {
                    log.e("Failed to unwind media", e)
                    0
                }
            }
        }
        // JS 쪽에서 네이티브 부분이 실렸는지, 화면 전환을 맡을 수 있는지 확인할 때

        log.i("Ready (chat=${chatListView != null}, hooks=${unhooks.size}, effect=${config.get().effect})")
    }

    stop {
        try {
            bounceRef?.reset()
        } catch (e: Throwable) {
        }
        bounceRef = null
        highlightsRef?.hooks?.forEach { it.unhook() }
        highlightsRef = null
        for (unhook in unhooks) unhook.unhook()
        unhooks = emptyList()
    }
}
