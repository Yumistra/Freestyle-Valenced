package io.github.yumistra.betteranimations

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.TimeInterpolator
import android.animation.ValueAnimator
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.view.View
import android.view.ViewGroup
import android.view.animation.AccelerateDecelerateInterpolator
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import java.io.File
import java.util.WeakHashMap
import kotlin.math.cos
import kotlin.math.exp
import kotlin.random.Random

/**
 * Cask 3 (iOS 목록 스크롤 애니메이션) 효과를 안드로이드 뷰로 옮긴 것.
 * 원본: https://github.com/ryannair05/Cask-3 의 Cask.swift
 * 효과 이름은 설정에서 "cask.<이름>" 으로 온다.
 */
internal object Cask {
    val STYLES = setOf(
        "fade", "flip", "bounce", "color", "permanentColor", "glitch", "helix", "rotate",
        "zoom", "drop", "stretch", "slide", "shake", "swing", "jiggle",
    )

    fun styleOf(effect: String): String? =
        if (effect.startsWith("cask.")) effect.removePrefix("cask.").takeIf { it in STYLES } else null

    private val savedForeground = WeakHashMap<View, Drawable?>()

    /** UIView 스프링(감쇠비 0.5 / 0) 흉내. t=1 에서 1 로 끝난다 */
    private fun spring(decay: Double, freq: Double) = TimeInterpolator { t ->
        if (t >= 1f) 1f else (1.0 - exp(-decay * t) * cos(freq * t)).toFloat()
    }

    private fun keyframes(values: FloatArray, times: FloatArray, p: Float): Float {
        if (p <= times[0]) return values[0]
        for (i in 1 until times.size) {
            if (p <= times[i]) {
                val k = (p - times[i - 1]) / (times[i] - times[i - 1])
                return values[i - 1] + (values[i] - values[i - 1]) * k
            }
        }
        return values.last()
    }

    private fun even(n: Int) = FloatArray(n) { it / (n - 1).toFloat() }

    /**
     * 효과를 시작한다. 처음 모습은 바로 적용해서(그리기 전에) 깜빡이지 않게 한다.
     * 돌려준 Animator 는 끝나면 [onEnd] 를 부른다 (영구 컬러는 끝나지 않는다).
     */
    fun start(view: View, style: String, duration: Long, delay: Long, onEnd: () -> Unit): Animator {
        val d = view.resources.displayMetrics.density
        val a = ValueAnimator.ofFloat(0f, 1f)
        a.duration = duration
        a.startDelay = delay
        a.interpolator = DecelerateInterpolator()
        val update: (Float) -> Unit
        when (style) {
            "fade" -> {
                view.alpha = 0f
                update = { p -> view.alpha = p.coerceIn(0f, 1f) }
            }
            "flip" -> {
                view.rotationX = 180f
                update = { p -> view.rotationX = 180f * (1f - p) }
            }
            "bounce" -> {
                view.scaleX = 0.01f
                a.interpolator = spring(5.0, 14.0)
                update = { p -> view.scaleX = 0.01f + 0.99f * p }
            }
            "stretch" -> {
                view.scaleX = 0.01f
                update = { p -> view.scaleX = 0.01f + 0.99f * p }
            }
            "glitch" -> {
                view.scaleX = 0.3f
                view.scaleY = 0.5f
                a.interpolator = spring(2.0, 30.0)
                update = { p ->
                    view.scaleX = 0.3f + 0.7f * p
                    view.scaleY = 0.5f + 0.5f * p
                }
            }
            "helix" -> {
                view.rotationY = 180f
                update = { p -> view.rotationY = 180f * (1f - p) }
            }
            "rotate" -> {
                // 원본은 360 라디안(= 약 106°)에서 돌아온다
                view.rotation = 106f
                update = { p -> view.rotation = 106f * (1f - p) }
            }
            "zoom" -> {
                view.scaleX = 5f
                view.scaleY = 5f
                a.interpolator = LinearInterpolator()
                update = { p ->
                    val s = 5f - 4f * p
                    view.scaleX = s
                    view.scaleY = s
                }
            }
            "drop" -> {
                view.translationY = -150f * d
                update = { p -> view.translationY = -150f * d * (1f - p) }
            }
            "slide" -> {
                val w = (if (view.width > 0) view.width else view.resources.displayMetrics.widthPixels).toFloat()
                view.translationX = w
                update = { p -> view.translationX = w * (1f - p) }
            }
            "shake" -> {
                val v = floatArrayOf(0f, 10f, -10f, 10f, -5f, 5f, -5f, 0f, 0f)
                val t = floatArrayOf(0f, 0.125f, 0.25f, 0.375f, 0.5f, 0.625f, 0.75f, 0.875f, 1f)
                a.interpolator = LinearInterpolator()
                update = { p -> view.translationX = keyframes(v, t, p) * d }
            }
            "swing" -> {
                val v = floatArrayOf(0f, 40f, -50f, 30f, 0f)
                val t = floatArrayOf(0f, 0.16f, 0.5f, 0.83f, 1f)
                a.interpolator = LinearInterpolator()
                update = { p -> view.translationX = keyframes(v, t, p) * d }
            }
            "jiggle" -> {
                val deg = 0.075f * 57.29578f
                val v = floatArrayOf(0f, -deg, deg, -deg, deg, 0f)
                val t = even(v.size)
                a.interpolator = AccelerateDecelerateInterpolator()
                update = { p -> view.rotation = keyframes(v, t, p) }
            }
            "color", "permanentColor" -> {
                // 줄 배경 대신 그 위에 무작위 색을 덮었다가 걷어 낸다
                val overlay = ColorDrawable(Color.rgb(Random.nextInt(256), Random.nextInt(256), Random.nextInt(256)))
                if (!savedForeground.containsKey(view)) savedForeground[view] = view.foreground
                view.foreground = overlay
                if (style == "permanentColor") {
                    a.interpolator = LinearInterpolator()
                    a.repeatCount = ValueAnimator.INFINITE
                    a.repeatMode = ValueAnimator.REVERSE
                    overlay.alpha = 150
                    update = { p -> overlay.alpha = (150 * (1f - p)).toInt().coerceIn(0, 255) }
                } else {
                    overlay.alpha = 255
                    update = { p -> overlay.alpha = (255 * (1f - p)).toInt().coerceIn(0, 255) }
                }
            }
            else -> update = { _ -> }
        }
        a.addUpdateListener {
            update(it.animatedValue as Float)
            RowFx.redraw(view)
        }
        a.addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) = onEnd()
        })
        a.start()
        return a
    }

    /** 덮어 둔 색을 걷어 낸다 (나머지 모습은 줄 쪽 clear 가 되돌린다) */
    fun clear(view: View) {
        if (savedForeground.containsKey(view)) view.foreground = savedForeground.remove(view)
    }
}

// ── 채팅 말고 다른 네이티브 목록 (DM 목록, 이모지 등) ─────────────────────

internal class ListsConfig(val style: String?, val duration: Long, val always: Boolean)

internal fun loadListsConfig(dir: File): ListsConfig? {
    try {
        val file = File(dir, "storage.json")
        if (!file.isFile) return null
        val root = org.json.JSONObject(file.readText())
        if (!root.optBoolean("enabled", true)) return null
        val m = root.optJSONObject("modules")?.optJSONObject("lists") ?: return null
        val style = Cask.styleOf(m.optString("effect", "default")) ?: return null
        return ListsConfig(style, m.optLong("duration", 500L).coerceIn(50L, 3000L), m.optBoolean("always", false))
    } catch (e: Throwable) {
        return null
    }
}

internal class ListRows(private val config: () -> ListsConfig?) {
    private val running = WeakHashMap<View, Animator>()

    fun onAttached(parent: ViewGroup, child: View, scrolling: Boolean) {
        reset(child)
        val c = config() ?: return
        val style = c.style ?: return
        if (!scrolling && !c.always) return
        running[child] = Cask.start(child, style, c.duration, 0L) {
            if (running.remove(child) != null) clear(child)
        }
    }

    fun reset(child: View) {
        running.remove(child)?.cancel()
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
        Cask.clear(child)
    }
}
