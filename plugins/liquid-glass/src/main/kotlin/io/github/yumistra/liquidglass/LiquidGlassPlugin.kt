@file:JvmName("LiquidGlassPlugin")

package io.github.yumistra.liquidglass

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.Shader
import android.graphics.drawable.Drawable
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeMethod
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import de.robv.android.xposed.XposedHelpers
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.Collections
import java.util.WeakHashMap

/**
 * Liquid Glass 의 네이티브 부분.
 * JS 가 nativeID "ogui-glass:왼위,오위,오아래,왼아래(dp)" 를 단 빈 칸에 유리를 그린다:
 *  1. 화면이 그려지기 직전(preDraw) 그 칸 뒤의 화면을 작게 녹화한다 (RenderNode, 하드웨어 그대로).
 *     유리가 깔린 창(칸의 부모: 창 내용 전체)은 녹화에서 뺀다 → 유리 뒤의 화면만 찍힌다
 *  2. 녹화본에 흐림 + 채도 + 밝기 효과 (RenderEffect, 안드로이드 12+)
 *  3. 칸 모양대로 잘라 그리고, 색 한 겹, 빛 받는 쪽 테두리, 안쪽 빛을 올린다
 * 값은 OpenGlass UI 의 liquid 재질 (packages/renderers/src/css.ts) 그대로다.
 */

private class Optics(val blur: Float, val saturation: Float, val brightness: Float, val alpha: Float)

/** OpenGlass liquid 재질, 어두운 테마 값 */
private val MATERIALS = mapOf(
    "clear" to Optics(3f, 1.9f, 0.46f, 0.22f),
    "regular" to Optics(14f, 1.85f, 0.56f, 0.36f),
    "frosted" to Optics(30f, 1.7f, 0.56f, 0.55f),
)

@Volatile private var glassOn = true
@Volatile private var optics = MATERIALS.getValue("regular")
@Volatile private var lastError: String? = null
@Volatile private var frames = 0L

/** 녹화 중에는 유리를 그리지 않는다 (유리가 자기 녹화본을 그리지 않게) */
@Volatile private var capturing = false
private val glassViews: MutableSet<View> = Collections.newSetFromMap(WeakHashMap())
private val controllers = WeakHashMap<View, Controller>()
/** 유리 창 → 그 창의 유리 칸 (누름 반응) */
private val panes = WeakHashMap<View, View>()
private val pl = IntArray(2)
private val gl = IntArray(2)
private var nativeIdKey = 0

private fun dp(v: View, x: Float) = x * v.resources.displayMetrics.density

/**
 * 유리가 깔린 창 전체 (유리 칸과 그 위 내용): 유리 칸과 크기가 거의 같은 가장 바깥 조상.
 * 녹화에서 이걸 빼야 유리에 창 자신의 글자가 비치지 않는다
 */
private fun paneOf(v: View): View {
    val tol = dp(v, 6f)
    var best: View = v
    var p = v.parent as? View
    var n = 0
    while (p != null && n++ < 12) {
        if (Math.abs(p.width - v.width) > tol || Math.abs(p.height - v.height) > tol) break
        best = p
        p = p.parent as? View
    }
    // 크기가 같은 조상이 없으면 바로 위 부모 (배경 칸과 내용이 형제로 들어 있는 곳)
    return if (best === v) (v.parent as? View ?: v) else best
}

/**
 * root 부터 pane 까지 내려가며 pane 보다 먼저(뒤에) 그려지는 것만 그린다.
 * 각 단계에서 pane 을 품은 자식 앞의 형제들은 통째로 그리고, 그 자식 안으로 들어간다. pane 과 그 뒤(위)는 그리지 않는다.
 * (디스코드의 그림 목록(display list)을 건드리지 않고 새로 그리기만 해서, 실제 화면에는 영향이 없다)
 */
private fun drawBehind(c: Canvas, root: View, pane: View) {
    val chain = ArrayList<View>()
    var v: View? = pane
    while (v != null) {
        chain.add(0, v)
        if (v === root) break
        v = v.parent as? View
    }
    if (chain.firstOrNull() !== root) return
    root.background?.draw(c)
    var i = 0
    while (i < chain.size - 1) {
        val g = chain[i] as? ViewGroup ?: return
        val next = chain[i + 1]
        for (k in 0 until g.childCount) {
            val ch = g.getChildAt(k)
            if (ch === next) break
            if (ch.visibility != View.VISIBLE || ch.alpha <= 0f) continue
            // 창 뒤를 어둡게 덮는 막 (backdrop): 화면을 거의 다 덮는 빈 칸. 이걸 빼야 유리 너머가 밝게 비친다
            if (ch is ViewGroup && ch.childCount == 0 && ch.width >= root.width * 0.9f && ch.height >= root.height * 0.5f) continue
            if (ch !is ViewGroup && ch.background != null && ch.width >= root.width * 0.9f && ch.height >= root.height * 0.5f) continue
            val sc = c.save()
            place(c, g, ch)
            if (ch.alpha < 1f) c.saveLayerAlpha(0f, 0f, ch.width.toFloat(), ch.height.toFloat(), (ch.alpha * 255).toInt())
            ch.draw(c)
            c.restoreToCount(sc)
        }
        if (next === pane) return
        place(c, g, next)
        next.background?.draw(c)
        i++
    }
}

/** 부모 좌표에서 자식 좌표로 */
private fun place(c: Canvas, parent: ViewGroup, ch: View) {
    c.translate((ch.left - parent.scrollX).toFloat(), (ch.top - parent.scrollY).toFloat())
    val m = ch.matrix
    if (!m.isIdentity) c.concat(m)
}

/**
 * 유리 창 안의 넓은 배경 (창 바탕, 카드, 줄) 을 반투명하게 해서 유리가 비치게 한다.
 * 버튼, 아이콘 같은 작은 것은 그대로. 한 번 바꾼 배경은 다시 바꾸지 않는다 (0.5초에 한 번만 훑는다)
 */
private val seen: MutableSet<Drawable> = Collections.newSetFromMap(WeakHashMap())
private val lastScan = WeakHashMap<View, Long>()
@Volatile private var contentAlpha = 0.45f
/** 비침 처리한 배경 수, 창 바탕으로 본 배경의 종류 (테스트 로그용) */
@Volatile private var faded = 0
@Volatile private var surfaceKinds = ""
private fun fade(bg: Drawable, a: Float) {
    val want = (a * 255).toInt()
    try {
        bg.mutate().alpha = want
    } catch (_: Throwable) {
    }
    // RN 배경처럼 alpha 를 무시하는 것은 색 필터로 알파를 곱한다 (결과 = 원래 색 × a)
    val took = try { bg.alpha == want } catch (_: Throwable) { false }
    if (!took) try {
        bg.colorFilter = android.graphics.PorterDuffColorFilter(Color.argb(want, 0, 0, 0), android.graphics.PorterDuff.Mode.DST_IN)
    } catch (_: Throwable) {
    }
    faded++
}

/**
 * 유리 창 안의 배경을 비치게 한다.
 * 창을 거의 다 덮는 바탕 (디스코드 시트의 바탕 판, 여러 겹일 수 있다) 은 아예 투명하게, 그보다 작은 넓은 카드와 줄은 반투명하게.
 * 겹겹이 반투명이면 겹칠수록 다시 진해져서 유리가 안 보인다. 버튼, 아이콘 같은 작은 것은 그대로
 */
private fun seeThrough(pane: View, glass: View) {
    val now = System.currentTimeMillis()
    if (now - (lastScan[pane] ?: 0L) < 500) return
    lastScan[pane] = now
    val minW = pane.width * 0.6f
    fun walk(v: View, depth: Int) {
        if (depth > 40 || v === glass) return
        val bg = v.background
        if (bg != null && v !== pane && v.width >= minW && bg !in seen) {
            seen.add(bg)
            val surface = v.width >= pane.width * 0.9f && v.height >= pane.height * 0.6f
            if (surface && surfaceKinds.length < 200) surfaceKinds += (if (surfaceKinds.isEmpty()) "" else ", ") + bg.javaClass.simpleName
            fade(bg, if (surface) 0f else contentAlpha)
            v.invalidate()
        }
        if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i), depth + 1)
    }
    walk(pane, 0)
}

/** 창(루트 뷰) 하나에 하나: 그리기 직전에 뒤 화면을 녹화한다 */
private class Controller(root: View) : ViewTreeObserver.OnPreDrawListener {
    val root = WeakReference(root)
    val scale = 4f
    val node: RenderNode? = if (Build.VERSION.SDK_INT >= 31) RenderNode("ogui-backdrop") else null
    var w = 0
    var h = 0
    var effectKey: Optics? = null

    override fun onPreDraw(): Boolean {
        val r = root.get() ?: return true
        val n = node ?: return true
        if (!glassOn) return true
        val live = synchronized(glassViews) { glassViews.filter { it.isAttachedToWindow && it.rootView === r && it.isShown && it.width > 0 } }
        if (live.isEmpty()) return true
        try {
            val sw = Math.max(1, (r.width / scale).toInt())
            val sh = Math.max(1, (r.height / scale).toInt())
            if (sw != w || sh != h) {
                n.setPosition(0, 0, sw, sh)
                w = sw
                h = sh
            }
            // 맨 위(가장 나중에 그려지는) 유리 창 하나 아래까지만 그린다
            val pane = paneOf(live.last())
            for (v in live) panes[paneOf(v)] = v
            val c = n.beginRecording(sw, sh)
            capturing = true
            try {
                c.scale(1f / scale, 1f / scale)
                drawBehind(c, r, pane)
            } finally {
                capturing = false
                n.endRecording()
            }
            val o = optics
            if (effectKey !== o) {
                effectKey = o
                val radius = Math.max(0.5f, dp(r, o.blur) / scale)
                val cm = ColorMatrix().apply { setSaturation(o.saturation) }
                val b = o.brightness
                cm.postConcat(ColorMatrix(floatArrayOf(b, 0f, 0f, 0f, 0f, 0f, b, 0f, 0f, 0f, 0f, 0f, b, 0f, 0f, 0f, 0f, 0f, 1f, 0f)))
                n.setRenderEffect(RenderEffect.createColorFilterEffect(ColorMatrixColorFilter(cm), RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP)))
            }
            frames++
            seeThrough(pane, live.last())
            for (v in live) v.foreground?.invalidateSelf()
        } catch (t: Throwable) {
            capturing = false
            lastError = "capture: $t"
        }
        return true
    }
}

private class GlassDrawable(view: View, private val radii: FloatArray) : Drawable() {
    private val view = WeakReference(view)
    private val path = Path()
    private val rect = RectF()
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val rim = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val loc = IntArray(2)
    private val rootLoc = IntArray(2)
    private val touchPaint = Paint(Paint.ANTI_ALIAS_FLAG)

    /** 누르고 있는 정도 (0~1) 와 누른 곳. 누르면 그 자리에 빛이 모이고 테두리가 밝아진다 (liquid 의 반응) */
    var press = 0f
    var tx = 0f
    var ty = 0f
    private var anim: android.animation.ValueAnimator? = null

    /** 손가락이 유리 위에 있는 동안 true */
    var held = false

    fun follow(x: Float, y: Float) {
        tx = x
        ty = y
        invalidateSelf()
    }

    fun touch(down: Boolean, x: Float, y: Float) {
        held = down
        tx = x
        ty = y
        val from = press
        val to = if (down) 1f else 0f
        if (down && from >= 1f) {
            invalidateSelf()
            return
        }
        anim?.cancel()
        anim = android.animation.ValueAnimator.ofFloat(from, to).apply {
            duration = if (down) 160L else 420L
            interpolator = android.view.animation.DecelerateInterpolator()
            addUpdateListener {
                press = it.animatedValue as Float
                invalidateSelf()
            }
            start()
        }
    }

    override fun draw(canvas: Canvas) {
        if (capturing || !glassOn) return
        val v = view.get() ?: return
        val b = bounds
        if (b.width() <= 0 || b.height() <= 0) return
        rect.set(b)
        path.reset()
        path.addRoundRect(rect, radii, Path.Direction.CW)
        val o = optics
        canvas.save()
        canvas.clipPath(path)
        // 1. 흐린 뒤 화면
        val ctl = controllers[v.rootView]
        val n = ctl?.node
        if (n != null && canvas.isHardwareAccelerated && ctl.w > 0) {
            v.getLocationInWindow(loc)
            v.rootView.getLocationInWindow(rootLoc)
            canvas.save()
            canvas.translate(-(loc[0] - rootLoc[0]).toFloat(), -(loc[1] - rootLoc[1]).toFloat())
            canvas.scale(ctl.scale, ctl.scale)
            canvas.drawRenderNode(n)
            canvas.restore()
            fill.color = Color.argb((o.alpha * 255).toInt(), 16, 18, 24)
        } else {
            // 흐림을 못 쓰면 진하게 (글자가 읽히게)
            fill.color = Color.argb(235, 16, 18, 24)
        }
        // 2. 색 한 겹
        canvas.drawRect(rect, fill)
        // 3. 안쪽 빛 (edge lensing): 가장자리 안쪽의 옅은 흰 띠
        val g = dp(v, 16f)
        glow.strokeWidth = g
        glow.color = Color.argb(((0.05f + 0.06f * press) * 255).toInt(), 255, 255, 255)
        canvas.drawPath(path, glow)
        // 누른 곳에 모이는 빛
        if (press > 0.01f) {
            val rad = dp(v, 140f) * (0.7f + 0.3f * press)
            touchPaint.shader = android.graphics.RadialGradient(tx, ty, rad, intArrayOf(Color.argb((0.22f * press * 255).toInt(), 255, 255, 255), Color.argb(0, 255, 255, 255)), null, Shader.TileMode.CLAMP)
            canvas.drawCircle(tx, ty, rad, touchPaint)
        }
        canvas.restore()
        // 4. 빛 받는 쪽 테두리 (rim): 왼쪽 위에서 비치는 빛, 오른쪽 아래로 사라진다
        rim.strokeWidth = dp(v, 1.2f)
        rim.shader = LinearGradient(rect.left, rect.top, rect.left + rect.width() * 0.6f, rect.top + Math.min(rect.height(), dp(v, 220f)),
            intArrayOf(Color.argb((217 + 38 * press).toInt(), 255, 255, 255), Color.argb((60 + 80 * press).toInt(), 255, 255, 255), Color.argb((40 * press).toInt(), 255, 255, 255)), floatArrayOf(0f, 0.45f, 1f), Shader.TileMode.CLAMP)
        val inset = rim.strokeWidth / 2
        rect.inset(inset, inset)
        path.reset()
        path.addRoundRect(rect, radii, Path.Direction.CW)
        canvas.drawPath(path, rim)
    }

    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(colorFilter: ColorFilter?) {}
    @Deprecated("") override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

/** nativeID 가 붙은 칸에 유리를 단다 */
private fun attach(v: View, id: String) {
    val parts = id.substringAfter(':', "").split(',').mapNotNull { it.trim().toFloatOrNull() }
    val r = FloatArray(8)
    for (i in 0 until 4) {
        val x = dp(v, parts.getOrNull(i) ?: parts.firstOrNull() ?: 0f)
        r[i * 2] = x
        r[i * 2 + 1] = x
    }
    v.foreground = GlassDrawable(v, r)
    v.setWillNotDraw(false)
    synchronized(glassViews) { glassViews.add(v) }
    val hook = { root: View ->
        if (controllers[root] == null) {
            val c = Controller(root)
            controllers[root] = c
            root.viewTreeObserver.addOnPreDrawListener(c)
        }
    }
    if (v.isAttachedToWindow) hook(v.rootView)
    v.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(x: View) = hook(x.rootView)
        override fun onViewDetachedFromWindow(x: View) {}
    })
}

val liquidGlassPlugin = plugin {
    var unhooks = mutableListOf<XC_MethodHook.Unhook>()

    start {
        try {
            // RN 은 nativeID 를 view.setTag(R.id.view_tag_native_id, 값) 으로 단다
            unhooks += XposedHelpers.findAndHookMethod(View::class.java, "setTag", Int::class.javaPrimitiveType, Any::class.java, object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    val tag = param.args[1] as? String ?: return
                    if (!tag.startsWith("ogui-glass")) return
                    val v = param.thisObject as View
                    try {
                        if (nativeIdKey == 0) nativeIdKey = v.resources.getIdentifier("view_tag_native_id", "id", v.context.packageName)
                        if (nativeIdKey != 0 && param.args[0] != nativeIdKey) return
                        if (v.foreground !is GlassDrawable) attach(v, tag)
                    } catch (t: Throwable) {
                        lastError = "attach: $t"
                    }
                }
            })
            // 손가락을 따라 빛이 움직인다: 창의 맨 위 뷰(DecorView)가 받는 모든 터치를 본다 (가로채지 않는다).
            // 시트 안의 스크롤이나 버튼이 터치를 가져가도 맨 위에서는 계속 보인다
            unhooks += XposedHelpers.findAndHookMethod(ViewGroup::class.java, "dispatchTouchEvent", android.view.MotionEvent::class.java, object : XC_MethodHook() {
                override fun beforeHookedMethod(param: MethodHookParam) {
                    if (!glassOn) return
                    val root = param.thisObject as View
                    if (root.parent is View) return
                    val e = param.args[0] as android.view.MotionEvent
                    val g = synchronized(glassViews) { glassViews.lastOrNull { it.isAttachedToWindow && it.rootView === root && it.isShown && it.width > 0 } } ?: return
                    val d = g.foreground as? GlassDrawable ?: return
                    g.getLocationOnScreen(gl)
                    val x = e.rawX - gl[0]
                    val y = e.rawY - gl[1]
                    when (e.actionMasked) {
                        android.view.MotionEvent.ACTION_DOWN ->
                            if (x >= 0 && y >= 0 && x <= g.width && y <= g.height) d.touch(true, x, y)
                        android.view.MotionEvent.ACTION_MOVE -> if (d.held) d.follow(x, y)
                        android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> if (d.held) d.touch(false, x, y)
                    }
                }
            })
        } catch (t: Throwable) {
            lastError = "hook: $t"
        }

        registerNativeMethod("${manifest.id}.config") { args ->
            try {
                val o = JSONObject(args.getOrNull(0) as? String ?: "{}")
                glassOn = o.optBoolean("enabled", true)
                optics = MATERIALS[o.optString("material")] ?: MATERIALS.getValue("regular")
                contentAlpha = when (o.optString("material")) { "clear" -> 0.3f; "frosted" -> 0.65f; else -> 0.45f }
                synchronized(glassViews) { for (v in glassViews) v.post { v.invalidate() } }
                true
            } catch (t: Throwable) {
                lastError = "config: $t"
                false
            }
        }
        registerNativeMethod("${manifest.id}.status") {
            JSONObject()
                .put("sdk", Build.VERSION.SDK_INT)
                .put("blur", Build.VERSION.SDK_INT >= 31)
                .put("views", synchronized(glassViews) { glassViews.count { it.isAttachedToWindow } })
                .put("frames", frames)
                .put("faded", faded)
                .put("surfaces", surfaceKinds)
                .put("hooks", unhooks.size)
                .put("error", lastError ?: JSONObject.NULL)
                .toString()
        }
    }

    stop {
        for (u in unhooks) try {
            u.unhook()
        } catch (_: Throwable) {
        }
        unhooks.clear()
        for ((root, c) in controllers) try {
            root.viewTreeObserver.removeOnPreDrawListener(c)
        } catch (_: Throwable) {
        }
        controllers.clear()
        synchronized(glassViews) {
            for (v in glassViews) if (v.foreground is GlassDrawable) v.post { v.foreground = null }
            glassViews.clear()
        }
    }
}
