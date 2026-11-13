@file:JvmName("VoiceOverlayPlugin")

package io.github.yumistra.voiceoverlay

import android.animation.ValueAnimator
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
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.SpannableStringBuilder
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeMethod
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedHelpers
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors

/**
 * Voice Overlay 의 네이티브 부분: PC 오버레이처럼 다른 앱(게임 등) 위에 음성 채널 사람들을 띄운다.
 *  - 사람 줄: 동그란 프로필 사진(말하면 초록 테두리) + 이름 칸. 말하지 않는 사람은 반투명 (부드럽게 바뀐다)
 *  - 맨 위 채팅 버튼: 디스코드 채팅처럼 생긴 간이 채팅 창
 *  - 길게 누르면 메뉴: 마이크 끄기, 헤드셋 끄기, 방송, 음성 채널 나가기
 * 아이콘은 디스코드 앱 안의 아이콘 그림을 이름으로 찾아 쓴다.
 * 다른 앱 위에 그리려면 "다른 앱 위에 표시" 권한이 필요하다. 없으면 디스코드 안에서만 보인다.
 */

private data class Person(val id: String, val name: String, val avatar: String?, val speaking: Boolean, val muted: Boolean, val deafened: Boolean, val live: Boolean = false)
private class ChatLine(val author: String, val color: Int, val avatar: String?, val time: String, val content: String, val head: Boolean)

private val main = Handler(Looper.getMainLooper())
private val pool = Executors.newFixedThreadPool(3)
private val bitmaps = ConcurrentHashMap<String, Bitmap>()
private val loading = ConcurrentHashMap.newKeySet<String>()

@Volatile private var people: List<Person> = emptyList()
@Volatile private var overlayOn = false
@Volatile private var onlySpeaking = false
@Volatile private var hideInDiscord = true
@Volatile private var scale = 1f
@Volatile private var opacity = 1f
@Volatile private var idleAlpha = 0.45f
/** 끌어서 옮기지 못하게 */
@Volatile private var locked = false
/** 터치가 오버레이를 지나 아래 앱으로 (FLAG_NOT_TOUCHABLE) */
@Volatile private var passThrough = false
/** 오버레이를 길게 누르면: menu, chat, off */
@Volatile private var longAction = "menu"
/** 채팅 버튼: tap, long, hidden */
@Volatile private var chatMode = "long"
private var builtChatMode = ""
/** 디스코드가 직접 띄우는 오버레이 창을 막는다 */
@Volatile private var hideDiscordOverlay = false
/** 우리 창을 붙이는 중 (막지 않게) */
private var addingOwn = false
/** 본 다른 오버레이 창 (로그용) */
private val foreignWindows = ConcurrentLinkedQueue<String>()
private fun addOwn(wm: WindowManager, v: View, lp: WindowManager.LayoutParams) {
    addingOwn = true
    try {
        wm.addView(v, lp)
    } finally {
        addingOwn = false
    }
}
private fun isOverlayType(t: Int) = t == 2038 || t == 2002 || t == 2003 || t == 2006 || t == 2007 || t == 2010
@Volatile private var posX = 24
@Volatile private var posY = 200
@Volatile private var lastError = ""
/** 내 상태 (메뉴 글자에 쓴다) */
@Volatile private var selfMute = false
@Volatile private var selfDeaf = false
@Volatile private var streaming = false

private var resumed: Activity? = null

/** JS 로 보낼 일 (JS 가 events 로 가져간다): action(name), chatOpen, chatClose, send(text) */
private val events = ConcurrentLinkedQueue<String>()
private fun emitEvent(type: String, extra: Map<String, Any?> = emptyMap()) {
    val o = JSONObject()
    o.put("type", type)
    for ((k, v) in extra) o.put(k, v)
    events.add(o.toString())
}

private fun ctx(): Context? = try {
    AndroidAppHelper.currentApplication()
} catch (e: Throwable) {
    null
}

private fun canOverlay(c: Context) = Build.VERSION.SDK_INT < 23 || Settings.canDrawOverlays(c)
private fun dp(c: Context, v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.resources.displayMetrics).toInt()

private fun overlayType(system: Boolean) = if (system) {
    if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
} else WindowManager.LayoutParams.TYPE_APPLICATION

private fun windowManager(c: Context): Pair<WindowManager, Boolean>? {
    val system = canOverlay(c)
    val wm = (if (system) c.getSystemService(Context.WINDOW_SERVICE) as WindowManager else resumed?.windowManager) ?: return null
    return wm to system
}

// ── 디스코드 아이콘 ──────────────────────────────────────────────
/**
 * 아이콘 이름 후보 (앞의 것부터). 디스코드(리액트 네이티브)의 아이콘 그림은 앱 리소스에
 * "…_microphoneicon" 처럼 경로를 이어 붙인 이름으로 들어 있어서, 이름 끝으로 찾는다
 */
private val ICONS = mapOf(
    "chat" to listOf("chaticon", "chatsmileicon", "textchannelicon"),
    "mic" to listOf("microphoneicon"),
    "micOff" to listOf("microphoneslashicon", "microphonemutedicon"),
    "headset" to listOf("headphonesicon", "headseticon"),
    "headsetOff" to listOf("headphonesslashicon", "headphonesdeafenedicon"),
    "stream" to listOf("screenarrowicon", "screensharestarticon", "screenicon"),
    "leave" to listOf("phonehangupicon", "phonecallendicon", "callendicon"),
    "close" to listOf("xsmallicon", "xlargeicon", "closesmallicon"),
    "send" to listOf("sendmessageicon", "sendicon", "arrowupicon"),
)
private val ICON_WORDS = ICONS

private val iconIds = ConcurrentHashMap<String, Int>()
private val iconNames = ConcurrentHashMap<String, String>()
private var allDrawables: List<String>? = null
/** 리소스 이름을 찾을 패키지 (R 클래스를 찾은 쪽) */
private var resPkg: String? = null

private fun resId(c: Context, name: String): Int {
    for (pkg in listOfNotNull(resPkg, c.packageName, "com.discord").distinct()) {
        val id = c.resources.getIdentifier(name, "drawable", pkg)
        if (id != 0) return id
    }
    return 0
}

private fun drawableNames(c: Context): List<String> {
    allDrawables?.let { return it }
    val out = ArrayList<String>()
    // 모드 앱은 패키지 이름이 바뀌어 있어서 원래 이름(com.discord)의 R 도 찾아본다
    for (pkg in listOf(c.packageName, "com.discord")) {
        try {
            val cls = Class.forName("$pkg.R\$drawable", false, c.classLoader)
            for (f in cls.fields) out += f.name
            resPkg = pkg
            break
        } catch (e: Throwable) {
            lastError = "R.drawable ($pkg): $e"
        }
    }
    // R 클래스가 줄여져 없으면 리소스 번호를 차례로 훑는다 (drawable 종류 번호를 찾아 그 안을 끝까지)
    if (out.isEmpty()) {
        try {
            val res = c.resources
            for (pkgId in listOf(0x7f)) {
                for (type in 1..0x40) {
                    val base = (pkgId shl 24) or (type shl 16)
                    val typeName = try {
                        res.getResourceTypeName(base)
                    } catch (e: Throwable) {
                        null
                    } ?: continue
                    if (typeName != "drawable") continue
                    var miss = 0
                    var i = 0
                    while (miss < 50 && i < 0xffff) {
                        try {
                            out += res.getResourceEntryName(base + i)
                            miss = 0
                        } catch (e: Throwable) {
                            miss++
                        }
                        i++
                    }
                    resPkg = try {
                        res.getResourcePackageName(base)
                    } catch (e: Throwable) {
                        resPkg
                    }
                }
            }
            if (out.isNotEmpty()) lastError = ""
        } catch (e: Throwable) {
            lastError = "scan: $e"
        }
    }
    allDrawables = out
    return out
}

private fun iconId(c: Context, key: String): Int {
    iconIds[key]?.let { return it }
    var found = 0
    var name = ""
    val all = drawableNames(c)
    for (want in ICONS[key].orEmpty()) {
        // 이름 끝이 "_microphoneicon" 이거나 그 자체 (짧은 것부터)
        val cand = all.filter { it == want || it.endsWith("_$want") }.sortedBy { it.length }
        for (n in cand) {
            val id = resId(c, n)
            if (id != 0) {
                found = id
                name = n
                break
            }
        }
        if (found != 0) break
    }
    iconIds[key] = found
    iconNames[key] = if (found == 0) "(none)" else name
    return found
}

private fun iconDrawable(c: Context, key: String, tint: Int): Drawable? = try {
    val id = iconId(c, key)
    if (id == 0) null else c.resources.getDrawable(id, c.theme)?.mutate()?.also { it.setTint(tint) }
} catch (e: Throwable) {
    null
}

/** 아이콘 칸 (못 찾으면 대신 글자) */
private fun iconView(c: Context, key: String, sizeDp: Float, tint: Int, fallback: String): View {
    val d = iconDrawable(c, key, tint)
    if (d != null) {
        val iv = ImageView(c)
        iv.setImageDrawable(d)
        iv.scaleType = ImageView.ScaleType.FIT_CENTER
        iv.layoutParams = LinearLayout.LayoutParams(dp(c, sizeDp), dp(c, sizeDp))
        return iv
    }
    val t = TextView(c)
    t.text = fallback
    t.setTextColor(tint)
    t.textSize = sizeDp * 0.7f
    t.gravity = Gravity.CENTER
    t.typeface = Typeface.DEFAULT_BOLD
    return t
}

// ── 프로필 사진 ─────────────────────────────────────────────────
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

private val waiting = ConcurrentHashMap<String, MutableList<AvatarView>>()
private fun loadAvatar(url: String, into: AvatarView) {
    bitmaps[url]?.let {
        into.bmp = it
        into.invalidate()
        return
    }
    waiting.getOrPut(url) { java.util.Collections.synchronizedList(ArrayList()) }.add(into)
    if (!loading.add(url)) return
    pool.execute {
        try {
            URL(url).openStream().use { s -> BitmapFactory.decodeStream(s)?.let { bitmaps[url] = circle(it) } }
        } catch (e: Throwable) {
            lastError = "avatar: $e"
        } finally {
            loading.remove(url)
            main.post {
                val b = bitmaps[url]
                waiting.remove(url)?.forEach {
                    it.bmp = b
                    it.invalidate()
                }
            }
        }
    }
}

/** 사진 칸: 사진 + 테두리 (말하면 초록, 부드럽게 바뀐다) */
private class AvatarView(c: Context) : View(c) {
    var bmp: Bitmap? = null
    var initial = "?"
    var ring = 0f
        set(v) {
            field = v
            invalidate()
        }
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private var anim: ValueAnimator? = null
    fun setSpeaking(on: Boolean, animate: Boolean) {
        val to = if (on) 1f else 0f
        if (!animate) {
            anim?.cancel()
            ring = to
            return
        }
        if (anim?.isRunning == true || ring == to) {
            if (ring == to) return
        }
        anim?.cancel()
        anim = ValueAnimator.ofFloat(ring, to).setDuration(160).also { a ->
            a.addUpdateListener { ring = it.animatedValue as Float }
            a.start()
        }
    }
    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val r = w / 2f
        val border = w * 0.07f
        // 테두리: 어두운 회색 → 초록
        val g = ring
        p.style = Paint.Style.FILL
        p.color = Color.argb((160 + 95 * g).toInt(), (30 + (35 - 30) * g).toInt(), (31 + (165 - 31) * g).toInt(), (34 + (90 - 34) * g).toInt())
        canvas.drawCircle(r, r, r, p)
        val inner = r - border
        val b = bmp
        if (b != null) {
            canvas.drawBitmap(b, null, RectF(r - inner, r - inner, r + inner, r + inner), p)
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

// ── 오버레이 (사람 목록) ─────────────────────────────────────────
private class Row(val view: LinearLayout, val avatar: AvatarView, val name: TextView, val status: LinearLayout)

private var root: LinearLayout? = null
private var attachedTo: WindowManager? = null
private var attachedSystem = false
private val rows = LinkedHashMap<String, Row>()
private var chatBtn: View? = null
private var builtScale = 0f
/**
 * 터치 통과일 때 채팅 버튼은 따로 작은 창에 둔다: 그 창만 터치를 받고, 나머지 오버레이는 전부 아래 앱으로 넘긴다.
 * (한 번 받은 터치를 나중에 다른 앱으로 넘길 수는 없어서, 버튼 자리는 탭도 길게 누르기도 버튼이 받는다)
 */
private var btnWin: android.widget.FrameLayout? = null
private var btnWm: WindowManager? = null
private var builtSplit = false
private val splitButton get() = passThrough && chatMode != "hidden"

/** 짧은 탭을 게임으로 다시 눌러 준 마지막 결과 (로그용) */
@Volatile private var tapPass = "not tried"
private var downRawX = 0f
private var downRawY = 0f

/**
 * 버튼 창이 받아 버린 짧은 탭을 아래 앱(게임)에 다시 눌러 준다.
 * 버튼 창을 잠깐 터치 통과로 바꾼 뒤 같은 자리에 탭을 넣는다.
 * 다른 앱에 터치를 넣는 건 보통 앱에게 막혀 있어서 (INJECT_EVENTS), 루트가 있으면 su 로도 시도한다.
 */
private fun passTap(x: Float, y: Float) {
    val holder = btnWin ?: return
    val wm = btnWm ?: return
    val lp = holder.layoutParams as? WindowManager.LayoutParams ?: return
    lp.flags = lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
    try {
        wm.updateViewLayout(holder, lp)
    } catch (e: Throwable) {
    }
    Thread {
        var ok = false
        val how = StringBuilder()
        try {
            Thread.sleep(60)
            val imClass = Class.forName("android.hardware.input.InputManager")
            val im = imClass.getMethod("getInstance").invoke(null)
            val inject = imClass.getMethod("injectInputEvent", android.view.InputEvent::class.java, Int::class.javaPrimitiveType)
            val t = android.os.SystemClock.uptimeMillis()
            val down = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0)
            down.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
            val up = MotionEvent.obtain(t, t + 40, MotionEvent.ACTION_UP, x, y, 0)
            up.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
            ok = (inject.invoke(im, down, 0) as? Boolean == true) && (inject.invoke(im, up, 0) as? Boolean == true)
            down.recycle()
            up.recycle()
            how.append("inject=").append(ok)
        } catch (e: Throwable) {
            val cause = (e as? java.lang.reflect.InvocationTargetException)?.targetException ?: e
            how.append("inject failed: ").append(cause.javaClass.simpleName).append(' ').append(cause.message ?: "")
        }
        if (!ok) {
            try {
                val p = Runtime.getRuntime().exec(arrayOf("su", "-c", "input tap ${x.toInt()} ${y.toInt()}"))
                ok = p.waitFor() == 0
                how.append(", su=").append(ok)
            } catch (e: Throwable) {
                how.append(", su failed: ").append(e.javaClass.simpleName)
            }
        }
        tapPass = "${if (ok) "worked" else "blocked"} at ${x.toInt()},${y.toInt()} ($how)"
        main.postDelayed({
            lp.flags = lp.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
            try {
                if (btnWin === holder) wm.updateViewLayout(holder, lp)
            } catch (e: Throwable) {
            }
        }, 200)
    }.start()
}

private fun detachButton() {
    val b = btnWin ?: return
    try {
        btnWm?.removeView(b)
    } catch (e: Throwable) {
    }
    btnWm = null
}

@SuppressLint("ClickableViewAccessibility")
private fun ensureRoot(c: Context): LinearLayout {
    root?.let { return it }
    val l = LinearLayout(c)
    l.orientation = LinearLayout.VERTICAL
    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    var moved = false
    var longDone = false
    val slop = ViewConfiguration.get(c).scaledTouchSlop
    // 길게 누르면 메뉴
    val long = Runnable {
        if (!moved) {
            longDone = true
            when (longAction) {
                "menu" -> {
                    l.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                    showMenu()
                }
                "chat" -> {
                    l.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                    toggleChat()
                }
            }
        }
    }
    l.setOnTouchListener { v, e ->
        val lp = v.layoutParams as? WindowManager.LayoutParams ?: return@setOnTouchListener false
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = e.rawX
                downY = e.rawY
                startX = lp.x
                startY = lp.y
                moved = false
                longDone = false
                main.postDelayed(long, ViewConfiguration.getLongPressTimeout().toLong())
                true
            }
            MotionEvent.ACTION_MOVE -> {
                if (!moved && !longDone && (Math.abs(e.rawX - downX) > slop || Math.abs(e.rawY - downY) > slop)) {
                    moved = true
                    main.removeCallbacks(long)
                }
                if (moved && !locked) {
                    lp.x = startX + (e.rawX - downX).toInt()
                    lp.y = startY + (e.rawY - downY).toInt()
                    try {
                        attachedTo?.updateViewLayout(v, lp)
                    } catch (x: Throwable) {
                    }
                }
                true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                main.removeCallbacks(long)
                if (!locked) {
                    posX = lp.x
                    posY = lp.y
                }
                true
            }
            else -> false
        }
    }
    root = l
    return l
}

private fun detach() {
    detachButton()
    val r = root ?: return
    try {
        attachedTo?.removeView(r)
    } catch (e: Throwable) {
    }
    attachedTo = null
}

private fun pill(c: Context, color: Int, radius: Float): GradientDrawable {
    val d = GradientDrawable()
    d.cornerRadius = dp(c, radius).toFloat()
    d.setColor(color)
    return d
}

private fun makeRow(c: Context, p: Person): Row {
    val size = dp(c, 40f * scale)
    val gap = dp(c, 6f * scale)
    val row = LinearLayout(c)
    row.orientation = LinearLayout.HORIZONTAL
    row.gravity = Gravity.CENTER_VERTICAL
    val av = AvatarView(c)
    av.initial = p.name.take(1).uppercase()
    p.avatar?.let { loadAvatar(it, av) }
    row.addView(av, LinearLayout.LayoutParams(size, size))
    val box = LinearLayout(c)
    box.orientation = LinearLayout.HORIZONTAL
    box.gravity = Gravity.CENTER_VERTICAL
    box.background = pill(c, Color.argb(205, 20, 21, 24), 14f * scale)
    box.setPadding(dp(c, 12f * scale), dp(c, 5f * scale), dp(c, 10f * scale), dp(c, 5f * scale))
    val name = TextView(c)
    name.textSize = 14f * scale
    name.typeface = Typeface.DEFAULT_BOLD
    name.maxLines = 1
    name.ellipsize = TextUtils.TruncateAt.END
    name.maxWidth = dp(c, 170f * scale)
    name.setTextColor(Color.WHITE)
    box.addView(name)
    val status = LinearLayout(c)
    status.orientation = LinearLayout.HORIZONTAL
    status.gravity = Gravity.CENTER_VERTICAL
    box.addView(status)
    val blp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
    blp.leftMargin = gap
    row.addView(box, blp)
    return Row(row, av, name, status)
}

/** 이름 옆 상태 아이콘 (마이크 꺼짐, 헤드셋 꺼짐) */
private fun setStatus(c: Context, r: Row, p: Person) {
    r.status.removeAllViews()
    val red = Color.rgb(242, 63, 67)
    if (p.live) {
        // 방송 중: 디스코드처럼 빨간 LIVE 표시
        val live = TextView(c)
        live.text = "LIVE"
        live.textSize = 10f * scale
        live.typeface = Typeface.DEFAULT_BOLD
        live.setTextColor(Color.WHITE)
        live.background = pill(c, red, 4f * scale)
        live.setPadding(dp(c, 5f * scale), dp(c, 1f * scale), dp(c, 5f * scale), dp(c, 1f * scale))
        val llp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        llp.leftMargin = dp(c, 6f * scale)
        r.status.addView(live, llp)
    }
    val key = when {
        p.deafened -> "headsetOff"
        p.muted -> "micOff"
        else -> null
    } ?: return
    val v: View = iconView(c, key, 15f * scale, red, if (key == "headsetOff") "D" else "M")
    val lp = LinearLayout.LayoutParams(dp(c, 15f * scale), dp(c, 15f * scale))
    lp.leftMargin = dp(c, 6f * scale)
    r.status.addView(v, lp)
}

/** 지금 상태대로 다시 그린다 (메인 스레드). 줄은 다시 만들지 않고 고쳐서 바뀐 것만 부드럽게 */
private fun render() {
    val c = ctx() ?: return
    val inDiscord = resumed != null
    val shown = people.filter { !onlySpeaking || it.speaking }
    val (wm, system) = windowManager(c) ?: run {
        detach()
        return
    }
    // 음성 채널에 있으면 (말하는 사람만 보기로 아무도 안 보여도) 채팅 버튼은 남긴다
    val want = overlayOn && people.isNotEmpty() && (if (inDiscord) !hideInDiscord || !system else system)
    if (!want) {
        if (chatOpen && people.isEmpty()) closeChat()
        hideMenu()
        detach()
        return
    }
    val r = ensureRoot(c)
    if (builtScale != scale || builtChatMode != chatMode || builtSplit != splitButton) {
        // 크기가 바뀌면 처음부터
        r.removeAllViews()
        rows.clear()
        detachButton()
        btnWin?.removeAllViews()
        btnWin = null
        chatBtn = null
        builtScale = scale
        builtChatMode = chatMode
        builtSplit = splitButton
    }
    val size = dp(c, 40f * scale)
    val gap = dp(c, 6f * scale)
    if (chatBtn == null && chatMode != "hidden") {
        val b = LinearLayout(c)
        b.gravity = Gravity.CENTER
        val bg = GradientDrawable()
        bg.shape = GradientDrawable.OVAL
        bg.setColor(Color.argb(215, 20, 21, 24))
        b.background = bg
        b.addView(iconView(c, "chat", 20f * scale, Color.WHITE, "#"))
        val press: (View) -> Unit = {
            it.animate().scaleX(0.85f).scaleY(0.85f).setDuration(70).withEndAction { it.animate().scaleX(1f).scaleY(1f).setDuration(120).start() }.start()
            toggleChat()
        }
        if (chatMode == "long") {
            // 누른 자리 기억 (짧은 탭을 게임으로 다시 눌러 줄 때 쓴다)
            b.setOnTouchListener { _, e ->
                if (e.actionMasked == MotionEvent.ACTION_DOWN) {
                    downRawX = e.rawX
                    downRawY = e.rawY
                }
                false
            }
            // 톡 누르면: 터치 통과일 때는 게임으로 넘기고, 아니면 살짝 눌리는 것만 보인다
            b.setOnClickListener {
                if (splitButton) passTap(downRawX, downRawY)
                else it.animate().scaleX(0.95f).scaleY(0.95f).setDuration(60).withEndAction { it.animate().scaleX(1f).scaleY(1f).setDuration(100).start() }.start()
            }
            b.setOnLongClickListener {
                it.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                press(it)
                true
            }
        } else {
            b.setOnClickListener(press)
            // 탭으로 열기일 때 길게 누르기는 아무것도 하지 않는다
            b.setOnLongClickListener { true }
        }
        val lp = LinearLayout.LayoutParams(size, size)
        lp.bottomMargin = gap
        if (splitButton) {
            // 버튼은 따로 창에, 오버레이 안에는 같은 크기의 빈자리 (사람 줄 위치가 그대로)
            val holder = android.widget.FrameLayout(c)
            holder.addView(b, android.widget.FrameLayout.LayoutParams(size, size))
            btnWin = holder
            r.addView(View(c), 0, lp)
        } else r.addView(b, 0, lp)
        chatBtn = b
    }
    // 빠진 사람은 흐려지며 사라진다
    val ids = shown.map { it.id }.toSet()
    for ((id, row) in rows.entries.toList()) {
        if (id in ids) continue
        rows.remove(id)
        row.view.animate().alpha(0f).translationX(-dp(c, 12f).toFloat()).setDuration(160).withEndAction { r.removeView(row.view) }.start()
    }
    var index = 1
    for (p in shown) {
        var row = rows[p.id]
        val fresh = row == null
        if (row == null) {
            row = makeRow(c, p)
            rows[p.id] = row
            val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = gap
            row.view.alpha = 0f
            row.view.translationX = -dp(c, 12f).toFloat()
            r.addView(row.view, minOf(index, r.childCount), lp)
        } else if (r.indexOfChild(row.view) != index) {
            r.removeView(row.view)
            r.addView(row.view, minOf(index, r.childCount))
        }
        index++
        row.name.text = p.name
        row.avatar.setSpeaking(p.speaking, !fresh)
        setStatus(c, row, p)
        // 말하는 사람은 뚜렷하게, 조용한 사람은 반투명하게
        val to = if (p.speaking) 1f else idleAlpha
        if (fresh) row.view.animate().alpha(to).translationX(0f).setDuration(200).setInterpolator(DecelerateInterpolator()).start()
        else if (row.view.alpha != to) row.view.animate().alpha(to).setDuration(if (p.speaking) 90 else 260).start()
    }
    // 터치 통과일 때 투명도는 창 쪽(lp.alpha)에서 준다 (안드로이드 12+ 규칙, 아래)
    r.alpha = if (passThrough && Build.VERSION.SDK_INT >= 31) 1f else opacity
    if (attachedTo !== wm || attachedSystem != system) {
        detach()
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(system),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                (if (passThrough) WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE else 0),
            PixelFormat.TRANSLUCENT,
        )
        lp.gravity = Gravity.TOP or Gravity.START
        // 안드로이드 12 부터는 다른 앱 위 창이 많이 불투명하면 터치 통과가 막힌다: 통과일 때는 창 자체 투명도를 낮춰 둔다
        if (passThrough && Build.VERSION.SDK_INT >= 31) lp.alpha = minOf(opacity, 0.8f)
        lp.x = posX
        lp.y = posY
        try {
            addOwn(wm, r, lp)
            attachedTo = wm
            attachedSystem = system
            r.scaleX = 0.9f
            r.scaleY = 0.9f
            r.animate().scaleX(1f).scaleY(1f).setDuration(200).setInterpolator(OvershootInterpolator(1.2f)).start()
        } catch (e: Throwable) {
            lastError = "attach: $e"
        }
    }
    // 따로 떼어 낸 채팅 버튼 창 (터치를 받는 창)
    val holder = btnWin
    if (splitButton && holder != null && btnWm == null && attachedTo != null) {
        val lp = WindowManager.LayoutParams(
            size,
            size,
            overlayType(system),
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        )
        lp.gravity = Gravity.TOP or Gravity.START
        lp.x = posX
        lp.y = posY
        try {
            holder.alpha = opacity
            addOwn(wm, holder, lp)
            btnWm = wm
        } catch (e: Throwable) {
            lastError = "button attach: $e"
        }
    }
}

// ── 길게 누르기 메뉴 ─────────────────────────────────────────────
private var menu: LinearLayout? = null
private var menuWm: WindowManager? = null

private fun hideMenu() {
    val m = menu ?: return
    menu = null
    val wm = menuWm
    menuWm = null
    m.animate().alpha(0f).scaleX(0.92f).scaleY(0.92f).setDuration(120).withEndAction {
        try {
            wm?.removeView(m)
        } catch (e: Throwable) {
        }
    }.start()
}

@SuppressLint("ClickableViewAccessibility")
private fun showMenu() {
    val c = ctx() ?: return
    hideMenu()
    val (wm, system) = windowManager(c) ?: return
    val box = LinearLayout(c)
    box.orientation = LinearLayout.VERTICAL
    box.background = pill(c, Color.argb(245, 30, 31, 34), 14f)
    box.setPadding(dp(c, 6f), dp(c, 6f), dp(c, 6f), dp(c, 6f))
    box.elevation = dp(c, 8f).toFloat()
    val white = Color.argb(235, 235, 236, 240)
    val red = Color.rgb(242, 63, 67)
    fun item(icon: String, label: String, color: Int, fallback: String, action: String) {
        val row = LinearLayout(c)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(dp(c, 12f), dp(c, 11f), dp(c, 18f), dp(c, 11f))
        row.background = pill(c, Color.TRANSPARENT, 10f)
        row.addView(iconView(c, icon, 20f, color, fallback))
        val t = TextView(c)
        t.text = label
        t.setTextColor(color)
        t.textSize = 15f
        t.typeface = Typeface.DEFAULT_BOLD
        val tlp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        tlp.leftMargin = dp(c, 12f)
        row.addView(t, tlp)
        row.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> (v.background as? GradientDrawable)?.setColor(Color.argb(40, 255, 255, 255))
                MotionEvent.ACTION_CANCEL -> (v.background as? GradientDrawable)?.setColor(Color.TRANSPARENT)
                MotionEvent.ACTION_UP -> {
                    (v.background as? GradientDrawable)?.setColor(Color.TRANSPARENT)
                    emitEvent("action", mapOf("name" to action))
                    hideMenu()
                }
            }
            true
        }
        box.addView(row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    }
    item(if (selfMute) "mic" else "micOff", if (selfMute) "Unmute" else "Mute", white, "M", "mute")
    item(if (selfDeaf) "headset" else "headsetOff", if (selfDeaf) "Undeafen" else "Deafen", white, "D", "deafen")
    item("stream", if (streaming) "Stop streaming" else "Go Live", white, "L", "stream")
    item("leave", "Leave voice", red, "X", "leave")
    // 메뉴 바깥을 누르면 닫는다
    val lp = WindowManager.LayoutParams(
        WindowManager.LayoutParams.WRAP_CONTENT,
        WindowManager.LayoutParams.WRAP_CONTENT,
        overlayType(system),
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    )
    lp.gravity = Gravity.TOP or Gravity.START
    val screenW = c.resources.displayMetrics.widthPixels
    lp.x = if (posX + dp(c, 260f) < screenW) posX + dp(c, 50f * scale) else maxOf(0, posX - dp(c, 210f))
    lp.y = posY
    box.setOnTouchListener { _, e ->
        if (e.actionMasked == MotionEvent.ACTION_OUTSIDE) hideMenu()
        false
    }
    try {
        box.alpha = 0f
        box.scaleX = 0.9f
        box.scaleY = 0.9f
        box.pivotX = 0f
        box.pivotY = 0f
        addOwn(wm, box, lp)
        menu = box
        menuWm = wm
        box.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(170).setInterpolator(DecelerateInterpolator()).start()
        // 5초 동안 안 고르면 닫는다
        main.postDelayed({ if (menu === box) hideMenu() }, 5000)
    } catch (e: Throwable) {
        lastError = "menu: $e"
    }
}

// ── 간이 채팅 창 (디스코드 채팅처럼) ─────────────────────────────
@Volatile private var chatTitle = ""
@Volatile private var chatLines: List<ChatLine> = emptyList()
private var chatRoot: LinearLayout? = null
private var chatList: LinearLayout? = null
private var chatScroll: ScrollView? = null
private var chatTitleView: TextView? = null
private var chatWm: WindowManager? = null
private var chatOpen = false
private var chatShown = 0

private fun toggleChat() {
    if (chatOpen) closeChat() else openChat()
}

private fun closeChat() {
    if (!chatOpen) return
    chatOpen = false
    val box = chatRoot
    val wm = chatWm
    chatWm = null
    emitEvent("chatClose")
    box?.animate()?.alpha(0f)?.scaleX(0.94f)?.scaleY(0.94f)?.setDuration(140)?.withEndAction {
        try {
            box.let { wm?.removeView(it) }
        } catch (e: Throwable) {
        }
    }?.start()
}

private fun buildChat(c: Context): LinearLayout {
    chatRoot?.let { return it }
    val b = LinearLayout(c)
    b.orientation = LinearLayout.VERTICAL
    b.background = pill(c, Color.argb(245, 49, 51, 56), 16f)
    b.elevation = dp(c, 10f).toFloat()
    b.clipToOutline = true
    // 위: 채널 이름 + 닫기
    val head = LinearLayout(c)
    head.orientation = LinearLayout.HORIZONTAL
    head.gravity = Gravity.CENTER_VERTICAL
    head.setPadding(dp(c, 12f), dp(c, 10f), dp(c, 6f), dp(c, 10f))
    head.setBackgroundColor(Color.argb(255, 43, 45, 49))
    head.addView(iconView(c, "chat", 18f, Color.argb(200, 181, 186, 193), "#"))
    val title = TextView(c)
    title.setTextColor(Color.WHITE)
    title.typeface = Typeface.DEFAULT_BOLD
    title.textSize = 15f
    title.maxLines = 1
    title.ellipsize = TextUtils.TruncateAt.END
    val tlp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
    tlp.leftMargin = dp(c, 8f)
    head.addView(title, tlp)
    val close = LinearLayout(c)
    close.gravity = Gravity.CENTER
    close.setPadding(dp(c, 8f), dp(c, 4f), dp(c, 8f), dp(c, 4f))
    close.addView(iconView(c, "close", 20f, Color.argb(220, 181, 186, 193), "×"))
    close.setOnClickListener { closeChat() }
    head.addView(close)
    b.addView(head)
    // 가운데: 메시지
    val sv = ScrollView(c)
    sv.isVerticalScrollBarEnabled = false
    val list = LinearLayout(c)
    list.orientation = LinearLayout.VERTICAL
    list.setPadding(0, dp(c, 6f), 0, dp(c, 6f))
    sv.addView(list)
    b.addView(sv, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
    // 아래: 입력칸 + 보내기
    val inputRow = LinearLayout(c)
    inputRow.orientation = LinearLayout.HORIZONTAL
    inputRow.gravity = Gravity.CENTER_VERTICAL
    inputRow.setPadding(dp(c, 10f), dp(c, 4f), dp(c, 10f), dp(c, 10f))
    val input = EditText(c)
    input.hint = "Message"
    input.setHintTextColor(Color.argb(150, 181, 186, 193))
    input.setTextColor(Color.WHITE)
    input.textSize = 14.5f
    input.maxLines = 4
    input.imeOptions = EditorInfo.IME_ACTION_SEND
    input.background = pill(c, Color.argb(255, 56, 58, 64), 20f)
    input.setPadding(dp(c, 14f), dp(c, 9f), dp(c, 14f), dp(c, 9f))
    val send = LinearLayout(c)
    send.gravity = Gravity.CENTER
    val sbg = GradientDrawable()
    sbg.shape = GradientDrawable.OVAL
    sbg.setColor(Color.rgb(88, 101, 242))
    send.background = sbg
    send.addView(iconView(c, "send", 18f, Color.WHITE, "›"))
    val doSend = {
        val t = input.text?.toString()?.trim().orEmpty()
        if (t.isNotEmpty()) {
            emitEvent("send", mapOf("text" to t))
            input.setText("")
            send.animate().scaleX(0.85f).scaleY(0.85f).setDuration(70).withEndAction { send.animate().scaleX(1f).scaleY(1f).setDuration(120).start() }.start()
        }
    }
    send.setOnClickListener { doSend() }
    input.setOnEditorActionListener { _, id, _ ->
        if (id == EditorInfo.IME_ACTION_SEND) {
            doSend()
            true
        } else false
    }
    inputRow.addView(input, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    val slp = LinearLayout.LayoutParams(dp(c, 38f), dp(c, 38f))
    slp.leftMargin = dp(c, 8f)
    inputRow.addView(send, slp)
    b.addView(inputRow)
    chatRoot = b
    chatList = list
    chatScroll = sv
    chatTitleView = title
    return b
}

private fun openChat() {
    val c = ctx() ?: return
    val (wm, system) = windowManager(c) ?: return
    hideMenu()
    val box = buildChat(c)
    // 입력해야 해서 이 창은 키보드를 받을 수 있게 (FLAG_NOT_FOCUSABLE 없이)
    val w = dp(c, 320f)
    val lp = WindowManager.LayoutParams(
        w,
        dp(c, 420f),
        overlayType(system),
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    )
    lp.gravity = Gravity.TOP or Gravity.START
    val screenW = c.resources.displayMetrics.widthPixels
    val right = posX + dp(c, 52f * scale)
    lp.x = if (right + w < screenW) right else maxOf(0, posX - w - dp(c, 8f))
    lp.y = posY
    lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
    try {
        box.alpha = 0f
        box.scaleX = 0.92f
        box.scaleY = 0.92f
        box.pivotX = if (lp.x >= posX) 0f else w.toFloat()
        box.pivotY = 0f
        addOwn(wm, box, lp)
        chatWm = wm
        chatOpen = true
        chatShown = 0
        emitEvent("chatOpen")
        renderChat()
        box.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(200).setInterpolator(DecelerateInterpolator()).start()
    } catch (e: Throwable) {
        lastError = "chat: $e"
    }
}

/** 디스코드 메시지처럼: 프로필 사진, 이름(역할 색), 시간, 내용. 같은 사람이 이어 쓰면 내용만 */
private fun messageView(c: Context, m: ChatLine): View {
    val av = dp(c, 36f)
    val row = LinearLayout(c)
    row.orientation = LinearLayout.HORIZONTAL
    row.setPadding(dp(c, 12f), if (m.head) dp(c, 10f) else dp(c, 1f), dp(c, 12f), dp(c, 1f))
    if (m.head) {
        val a = AvatarView(c)
        a.ring = 0f
        a.initial = m.author.take(1).uppercase()
        m.avatar?.let { loadAvatar(it, a) }
        row.addView(a, LinearLayout.LayoutParams(av, av))
    } else {
        row.addView(View(c), LinearLayout.LayoutParams(av, 1))
    }
    val col = LinearLayout(c)
    col.orientation = LinearLayout.VERTICAL
    if (m.head) {
        val head = TextView(c)
        val sb = SpannableStringBuilder()
        sb.append(m.author)
        sb.setSpan(StyleSpan(Typeface.BOLD), 0, sb.length, 0)
        sb.setSpan(ForegroundColorSpan(m.color), 0, sb.length, 0)
        val start = sb.length
        sb.append("  ").append(m.time)
        sb.setSpan(ForegroundColorSpan(Color.argb(170, 148, 155, 164)), start, sb.length, 0)
        sb.setSpan(RelativeSizeSpan(0.8f), start, sb.length, 0)
        head.text = sb
        head.textSize = 15f
        head.maxLines = 1
        head.ellipsize = TextUtils.TruncateAt.END
        col.addView(head)
    }
    if (m.content.isNotEmpty()) {
        val t = TextView(c)
        t.text = m.content
        t.setTextColor(Color.argb(240, 219, 222, 225))
        t.textSize = 14.5f
        t.setLineSpacing(0f, 1.1f)
        col.addView(t)
    }
    val clp = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
    clp.leftMargin = dp(c, 12f)
    row.addView(col, clp)
    return row
}

private fun renderChat() {
    val c = ctx() ?: return
    val list = chatList ?: return
    chatTitleView?.text = chatTitle
    val lines = chatLines
    // 처음이거나 줄었으면 다시, 늘었으면 새 메시지만 붙인다 (새 것은 아래에서 올라오며 나타난다)
    if (lines.size < chatShown || chatShown == 0) {
        list.removeAllViews()
        for (m in lines) list.addView(messageView(c, m))
    } else {
        for (m in lines.drop(chatShown)) {
            val v = messageView(c, m)
            v.alpha = 0f
            v.translationY = dp(c, 10f).toFloat()
            list.addView(v)
            v.animate().alpha(1f).translationY(0f).setDuration(180).setInterpolator(DecelerateInterpolator()).start()
        }
    }
    chatShown = lines.size
    chatScroll?.post { chatScroll?.fullScroll(View.FOCUS_DOWN) }
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
                    if (!attachedSystem) main.post { detach() }
                    main.post { render() }
                }
            })
        } catch (e: Throwable) {
            lastError = "lifecycle hook: $e"
        }
        // 디스코드 자체 오버레이 창 막기: 앱이 다른 앱 위 창을 붙일 때, 우리 것이 아니면 (설정이 켜져 있을 때) 붙이지 않는다
        try {
            hooks += XposedHelpers.findAndHookMethod(
                "android.view.WindowManagerImpl",
                null,
                "addView",
                View::class.java,
                android.view.ViewGroup.LayoutParams::class.java,
                object : XC_MethodHook() {
                    override fun beforeHookedMethod(param: MethodHookParam) {
                        if (addingOwn) return
                        val lp = param.args[1] as? WindowManager.LayoutParams ?: return
                        if (!isOverlayType(lp.type)) return
                        val v = param.args[0] as? View
                        val what = "${v?.javaClass?.name} type=${lp.type}${if (hideDiscordOverlay) " (blocked)" else ""}"
                        foreignWindows.add(what)
                        while (foreignWindows.size > 8) foreignWindows.poll()
                        if (hideDiscordOverlay) param.result = null
                    }
                },
            )
        } catch (e: Throwable) {
            lastError = "window hook: $e"
        }
        unhooks = hooks

        registerNativeMethod("${manifest.id}.update") { args ->
            try {
                val arr = JSONArray(args.getOrNull(0) as? String ?: "[]")
                people = (0 until arr.length()).map {
                    val o = arr.getJSONObject(it)
                    Person(o.optString("id"), o.optString("name"), o.optString("avatar").takeIf { s -> s.isNotBlank() }, o.optBoolean("speaking"), o.optBoolean("muted"), o.optBoolean("deafened"), o.optBoolean("live"))
                }
                main.post { render() }
                true
            } catch (e: Throwable) {
                lastError = "update: $e"
                false
            }
        }
        /** 내 상태: [마이크 꺼짐, 헤드셋 꺼짐, 방송 중] */
        registerNativeMethod("${manifest.id}.self") { args ->
            selfMute = args.getOrNull(0) == true
            selfDeaf = args.getOrNull(1) == true
            streaming = args.getOrNull(2) == true
            true
        }
        registerNativeMethod("${manifest.id}.config") { args ->
            try {
                val o = JSONObject(args.getOrNull(0) as? String ?: "{}")
                overlayOn = o.optBoolean("enabled", overlayOn)
                onlySpeaking = o.optBoolean("onlySpeaking", onlySpeaking)
                hideInDiscord = o.optBoolean("hideInDiscord", hideInDiscord)
                scale = o.optDouble("scale", scale.toDouble()).toFloat().coerceIn(0.5f, 2f)
                opacity = o.optDouble("opacity", opacity.toDouble()).toFloat().coerceIn(0.2f, 1f)
                idleAlpha = o.optDouble("idleAlpha", idleAlpha.toDouble()).toFloat().coerceIn(0.1f, 1f)
                locked = o.optBoolean("locked", locked)
                passThrough = o.optBoolean("passThrough", passThrough)
                longAction = o.optString("longPress", longAction)
                chatMode = o.optString("chatButton", chatMode)
                hideDiscordOverlay = o.optBoolean("hideDiscordOverlay", hideDiscordOverlay)
                if (o.has("x")) posX = o.optInt("x", posX)
                if (o.has("y")) posY = o.optInt("y", posY)
                main.post {
                    detach()
                    render()
                }
                true
            } catch (e: Throwable) {
                lastError = "config: $e"
                false
            }
        }
        registerNativeMethod("${manifest.id}.events") {
            val out = ArrayList<String>()
            while (true) out += events.poll() ?: break
            "[" + out.joinToString(",") + "]"
        }
        /** 간이 채팅 내용: {title, messages: [{author, color, avatar, time, content, head}]} */
        registerNativeMethod("${manifest.id}.chat") { args ->
            try {
                val o = JSONObject(args.getOrNull(0) as? String ?: "{}")
                chatTitle = o.optString("title")
                val arr = o.optJSONArray("messages") ?: JSONArray()
                chatLines = (0 until arr.length()).map {
                    val m = arr.getJSONObject(it)
                    val color = try {
                        Color.parseColor(m.optString("color").ifBlank { "#F2F3F5" })
                    } catch (e: Throwable) {
                        Color.rgb(242, 243, 245)
                    }
                    ChatLine(m.optString("author"), color, m.optString("avatar").takeIf { s -> s.isNotBlank() }, m.optString("time"), m.optString("content"), m.optBoolean("head", true))
                }
                main.post { renderChat() }
                true
            } catch (e: Throwable) {
                lastError = "chat: $e"
                false
            }
        }
        registerNativeMethod("${manifest.id}.closeChat") {
            main.post { closeChat() }
            true
        }
        registerNativeMethod("${manifest.id}.position") { listOf(posX, posY) }
        registerNativeMethod("${manifest.id}.canOverlay") { ctx()?.let { canOverlay(it) } ?: false }
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
            if (c != null) for (k in ICONS.keys) iconId(c, k)
            mapOf(
                "canOverlay" to (c?.let { canOverlay(it) } ?: false),
                "attached" to (attachedTo != null),
                "overOtherApps" to attachedSystem,
                "inDiscord" to (resumed != null),
                "people" to people.size,
                "enabled" to overlayOn,
                "icons" to iconNames.entries.joinToString(", ") { "${it.key}=${it.value}" },
                "foreignOverlays" to foreignWindows.joinToString(" | "),
                "tapPass" to tapPass,
                "error" to lastError,
            )
        }
        /** 이름에 낱말이 든 디스코드 아이콘 (아이콘 이름 찾기용) */
        registerNativeMethod("${manifest.id}.findIcons") { args ->
            val c = ctx() ?: return@registerNativeMethod ""
            val word = (args.getOrNull(0) as? String).orEmpty()
            val all = drawableNames(c)
            "(${all.size} drawables, R from ${resPkg ?: "none"}) " + all.filter { it.contains(word) }.take(60).joinToString(", ")
        }
    }

    stop {
        for (u in unhooks) try {
            u.unhook()
        } catch (e: Throwable) {
        }
        unhooks = emptyList()
        overlayOn = false
        main.post {
            closeChat()
            hideMenu()
            detach()
        }
    }
}
