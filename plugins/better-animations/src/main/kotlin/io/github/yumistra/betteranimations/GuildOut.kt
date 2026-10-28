package io.github.yumistra.betteranimations

import android.animation.ValueAnimator
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Camera
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import kotlin.coroutines.resume

/**
 * 서버 바꾸기: 옛 채널 목록이 나가는 효과.
 *
 * JS 가 서버를 바꾸는 액션을 보내기 직전에 부른다. 지금 화면에 보이는 목록(JS 가 nativeID 를 붙인 Animated.View)을
 * 그대로 그려 찍고(안 되면 PixelCopy), 그 그림을 부모 뷰의 오버레이에 덮는다.
 * JS 가 새 목록을 그리는 건 그보다 늦으므로 새 목록은 그림 밑에서 나타나고, 그림은 나가는 효과로 움직이며 사라진다.
 */
internal object GuildOut {
    private val main = Handler(Looper.getMainLooper())

    /** RN 이 nativeID 를 넣어 두는 태그 키 */
    private var tagKey = 0

    private fun find(v: View, ids: List<String>): View? {
        var best: View? = null
        var bestRank = Int.MAX_VALUE
        fun walk(x: View) {
            val tag = x.getTag(tagKey)
            if (tag is String) {
                val rank = ids.indexOf(tag)
                if (rank >= 0 && rank < bestRank && x.isShown && x.width > 0 && x.height > 0 && x.getGlobalVisibleRect(Rect())) {
                    best = x
                    bestRank = rank
                }
            }
            if (x is ViewGroup) for (i in 0 until x.childCount) walk(x.getChildAt(i))
        }
        walk(v)
        return best
    }

    /** 메인 스레드에서 부른다 */
    suspend fun play(activity: Activity, o: JSONObject): String {
        if (tagKey == 0) tagKey = activity.resources.getIdentifier("view_tag_native_id", "id", activity.packageName)
        if (tagKey == 0) return "notag"
        val arr = o.optJSONArray("ids") ?: return "noview"
        val ids = (0 until arr.length()).map { arr.optString(it) }
        val window = activity.window ?: return "noview"
        val view = find(window.decorView, ids) ?: return "noview"
        val parent = view.parent as? ViewGroup ?: return "noview"

        val loc = IntArray(2)
        view.getLocationInWindow(loc)
        val decor = window.decorView
        val src = Rect(loc[0], loc[1], loc[0] + view.width, loc[1] + view.height)
        if (!src.intersect(0, 0, decor.width, decor.height) || src.width() <= 0 || src.height() <= 0) return "noview"
        val bitmap = try {
            Bitmap.createBitmap(src.width(), src.height(), Bitmap.Config.ARGB_8888)
        } catch (e: Throwable) {
            return "nomem"
        }
        // 먼저 그 자리에서 바로 그려 본다 (새 목록이 그려지기 전에 확실히 옛 모습).
        // 하드웨어 비트맵 이미지가 있으면 소프트웨어로 못 그리므로 화면을 복사한다 (한두 프레임 늦을 수 있음)
        var ok = try {
            val c = Canvas(bitmap)
            c.translate((loc[0] - src.left).toFloat(), (loc[1] - src.top).toFloat())
            view.draw(c)
            true
        } catch (e: Throwable) {
            bitmap.eraseColor(0)
            false
        }
        if (!ok) {
            if (Build.VERSION.SDK_INT < 26) {
                bitmap.recycle()
                return "old"
            }
            val result = withTimeoutOrNull(250L) {
                suspendCancellableCoroutine<Int> { cont ->
                    try {
                        PixelCopy.request(window, src, bitmap, { r -> if (cont.isActive) cont.resume(r) }, main)
                    } catch (e: Throwable) {
                        if (cont.isActive) cont.resume(-1)
                    }
                }
            }
            val deadline = o.optLong("deadline", 0L)
            if (result != PixelCopy.SUCCESS || (deadline > 0 && System.currentTimeMillis() > deadline) || !view.isAttachedToWindow) {
                bitmap.recycle()
                return if (result == PixelCopy.SUCCESS) "late" else "copy$result"
            }
            ok = true
        }

        // 부모 좌표에서 뷰 자리 (화면 밖으로 잘린 만큼 옮김)
        val left = view.left + (src.left - loc[0])
        val top = view.top + (src.top - loc[1])
        val density = activity.resources.displayMetrics.density
        val p = o.optJSONObject("pose")
        val pose = Pose.of(p)?.let {
            Pose(it.o, it.tx * density, it.ty * density, it.txW, it.tyH, it.s, it.sy, it.r, it.rx, it.ry)
        } ?: Pose(o = 0f)
        val pivot = pivotOf(o.optString("position", "auto")) ?: (0.5f to 0.5f)
        val shot = Shot(bitmap, pose, pivot)
        shot.setBounds(left, top, left + src.width(), top + src.height())
        parent.overlay.add(shot)

        val anim = ValueAnimator.ofFloat(0f, 1f)
        anim.duration = o.optLong("duration", 260L).coerceIn(60L, 3000L)
        anim.interpolator = interpolatorFor(o.optString("easing", "out"))
        var cleaned = false
        val cleanup = {
            if (!cleaned) {
                cleaned = true
                try {
                    parent.overlay.remove(shot)
                } catch (e: Throwable) {
                }
                bitmap.recycle()
            }
        }
        anim.addUpdateListener {
            shot.t = it.animatedValue as Float
            shot.invalidateSelf()
            if (it.animatedFraction >= 1f) cleanup()
        }
        anim.start()
        // 다 끝나기 전에 그 자리(부모)가 사라지면 같이 치운다 (옛 목록만 빠지는 건 괜찮음)
        parent.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) {}
            override fun onViewDetachedFromWindow(v: View) {
                v.removeOnAttachStateChangeListener(this)
                anim.cancel()
                cleanup()
            }
        })
        return "ok"
    }

    /** 찍은 그림: 자기 자리 안에서만 나가는 효과로 움직인다 */
    private class Shot(val bitmap: Bitmap, val pose: Pose, val pivot: Pair<Float, Float>) : Drawable() {
        var t = 0f
        private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
        private val matrix = Matrix()
        private val camera = Camera()

        override fun draw(canvas: Canvas) {
            if (bitmap.isRecycled) return
            val b = bounds
            val alpha = poseMatrix(Pose.NORMAL, pose, t, b.width().toFloat(), b.height().toFloat(), pivot, camera, matrix)
            if (alpha <= 0f) return
            paint.alpha = (alpha * 255).toInt().coerceIn(0, 255)
            val save = canvas.save()
            canvas.clipRect(b)
            canvas.translate(b.left.toFloat(), b.top.toFloat())
            canvas.concat(matrix)
            canvas.drawBitmap(bitmap, 0f, 0f, paint)
            canvas.restoreToCount(save)
        }

        override fun setAlpha(alpha: Int) {}
        override fun setColorFilter(colorFilter: ColorFilter?) {}
        @Deprecated("Deprecated in Java")
        override fun getOpacity() = PixelFormat.TRANSLUCENT
    }
}
