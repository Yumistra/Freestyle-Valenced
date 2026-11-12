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

private data class Person(val id: String, val name: String, val avatar: String?, val speaking: Boolean, val muted: Boolean, val deafened: Boolean)
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
/** 아이콘 이름 후보 (앞의 것부터). 디스코드 앱 리소스 안에서 찾고, 찾은 이름은 status 에 남긴다 */
private val ICONS = mapOf(
    "chat" to listOf("ic_chat", "ic_chat_24dp", "ic_message", "ic_channel_text", "ic_text_channel"),
    "mic" to listOf("ic_microphone", "ic_mic", "ic_mic_24dp", "ic_microphone_24dp", "ic_mic_white_24dp"),
    "micOff" to listOf("ic_microphone_slash", "ic_mic_muted", "ic_mic_off", "ic_mic_mute", "ic_microphone_off", "ic_mute"),
    "headset" to listOf("ic_headphones", "ic_headset", "ic_headset_24dp", "ic_deafen_off"),
    "headsetOff" to listOf("ic_headphones_slash", "ic_headset_deafened", "ic_headset_off", "ic_deafen", "ic_deafened"),
    "stream" to listOf("ic_screen_arrow", "ic_screenshare", "ic_screen_share", "ic_go_live", "ic_stream", "ic_screen"),
    "leave" to listOf("ic_phone_hangup", "ic_call_disconnect", "ic_disconnect", "ic_call_end", "ic_phone_x", "ic_leave"),
    "close" to listOf("ic_x_small", "ic_close", "ic_close_24dp", "ic_x", "ic_clear"),
    "send" to listOf("ic_send", "ic_send_24dp", "ic_arrow_up", "ic_send_message"),
)
/** 위 후보가 없을 때 이름에 들어 있으면 쓸 낱말 */
private val ICON_WORDS = mapOf(
    "chat" to listOf("chat"),
    "mic" to listOf("microphone", "mic"),
    "micOff" to listOf("microphone_slash", "mic_off", "mic_mute", "muted"),
    "headset" to listOf("headphones", "headset"),
    "headsetOff" to listOf("headphones_slash", "headset_off", "deafen"),
    "stream" to listOf("screen_arrow", "screenshare", "screen_share", "go_live", "stream"),
    "leave" to listOf("hangup", "disconnect", "call_end"),
    "close" to listOf("x_small", "close"),
    "send" to listOf("send"),
)
private val iconIds = ConcurrentHashMap<String, Int>()
private val iconNames = ConcurrentHashMap<String, String>()
private var allDrawables: List<String>? = null

private fun drawableNames(c: Context): List<String> {
    allDrawables?.let { return it }
    val out = ArrayList<String>()
    try {
        val cls = Class.forName("${c.packageName}.R\$drawable", false, c.classLoader)
        for (f in cls.fields) out += f.name
    } catch (e: Throwable) {
        lastError = "R.drawable: $e"
    }
    allDrawables = out
    return out
}

private fun iconId(c: Context, key: String): Int {
    iconIds[key]?.let { return it }
    val res = c.resources
    var found = 0
    var name = ""
    for (n in ICONS[key].orEmpty()) {
        val id = res.getIdentifier(n, "drawable", c.packageName)
        if (id != 0) {
            found = id
            name = n
            break
        }
    }
    if (found == 0) {
        val words = ICON_WORDS[key].orEmpty()
        // 짧은 이름(기본 아이콘)부터
        val cand = drawableNames(c).filter { n -> n.startsWith("ic_") && words.any { n.contains(it) } && (key.endsWith("Off") || !n.contains("slash") && !n.contains("off") && !n.contains("mute")) }.sortedBy { it.length }
        for (n in cand) {
            val id = res.getIdentifier(n, "drawable", c.packageName)
            if (id != 0) {
                found = id
                name = n
                break
            }
        }
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
            l.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            showMenu()
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
                if (moved) {
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
                posX = lp.x
                posY = lp.y
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
    val key = when {
        p.deafened -> "headsetOff"
        p.muted -> "micOff"
        else -> null
    } ?: return
    val v = iconView(c, key, 15f * scale, red, if (key == "headsetOff") "D" else "M")
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
    if (builtScale != scale) {
        // 크기가 바뀌면 처음부터
        r.removeAllViews()
        rows.clear()
        chatBtn = null
        builtScale = scale
    }
    val size = dp(c, 40f * scale)
    val gap = dp(c, 6f * scale)
    if (chatBtn == null) {
        val b = LinearLayout(c)
        b.gravity = Gravity.CENTER
        val bg = GradientDrawable()
        bg.shape = GradientDrawable.OVAL
        bg.setColor(Color.argb(215, 20, 21, 24))
        b.background = bg
        b.addView(iconView(c, "chat", 20f * scale, Color.WHITE, "#"))
        b.setOnClickListener {
            it.animate().scaleX(0.85f).scaleY(0.85f).setDuration(70).withEndAction { it.animate().scaleX(1f).scaleY(1f).setDuration(120).start() }.start()
            toggleChat()
        }
        val lp = LinearLayout.LayoutParams(size, size)
        lp.bottomMargin = gap
        r.addView(b, 0, lp)
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
    r.alpha = opacity
    if (attachedTo !== wm || attachedSystem != system) {
        detach()
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            overlayType(system),
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
            r.scaleX = 0.9f
            r.scaleY = 0.9f
            r.animate().scaleX(1f).scaleY(1f).setDuration(200).setInterpolator(OvershootInterpolator(1.2f)).start()
        } catch (e: Throwable) {
            lastError = "attach: $e"
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
        wm.addView(box, lp)
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
        wm.addView(box, lp)
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
        unhooks = hooks

        registerNativeMethod("${manifest.id}.update") { args ->
            try {
                val arr = JSONArray(args.getOrNull(0) as? String ?: "[]")
                people = (0 until arr.length()).map {
                    val o = arr.getJSONObject(it)
                    Person(o.optString("id"), o.optString("name"), o.optString("avatar").takeIf { s -> s.isNotBlank() }, o.optBoolean("speaking"), o.optBoolean("muted"), o.optBoolean("deafened"))
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
                "error" to lastError,
            )
        }
        /** 이름에 낱말이 든 디스코드 아이콘 (아이콘 이름 찾기용) */
        registerNativeMethod("${manifest.id}.findIcons") { args ->
            val c = ctx() ?: return@registerNativeMethod ""
            val word = (args.getOrNull(0) as? String).orEmpty()
            drawableNames(c).filter { it.contains(word) }.take(80).joinToString(", ")
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
