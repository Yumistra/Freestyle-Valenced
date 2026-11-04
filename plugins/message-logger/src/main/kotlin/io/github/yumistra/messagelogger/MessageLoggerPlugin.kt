@file:JvmName("MessageLoggerPlugin")

package io.github.yumistra.messagelogger

import android.text.SpannableStringBuilder
import app.valenced.plugins.PluginBuilder
import app.valenced.plugins.PluginScope
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeMethod
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge

/**
 * 메시지 글이 화면에 들어가기 직전(SimpleDraweeSpanTextView.setDraweeSpanStringBuilder)에
 * JS 가 넣어 둔 표시를 디스코드의 "(수정됨)"·시간 글자와 같은 모양으로 바꾼다 (Markers.kt).
 * (람다 대신 객체로 써서 kotlin.jvm.internal.Lambda 에 기대지 않는다)
 */
private object Hooks {
    var unhook: XC_MethodHook.Unhook? = null
    var decoUnhook: XC_MethodHook.Unhook? = null
    val pushUnhooks = ArrayList<XC_MethodHook.Unhook>()

    fun start(scope: PluginScope) {
        // 알림으로 온 메시지 기록 (화면이 없어도 되니 먼저)
        try {
            Pushes.file = java.io.File(scope.storageDir, "pushed.jsonl")
            scope.registerNativeMethod("yumistra.message-logger.takePushed", TakePushed)
            scope.registerNativeMethod("yumistra.message-logger.tray", ReadTray)
            scope.registerNativeMethod("yumistra.message-logger.status", Status)
            scope.withAppContext(KeepContext)
            val client = scope.classLoader.loadClass("com.discord.notifications.client.NotificationClient")
            val ms = client.declaredMethods
            var k = 0
            val names = StringBuilder()
            while (k < ms.size) {
                val m = ms[k++]
                // 알림 데이터(Map)를 받는 곳 전부: 푸시(onNotificationReceived), 앱이 띄우는 알림(showLocalNotification), 공통(showNotification)
                if (m.name != "onNotificationReceived" && m.name != "showNotification" && m.name != "showLocalNotification") continue
                val p = m.parameterTypes
                var mapAt = -1
                var q = 0
                while (q < p.size) {
                    if (Map::class.java.isAssignableFrom(p[q]) && mapAt < 0) mapAt = q
                    q++
                }
                if (mapAt < 0) continue
                pushUnhooks.add(XposedBridge.hookMethod(m, OnPush(mapAt)))
                if (names.length > 0) names.append(", ")
                names.append(m.name)
            }
            Diag.hooked = names.toString()
        } catch (t: Throwable) {
            Diag.error = t.toString()
        }
        // 새 디스코드에는 NotificationClient 가 없다 → 푸시를 받는 서비스(onMessageReceived)에서 직접
        if (pushUnhooks.isEmpty()) {
            try {
                val svc = scope.classLoader.loadClass("com.discord.notifications.service.NotificationService")
                val ms = svc.declaredMethods
                var k = 0
                while (k < ms.size) {
                    val m = ms[k++]
                    if (m.name == "onMessageReceived" && m.parameterTypes.size == 1) {
                        pushUnhooks.add(XposedBridge.hookMethod(m, OnPush(0)))
                        Diag.hooked = "NotificationService.onMessageReceived"
                        Diag.error = ""
                    }
                }
            } catch (t: Throwable) {
                Diag.error = t.toString()
            }
        }
        val view = scope.classLoader.loadClass("com.facebook.drawee.span.SimpleDraweeSpanTextView")
        val methods = view.declaredMethods
        var set: java.lang.reflect.Method? = null
        var i = 0
        while (i < methods.size) {
            val m = methods[i++]
            if (m.name == "setDraweeSpanStringBuilder" && m.parameterTypes.size == 1) set = m
        }
        try {
            RowBackground.listClass = scope.classLoader.loadClass("androidx.recyclerview.widget.RecyclerView")
            Diag.deco = true
        } catch (t: Throwable) {
            Diag.error = t.toString()
        }
        unhook = XposedBridge.hookMethod(set ?: return, Before)
    }

    fun stop() {
        unhook?.unhook()
        unhook = null
        decoUnhook?.unhook()
        decoUnhook = null
        var i = 0
        while (i < pushUnhooks.size) pushUnhooks[i++].unhook()
        pushUnhooks.clear()
    }
}

private object Before : XC_MethodHook() {
    override fun beforeHookedMethod(param: MethodHookParam) {
        val text = param.args[0] as? SpannableStringBuilder ?: return
        try {
            styleMarkers(text, param.thisObject as? android.view.View)
        } catch (_: Throwable) {
        }
        try {
            RowBackground.update(param.thisObject as? android.view.View)
        } catch (_: Throwable) {
        }
    }
}

private object TakePushed : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Pushes.take()
}

private object ReadTray : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Tray.read()
}

private object Status : Function1<List<Any?>, Any?> {
    override fun invoke(args: List<Any?>): Any? = Diag.json()
}

private object KeepContext : Function1<android.content.Context, Unit> {
    override fun invoke(ctx: android.content.Context) {
        Tray.context = ctx.applicationContext ?: ctx
    }
}

private object OnStart : Function1<PluginScope, Unit> {
    override fun invoke(scope: PluginScope) = Hooks.start(scope)
}

private object OnStop : Function1<PluginScope, Unit> {
    override fun invoke(scope: PluginScope) = Hooks.stop()
}

private object Build : Function1<PluginBuilder, Unit> {
    override fun invoke(b: PluginBuilder) {
        b.start(OnStart)
        b.stop(OnStop)
    }
}

@Suppress("UNUSED")
val messageLoggerPlugin = plugin(Build)
