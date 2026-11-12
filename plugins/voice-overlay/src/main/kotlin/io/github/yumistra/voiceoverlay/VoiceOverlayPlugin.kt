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
import android.widget.EditText
import android.widget.ScrollView
import android.view.inputmethod.EditorInfo
import android.view.HapticFeedbackConstants
import android.view.ViewConfiguration
import java.util.concurrent.ConcurrentLinkedQueue
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
@Volatile private var overlayOn = false
@Volatile private var onlySpeaking = false
@Volatile private var hideInDiscord = true
@Volatile private var scale = 1f
@Volatile private var opacity = 1f
/** 말하지 않는 사람 줄의 투명도 */
@Volatile private var idleAlpha = 0.45f
@Volatile private var posX = 24
@Volatile private var posY = 200
@Volatile private var lastError = ""

/** JS 로 보낼 일 (JS 가 events 로 가져간다): leave, chatOpen, chatClose, send */
private val events = ConcurrentLinkedQueue<String>()
private fun emitEvent(type: String, extra: Map<String, Any?> = emptyMap()) {
    val o = JSONObject()
    o.put("type", type)
    for ((k, v) in extra) o.put(k, v)
    events.add(o.toString())
}

// ── 간이 채팅 창 ──
private class ChatLine(val author: String, val content: String, val mine: Boolean)
@Volatile private var chatTitle = ""
@Volatile private var chatLines: List<ChatLine> = emptyList()
private var chatRoot: LinearLayout? = null
private var chatList: LinearLayout? = null
private var chatScroll: ScrollView? = null
private var chatTitleView: TextView? = null
private var chatWm: WindowManager? = null
private var chatOpen = false

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

private fun toggleChat() {
    if (chatOpen) closeChat() else openChat()
}

private fun closeChat() {
    chatOpen = false
    try {
        chatRoot?.let { chatWm?.removeView(it) }
    } catch (e: Throwable) {
    }
    chatWm = null
    emitEvent("chatClose")
    render()
}

/** 간이 채팅 창: 위에 채널 이름과 닫기, 가운데 최근 메시지, 아래 입력칸과 보내기 */
private fun openChat() {
    val c = ctx() ?: return
    val system = canOverlay(c)
    val wm: WindowManager = (if (system) c.getSystemService(Context.WINDOW_SERVICE) as WindowManager else resumed?.windowManager) ?: return
    val box = chatRoot ?: run {
        val b = LinearLayout(c)
        b.orientation = LinearLayout.VERTICAL
        val bg = GradientDrawable()
        bg.cornerRadius = dp(c, 16f).toFloat()
        bg.setColor(Color.argb(235, 24, 25, 28))
        b.background = bg
        b.setPadding(dp(c, 10f), dp(c, 8f), dp(c, 10f), dp(c, 10f))
        val head = LinearLayout(c)
        head.orientation = LinearLayout.HORIZONTAL
        head.gravity = Gravity.CENTER_VERTICAL
        val title = TextView(c)
        title.setTextColor(Color.WHITE)
        title.typeface = Typeface.DEFAULT_BOLD
        title.textSize = 15f
        title.maxLines = 1
        title.ellipsize = TextUtils.TruncateAt.END
        head.addView(title, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        val close = TextView(c)
        close.text = "\u2715"
        close.textSize = 16f
        close.setTextColor(Color.argb(220, 220, 220, 225))
        close.setPadding(dp(c, 10f), dp(c, 4f), dp(c, 4f), dp(c, 4f))
        close.setOnClickListener { closeChat() }
        head.addView(close)
        b.addView(head)
        val sv = ScrollView(c)
        val list = LinearLayout(c)
        list.orientation = LinearLayout.VERTICAL
        sv.addView(list)
        b.addView(sv, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        val inputRow = LinearLayout(c)
        inputRow.orientation = LinearLayout.HORIZONTAL
        inputRow.gravity = Gravity.CENTER_VERTICAL
        val input = EditText(c)
        input.hint = "Message"
        input.setHintTextColor(Color.argb(150, 200, 200, 205))
        input.setTextColor(Color.WHITE)
        input.textSize = 14f
        input.maxLines = 3
        input.imeOptions = EditorInfo.IME_ACTION_SEND
        input.setSingleLine(false)
        val ibg = GradientDrawable()
        ibg.cornerRadius = dp(c, 12f).toFloat()
        ibg.setColor(Color.argb(255, 44, 45, 50))
        input.background = ibg
        input.setPadding(dp(c, 12f), dp(c, 8f), dp(c, 12f), dp(c, 8f))
        val send = TextView(c)
        send.text = "\u27A4"
        send.textSize = 18f
        send.setTextColor(Color.rgb(88, 101, 242))
        send.setPadding(dp(c, 10f), dp(c, 6f), dp(c, 6f), dp(c, 6f))
        val doSend = {
            val t = input.text?.toString()?.trim().orEmpty()
            if (t.isNotEmpty()) {
                emitEvent("send", mapOf("text" to t))
                input.setText("")
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
        inputRow.addView(send)
        val ilp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        ilp.topMargin = dp(c, 8f)
        b.addView(inputRow, ilp)
        chatRoot = b
        chatList = list
        chatScroll = sv
        chatTitleView = title
        b
    }
    val type = if (system) {
        if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE
    } else WindowManager.LayoutParams.TYPE_APPLICATION
    // 입력해야 해서 이 창은 키보드를 받을 수 있게 (FLAG_NOT_FOCUSABLE 없이)
    val lp = WindowManager.LayoutParams(
        dp(c, 300f),
        dp(c, 360f),
        type,
        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    )
    lp.gravity = Gravity.TOP or Gravity.START
    val screenW = c.resources.displayMetrics.widthPixels
    lp.x = if (posX + dp(c, 360f) < screenW) posX + dp(c, 56f * scale) else maxOf(0, posX - dp(c, 300f))
    lp.y = posY
    lp.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
    try {
        wm.addView(box, lp)
        chatWm = wm
        chatOpen = true
        emitEvent("chatOpen")
        renderChat()
        render()
    } catch (e: Throwable) {
        lastError = "chat: $e"
    }
}

private fun renderChat() {
    val c = ctx() ?: return
    val list = chatList ?: return
    chatTitleView?.text = chatTitle
    list.removeAllViews()
    for (m in chatLines) {
        val t = TextView(c)
        val name = android.text.SpannableString("${m.author}  ")
        name.setSpan(android.text.style.StyleSpan(Typeface.BOLD), 0, name.length, 0)
        name.setSpan(android.text.style.ForegroundColorSpan(if (m.mine) Color.rgb(140, 150, 255) else Color.WHITE), 0, name.length, 0)
        t.text = android.text.SpannableStringBuilder(name).append(m.content)
        t.setTextColor(Color.argb(230, 220, 221, 225))
        t.textSize = 13.5f
        t.setPadding(0, dp(c, 3f), 0, dp(c, 3f))
        list.addView(t)
    }
    chatScroll?.post { chatScroll?.fullScroll(View.FOCUS_DOWN) }
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
    var moved = false
    // 길게 누르면 음성 채널에서 나간다 (진동으로 알린다)
    val slop = ViewConfiguration.get(c).scaledTouchSlop
    val leave = Runnable {
        if (!moved) {
            l.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            emitEvent("leave")
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
                main.postDelayed(leave, 800)
                true
            }
            MotionEvent.ACTION_MOVE -> {
                if (!moved && (Math.abs(e.rawX - downX) > slop || Math.abs(e.rawY - downY) > slop)) {
                    moved = true
                    main.removeCallbacks(leave)
                }
                if (!moved) return@setOnTouchListener true
                lp.x = startX + (e.rawX - downX).toInt()
                lp.y = startY + (e.rawY - downY).toInt()
                try {
                    attachedTo?.updateViewLayout(v, lp)
                } catch (x: Throwable) {
                }
                true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                main.removeCallbacks(leave)
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
    // 음성 채널에 있으면 (말하는 사람만 보기로 아무도 안 보여도) 채팅 버튼은 남긴다
    val want = overlayOn && people.isNotEmpty() && (if (inDiscord) !hideInDiscord || !system else system)
    if (!want) {
        if (chatOpen && people.isEmpty()) closeChat()
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
    // 맨 위: 간이 채팅 버튼
    val chatBtn = TextView(c)
    chatBtn.text = if (chatOpen) "\u2715" else "\uD83D\uDCAC"
    chatBtn.textSize = 15f * scale
    chatBtn.gravity = Gravity.CENTER
    chatBtn.setTextColor(Color.WHITE)
    val btnBg = GradientDrawable()
    btnBg.shape = GradientDrawable.OVAL
    btnBg.setColor(Color.argb(210, 20, 21, 24))
    chatBtn.background = btnBg
    chatBtn.setOnClickListener { toggleChat() }
    val blp = LinearLayout.LayoutParams(size, size)
    blp.bottomMargin = gap
    r.addView(chatBtn, blp)
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
        // 말하는 사람은 뚜렷하게, 조용한 사람은 반투명하게
        row.alpha = if (p.speaking) 1f else idleAlpha
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
                overlayOn = o.optBoolean("enabled", overlayOn)
                onlySpeaking = o.optBoolean("onlySpeaking", onlySpeaking)
                hideInDiscord = o.optBoolean("hideInDiscord", hideInDiscord)
                scale = o.optDouble("scale", scale.toDouble()).toFloat().coerceIn(0.5f, 2f)
                opacity = o.optDouble("opacity", opacity.toDouble()).toFloat().coerceIn(0.2f, 1f)
                idleAlpha = o.optDouble("idleAlpha", idleAlpha.toDouble()).toFloat().coerceIn(0.1f, 1f)
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
        /** 쌓인 일 (JS 가 자주 가져간다) */
        registerNativeMethod("${manifest.id}.events") {
            val out = ArrayList<String>()
            while (true) out += events.poll() ?: break
            "[" + out.joinToString(",") + "]"
        }
        /** 간이 채팅 내용: {title, messages: [{author, content, mine}]} */
        registerNativeMethod("${manifest.id}.chat") { args ->
            try {
                val o = JSONObject(args.getOrNull(0) as? String ?: "{}")
                chatTitle = o.optString("title")
                val arr = o.optJSONArray("messages") ?: JSONArray()
                chatLines = (0 until arr.length()).map {
                    val m = arr.getJSONObject(it)
                    ChatLine(m.optString("author"), m.optString("content"), m.optBoolean("mine"))
                }
                main.post { renderChat() }
                true
            } catch (e: Throwable) {
                lastError = "chat: $e"
                false
            }
        }
        registerNativeMethod("${manifest.id}.closeChat") {
            main.post { if (chatOpen) closeChat() }
            true
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
                "enabled" to overlayOn,
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
        overlayOn = false
        main.post {
            if (chatOpen) closeChat()
            detach()
        }
    }
}
