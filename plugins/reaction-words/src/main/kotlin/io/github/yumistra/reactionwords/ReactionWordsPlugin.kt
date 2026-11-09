@file:JvmName("ReactionWordsPlugin")

package io.github.yumistra.reactionwords

import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.View
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeMethod
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedBridge
import de.robv.android.xposed.XposedHelpers
import java.lang.reflect.Method
import java.util.WeakHashMap

/**
 * Reaction Words 의 네이티브 부분: 반응 줄 끝의 "반응 추가" 버튼에 꾹 누르기를 붙인다.
 *
 * 디스코드는 이 버튼에 누르기만 있고 꾹 누르기가 없어서 JS 로는 알 수 없다.
 * 반응 줄(ShortcutsFlexbox.setReactions)이 그려질 때 받은 "반응 꾹 누르기" 함수를 기억해 두었다가,
 * 버튼을 꾹 누르면 "이건 반응 추가 버튼이다" 표시를 남기고 첫 번째 반응으로 그 함수를 부른다.
 * 그러면 디스코드가 JS 에 어느 메시지인지 알려 주고, JS 는 takeAddLongPress 로 표시를 확인해
 * 반응 목록을 여는 대신 달린 이모지 전부로 반응한다.
 */

private const val FLEXBOX = "com.discord.reactions.ShortcutsFlexbox"
private const val NESTED = "com.discord.react_gesture_handler.nested_touch.NestedScrollOnTouchUtilsKt"
/** 표시가 이보다 오래되면 무시한다 */
private const val PENDING_TTL = 3000L

private class Row(val first: Any, val longPress: Any)

private fun invoke1(fn: Any, arg: Any?) {
    val m: Method = fn.javaClass.methods.first { it.name == "invoke" && it.parameterTypes.size == 1 }
    m.isAccessible = true
    m.invoke(fn, arg)
}

val reactionWordsPlugin = plugin {
    var unhooks = emptyList<XC_MethodHook.Unhook>()

    start {
        val cl = classLoader
        val rows = WeakHashMap<View, Row>()
        val hooked = WeakHashMap<View, Boolean>()
        var pendingAt = 0L

        // 디스코드가 반응에 꾹 누르기를 붙일 때 쓰는 방법 (스크롤과 안 겹치게 해 준다). 없으면 기본 방법
        val nested: Method? = try {
            cl.loadClass(NESTED).declaredMethods.firstOrNull { it.name == "setOnLongClickListenerNested\$default" }?.apply { isAccessible = true }
        } catch (e: Throwable) {
            null
        }

        fun attach(addView: View) {
            if (hooked[addView] == true) return
            hooked[addView] = true
            val listener = View.OnLongClickListener { v ->
                try {
                    // 버튼이 들어 있는 반응 줄을 찾는다
                    var p: Any? = v.parent
                    var row: Row? = null
                    while (p is View) {
                        row = rows[p]
                        if (row != null) break
                        p = p.parent
                    }
                    if (row == null) return@OnLongClickListener false
                    pendingAt = SystemClock.uptimeMillis()
                    v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                    invoke1(row.longPress, row.first)
                    true
                } catch (e: Throwable) {
                    log.e("long press: $e")
                    pendingAt = 0L
                    false
                }
            }
            try {
                if (nested != null) nested.invoke(null, addView, false, listener, 2, null)
                else addView.setOnLongClickListener(listener)
            } catch (e: Throwable) {
                addView.setOnLongClickListener(listener)
            }
        }

        val hooks = ArrayList<XC_MethodHook.Unhook>()
        try {
            val flexbox = cl.loadClass(FLEXBOX)
            hooks.addAll(
                XposedBridge.hookAllMethods(
                    flexbox,
                    "setReactions",
                    object : XC_MethodHook() {
                        override fun afterHookedMethod(param: MethodHookParam) {
                            try {
                                val box = param.thisObject as? View ?: return
                                val list = param.args.firstOrNull { it is List<*> } as? List<*>
                                // 매개변수 중 Function1 두 개: 누르기, 꾹 누르기 순서
                                val types = (param.method as Method).parameterTypes
                                val fns = types.indices.filter { types[it].name == "kotlin.jvm.functions.Function1" }.mapNotNull { param.args[it] }
                                val first = list?.firstOrNull()
                                if (first == null || fns.size < 2) {
                                    rows.remove(box)
                                    return
                                }
                                rows[box] = Row(first, fns[1])
                                val add = XposedHelpers.getObjectField(box, "addReactionView") as? View ?: return
                                attach(add)
                            } catch (e: Throwable) {
                                log.e("setReactions: $e")
                            }
                        }
                    },
                ),
            )
            log.i("Hooked ${flexbox.name}.setReactions (nested=${nested != null})")
        } catch (e: Throwable) {
            log.e("Reactions row not found: $e")
        }
        unhooks = hooks

        /** 방금 반응 추가 버튼을 꾹 눌렀는지 (한 번 읽으면 지운다) */
        registerNativeMethod("${manifest.id}.takeAddLongPress") {
            val ok = pendingAt != 0L && SystemClock.uptimeMillis() - pendingAt < PENDING_TTL
            pendingAt = 0L
            ok
        }
        registerNativeMethod("${manifest.id}.ping") { "pong" }
    }

    stop {
        for (u in unhooks) try {
            u.unhook()
        } catch (e: Throwable) {
        }
        unhooks = emptyList()
    }
}
