package io.github.yumistra.betteranimations

import android.content.Context
import android.graphics.Camera
import android.view.View
import android.view.animation.Animation
import android.view.animation.AnimationSet
import android.view.animation.AnimationUtils
import android.view.animation.Interpolator
import android.view.animation.Transformation
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedHelpers
import org.json.JSONObject
import java.io.File

/**
 * 큰 화면(react-native-screens 네이티브 스택) 전환을 "화면 전환" 효과로 바꾼다.
 *
 * RNS 는 화면을 열고 닫을 때 Fragment 에 setCustomAnimations(애니메이션 리소스)를 걸고,
 * Fragment 는 그 리소스를 AnimationUtils.loadAnimation 으로 읽는다.
 * JS 쪽이 효과를 줄 화면의 stackAnimation 을 ios_from_right 로 두면, 리소스 이름으로 역할을 알 수 있다:
 *   foreground_open  = 새로 열리는 화면      (숨은 상태 → 원래)
 *   background_open  = 그 아래로 깔리는 화면  (원래 → under)
 *   foreground_close = 닫히는 화면          (원래 → 나갈 때 효과)
 *   background_close = 다시 드러나는 화면    (under → 원래)
 * 그 역할에 맞는 우리 애니메이션을 돌려준다. 뒤로 가기·← 버튼·쓸어서 닫기 모두 같은 길로 지나간다.
 */

private const val MARKER = "rns_ios_from_right_"

/** 효과의 한 상태. JS 의 Hidden(normalize 된 것)과 같은 필드 */
internal class Pose(
    val o: Float = 1f,
    val tx: Float = 0f,
    val ty: Float = 0f,
    val txW: Float = 0f,
    val tyH: Float = 0f,
    val s: Float = 1f,
    val sy: Float = 1f,
    val r: Float = 0f,
    val rx: Float = 0f,
    val ry: Float = 0f,
) {
    companion object {
        val NORMAL = Pose()

        fun of(j: JSONObject?): Pose? {
            if (j == null) return null
            fun f(key: String, def: Double) = j.optDouble(key, def).toFloat()
            return Pose(f("o", 1.0), f("tx", 0.0), f("ty", 0.0), f("txW", 0.0), f("tyH", 0.0), f("s", 1.0), f("sy", 1.0), f("r", 0.0), f("rx", 0.0), f("ry", 0.0))
        }
    }
}

internal class StackConfig(
    val hidden: Pose,
    val exit: Pose,
    val under: Pose?,
    val duration: Long,
    val easing: String,
    val position: String,
)

/** storage.json 의 native.stack (JS 가 효과 정의를 풀어서 넣어 둔다). 꺼져 있으면 null */
internal fun loadStackConfig(dir: File): StackConfig? {
    try {
        val file = File(dir, "storage.json")
        if (!file.isFile) return null
        val root = JSONObject(file.readText())
        if (!root.optBoolean("enabled", true)) return null
        val st = root.optJSONObject("native")?.optJSONObject("stack") ?: return null
        if (!st.optBoolean("enabled", false)) return null
        val hidden = Pose.of(st.optJSONObject("hidden")) ?: return null
        return StackConfig(
            hidden = hidden,
            exit = Pose.of(st.optJSONObject("exit")) ?: hidden,
            under = Pose.of(st.optJSONObject("under")),
            duration = st.optLong("duration", 300L).coerceIn(50L, 3000L),
            easing = st.optString("easing", "out"),
            position = st.optString("position", "auto"),
        )
    } catch (e: Throwable) {
        return null
    }
}

/** from → to 로 움직이는 애니메이션 (투명도·이동·크기·회전·뒤집기) */
internal class PoseAnimation(private val from: Pose, private val to: Pose, private val pivot: Pair<Float, Float>) : Animation() {
    private var w = 0f
    private var h = 0f
    private val camera = Camera()

    override fun initialize(width: Int, height: Int, parentWidth: Int, parentHeight: Int) {
        super.initialize(width, height, parentWidth, parentHeight)
        w = width.toFloat()
        h = height.toFloat()
    }

    override fun willChangeBounds() = true

    override fun applyTransformation(t: Float, tr: Transformation) {
        tr.alpha = poseMatrix(from, to, t, w, h, pivot, camera, tr.matrix)
    }
}

/** from → to 의 t 지점 모습을 행렬에 넣고 투명도를 돌려준다 (크기 w×h, 기준점은 비율) */
internal fun poseMatrix(from: Pose, to: Pose, t: Float, w: Float, h: Float, pivot: Pair<Float, Float>, camera: Camera, m: android.graphics.Matrix): Float {
    fun l(a: Float, b: Float) = a + (b - a) * t
    val tx = l(from.tx + from.txW * w, to.tx + to.txW * w)
    val ty = l(from.ty + from.tyH * h, to.ty + to.tyH * h)
    val s = l(from.s, to.s)
    val sy = l(from.s * from.sy, to.s * to.sy)
    val r = l(from.r, to.r)
    val rx = l(from.rx, to.rx)
    val ry = l(from.ry, to.ry)
    val px = w * pivot.first
    val py = h * pivot.second
    m.reset()
    if (rx != 0f || ry != 0f) {
        camera.save()
        camera.rotateX(-rx)
        camera.rotateY(ry)
        camera.getMatrix(m)
        camera.restore()
        m.preTranslate(-px, -py)
        m.postTranslate(px, py)
    }
    if (r != 0f) m.postRotate(r, px, py)
    m.postScale(s, sy, px, py)
    m.postTranslate(tx, ty)
    return l(from.o, to.o).coerceIn(0f, 1f)
}

internal class ScreenTransitions(private val config: () -> StackConfig?) {
    var played = 0
        private set

    /**
     * Fragment 는 화면을 열고 닫을 때 setCustomAnimations 로 받은 애니메이션 리소스를 AnimationUtils.loadAnimation 으로 읽는다
     * (RNS 의 onCreateAnimation/onCreateAnimator 가 null 일 때. 시트가 아닌 화면은 늘 그렇다).
     * 디스코드 안쪽 이름(ScreenStackFragment, Fragment.onCreateAnimation …)은 버전마다 줄여지지만
     * 안드로이드 기본 메서드와 리소스 이름(rns_ios_from_right_*)은 그대로라 그쪽을 잡는다.
     */
    private fun hookAnimation(): XC_MethodHook.Unhook = XposedHelpers.findAndHookMethod(
        AnimationUtils::class.java,
        "loadAnimation",
        Context::class.java,
        Integer.TYPE,
        object : XC_MethodHook() {
            override fun afterHookedMethod(param: MethodHookParam) {
                try {
                    val ctx = param.args[0] as? Context ?: return
                    animationFor(ctx, param.args[1] as Int)?.let {
                        param.result = it
                        played++
                    }
                } catch (e: Throwable) {
                    // 실패하면 RNS 기본 애니메이션 그대로
                }
            }
        },
    )

    /** 움직이는 동안만 화면을 GPU 레이어로 그려서 버벅이지 않게 */
    private fun hookLayer(): XC_MethodHook.Unhook? = try {
        XposedHelpers.findAndHookMethod(
            View::class.java,
            "startAnimation",
            Animation::class.java,
            object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    val anim = param.args[0] as? Animation ?: return
                    if (!isOurs(anim)) return
                    val view = param.thisObject as? View ?: return
                    try {
                        if (view.layerType != View.LAYER_TYPE_HARDWARE) {
                            view.setLayerType(View.LAYER_TYPE_HARDWARE, null)
                            view.postDelayed({ view.setLayerType(View.LAYER_TYPE_NONE, null) }, anim.duration + anim.startOffset + 80L)
                        }
                    } catch (e: Throwable) {
                    }
                }
            },
        )
    } catch (e: Throwable) {
        null
    }

    /** 우리 애니메이션 (Fragment 가 AnimationSet 으로 한 번 감싸기도 한다) */
    private fun isOurs(anim: Animation): Boolean =
        anim is PoseAnimation || (anim is AnimationSet && anim.animations.any { it is PoseAnimation })

    fun hook(): List<XC_MethodHook.Unhook> = listOfNotNull(hookAnimation(), hookLayer())

    private fun animationFor(ctx: Context, id: Int): Animation? {
        if (id == 0) return null
        val c = config() ?: return null
        val name = try {
            ctx.resources.getResourceEntryName(id)
        } catch (e: Throwable) {
            return null
        }
        if (!name.startsWith(MARKER)) return null
        val (from, to) = when (name.removePrefix(MARKER)) {
            "foreground_open" -> c.hidden to Pose.NORMAL
            "background_open" -> Pose.NORMAL to (c.under ?: Pose.NORMAL)
            "foreground_close" -> Pose.NORMAL to c.exit
            "background_close" -> (c.under ?: Pose.NORMAL) to Pose.NORMAL
            else -> return null
        }
        val curve = interpolatorFor(c.easing)
        val anim = PoseAnimation(from, to, pivotOf(c.position) ?: (0.5f to 0.5f))
        anim.duration = c.duration
        anim.interpolator = Interpolator { t -> curve.getInterpolation(t) }
        return anim
    }
}
