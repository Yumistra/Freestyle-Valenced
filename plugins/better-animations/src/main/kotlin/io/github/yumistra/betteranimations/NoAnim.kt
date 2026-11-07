package io.github.yumistra.betteranimations

import android.animation.ValueAnimator
import android.content.Context
import android.view.View
import android.view.animation.Animation
import android.view.animation.AnimationSet
import android.view.animation.AnimationUtils
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedHelpers
import org.json.JSONObject
import java.io.File

/**
 * "No animations": 폰의 "애니메이션 제거"를 디스코드 안에서만 켠 것처럼 한다.
 *  - ValueAnimator 길이 배율을 0 으로 (안드로이드 애니메이터가 바로 끝난다)
 *  - 화면 전환 같은 View 애니메이션(Animation)은 길이를 0 으로 바꿔 바로 끝나게
 * JS 설정의 storage.json "noAnimations" 를 읽는다.
 */
internal object NoAnim {
    @Volatile
    var on = false
        private set

    /** 켜기 전 배율 (끌 때 돌려 놓는다) */
    private var savedScale: Float? = null

    fun read(dir: File): Boolean = try {
        val file = File(dir, "storage.json")
        file.isFile && JSONObject(file.readText()).optBoolean("noAnimations", false)
    } catch (e: Throwable) {
        false
    }

    fun set(value: Boolean) {
        on = value
        try {
            val get = ValueAnimator::class.java.getDeclaredMethod("getDurationScale")
            val put = ValueAnimator::class.java.getDeclaredMethod("setDurationScale", java.lang.Float.TYPE)
            get.isAccessible = true
            put.isAccessible = true
            if (value) {
                if (savedScale == null) savedScale = get.invoke(null) as? Float ?: 1f
                put.invoke(null, 0f)
            } else {
                savedScale?.let { put.invoke(null, it) }
                savedScale = null
            }
        } catch (e: Throwable) {
        }
    }

    /** 애니메이션(묶음 포함)을 바로 끝나게 */
    private fun instant(a: Animation) {
        try {
            a.duration = 0L
            a.startOffset = 0L
            if (a is AnimationSet) for (c in a.animations) instant(c)
        } catch (e: Throwable) {
        }
    }

    fun hook(): List<XC_MethodHook.Unhook> {
        val out = ArrayList<XC_MethodHook.Unhook>()
        try {
            out += XposedHelpers.findAndHookMethod(
                AnimationUtils::class.java,
                "loadAnimation",
                Context::class.java,
                Integer.TYPE,
                object : XC_MethodHook() {
                    override fun afterHookedMethod(param: MethodHookParam) {
                        if (!on) return
                        (param.result as? Animation)?.let { instant(it) }
                    }
                },
            )
        } catch (e: Throwable) {
        }
        try {
            out += XposedHelpers.findAndHookMethod(
                View::class.java,
                "startAnimation",
                Animation::class.java,
                object : XC_MethodHook() {
                    override fun beforeHookedMethod(param: MethodHookParam) {
                        if (!on) return
                        (param.args[0] as? Animation)?.let { instant(it) }
                    }
                },
            )
        } catch (e: Throwable) {
        }
        return out
    }
}
