package io.github.yumistra.betteranimations

import android.animation.TimeInterpolator
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Path
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.Shader
import android.os.Build
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import java.lang.reflect.Method
import java.lang.reflect.Modifier
import java.util.WeakHashMap

/**
 * 메시지 줄 효과 중 View 속성으로 읽을 수 없는 것 (원형 펼치기, 흐림)을 장식 그리기에 알려 주는 곳.
 * 또 효과가 도는 동안 목록을 매 프레임 다시 그리게 한다: 줄 속성(이동·투명도)만 바뀌면 안드로이드는
 * 목록을 다시 그리지 않아서, 목록 캔버스에 그리는 장식(멘션 배경)은 옛 자리에 머문다.
 */
internal object RowFx {
    class Reveal(val cx: Float, val cy: Float, val radius: Float, val startAt: Long, val duration: Long, val interpolator: TimeInterpolator)

    val reveal = WeakHashMap<View, Reveal>()
    val blur = WeakHashMap<View, Float>()

    fun redraw(child: View) {
        (child.parent as? View)?.invalidate()
    }
}

/**
 * 멘션(핑) 노란 배경 같은 "메시지 뒤 배경"이 메시지 효과를 그대로 따라가게 한다.
 *
 * 디스코드는 이 배경을 메시지 줄 안이 아니라 채팅 목록의 ItemDecoration 이 목록 캔버스에 따로 그린다
 * (352: l9.a → l9.b.b(Canvas, View)). 그 그리기는 줄의 위치 이동(translationY)만 반영하고
 * 크기·회전·투명도는 모른다. 그래서 메시지가 커지며·흐려지며 나타나는 동안 배경만 제자리·제 크기로 있다가
 * 효과가 끝나면 맞아떨어진다.
 *
 * 채팅 목록에 붙은 ItemDecoration 들을 찾아, 그 안에서 "(Canvas, View) 로 줄 하나를 그리는" 메서드를 감싼다.
 * 그리는 동안만 캔버스에 그 줄의 변환(View.getMatrix)·투명도·원형 펼치기(잘라내기)·흐림을 걸어 준다.
 */
internal class Highlights(private val rvClass: Class<*>, private val log: (String, Throwable?) -> Unit) {
    private val done = HashSet<Class<*>>()
    private val hooked = HashSet<Method>()
    val hooks = ArrayList<XC_MethodHook.Unhook>()
    private val tmp = Matrix()
    var count = 0
        private set

    /** 채팅 목록이 처음 그려지기 전에 한 번 (장식은 목록을 만들 때 붙는다) */
    fun scan(list: ViewGroup) {
        for (deco in decorations(list)) {
            val cls = deco.javaClass
            if (!done.add(cls)) continue
            // 장식 자신 또는 그 필드(그리기 도우미)에 있는 (Canvas, View) → void 메서드
            val targets = ArrayList<Method>()
            targets.addAll(drawRowMethods(cls))
            var c: Class<*>? = cls
            while (c != null && c != Any::class.java) {
                for (f in c.declaredFields) {
                    if (Modifier.isStatic(f.modifiers) || f.type.isPrimitive) continue
                    val helper = try {
                        f.isAccessible = true
                        f.get(deco)
                    } catch (e: Throwable) {
                        null
                    } ?: continue
                    if (helper is View || helper is Collection<*>) continue
                    targets.addAll(drawRowMethods(helper.javaClass))
                }
                c = c.superclass
            }
            for (m in targets) hook(m)
        }
    }

    /** 목록의 ArrayList 필드 중에 ItemDecoration(목록 캔버스에 그리는 것)이 든 것 */
    private fun decorations(list: ViewGroup): List<Any> {
        val out = ArrayList<Any>()
        var c: Class<*>? = list.javaClass
        while (c != null && c != ViewGroup::class.java) {
            for (f in c.declaredFields) {
                if (Modifier.isStatic(f.modifiers) || !java.util.ArrayList::class.java.isAssignableFrom(f.type)) continue
                val items = try {
                    f.isAccessible = true
                    f.get(list) as? java.util.ArrayList<*>
                } catch (e: Throwable) {
                    null
                } ?: continue
                for (item in items.toList()) if (item != null && isDecoration(item.javaClass)) out.add(item)
            }
            c = c.superclass
        }
        return out
    }

    /** onDraw(Canvas, RecyclerView, State) 를 가진 클래스 */
    private fun isDecoration(cls: Class<*>): Boolean {
        var c: Class<*>? = cls
        while (c != null && c != Any::class.java) {
            if (c.declaredMethods.any { m -> m.parameterTypes.size == 3 && m.parameterTypes[0] == Canvas::class.java && m.parameterTypes[1].isAssignableFrom(rvClass) }) return true
            c = c.superclass
        }
        return false
    }

    private fun drawRowMethods(cls: Class<*>) = cls.declaredMethods.filter {
        !Modifier.isStatic(it.modifiers) && !Modifier.isAbstract(it.modifiers) && it.returnType == Void.TYPE &&
            it.parameterTypes.size == 2 && it.parameterTypes[0] == Canvas::class.java && it.parameterTypes[1] == View::class.java
    }

    private fun hook(m: Method) {
        if (!hooked.add(m)) return
        try {
            hooks.add(
                XposedBridge.hookMethod(
                    m,
                    object : XC_MethodHook() {
                        override fun beforeHookedMethod(param: MethodHookParam) {
                            val canvas = param.args[0] as? Canvas ?: return
                            val view = param.args[1] as? View ?: return
                            try {
                                val save = apply(canvas, view)
                                if (save < 0) return
                                param.setObjectExtra("baSave", save)
                                // 흐림: 도우미가 그리는 걸 따로 받아서 같은 세기로 흐리게 해 붙인다
                                val radius = RowFx.blur[view] ?: 0f
                                if (radius >= 0.5f && Build.VERSION.SDK_INT >= 31 && canvas.isHardwareAccelerated) {
                                    val node = nodes.getOrPut(view) { RenderNode("ba-highlight") }
                                    node.setPosition(0, 0, canvas.width.coerceAtLeast(1), canvas.height.coerceAtLeast(1))
                                    node.setRenderEffect(RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.DECAL))
                                    param.setObjectExtra("baNode", node)
                                    param.args[0] = node.beginRecording()
                                    param.setObjectExtra("baCanvas", canvas)
                                }
                            } catch (e: Throwable) {
                                log("Highlight transform failed", e)
                            }
                        }

                        override fun afterHookedMethod(param: MethodHookParam) {
                            val save = param.getObjectExtra("baSave") as? Int ?: return
                            val canvas = (param.getObjectExtra("baCanvas") as? Canvas) ?: (param.args[0] as? Canvas) ?: return
                            (param.getObjectExtra("baNode") as? RenderNode)?.let { node ->
                                try {
                                    node.endRecording()
                                    canvas.drawRenderNode(node)
                                } catch (e: Throwable) {
                                }
                                param.args[0] = canvas
                            }
                            canvas.restoreToCount(save)
                        }
                    },
                ),
            )
            count++
        } catch (e: Throwable) {
            log("Failed to hook ${m.declaringClass.name}.${m.name}", e)
        }
    }

    /**
     * 줄이 크기·회전·투명도 변환 중이면 캔버스에 같은 변환을 건다. 건 게 없으면 -1.
     * 도우미는 (left + translationX, top + translationY) 에 그리므로, 그 이동은 빼고 줄 행렬 전체를 다시 건다:
     * T(left, top) · M · T(−left − tx, −top − ty)
     */
    private fun apply(canvas: Canvas, v: View): Int {
        val transformed = v.scaleX != 1f || v.scaleY != 1f || v.rotation != 0f || v.rotationX != 0f || v.rotationY != 0f
        val faded = v.alpha < 1f
        val reveal = RowFx.reveal[v]
        val blurred = (RowFx.blur[v] ?: 0f) >= 0.5f
        if (!transformed && !faded && reveal == null && !blurred) return -1
        val save = canvas.save()
        if (transformed) {
            tmp.set(v.matrix)
            canvas.translate(v.left.toFloat(), v.top.toFloat())
            canvas.concat(tmp)
            canvas.translate(-v.left - v.translationX, -v.top - v.translationY)
        }
        val l = v.left + v.translationX
        val t = v.top + v.translationY
        if (reveal != null) {
            // 줄이 원형으로 펼쳐지는 것과 같은 원으로 잘라 그린다 (같은 시작 시각·길이·곡선으로 계산)
            val elapsed = SystemClock.uptimeMillis() - reveal.startAt
            val f = if (reveal.duration <= 0) 1f else (elapsed.toFloat() / reveal.duration).coerceIn(0f, 1f)
            if (f >= 1f) {
                RowFx.reveal.remove(v)
            } else {
                val r = (reveal.radius * reveal.interpolator.getInterpolation(f)).coerceAtLeast(0f)
                path.reset()
                path.addCircle(l + reveal.cx, t + reveal.cy, r, Path.Direction.CW)
                canvas.clipPath(path)
            }
        }
        if (faded) {
            canvas.saveLayerAlpha(l, t, l + v.width, t + v.height, (v.alpha.coerceIn(0f, 1f) * 255).toInt())
        }
        return save
    }

    private val path = Path()
    private val nodes = WeakHashMap<View, RenderNode>()
}
