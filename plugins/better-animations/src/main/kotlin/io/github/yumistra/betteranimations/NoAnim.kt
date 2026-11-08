package io.github.yumistra.betteranimations

import de.robv.android.xposed.XC_MethodHook
import org.json.JSONObject
import java.io.File

/**
 * "No animations": 폰의 "애니메이션 제거"를 디스코드 안에서만 켠 것처럼 한다.
 *  - 네이티브는 메시지 효과, 밀림, 튕기기만 끈다 (BetterAnimationsPlugin.loadConfig)
 * JS 설정의 storage.json "noAnimations" 를 읽는다.
 */
internal object NoAnim {
    @Volatile
    var on = false
        private set

    fun read(dir: File): Boolean = try {
        val file = File(dir, "storage.json")
        file.isFile && JSONObject(file.readText()).optBoolean("noAnimations", false)
    } catch (e: Throwable) {
        false
    }

    // 안드로이드 전체 애니메이터 배율(ValueAnimator durationScale)은 건드리지 않는다.
    // 0 으로 두면 화면 뒤로 가기(예측 뒤로 가기 포함)가 끝나지 않아 회색 빈 화면이 남는 일이 있었다.
    fun set(value: Boolean) {
        on = value
    }

    /**
     * 화면 전환(View 애니메이션)을 0 으로 줄이던 훅은 뺐다. 프래그먼트 전환이 끝나지 않아
     * 뒤로 가면 회색 빈 화면이 남는 일이 있었다. 화면 전환은 JS 쪽 "동작 줄이기"로 줄인다.
     */
    @Suppress("UNUSED_PARAMETER")
    fun hook(): List<XC_MethodHook.Unhook> = emptyList()
}
