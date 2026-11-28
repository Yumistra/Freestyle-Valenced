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

/**
 * 재질. 굴절 값(두께, 굴절률, 분산, 테두리 빛, 서리)은 OpenGlass UI 의 재질 프리셋(packages/core/src/materials.ts) 그대로,
 * 흐림과 색 막은 디스코드 어두운 화면에서 뒤가 잘 비치게 맞춘 값
 */
private class Optics(
    val blur: Float, val saturation: Float, val brightness: Float, val alpha: Float,
    val thickness: Float, val ior: Float, val dispersion: Float, val edgeStrength: Float, val frost: Float,
)

private val MATERIALS = mapOf(
    "clear" to Optics(1.5f, 1.5f, 1.08f, 0.03f, 0.78f, 1.5f, 0.018f, 0.54f, 0.04f),
    "regular" to Optics(6f, 1.5f, 1.08f, 0.08f, 0.62f, 1.46f, 0.012f, 0.46f, 0.24f),
    "frosted" to Optics(16f, 1.4f, 1.08f, 0.16f, 0.44f, 1.4f, 0.006f, 0.36f, 0.66f),
)

/**
 * OpenGlass 의 WebGL 굴절 셰이더(packages/renderers/src/webgl.ts)를 안드로이드 AGSL 로 옮긴 것.
 * 둥근 사각형의 거리장(SDF)으로 가장자리일수록 뒤 화면을 바깥쪽에서 끌어와 물방울처럼 휘게 하고,
 * 빨강, 초록, 파랑을 조금씩 다르게 휘어 가장자리에 무지개 번짐(분산), 가장자리 빛띠와 프레넬 반사를 더한다.
 * 여기에 왼쪽 위에서 비치는 반사광과 누른 자리의 빛을 더했다
 */
private const val GLASS_SHADER = """
uniform shader bg;
uniform float2 size;
uniform float radius;
uniform float2 origin;
uniform float inv;
uniform float dens;
uniform float4 optics;
uniform float2 surface;
uniform float4 tint;
uniform float3 touch;

float sdRR(float2 p, float2 h, float r) {
    float2 q = abs(p) - h + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

half4 samp(float2 screen, float frost) {
    float2 uv = screen * inv;
    half4 c = bg.eval(uv);
    if (frost < 0.01) return c;
    float t = mix(0.0, 2.4, frost);
    half4 taps = bg.eval(uv + float2(t, 0.0)) + bg.eval(uv - float2(t, 0.0)) + bg.eval(uv + float2(0.0, t)) + bg.eval(uv - float2(0.0, t));
    return mix(c, (c * 2.0 + taps) / 6.0, half(frost));
}

half4 main(float2 xy) {
    float2 h = max(size * 0.5, float2(1.0));
    float2 p = xy - h;
    float mh = max(min(h.x, h.y), 1.0);
    float r = clamp(radius, 0.0, mh);
    float d = sdRR(p, h, r);
    if (d > 1.5) return half4(0.0);
    float mask = 1.0 - smoothstep(-1.0, 1.0, d);
    float depth = clamp(-d / mh, 0.0, 1.0);
    float edge = pow(1.0 - depth, 1.35);
    float s = 0.75;
    float2 g = float2(sdRR(p + float2(s, 0.0), h, r) - sdRR(p - float2(s, 0.0), h, r),
                      sdRR(p + float2(0.0, s), h, r) - sdRR(p - float2(0.0, s), h, r));
    g = g / max(length(g), 0.0001);
    float power = ((optics.y - 1.0) / optics.y) * optics.x;
    float2 disp = g * edge * power * mh * 0.48;
    float spread = optics.z * 7.5;
    float2 at = origin + xy;
    float red = samp(at + disp * (1.0 + spread), surface.y).r;
    float green = samp(at + disp, surface.y).g;
    float blue = samp(at + disp * (1.0 - spread), surface.y).b;
    float3 col = float3(red, green, blue);
    float band = exp(-abs(d) / (2.8 * dens));
    float fresnel = pow(clamp(edge, 0.0, 1.0), 4.0);
    float hi = clamp((band * 0.34 + fresnel * 0.16) * surface.x, 0.0, 0.48);
    // 반사: 왼쪽 위에서 오는 빛이 그쪽 가장자리에 맺히고, 반대쪽에는 약하게 되비친다
    float2 L = normalize(float2(-0.55, -0.85));
    float facing = dot(g, L);
    hi += (pow(max(facing, 0.0), 3.0) * 0.55 + pow(max(-facing, 0.0), 3.0) * 0.18) * band * surface.x * 1.6;
    col += hi;
    col = mix(col, float3(dot(col, float3(0.2126, 0.7152, 0.0722))), surface.y * 0.08);
    // 색 막 (버튼은 버튼 색)
    col = mix(col, tint.rgb, tint.a);
    // 누른 자리에 모이는 빛
    if (touch.z > 0.001) {
        float rr = clamp(mh * 1.4, 24.0 * dens, 90.0 * dens);
        float k = exp(-dot(xy - touch.xy, xy - touch.xy) / (rr * rr));
        col += k * 0.14 * touch.z;
        col += band * 0.15 * touch.z;
    }
    return half4(half3(col) * half(mask), half(mask));
}
"""

@Volatile private var glassOn = true
@Volatile private var optics = MATERIALS.getValue("regular")
@Volatile private var lastError: String? = null
@Volatile private var frames = 0L

/** 녹화 중에는 유리를 그리지 않는다 (유리가 자기 녹화본을 그리지 않게) */
@Volatile private var capturing = false
private val glassViews: MutableSet<View> = Collections.newSetFromMap(WeakHashMap())
/** 아래 창(시트) 유리. 나머지는 버튼 유리 */
private val sheetGlass: MutableSet<View> = Collections.newSetFromMap(WeakHashMap())
private val controllers = WeakHashMap<View, Controller>()
/** 유리 창 → 그 창의 유리 칸 (누름 반응) */
private val panes = WeakHashMap<View, View>()
private val pl = IntArray(2)
private val gl = IntArray(2)
private var nativeIdKey = 0
/** 지금 손가락이 누르고 있는 유리 */
private var held: WeakReference<View>? = null
private var downX = 0f
private var downY = 0f

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
private val filtered: MutableSet<Drawable> = Collections.newSetFromMap(WeakHashMap())
/** 투명하게 만든 배경을 원래대로 (버튼 색이 바뀌었는지 다시 볼 때) */
private fun unfade(bg: Drawable) {
    try { bg.alpha = 255 } catch (_: Throwable) {}
    if (filtered.remove(bg)) try { bg.colorFilter = null } catch (_: Throwable) {}
}
@Volatile private var surfaceKinds = ""
private fun fade(bg: Drawable, a: Float) {
    val want = (a * 255).toInt()
    // mutate() 는 쓰지 않는다: RN 배경(LayerDrawable)을 mutate 하면 안쪽 그림이 두 주인을 갖게 돼서
    // 그리는 스레드(RenderThread)가 죽는다. 뷰마다 따로 만든 배경이라 그대로 바꿔도 된다
    try {
        bg.alpha = want
    } catch (_: Throwable) {
    }
    // RN 배경처럼 alpha 를 무시하는 것은 색 필터로 알파를 곱한다 (결과 = 원래 색 × a)
    val took = try { bg.alpha == want } catch (_: Throwable) { false }
    if (!took) try {
        bg.colorFilter = android.graphics.PorterDuffColorFilter(Color.argb(want, 0, 0, 0), android.graphics.PorterDuff.Mode.DST_IN)
        filtered.add(bg)
    } catch (_: Throwable) {
    }
    faded++
}

/**
 * 유리 창 안의 배경을 비치게 한다.
 * 창을 거의 다 덮는 바탕 (디스코드 시트의 바탕 판, 여러 겹일 수 있다) 은 아예 투명하게, 그보다 작은 넓은 카드와 줄은 반투명하게.
 * 겹겹이 반투명이면 겹칠수록 다시 진해져서 유리가 안 보인다. 버튼, 아이콘 같은 작은 것은 그대로
 */
@Volatile private var tree = ""
private fun describe(v: View): String {
    val bg = v.background
    return "${v.javaClass.simpleName} ${v.width}x${v.height} a${"%.2f".format(v.alpha)}" +
        (if (v is ViewGroup) " kids${v.childCount}" else "") +
        (if (bg != null) " bg=${bg.javaClass.simpleName}/${try { bg.alpha } catch (_: Throwable) { -1 }}" else "") +
        (if (v.foreground is GlassDrawable) " GLASS" else "")
}

/** 테스트 로그: 루트에서 유리 창까지, 그리고 창 안에서 배경이 있는 칸 */
private fun dumpTree(root: View, pane: View) {
    val sb = StringBuilder()
    val chain = ArrayList<View>()
    var v: View? = pane
    while (v != null) { chain.add(0, v); if (v === root) break; v = v.parent as? View }
    sb.append("root ${root.width}x${root.height}\n")
    for (i in chain.indices) {
        val g = chain[i]
        sb.append("  ".repeat(Math.min(i, 12))).append(if (g === pane) "PANE " else "> ").append(describe(g)).append('\n')
        if (g is ViewGroup && g !== pane && i + 1 < chain.size) for (k in 0 until g.childCount) {
            val ch = g.getChildAt(k)
            if (ch === chain[i + 1]) break
            sb.append("  ".repeat(Math.min(i, 12))).append("  behind: ").append(describe(ch)).append('\n')
        }
    }
    fun walk(x: View, d: Int) {
        if (d > 30 || sb.length > 6000) return
        if (x !== pane && (x.background != null || x.foreground is GlassDrawable)) sb.append("    ".repeat(1)).append("in pane d$d: ").append(describe(x)).append('\n')
        if (x is ViewGroup) for (k in 0 until x.childCount) walk(x.getChildAt(k), d + 1)
    }
    walk(pane, 0)
    tree = sb.toString()
}

private fun seeThrough(pane: View, glass: View) {
    val now = System.currentTimeMillis()
    if (now - (lastScan[pane] ?: 0L) < 500) return
    lastScan[pane] = now
    if (synchronized(glassViews) { glass in sheetGlass }) try { dumpTree(pane.rootView, pane) } catch (t: Throwable) { tree = "dump: $t" }
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

/**
 * 창(루트 뷰) 하나에 하나: 그리기 직전에 유리 뒤 화면을 작게(1/4) 찍어 그림(Bitmap)으로 만든다.
 * 시트가 열려 있으면 시트 아래만, 아니면 화면 전체.
 * 녹화본(RenderNode)을 유리가 바로 그리면, 녹화본 안에 그 유리가 다시 들어가 RenderThread 가 끝없이 돌다 죽는다.
 * 그래서 따로 된 렌더러(HardwareRenderer)로 그림 한 장에 그려 두고, 유리는 그 그림만 읽는다 (고리가 생기지 않는다)
 */
private class Controller(root: View) : ViewTreeObserver.OnPreDrawListener {
    val root = WeakReference(root)
    val scale = 4f
    val node: RenderNode? = if (Build.VERSION.SDK_INT >= 31) RenderNode("ogui-backdrop") else null
    var w = 0
    var h = 0
    var effectKey: Optics? = null
    var lastCapture = 0L
    var lastRecheck = 0L
    private var renderer: android.graphics.HardwareRenderer? = null
    private var reader: android.media.ImageReader? = null
    private var held: android.media.Image? = null
    /** 가장 최근에 찍힌 뒤 화면 (1/4 크기) */
    @Volatile var shot: android.graphics.Bitmap? = null
    @Volatile var shotShader: android.graphics.BitmapShader? = null
    /** 시트를 찍은 그림인지 (시트 아래만 찍었는지) */
    @Volatile var shotSheet = false
    /** 새 그림이 와서 유리를 다시 그리게 한 프레임은 다시 찍지 않는다 (끝없이 찍지 않게) */
    private var selfFrame = false

    private fun setup(sw: Int, sh: Int) {
        release()
        val rd = android.media.ImageReader.newInstance(sw, sh, PixelFormat.RGBA_8888, 3,
            android.hardware.HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE or android.hardware.HardwareBuffer.USAGE_GPU_COLOR_OUTPUT)
        rd.setOnImageAvailableListener({ r ->
            try {
                val img = r.acquireLatestImage() ?: return@setOnImageAvailableListener
                val hb = img.hardwareBuffer
                val bmp = if (hb != null) android.graphics.Bitmap.wrapHardwareBuffer(hb, android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.SRGB)) else null
                hb?.close()
                if (bmp == null) {
                    img.close()
                    return@setOnImageAvailableListener
                }
                held?.close()
                held = img
                shot = bmp
                shotShader = android.graphics.BitmapShader(bmp, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
                shots++
                selfFrame = true
                val rt = this.root.get()
                synchronized(glassViews) { for (v in glassViews) if (v.rootView === rt) v.foreground?.invalidateSelf() }
            } catch (t: Throwable) {
                lastError = "shot: $t"
            }
        }, android.os.Handler(android.os.Looper.getMainLooper()))
        val hr = android.graphics.HardwareRenderer()
        hr.setSurface(rd.surface)
        hr.setContentRoot(node)
        hr.isOpaque = false
        reader = rd
        renderer = hr
    }

    fun release() {
        try { renderer?.destroy() } catch (_: Throwable) {}
        try { reader?.close() } catch (_: Throwable) {}
        try { held?.close() } catch (_: Throwable) {}
        renderer = null
        reader = null
        held = null
    }

    override fun onPreDraw(): Boolean {
        val r = root.get() ?: return true
        val n = node ?: return true
        if (!glassOn) return true
        if (selfFrame) {
            selfFrame = false
            return true
        }
        val live = synchronized(glassViews) { glassViews.filter { it.isAttachedToWindow && it.rootView === r && it.isShown && it.width > 0 } }
        val now0 = System.currentTimeMillis()
        // 버튼 색이 바뀌었는지 (고른 채널이 바뀌면 그 줄에 색이 옮겨 간다) 0.6초마다 화면에 보이는 버튼만 다시 본다
        if (now0 - lastRecheck > 600) {
            lastRecheck = now0
            val ps = synchronized(probes) { probes.filter { it.isAttachedToWindow && it.rootView === r && it.isShown } }
            for (pv in ps.take(60)) try { recheck(pv) } catch (_: Throwable) {}
        }
        if (live.isEmpty()) return true
        try {
            val sheet = synchronized(glassViews) { live.lastOrNull { it in sheetGlass } }
            for (v in live) if (v !== sheet) seeThrough(paneOf(v), v)
            val now = System.currentTimeMillis()

            // 시트가 없으면 화면이 바뀌는 동안에도 초당 20번까지만 (배터리)
            if (sheet == null && now - lastCapture < 50) return true
            lastCapture = now
            val sw = Math.max(1, (r.width / scale).toInt())
            val sh = Math.max(1, (r.height / scale).toInt())
            if (sw != w || sh != h || renderer == null) {
                n.setPosition(0, 0, sw, sh)
                w = sw
                h = sh
                setup(sw, sh)
            }
            val c = n.beginRecording(sw, sh)
            capturing = true
            try {
                c.scale(1f / scale, 1f / scale)
                if (sheet != null) drawBehind(c, r, paneOf(sheet)) else r.draw(c)
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
            // 찍는 동안만 유리 칸을 투명하게 (syncAndDraw 는 값을 넘겨받을 때까지 기다리니, 끝나면 바로 되돌려도 된다)
            val layers = live.mapNotNull { (it.foreground as? GlassDrawable)?.layer }
            for (l in layers) l.setAlpha(0f)
            try {
                renderer?.createRenderRequest()?.setWaitForPresent(false)?.syncAndDraw()
            } finally {
                for (l in layers) l.setAlpha(1f)
            }
            shotSheet = sheet != null
            frames++
            if (sheet != null) seeThrough(paneOf(sheet), sheet)
        } catch (t: Throwable) {
            capturing = false
            lastError = "capture: $t"
        }
        return true
    }
}

@Volatile private var shots = 0L

private class GlassDrawable(view: View, private var radii: FloatArray, @Volatile var tint: Int? = null, target: View? = null) : Drawable() {
    /** 버튼: 색이 칠해져 있던 안쪽 칸. 매번 그 칸의 지금 자리와 크기에 맞춰 그린다 (모양이 바뀌면 따라간다) */
    private var targetRef = target?.let { WeakReference(it) }
    val target: View? get() = targetRef?.get()
    /** 버튼 색이 빠졌을 때 (고른 채널에서 다른 채널로 바뀌었을 때 등) 유리도 끈다 */
    @Volatile var off = false
    /**
     * 유리 한 장을 따로 된 그림 칸(RenderNode)에 그린다. 뒤 화면을 찍을 때 이 칸만 잠깐 투명하게 해서
     * 찍은 그림에 유리가 다시 들어가지 않게 한다 (들어가면 프레임마다 밝기, 채도가 쌓여 색이 터진다)
     */
    val layer: RenderNode? = if (Build.VERSION.SDK_INT >= 29) RenderNode("ogui-glass") else null

    fun retarget(t: View, color: Int, r: Float) {
        targetRef = WeakReference(t)
        tint = color
        radii = FloatArray(8) { r }
        off = false
        invalidateSelf()
    }
    private val tloc = IntArray(2)
    private val shader: android.graphics.RuntimeShader? = if (Build.VERSION.SDK_INT >= 33) try { android.graphics.RuntimeShader(GLASS_SHADER) } catch (t: Throwable) { lastError = "shader: $t"; null } else null
    private val shaderPaint = Paint(Paint.ANTI_ALIAS_FLAG)
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
        // 찍는 중에도 그린다: 유리는 그림(Bitmap)만 읽어서 고리가 생기지 않고,
        // 여기서 빼면 그때 다시 그려진 칸의 그림 목록에서 유리가 빠진 채로 화면에 쓰인다
        if (!glassOn) return
        val v = view.get() ?: return
        val b = bounds
        if (b.width() <= 0 || b.height() <= 0) return
        if (off) return
        val tint = this.tint
        rect.set(b)
        val t = target
        var rr = radii
        if (t != null) {
            if (!t.isAttachedToWindow || t.width <= 0) return
            t.getLocationInWindow(tloc)
            v.getLocationInWindow(loc)
            val l = (tloc[0] - loc[0]).toFloat()
            val tp = (tloc[1] - loc[1]).toFloat()
            rect.set(l, tp, l + t.width, tp + t.height)
            val cap = Math.min(t.width, t.height) / 2f
            if (radii[0] > cap) rr = FloatArray(8) { cap }
        }
        val bw = rect.width()
        val bh = rect.height()
        // 굴절 셰이더 (안드로이드 13+): 찍어 둔 뒤 화면을 물방울처럼 휘고 반사를 얹는다
        val ctl = controllers[v.rootView]
        val bgShader = ctl?.shotShader
        val sh = shader
        if (sh != null && bgShader != null && canvas.isHardwareAccelerated) {
            v.getLocationInWindow(loc)
            v.rootView.getLocationInWindow(rootLoc)
            val o = optics
            sh.setInputShader("bg", bgShader)
            sh.setFloatUniform("size", bw, bh)
            sh.setFloatUniform("radius", rr[0])
            sh.setFloatUniform("origin", (loc[0] - rootLoc[0]) + rect.left, (loc[1] - rootLoc[1]) + rect.top)
            sh.setFloatUniform("inv", 1f / ctl.scale)
            sh.setFloatUniform("dens", v.resources.displayMetrics.density)
            sh.setFloatUniform("optics", o.thickness, o.ior, o.dispersion, 0f)
            sh.setFloatUniform("surface", o.edgeStrength, o.frost)
            if (tint != null) {
                val a = (Color.alpha(tint) / 255f) * (0.22f + o.alpha)
                sh.setFloatUniform("tint", Color.red(tint) / 255f, Color.green(tint) / 255f, Color.blue(tint) / 255f, a.coerceIn(0f, 0.85f))
            } else {
                sh.setFloatUniform("tint", 16f / 255f, 18f / 255f, 24f / 255f, o.alpha)
            }
            sh.setFloatUniform("touch", tx - rect.left, ty - rect.top, press)
            shaderPaint.shader = sh
            val ly = layer
            val outer = canvas
            val cv: Canvas = if (ly != null) {
                ly.setPosition(0, 0, b.width(), b.height())
                ly.beginRecording(b.width(), b.height())
            } else canvas
            cv.save()
            cv.translate(rect.left, rect.top)
            cv.drawRect(0f, 0f, bw, bh, shaderPaint)
            cv.restore()
            // 가장 바깥 얇은 테두리
            rim.strokeWidth = dp(v, 1f)
            rim.shader = LinearGradient(rect.left, rect.top, rect.left + bw * 0.6f, rect.top + Math.min(bh, dp(v, 220f)),
                intArrayOf(Color.argb((150 + 80 * press).toInt(), 255, 255, 255), Color.argb((40 + 60 * press).toInt(), 255, 255, 255), Color.argb((20 + 30 * press).toInt(), 255, 255, 255)), floatArrayOf(0f, 0.45f, 1f), Shader.TileMode.CLAMP)
            val ins = rim.strokeWidth / 2
            rect.inset(ins, ins)
            path.reset()
            path.addRoundRect(rect, rr, Path.Direction.CW)
            cv.drawPath(path, rim)
            if (ly != null) {
                ly.endRecording()
                outer.drawRenderNode(ly)
            }
            return
        }
        path.reset()
        path.addRoundRect(rect, rr, Path.Direction.CW)
        val o = optics
        canvas.save()
        canvas.clipPath(path)
        // 셰이더를 못 쓰면 (안드로이드 12 이하, 아직 찍은 그림이 없을 때): 색 막과 빛만
        if (tint != null) {
            fill.color = Color.argb((Color.alpha(tint) * (0.18f + o.alpha)).toInt().coerceIn(0, 255), Color.red(tint), Color.green(tint), Color.blue(tint))
            canvas.drawRect(rect, fill)
            fill.color = Color.argb(14, 255, 255, 255)
        } else {
            fill.color = Color.argb(235, 16, 18, 24)
        }
        // 2. 색 한 겹
        canvas.drawRect(rect, fill)
        // 3. 안쪽 빛 (edge lensing): 가장자리 안쪽의 옅은 흰 띠
        // 한 줄짜리 띠는 안쪽에 테두리가 하나 더 있는 것처럼 보여서, 넓이를 달리한 옅은 띠를 겹쳐 안쪽으로 부드럽게 사라지게 한다
        for (k in 1..4) {
            glow.strokeWidth = Math.min(dp(v, 6f * k), Math.min(bw, bh) * 0.08f * k)
            glow.color = Color.argb(((0.012f + 0.02f * press) * 255).toInt().coerceAtLeast(1), 255, 255, 255)
            canvas.drawPath(path, glow)
        }
        // 누른 곳에 모이는 빛
        if (press > 0.01f) {
            val rad = Math.min(dp(v, 140f), Math.max(bw, bh) * 0.8f) * (0.7f + 0.3f * press)
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
        path.addRoundRect(rect, rr, Path.Direction.CW)
        canvas.drawPath(path, rim)
    }

    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(colorFilter: ColorFilter?) {}
    @Deprecated("") override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

/** nativeID 가 붙은 칸에 유리를 단다 */
private fun attach(v: View, id: String) {
    if (id.startsWith("ogui-glass-probe")) {
        probesSeen++
        probe(v, 0)
        return
    }
    val tint = id.substringAfter(";c=", "").toLongOrNull()?.toInt()
    val parts = id.substringAfter(':', "").substringBefore(';').split(',').mapNotNull { it.trim().toFloatOrNull() }
    val r = FloatArray(8)
    for (i in 0 until 4) {
        val x = dp(v, parts.getOrNull(i) ?: parts.firstOrNull() ?: 0f)
        r[i * 2] = x
        r[i * 2 + 1] = x
    }
    install(v, GlassDrawable(v, r, tint), !id.startsWith("ogui-glass-btn"))
}

private fun ensureController(v: View) {
    if (!v.isAttachedToWindow) return
    val root = v.rootView
    if (controllers[root] == null) {
        val c = Controller(root)
        controllers[root] = c
        root.viewTreeObserver.addOnPreDrawListener(c)
    }
}

private fun install(v: View, d: GlassDrawable, sheet: Boolean) {
    v.foreground = d
    v.setWillNotDraw(false)
    synchronized(glassViews) {
        glassViews.add(v)
        if (sheet) sheetGlass.add(v)
    }
    ensureController(v)
    val hook = { root: View -> ensureController(root) }
    if (v.isAttachedToWindow) hook(v.rootView)
    v.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(x: View) = hook(x.rootView)
        override fun onViewDetachedFromWindow(x: View) {}
    })
}

@Volatile private var buttonsFound = 0
@Volatile private var probesSeen = 0
@Volatile private var probesRun = 0

/** 배경을 작게 그려 가운데 색과 모서리 둥글기를 잰다. 둥글고 색이 있으면 (색, 둥글기 px) */
private fun sampleBg(t: View): Pair<Int, Float>? {
    val bg = t.background ?: return null
    val s = 4
    val w = Math.max(2, t.width / s)
    val h = Math.max(2, t.height / s)
    val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
    try {
        val c = Canvas(bmp)
        c.scale(1f / s, 1f / s)
        val old = bg.copyBounds()
        if (old.isEmpty) bg.setBounds(0, 0, t.width, t.height)
        bg.draw(c)
        if (old.isEmpty) bg.bounds = old
        val mid = bmp.getPixel(w / 2, h / 2)
        if (Color.alpha(mid) < 40) return null
        // 왼쪽 위 모서리에서 대각선으로 들어가며 색이 반쯤 찰 때까지
        var d = 0
        val lim = Math.min(w, h) / 2
        while (d < lim && Color.alpha(bmp.getPixel(d, d)) < Color.alpha(mid) / 2) d++
        if (d == 0) return null // 각진 칸 (타일, 목록) 은 버튼이 아니다
        // 네 모서리가 다 둥글어야 버튼 (목록 묶음의 첫 줄, 끝 줄은 한쪽만 둥글다)
        if (Color.alpha(bmp.getPixel(w - 1, h - 1)) >= Color.alpha(mid) / 2 || Color.alpha(bmp.getPixel(w - 1, 0)) >= Color.alpha(mid) / 2 || Color.alpha(bmp.getPixel(0, h - 1)) >= Color.alpha(mid) / 2) return null
        return mid to (d * s / (1f - 0.7071f))
    } finally {
        bmp.recycle()
    }
}

/**
 * 버튼 찾기: JS 가 모든 Pressable 안에 빈 칸(probe)을 넣는다.
 * 그 Pressable 이나 안쪽에 크기가 비슷하고 색칠된 둥근 배경이 있으면 그 배경을 투명하게 하고, 그 자리에 유리를 단다.
 * (디스코드 기본 버튼은 색이 Pressable 이 아니라 안쪽 칸에 칠해져 있다)
 */
/** 버튼 표시(probe) 칸들. 처음엔 색이 없다가 나중에 칠해지는 버튼(고른 채널 줄 등)도 있어서 계속 다시 본다 */
private val probes: MutableSet<View> = Collections.newSetFromMap(WeakHashMap())

/** 이 표시 칸의 버튼에서 색칠된 둥근 배경 찾기: (그 칸, 색, 둥글기) */
private fun findButtonBg(v: View): Triple<View, Int, Float>? {
    val pane = v.parent as? ViewGroup ?: return null
    if (pane.width <= 0 || pane.height <= 0) return null
    // 화면 폭만 한 버튼도 있다 (모서리가 네 군데 다 둥근지로 목록 줄과 가른다). 너무 높은 것은 카드
    if (pane.height > dp(v, 160f)) return null
    var best: View? = null
    var bestS: Pair<Int, Float>? = null
    fun walk(x: View, d: Int) {
        if (d > 4 || x === v) return
        if (x.background != null && x.width >= pane.width * 0.6f && x.height >= pane.height * 0.6f &&
            (best == null || x.width * x.height > best!!.width * best!!.height)) {
            val smp = sampleBg(x)
            if (smp != null) {
                best = x
                bestS = smp
            }
        }
        if (x is ViewGroup) for (i in 0 until x.childCount) walk(x.getChildAt(i), d + 1)
    }
    walk(pane, 0)
    val t = best ?: return null
    val (c, r) = bestS!!
    return Triple(t, c, Math.min(r, Math.min(t.width, t.height) / 2f))
}

/**
 * 버튼 상태 다시 보기: 유리가 있으면 그 버튼의 지금 색을 다시 재서 (투명해졌으면 유리를 끄고, 색이 바뀌었으면 바꾼다),
 * 유리가 없으면 그새 색이 칠해졌는지 본다
 */
private fun recheck(v: View) {
    if (!v.isAttachedToWindow || !v.isShown) return
    val d = v.foreground as? GlassDrawable
    if (d != null) {
        val t = d.target ?: return
        val bg = t.background
        if (bg != null) unfade(bg)
        val smp = if (bg != null && t.isAttachedToWindow) sampleBg(t) else null
        if (smp == null) {
            if (!d.off) { d.off = true; d.invalidateSelf() }
            // 지금 배경이 투명한지 아직 다른 칸에 칠해졌는지 모르니, 이 버튼 안을 다시 찾는다
            val f = findButtonBg(v)
            if (f != null) {
                d.retarget(f.first, f.second, f.third)
                fade(f.first.background!!, 0f)
                f.first.invalidate()
            }
            return
        }
        d.tint = smp.first
        d.off = false
        fade(bg!!, 0f)
        t.invalidate()
        d.invalidateSelf()
        return
    }
    val f = findButtonBg(v) ?: return
    fade(f.first.background!!, 0f)
    seen.add(f.first.background!!)
    f.first.invalidate()
    install(v, GlassDrawable(v, FloatArray(8) { f.third }, f.second, f.first), false)
    buttonsFound++
}

private fun probe(v: View, tries: Int) {
    probes.add(v)
    v.postDelayed({
        try {
            if (!glassOn || !v.isAttachedToWindow || v.foreground is GlassDrawable) return@postDelayed
            val pane = v.parent as? ViewGroup ?: return@postDelayed
            if (pane.width <= 0 || pane.height <= 0) {
                if (tries < 5) probe(v, tries + 1)
                return@postDelayed
            }
            probesRun++
            ensureController(v)
            recheck(v)
        } catch (e: Throwable) {
            lastError = "probe: $e"
        }
    }, if (tries == 0) 120L else 400L)
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
                    when (e.actionMasked) {
                        android.view.MotionEvent.ACTION_DOWN -> {
                            // 손가락 아래의 유리 중 가장 작은 것 (시트 위의 버튼이면 버튼)
                            var best: View? = null
                            val live = synchronized(glassViews) { glassViews.filter { it.isAttachedToWindow && it.rootView === root && it.isShown && it.width > 0 } }
                            for (g in live) {
                                g.getLocationOnScreen(gl)
                                val x = e.rawX - gl[0]
                                val y = e.rawY - gl[1]
                                if (x < 0 || y < 0 || x > g.width || y > g.height) continue
                                if (best == null || g.width * g.height < best.width * best.height) best = g
                            }
                            val g = best ?: return
                            g.getLocationOnScreen(gl)
                            held = WeakReference(g)
                            downX = e.rawX
                            downY = e.rawY
                            val x0 = e.rawX - gl[0]
                            val y0 = e.rawY - gl[1]
                            if (synchronized(glassViews) { g in sheetGlass }) (g.foreground as? GlassDrawable)?.touch(true, x0, y0)
                            // 버튼은 잠깐 기다렸다가 (끌려고 누른 거면 그새 움직여서 취소된다)
                            else g.postDelayed({
                                if (held?.get() === g) (g.foreground as? GlassDrawable)?.let { it.touch(true, it.tx.takeIf { _ -> it.held } ?: x0, it.ty.takeIf { _ -> it.held } ?: y0) }
                            }, 90L)
                        }
                        android.view.MotionEvent.ACTION_MOVE -> {
                            val g = held?.get() ?: return
                            g.getLocationOnScreen(gl)
                            val d = g.foreground as? GlassDrawable ?: return
                            // 버튼 위에서 손가락이 움직이면 목록을 끄는 중이다: 빛을 끈다 (끌 때마다 번쩍이지 않게)
                            val slop = android.view.ViewConfiguration.get(g.context).scaledTouchSlop
                            if (synchronized(glassViews) { g !in sheetGlass } && Math.hypot((e.rawX - downX).toDouble(), (e.rawY - downY).toDouble()) > slop) {
                                held = null
                                d.touch(false, e.rawX - gl[0], e.rawY - gl[1])
                                return
                            }
                            d.follow(e.rawX - gl[0], e.rawY - gl[1])
                        }
                        android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                            val g = held?.get() ?: return
                            held = null
                            g.getLocationOnScreen(gl)
                            (g.foreground as? GlassDrawable)?.touch(false, e.rawX - gl[0], e.rawY - gl[1])
                        }
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
                contentAlpha = when (o.optString("material")) { "clear" -> 0.12f; "frosted" -> 0.32f; else -> 0.2f }
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
                .put("shots", shots)
                .put("buttons", buttonsFound)
                .put("probes", probesSeen)
                .put("probed", probesRun)
                .put("surfaces", surfaceKinds)
                .put("tree", tree)
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
            c.release()
        } catch (_: Throwable) {
        }
        controllers.clear()
        synchronized(glassViews) {
            for (v in glassViews) if (v.foreground is GlassDrawable) v.post { v.foreground = null }
            glassViews.clear()
        }
    }
}
