package io.github.yumistra.betteranimations

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import kotlin.math.abs

/**
 * 사진·동영상 보기를 닫을 때, 다른 플러그인이 사진에 걸어 둔 회전·확대(예: ImageUtils 의 두 손가락 회전)를
 * 닫는 효과와 같은 시간·곡선으로 원래대로 되돌린다. 그래야 썸네일 자리로 돌아갈 때 각도가 맞는다.
 * 회전이 걸린 큰 뷰만 고른다 (디스코드 곳곳의 작은 화살표 아이콘 등은 건드리지 않음).
 */
internal object MediaUnwind {
    private fun norm(deg: Float): Float {
        var r = deg % 360f
        if (r > 180f) r -= 360f
        if (r < -180f) r += 360f
        return r
    }

    fun run(activity: Activity, duration: Long, easing: String): Int {
        val decor = activity.window?.decorView ?: return 0
        val minSize = (decor.width * 0.25f).toInt()
        val found = ArrayList<View>()
        fun walk(v: View) {
            if (v.visibility != View.VISIBLE) return
            if (abs(norm(v.rotation)) > 0.5f && v.width >= minSize && v.height >= minSize && v.isShown) found.add(v)
            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(decor)
        val curve = interpolatorFor(easing)
        for (v in found) {
            v.rotation = norm(v.rotation)
            v.animate().cancel()
            v.animate()
                .rotation(0f)
                .scaleX(1f)
                .scaleY(1f)
                .translationX(0f)
                .translationY(0f)
                .setDuration(duration.coerceIn(60L, 3000L))
                .setInterpolator { t -> curve.getInterpolation(t) }
                .start()
        }
        return found.size
    }
}
