@file:JvmName("StickerWithTextPlugin")

package io.github.yumistra.stickerwithtext

import android.graphics.Bitmap
import android.view.inputmethod.InputMethodManager
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import android.util.Base64
import app.valenced.plugins.PluginBuilder
import app.valenced.plugins.PluginScope
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeMethod
import java.io.ByteArrayOutputStream

/**
 * 움직이는(Lottie) 스티커의 한 장면을 디스코드 앱이 스티커를 그릴 때 쓰는 rlottie 로
 * 그려 PNG(base64)로 돌려준다. 디스코드가 채팅에서 그리는 것과 똑같이 보인다.
 * 디스코드 앱의 클래스를 직접 부르므로 이름은 리플렉션으로 찾는다.
 * (람다 대신 객체로 써서 kotlin.jvm.internal.Lambda 에 기대지 않는다)
 */
private object State {
    var loader: ClassLoader? = null
    @Volatile var suppressUntil = 0L
    var unhooks: Set<XC_MethodHook.Unhook> = emptySet()
}

/** 스티커를 고른 직후 잠깐은 폰 글자 키보드(IME)가 아예 뜨지 않게 showSoftInput 을 막는다 */
private object BlockShow : XC_MethodHook() {
    override fun beforeHookedMethod(param: MethodHookParam) {
        if (System.currentTimeMillis() < State.suppressUntil) param.result = false
    }
}

/** 안드로이드 11 부터는 RN 입력창이 WindowInsetsController.show(ime) 로 키보드를 띄운다. 그것도 막는다 */
private object BlockInsetsShow : XC_MethodHook() {
    override fun beforeHookedMethod(param: MethodHookParam) {
        if (System.currentTimeMillis() >= State.suppressUntil) return
        val types = param.args.getOrNull(0) as? Int ?: return
        val ime = try {
            android.view.WindowInsets.Type.ime()
        } catch (_: Throwable) {
            8
        }
        if (types and ime != 0) param.result = null
    }
}

private object SuppressIme : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? {
        val ms = (args.getOrNull(0) as? Number)?.toLong()?.coerceIn(0L, 3000L) ?: 1000L
        State.suppressUntil = System.currentTimeMillis() + ms
        return State.unhooks.isNotEmpty()
    }
}

private fun method(cls: Class<*>, name: String, argc: Int): java.lang.reflect.Method? {
    var c: Class<*>? = cls
    while (c != null) {
        val ms = c.declaredMethods
        var i = 0
        while (i < ms.size) {
            val m = ms[i++]
            if (m.name == name && m.parameterTypes.size == argc) {
                m.isAccessible = true
                return m
            }
        }
        c = c.superclass
    }
    return null
}

/**
 * 디스코드는 스티커를 com.discord.rlottie(텔레그램 rlottie) 로 그린다. 바깥 클래스 이름은 줄여져 있지만
 * 네이티브 함수들이 붙은 RLottieDrawable$Companion 은 이름이 그대로라 이것을 쓴다.
 *   createWithJson(json, name, params[3], colors) → 포인터, params[0] = 프레임 수
 *   getFrame(포인터, 프레임, bitmap, w, h, stride, clear)
 *   destroy(포인터)
 */
private object RLottie {
    var companion: Any? = null
    var create: java.lang.reflect.Method? = null
    var frame: java.lang.reflect.Method? = null
    var destroy: java.lang.reflect.Method? = null

    fun ready(cl: ClassLoader) {
        if (companion != null) return
        val comp = cl.loadClass("com.discord.rlottie.RLottieDrawable\$Companion")
        // 바깥 클래스를 초기화하면 네이티브 라이브러리가 올라온다
        var outer: Class<*>? = null
        try {
            outer = comp.declaringClass ?: comp.enclosingClass
            if (outer != null) Class.forName(outer.name, true, cl)
        } catch (_: Throwable) {
        }
        var inst: Any? = null
        try {
            val f = outer?.getDeclaredField("Companion")
            f?.isAccessible = true
            inst = f?.get(null)
        } catch (_: Throwable) {
        }
        // 이 Companion 에는 생성자가 없다 (R8 이 지웠다). 네이티브 함수는 this 를 쓰지 않으니 빈 객체를 만든다
        if (inst == null) {
            try {
                val unsafeCls = Class.forName("sun.misc.Unsafe")
                val f = unsafeCls.getDeclaredField("theUnsafe")
                f.isAccessible = true
                val unsafe = f.get(null)
                inst = unsafeCls.getMethod("allocateInstance", Class::class.java).invoke(unsafe, comp)
            } catch (_: Throwable) {
            }
        }
        if (inst == null) {
            val cs = comp.declaredConstructors
            var i = 0
            while (inst == null && i < cs.size) {
                val c = cs[i++]
                c.isAccessible = true
                try {
                    inst = if (c.parameterTypes.isEmpty()) c.newInstance() else c.newInstance(*arrayOfNulls<Any>(c.parameterTypes.size))
                } catch (_: Throwable) {
                }
            }
        }
        create = method(comp, "createWithJson", 4)
        frame = method(comp, "getFrame", 7)
        destroy = method(comp, "destroy", 1)
        if (inst == null || create == null || frame == null) throw IllegalStateException("rlottie not found (" + (if (inst == null) "no instance" else "no methods") + ")")
        companion = inst
    }
}

private fun empty(b: Bitmap): Boolean {
    val w = b.width
    val h = b.height
    var seen = 0
    var y = 0
    while (y < h) {
        var x = 0
        while (x < w) {
            if ((b.getPixel(x, y) ushr 24) > 20) seen++
            x += 4
        }
        y += 4
    }
    return seen < 4
}

/** args: [json, size, progress] → base64 PNG (디스코드가 그리는 것과 같은 모양) */
private object RenderLottie : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? {
        val json = args.getOrNull(0) as? String ?: throw IllegalArgumentException("no json")
        val size = (args.getOrNull(1) as? Number)?.toInt()?.coerceIn(32, 512) ?: 160
        val progress = (args.getOrNull(2) as? Number)?.toFloat()?.coerceIn(0f, 1f) ?: 0f
        val cl = State.loader ?: throw IllegalStateException("not started")
        RLottie.ready(cl)
        val params = IntArray(3)
        val ptr = (RLottie.create!!.invoke(RLottie.companion, json, "swt-" + json.hashCode(), params, null) as Number).toLong()
        if (ptr == 0L) throw IllegalStateException("bad lottie")
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        try {
            val frames = if (params[0] > 0) params[0] else 1
            // 처음 장면, 비어 있으면 몇 군데 더
            val tries = intArrayOf((frames * progress).toInt(), 0, frames * 2 / 5, frames / 2, frames / 4)
            var i = 0
            while (i < tries.size) {
                val f = tries[i++].coerceIn(0, frames - 1)
                bitmap.eraseColor(0)
                RLottie.frame!!.invoke(RLottie.companion, ptr, f, bitmap, size, size, bitmap.rowBytes, true)
                if (!empty(bitmap)) break
            }
        } finally {
            try {
                RLottie.destroy?.invoke(RLottie.companion, ptr)
            } catch (_: Throwable) {
            }
        }
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        bitmap.recycle()
        return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
}

private object OnStart : Function1<PluginScope, Unit> {
    override fun invoke(scope: PluginScope) {
        State.loader = scope.classLoader
        scope.registerNativeMethod("yumistra.sticker-with-text.renderLottie", RenderLottie)
        scope.registerNativeMethod("yumistra.sticker-with-text.suppressIme", SuppressIme)
        val hooks = HashSet<XC_MethodHook.Unhook>()
        try {
            hooks.addAll(XposedBridge.hookAllMethods(InputMethodManager::class.java, "showSoftInput", BlockShow))
        } catch (_: Throwable) {
        }
        for (name in arrayOf("android.view.InsetsController", "android.view.PendingInsetsController")) {
            try {
                hooks.addAll(XposedBridge.hookAllMethods(Class.forName(name), "show", BlockInsetsShow))
            } catch (_: Throwable) {
            }
        }
        State.unhooks = hooks
    }
}

private object OnStop : Function1<PluginScope, Unit> {
    override fun invoke(scope: PluginScope) {
        State.loader = null
        State.suppressUntil = 0L
        for (u in State.unhooks) try {
            u.unhook()
        } catch (_: Throwable) {
        }
        State.unhooks = emptySet()
    }
}

private object Build : Function1<PluginBuilder, Unit> {
    override fun invoke(b: PluginBuilder) {
        b.start(OnStart)
        b.stop(OnStop)
    }
}

@Suppress("UNUSED")
val stickerWithTextPlugin = plugin(Build)
