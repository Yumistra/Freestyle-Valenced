@file:JvmName("VoiceOverlayPlugin")

package io.github.yumistra.voiceoverlay

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AndroidAppHelper
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeMethod
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedHelpers
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Voice Overlay 의 네이티브 부분: PC 오버레이처럼 다른 앱(게임 등) 위에 음성 채널 사람들을 띄운다.
 * 동그란 프로필 사진(말하면 초록 테두리) + 이름 칸. JS 가 사람 목록을 update 로 보낸다.
 *
 * 다른 앱 위에 그리려면 "다른 앱 위에 표시" 권한이 필요하다. 권한이 없으면 디스코드 안에서만 보인다.
 */

private data class Person(val id: String, val name: String, val avatar: String?, val speaking: Boolean, val muted: Boolean, val deafened: Boolean)

private val main = Handler(Looper.getMainLooper())
private val pool = Executors.newFixedThreadPool(3)
private val bitmaps = ConcurrentHashMap<String, Bitmap>()
private val loading = ConcurrentHashMap.newKeySet<String>()

@Volatile private var people: List<Person> = emptyList()
@Volatile private var enabled = false
@Volatile private var onlySpeaking = false
@Volatile private var hideInDiscord = true
@Volatile private var scale = 1f
@Volatile private var opacity = 1f
@Volatile private var posX = 24
@Volatile private var posY = 200
@Volatile private var lastError = ""

/** 지금 화면에 있는 디스코드 화면 (앱 안에서만 띄울 때 쓴다) */
private var resumed: Activity? = null
private var root: LinearLayout? = null
private var attachedTo: WindowManager? = null
private var attachedSystem = false
private var onPosition: ((Int, Int) -> Unit)? = null

private fun ctx(): Context? = try {
    AndroidAppHelper.currentApplication()
} catch (e: Throwable) {
    null
}

private fun canOverlay(c: Context) = Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(c)

private fun dp(c: Context, v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.resources.displayMetrics).toInt()

/** 동그랗게 자른 프로필 사진 */
private fun circle(src: Bitmap): Bitmap {
    val size = minOf(src.width, src.height)
    val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val c = Canvas(out)
    val p = Paint(Paint.ANTI_ALIAS_FLAG)
    p.shader = BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP)
    c.translate(-(src.width - size) / 2f, -(src.height - size) / 2f)
    c.drawCircle(src.width / 2f, src.height / 2f, size / 2f, p)
    return out
}

private fun loadAvatar(url: String) {
    if (bitmaps.containsKey(url) || !loading.add(url)) return
    pool.execute {
        try {
            URL(url).openStream().use { s ->
                BitmapFactory.decodeStream(s)?.let { bitmaps[url] = circle(it) }
            }
        } catch (e: Throwable) {
            lastError = "avatar: $e"
        } finally {
            loading.remove(url)
            main.post { render() }
        }
    }
}

/** 사진 칸: 사진 + 말할 때 초록 테두리 */
private class AvatarView(c: Context) : View(c) {
    var bmp: Bitmap? = null
    var speaking = false
    var initial = "?"
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val ring = w * 0.07f
        val r = w / 2f
        // 테두리 (말하면 초록, 아니면 어두운 회색)
        p.style = Paint.Style.FILL
        p.color = if (speaking) Color.rgb(35, 165, 90) else Color.argb(160, 30, 31, 34)
        canvas.drawCircle(r, r, r, p)
        val inner = r - ring
        val b = bmp
        if (b != null) {
            val dst = android.graphics.RectF(r - inner, r - inner, r + inner, r + inner)
            canvas.drawBitmap(b, null, dst, p)
        } else {
            p.color = Color.rgb(88, 101, 242)
            canvas.drawCircle(r, r, inner, p)
            p.color = Color.WHITE
            p.textSize = inner
            p.textAlign = Paint.Align.CENTER
            p.typeface = Typeface.DEFAULT_BOLD
            canvas.drawText(initial, r, r + inner / 3f, p)
        }
    }
}

@SuppressLint("ClickableViewAccessibility")
private fun ensureRoot(c: Context): LinearLayout {
    root?.let { return it }
    val l = LinearLayout(c)
    l.orientation = LinearLayout.VERTICAL
    // 끌어서 옮기기
    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    l.setOnTouchListener { v, e ->
        val lp = v.layoutParams as? WindowManager.LayoutParams ?: return@setOnTouchListener false
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = e.rawX
                downY = e.rawY
                startX = lp.x
                startY = lp.y
                true
            }
            MotionEvent.ACTION_MOVE -> {
                lp.x = startX + (e.rawX - downX).toInt()
                lp.y = startY + (e.rawY - downY).toInt()
                try {
                    attachedTo?.updateViewLayout(v, lp)
                } catch (x: Throwable) {
                }
                true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                posX = lp.x
                posY = lp.y
                onPosition?.invoke(posX, posY)
                true
            }
            else -> false
        }
    }
    root = l
    return l
}

private fun detach() {
    val r = root ?: return
    try {
        attachedTo?.removeView(r)
    } catch (e: Throwable) {
    }
    attachedTo = null
}

/** 지금 상태대로 다시 그린다 (메인 스레드) */
private fun render() {
    val c = ctx() ?: return
    val inDiscord = resumed != null
    val shown = people.filter { !onlySpeaking || it.speaking }
    val system = canOverlay(c)
    val want = enabled && shown.isNotEmpty() && (if (inDiscord) !hideInDiscord || !system else system)
    if (!want) {
        detach()
        return
    }
    val r = ensureRoot(c)
    // 붙일 곳: 권한이 있으면 다른 앱 위, 없으면 디스코드 화면 위
    val wm: WindowManager? = if (system) c.getSystemService(Context.WINDOW_SERVICE) as WindowManager else resumed?.windowManager
    if (wm == null) {
        detach()
        return
    }
    if (attachedTo !== wm || attachedSystem != system) {
        detach()
        val type = if (system) {
            if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
        } else WindowManager.LayoutParams.TYPE_APPLICATION
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        )
        lp.gravity = Gravity.TOP or Gravity.START
        lp.x = posX
        lp.y = posY
        try {
            wm.addView(r, lp)
            attachedTo = wm
            attachedSystem = system
        } catch (e: Throwable) {
            lastError = "attach: $e"
            return
        }
    }
    r.alpha = opacity
    // 사람 줄을 다시 만든다 (많아야 수십 명)
    r.removeAllViews()
    val size = dp(c, 40f * scale)
    val gap = dp(c, 6f * scale)
    for (p in shown) {
        val row = LinearLayout(c)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        val av = AvatarView(c)
        av.speaking = p.speaking
        av.initial = p.name.take(1).uppercase()
        p.avatar?.let { url ->
            av.bmp = bitmaps[url]
            if (av.bmp == null) loadAvatar(url)
        }
        row.addView(av, LinearLayout.LayoutParams(size, size))
        val name = TextView(c)
        val mark = when {
            p.deafened -> " 🔇"
            p.muted -> " 🎙️⃠"
            else -> ""
        }
        name.text = p.name + mark
        name.setTextColor(if (p.speaking) Color.WHITE else Color.argb(220, 230, 230, 235))
        name.textSize = 14f * scale
        name.typeface = Typeface.DEFAULT_BOLD
        name.maxLines = 1
        name.ellipsize = TextUtils.TruncateAt.END
        name.maxWidth = dp(c, 180f * scale)
        val pill = GradientDrawable()
        pill.cornerRadius = dp(c, 14f * scale).toFloat()
        pill.setColor(Color.argb(200, 20, 21, 24))
        name.background = pill
        name.setPadding(dp(c, 12f * scale), dp(c, 5f * scale), dp(c, 12f * scale), dp(c, 5f * scale))
        val nlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        nlp.leftMargin = gap
        row.addView(name, nlp)
        val rlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        rlp.bottomMargin = gap
        r.addView(row, rlp)
    }
}

val voiceOverlayPlugin = plugin {
    var unhooks = emptyList<XC_MethodHook.Unhook>()

    start {
        // 디스코드 화면이 앞에 있는지 (디스코드 안에서는 숨기기)
        val hooks = mutableListOf<XC_MethodHook.Unhook>()
        try {
            hooks += XposedHelpers.findAndHookMethod(Activity::class.java, "onResume", object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    resumed = param.thisObject as Activity
                    main.post { render() }
                }
            })
            hooks += XposedHelpers.findAndHookMethod(Activity::class.java, "onPause", object : XC_MethodHook() {
                override fun afterHookedMethod(param: MethodHookParam) {
                    if (resumed === param.thisObject) resumed = null
                    // 디스코드 안에서만 붙여 둔 창은 화면이 바뀌면 뗀다
                    if (!attachedSystem) main.post { detach() }
                    main.post { render() }
                }
            })
        } catch (e: Throwable) {
            lastError = "lifecycle hook: $e"
        }
        unhooks = hooks

        registerNativeMethod("${manifest.id}.update") { args ->
            try {
                val arr = JSONArray(args.getOrNull(0) as? String ?: "[]")
                val list = ArrayList<Person>()
                for (i in 0 until arr.length()) {
                    val o = arr.getJSONObject(i)
                    list += Person(
                        o.optString("id"),
                        o.optString("name"),
                        o.optString("avatar").takeIf { it.isNotBlank() },
                        o.optBoolean("speaking"),
                        o.optBoolean("muted"),
                        o.optBoolean("deafened"),
                    )
                }
                people = list
                main.post { render() }
                true
            } catch (e: Throwable) {
                lastError = "update: $e"
                false
            }
        }
        registerNativeMethod("${manifest.id}.config") { args ->
            try {
                val o = JSONObject(args.getOrNull(0) as? String ?: "{}")
                enabled = o.optBoolean("enabled", enabled)
                onlySpeaking = o.optBoolean("onlySpeaking", onlySpeaking)
                hideInDiscord = o.optBoolean("hideInDiscord", hideInDiscord)
                scale = o.optDouble("scale", scale.toDouble()).toFloat().coerceIn(0.5f, 2f)
                opacity = o.optDouble("opacity", opacity.toDouble()).toFloat().coerceIn(0.2f, 1f)
                if (o.has("x")) posX = o.optInt("x", posX)
                if (o.has("y")) posY = o.optInt("y", posY)
                main.post {
                    // 위치가 바뀌었으면 다시 붙인다
                    detach()
                    render()
                }
                true
            } catch (e: Throwable) {
                lastError = "config: $e"
                false
            }
        }
        /** 끌어서 옮긴 위치 (JS 가 저장해 둔다) */
        registerNativeMethod("${manifest.id}.position") { listOf(posX, posY) }
        registerNativeMethod("${manifest.id}.canOverlay") { ctx()?.let { canOverlay(it) } ?: false }
        /** "다른 앱 위에 표시" 설정 화면을 연다 */
        registerNativeMethod("${manifest.id}.requestOverlay") {
            val c = ctx() ?: return@registerNativeMethod false
            try {
                val i = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${c.packageName}"))
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                c.startActivity(i)
                true
            } catch (e: Throwable) {
                lastError = "request: $e"
                false
            }
        }
        registerNativeMethod("${manifest.id}.status") {
            val c = ctx()
            mapOf(
                "canOverlay" to (c?.let { canOverlay(it) } ?: false),
                "attached" to (attachedTo != null),
                "overOtherApps" to attachedSystem,
                "inDiscord" to (resumed != null),
                "people" to people.size,
                "enabled" to enabled,
                "error" to lastError,
            )
        }
    }

    stop {
        for (u in unhooks) try {
            u.unhook()
        } catch (e: Throwable) {
        }
        unhooks = emptyList()
        enabled = false
        main.post { detach() }
    }
}
