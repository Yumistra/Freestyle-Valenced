@file:JvmName("StickerWithTextPlugin")

package io.github.yumistra.stickerwithtext

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.util.Base64
import app.valenced.plugins.PluginBuilder
import app.valenced.plugins.PluginScope
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeMethod
import java.io.ByteArrayOutputStream

/**
 * 움직이는(Lottie) 스티커의 한 장면을 디스코드 앱 안의 Lottie 그리기(com.airbnb.lottie)로
 * 그려 PNG(base64)로 돌려준다. 디스코드가 채팅에서 그리는 것과 똑같이 보인다.
 * 디스코드 앱의 클래스를 직접 부르므로 이름은 리플렉션으로 찾는다.
 * (람다 대신 객체로 써서 kotlin.jvm.internal.Lambda 에 기대지 않는다)
 */
private object State {
    var loader: ClassLoader? = null
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

/** args: [json, size, progress] → base64 PNG */
private object RenderLottie : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? {
        val json = args.getOrNull(0) as? String ?: throw IllegalArgumentException("no json")
        val size = (args.getOrNull(1) as? Number)?.toInt()?.coerceIn(32, 512) ?: 160
        val progress = (args.getOrNull(2) as? Number)?.toFloat()?.coerceIn(0f, 1f) ?: 0.4f
        val cl = State.loader ?: throw IllegalStateException("not started")

        val factory = cl.loadClass("com.airbnb.lottie.LottieCompositionFactory")
        val fromJson = method(factory, "fromJsonStringSync", 2) ?: throw IllegalStateException("fromJsonStringSync missing")
        val result = fromJson.invoke(null, json, "swt-" + json.length + "-" + json.hashCode())
            ?: throw IllegalStateException("no result")
        val composition = method(result.javaClass, "getValue", 0)?.invoke(result)
            ?: throw IllegalStateException("bad lottie: " + method(result.javaClass, "getException", 0)?.invoke(result))

        val drawableCls = cl.loadClass("com.airbnb.lottie.LottieDrawable")
        val drawable = drawableCls.getDeclaredConstructor().newInstance() as Drawable
        val setComposition = method(drawableCls, "setComposition", 1) ?: throw IllegalStateException("setComposition missing")
        setComposition.invoke(drawable, composition)
        method(drawableCls, "setProgress", 1)?.invoke(drawable, progress)

        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        // 원래 크기 비율을 지키며 가운데에
        val w = drawable.intrinsicWidth.takeIf { it > 0 } ?: size
        val h = drawable.intrinsicHeight.takeIf { it > 0 } ?: size
        val scale = minOf(size.toFloat() / w, size.toFloat() / h)
        val dw = (w * scale).toInt()
        val dh = (h * scale).toInt()
        val left = (size - dw) / 2
        val top = (size - dh) / 2
        drawable.setBounds(left, top, left + dw, top + dh)
        drawable.draw(canvas)

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
    }
}

private object OnStop : Function1<PluginScope, Unit> {
    override fun invoke(scope: PluginScope) {
        State.loader = null
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
