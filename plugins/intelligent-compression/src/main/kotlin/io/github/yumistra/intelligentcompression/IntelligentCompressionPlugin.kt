@file:JvmName("IntelligentCompressionPlugin")

package io.github.yumistra.intelligentcompression

import android.content.Context
import app.valenced.plugins.PluginBuilder
import app.valenced.plugins.PluginScope
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeMethod

/**
 * Intelligent Compression 네이티브 부분.
 *  - info(uri): 파일 크기·종류·이름 (JSON)
 *  - image(uri, targetBytes): 사진을 targetBytes 이하에서 가장 큰(=가장 좋은) JPEG 로. 백그라운드에서 돌고 작업 번호를 돌려준다
 *  - job(id): 그 작업 상태 (JSON)
 *  - audio(uri, bitrate) / audioJob(id): 영상의 소리만 그 비트레이트로 다시 인코딩 (Audio.kt)
 * (람다 대신 객체로 써서 kotlin 표준 라이브러리 람다 클래스에 기대지 않는다)
 */
internal object Ctx {
    @Volatile
    var context: Context? = null
}

private object Info : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Files.info(args[0].toString())
}

private object Image : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? {
        val target = (args[1] as Number).toLong()
        return Images.start(args[0].toString(), target)
    }
}

private object Job : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Images.job(args[0].toString())
}

private object AudioStart : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Audio.start(args[0].toString(), (args[1] as Number).toInt())
}

private object AudioJob : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Audio.job(args[0].toString())
}

/** config(limit, images, videos): JS 가 지금 채널의 업로드 한도와 설정을 알려 준다 */
private object SetConfig : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? {
        val limit = (args[0] as Number).toLong()
        if (limit > 0) Config.limit = limit
        if (args.size > 1) Config.images = args[1] == true
        if (args.size > 2) Config.videos = args[2] == true
        if (args.size > 3 && args[3] is String) Config.codec = args[3] as String
        return Diag.json(hooked)
    }
}

@Volatile
private var hooked = ""
private val unhooks = java.util.ArrayList<de.robv.android.xposed.XC_MethodHook.Unhook>()

private object TakeToasts : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Resolve.takeToasts()
}

private object KeepContext : Function1<Context, Unit> {
    override fun invoke(ctx: Context) {
        Ctx.context = ctx.applicationContext ?: ctx
    }
}

private object OnStart : Function1<PluginScope, Unit> {
    override fun invoke(scope: PluginScope) {
        scope.withAppContext(KeepContext)
        scope.registerNativeMethod("yumistra.intelligent-compression.info", Info)
        scope.registerNativeMethod("yumistra.intelligent-compression.image", Image)
        scope.registerNativeMethod("yumistra.intelligent-compression.job", Job)
        scope.registerNativeMethod("yumistra.intelligent-compression.audio", AudioStart)
        scope.registerNativeMethod("yumistra.intelligent-compression.audioJob", AudioJob)
        scope.registerNativeMethod("yumistra.intelligent-compression.config", SetConfig)
        scope.registerNativeMethod("yumistra.intelligent-compression.toasts", TakeToasts)
        // 디스코드가 파일을 준비하는 곳 (Resolve.kt)
        try {
            Resolve.loader = scope.classLoader
            val c = scope.classLoader.loadClass("com.discord.media.MediaManagerModule")
            val ms = c.declaredMethods
            var resolve: java.lang.reflect.Method? = null
            var i = 0
            while (i < ms.size) {
                val m = ms[i++]
                if (m.name == "resolveToMediaFilePath" && m.parameterTypes.size == 3) resolve = m
            }
            if (resolve != null) {
                Resolve.resolveMethod = resolve
                unhooks.add(de.robv.android.xposed.XposedBridge.hookMethod(resolve, OnResolve))
                val names = StringBuilder("resolveToMediaFilePath")
                i = 0
                while (i < ms.size) {
                    val m = ms[i++]
                    // 안드로이드에선 거부만 하는 compressVideo 도 같은 식으로 처리 (디스코드가 file:// 영상에 부르는 경우)
                    if (m.name == "compressVideo" && m.parameterTypes.size == 3) {
                        unhooks.add(de.robv.android.xposed.XposedBridge.hookMethod(m, OnResolve))
                        names.append(", compressVideo")
                    }
                }
                hooked = names.toString()
            } else {
                hooked = "resolveToMediaFilePath not found"
            }
        } catch (t: Throwable) {
            hooked = "error: " + t
        }
    }
}

private object OnStop : Function1<PluginScope, Unit> {
    override fun invoke(scope: PluginScope) {
        var i = 0
        while (i < unhooks.size) unhooks[i++].unhook()
        unhooks.clear()
    }
}

private object Build : Function1<PluginBuilder, Unit> {
    override fun invoke(b: PluginBuilder) {
        b.start(OnStart)
        b.stop(OnStop)
    }
}

@Suppress("UNUSED")
val intelligentCompressionPlugin = plugin(Build)
