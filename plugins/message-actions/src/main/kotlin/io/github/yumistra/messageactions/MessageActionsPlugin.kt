@file:JvmName("MessageActionsPlugin")

package io.github.yumistra.messageactions

import android.animation.ValueAnimator
import android.content.Context
import android.content.res.AssetManager
import android.graphics.Color
import android.graphics.Rect
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.SystemClock
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.animation.LinearInterpolator
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import de.robv.android.xposed.XC_MethodHook
import de.robv.android.xposed.XposedHelpers
import app.valenced.plugins.plugin
import app.valenced.xposed.api.registerNativeAsyncMethod
import app.valenced.xposed.api.registerNativeMethod
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.lang.reflect.Method
import java.util.WeakHashMap
import kotlin.coroutines.resume
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Message Actions 의 네이티브 부분: 메시지 바로 밑에 디스코드 버튼 줄 끼워 넣기.
 *
 * 채팅 목록(ChatListView, RecyclerView)은 네이티브라 JS 는 "어느 메시지인지"만 안다.
 * 손가락이 닿은 줄을 기억해 두었다가, JS 가 showActions 를 부르면
 *  - 그 줄 아래에 빈 자리를 만들어 밑의 메시지를 민다 (RecyclerView 의 장식 여백 = getItemDecorInsetsForChild)
 *  - 그 자리에 디스코드 버튼(크기·글꼴·색·눌림 애니메이션을 디스코드와 같게)을 그린다 (RecyclerView 오버레이)
 *  - 누른 버튼의 id 를 돌려준다.
 * 디스코드는 버전에 따라 안쪽 이름(androidx 포함)을 줄여 버리므로, 이름 대신 모양으로 찾거나(Recycler)
 * 안드로이드 기본 메서드(onInterceptTouchEvent/onTouchEvent)를 잡는다.
 */

private const val ACCESSORIES_VIEW = "com.discord.chat.presentation.message.MessageAccessoriesView"
private const val FONT_MANAGER = "com.facebook.react.common.assets.ReactFontManager"
/** 이보다 오래전에 닿은 줄은 쓰지 않는다 */
private const val TOUCH_TTL = 4000L
/** 메시지를 옆으로 당길 때 보이는 연필 아이콘 (SwipeHelper 가 이 리소스로 editIcon 을 만든다) */
private const val SWIPE_EDIT_ICON = "ic_swipe_edit"
private const val SWIPE_REPLY_ICON = "ic_swipe_reply"
/** 버튼으로 바꿨을 때 당기는 동안 보일 아이콘 (디스코드 ⋯ 아이콘) */
private const val BUTTONS_ICON = "design_components_icon_native_redesign_generated_images_morehorizontalicon"

// 디스코드 버튼 (design/components/Button/native/ButtonConstants: sm)
private const val BUTTON_HEIGHT = 32f
private const val BUTTON_PADDING_H = 12f
private const val BUTTON_ICON = 16f
private const val BUTTON_ICON_GAP = 6f
private const val BUTTON_BORDER = 1f
/** 눌렀을 때 줄어드는 양 (PressableScale 의 scaleAmountInPx 기본값) */
private const val PRESS_SHRINK_PX = 8f
private const val BUTTON_GAP = 8f
private const val ROW_TOP = 4f
private const val ROW_BOTTOM = 8f

/** 디스코드 스프링 (design/animation/reanimated/spring/springPresets) */
private class Spring(val mass: Double, val stiffness: Double, val damping: Double, val clamp: Boolean) {
    private val w0 = sqrt(stiffness / mass)
    private val zeta = damping / (2 * sqrt(stiffness * mass))

    /** 0 에서 출발해 1 로 가는 위치 */
    fun at(t: Double): Double {
        val x = if (zeta < 1) {
            val wd = w0 * sqrt(1 - zeta * zeta)
            1 - exp(-zeta * w0 * t) * (cos(wd * t) + zeta * w0 / wd * sin(wd * t))
        } else {
            1 - exp(-w0 * t) * (1 + w0 * t)
        }
        return if (clamp) min(1.0, x) else x
    }

    /** 거의 멈출 때까지 (ms) */
    val settleMs: Long = ((ln(1000.0) / (min(zeta, 1.0) * w0)) * 1000).toLong().coerceIn(120L, 1500L)
}

private val SPRING_STANDARD = Spring(0.35, 250.0, 13.0, true)
private val ON_PRESS_SPRING = Spring(1.0, 300.0, 27.0, true)

private fun animateSpring(spring: Spring, onUpdate: (Float) -> Unit, onEnd: () -> Unit = {}): ValueAnimator {
    val a = ValueAnimator.ofFloat(0f, 1f)
    a.duration = spring.settleMs
    a.interpolator = LinearInterpolator()
    var ended = false
    a.addUpdateListener {
        val t = it.animatedFraction * spring.settleMs / 1000.0
        onUpdate(if (it.animatedFraction >= 1f) 1f else spring.at(t).toFloat())
        if (it.animatedFraction >= 1f && !ended) {
            ended = true
            onEnd()
        }
    }
    a.start()
    return a
}

private fun color(value: String?, fallback: Int): Int = try {
    if (value.isNullOrEmpty()) fallback else Color.parseColor(value)
} catch (e: Throwable) {
    fallback
}

private fun mix(a: Int, b: Int, t: Float): Int {
    fun ch(s: Int) = (((a shr s) and 0xff) + (((b shr s) and 0xff) - ((a shr s) and 0xff)) * t).roundToInt().coerceIn(0, 255)
    return (ch(24) shl 24) or (ch(16) shl 16) or (ch(8) shl 8) or ch(0)
}

/** 손가락 아래의 줄 */
private fun childUnder(parent: ViewGroup, x: Float, y: Float): View? {
    for (i in parent.childCount - 1 downTo 0) {
        val c = parent.getChildAt(i)
        val left = c.left + c.translationX
        val top = c.top + c.translationY
        if (x >= left && x <= left + c.width && y >= top && y <= top + c.height) return c
    }
    return null
}

private class Colors(val bg: Int, val bgActive: Int, val border: Int, val borderActive: Int, val fg: Int) {
    companion object {
        fun from(o: JSONObject?, fallbackBg: Int) = Colors(
            color(o?.optString("bg"), fallbackBg),
            color(o?.optString("bgActive"), color(o?.optString("bg"), fallbackBg)),
            color(o?.optString("border"), Color.TRANSPARENT),
            color(o?.optString("borderActive"), color(o?.optString("border"), Color.TRANSPARENT)),
            color(o?.optString("fg"), Color.WHITE),
        )
    }
}

/** RecyclerView 쪽 일 (모양으로 찾은 Recycler 위에서) */
private class Rv(private val r: Recycler) {
    private val invalidateDecor: Method? = try {
        r.rv.getMethod("invalidateItemDecorations")
    } catch (e: Throwable) {
        null
    }

    /** 항목 id (어댑터가 고정 id 를 쓴다. 없으면 위치로) */
    fun idOf(list: View, child: View): Long? {
        val pos = r.adapterPosition(list, child) ?: return null
        if (pos < 0) return null
        val id = r.itemId(list, child) ?: -1L
        return if (id == -1L) -1000L - pos else id
    }

    /** 0 = 멈춤 */
    fun scrollState(list: View): Int = r.scrollState(list)

    /**
     * 여백을 다시 재고 바로 다시 배치한다.
     * RN 화면 안이라 requestLayout 이 위로 올라가지 않아서(ReactViewGroup 이 막음) 직접 measure/layout 해야 한다
     * (디스코드도 목록을 바꿀 때 measureAndLayout 으로 이렇게 한다).
     * 장식 여백은 매번 getItemDecorInsetsForChild 를 거치므로 invalidateItemDecorations 가 없어도 된다
     */
    fun relayout(list: View) {
        try {
            invalidateDecor?.invoke(list)
        } catch (e: Throwable) {
        }
        if (list.width <= 0 || list.height <= 0) return
        try {
            list.measure(
                View.MeasureSpec.makeMeasureSpec(list.width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(list.height, View.MeasureSpec.EXACTLY),
            )
            list.layout(list.left, list.top, list.right, list.bottom)
        } catch (e: Throwable) {
        }
    }
}

/** 디스코드 버튼 하나 */
private class ButtonView(
    ctx: Context,
    val id: String,
    var label: String,
    var colors: Colors,
    val confirmLabel: String,
    val confirmColors: Colors?,
    icon: String,
    typeface: Typeface?,
    textSizeSp: Float,
    radius: Float,
    dp: (Float) -> Int,
) : LinearLayout(ctx) {
    val text = TextView(ctx)
    val image = ImageView(ctx)
    private val bg = GradientDrawable()
    private val border = dp(BUTTON_BORDER)
    private var pressAmount = 0f
    private var colorAmount = 0f
    private var from: Colors = colors
    private var pressAnim: ValueAnimator? = null
    private var colorAnim: ValueAnimator? = null
    var armed = confirmLabel.isEmpty()

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(BUTTON_PADDING_H), 0, dp(BUTTON_PADDING_H), 0)
        bg.cornerRadius = radius
        background = bg

        val iconId = if (icon.isEmpty()) 0 else ctx.resources.getIdentifier(icon, "drawable", ctx.packageName)
        if (iconId != 0) {
            try {
                image.setImageDrawable(ctx.getDrawable(iconId)?.mutate())
                val lp = LayoutParams(dp(BUTTON_ICON), dp(BUTTON_ICON))
                lp.marginEnd = dp(BUTTON_ICON_GAP)
                addView(image, lp)
            } catch (e: Throwable) {
            }
        }

        text.text = label
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, textSizeSp)
        if (typeface != null) text.typeface = typeface else text.paint.isFakeBoldText = true
        text.includeFontPadding = false
        text.isSingleLine = true
        text.ellipsize = TextUtils.TruncateAt.END
        addView(text, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        applyColors()
    }

    private fun applyColors() {
        val c = colors
        val f = from
        val t = colorAmount
        val bgc = mix(mix(f.bg, c.bg, t), mix(f.bgActive, c.bgActive, t), pressAmount)
        val bc = mix(mix(f.border, c.border, t), mix(f.borderActive, c.borderActive, t), pressAmount)
        val fg = mix(f.fg, c.fg, t)
        bg.setColor(bgc)
        bg.setStroke(border, bc)
        text.setTextColor(fg)
        image.setColorFilter(fg)
    }

    private fun applyScale() {
        val w = width.toFloat()
        val s = if (w > 0) 1f - (PRESS_SHRINK_PX / w) * pressAmount else 1f
        scaleX = s
        scaleY = s
    }

    /** 누르기/떼기 (디스코드 ON_PRESS_SPRING 으로 줄어들고 색이 진해짐) */
    fun press(down: Boolean) {
        pressAnim?.cancel()
        val start = pressAmount
        val target = if (down) 1f else 0f
        if (start == target) return
        pressAnim = animateSpring(ON_PRESS_SPRING, {
            pressAmount = start + (target - start) * it
            applyColors()
            applyScale()
        })
    }

    /** 확인 상태로 (글자·색이 바뀜) */
    fun arm() {
        armed = true
        if (confirmLabel.isNotEmpty()) {
            text.text = confirmLabel
            label = confirmLabel
        }
        val next = confirmColors ?: return
        from = colors
        colors = next
        colorAmount = 0f
        colorAnim?.cancel()
        colorAnim = animateSpring(SPRING_STANDARD, {
            colorAmount = it
            applyColors()
        })
    }
}

/** 메시지 밑 버튼 줄 하나 (한 번에 하나만) */
private class Bar(
    val list: ViewGroup,
    val rv: Rv,
    val itemId: Long,
    row: View,
    opts: JSONObject,
    typeface: Typeface?,
    val onResult: (String) -> Unit,
    val onClosed: (Bar) -> Unit,
) {
    private val ctx = list.context
    private val dm = ctx.resources.displayMetrics
    fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, dm).roundToInt()

    private val container = LinearLayout(ctx)
    private val buttons = ArrayList<ButtonView>()
    private val fullHeight = dp(ROW_TOP + BUTTON_HEIGHT + ROW_BOTTOM)
    /** 지금 끼워 넣은 자리 높이 (px) */
    var height = 0
        private set
    private var progress = 0f
    private var anim: ValueAnimator? = null
    /** 버튼 줄이 없을 때 이 메시지가 있던 위치 (펼치고 접는 동안 여기 맞춘다) */
    private var originTop = Int.MIN_VALUE
    /** 지난 프레임에 맞춘 위치 (그 사이 사용자가 스크롤했는지 알아보려고) */
    private var lastTarget = Int.MIN_VALUE
    private var startListHeight = 0
    private var compensating = false
    private var closing = false
    private var delivered = false
    private var cleaned = false
    private val inset: Int
    private var pressed: ButtonView? = null
    private var downX = 0f
    private var downY = 0f
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private val clip = Rect()
    /** 버튼을 누른 손가락을 떼거나 취소될 때까지 목록 대신 받는다 */
    private var capturing = false
    private val preDraw = ViewTreeObserver.OnPreDrawListener {
        update()
        true
    }
    private val detach = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(v: View) {}
        override fun onViewDetachedFromWindow(v: View) = finishNow()
    }

    init {
        container.orientation = LinearLayout.HORIZONTAL
        container.gravity = Gravity.CENTER_VERTICAL
        val font = opts.optJSONObject("font")
        val size = font?.optDouble("size", 14.0)?.toFloat() ?: 14f
        val radius = opts.optDouble("radius", 8.0).toFloat().let { TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, it, dm) }
        val arr = opts.optJSONArray("buttons")
        for (i in 0 until (arr?.length() ?: 0)) {
            val b = arr!!.optJSONObject(i) ?: continue
            val confirm = b.optJSONObject("confirm")
            val v = ButtonView(
                ctx,
                b.optString("id"),
                b.optString("label", b.optString("id")),
                Colors.from(b.optJSONObject("colors"), Color.parseColor("#4e5058")),
                confirm?.optString("label") ?: "",
                confirm?.optJSONObject("colors")?.let { Colors.from(it, Color.parseColor("#da373c")) },
                b.optString("icon"),
                typeface,
                size,
                radius,
                ::dp,
            )
            val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(BUTTON_HEIGHT))
            if (buttons.isNotEmpty()) lp.marginStart = dp(BUTTON_GAP)
            container.addView(v, lp)
            buttons.add(v)
        }
        inset = contentInset(row) ?: dp(opts.optDouble("inset", 68.0).toFloat())
        measureContainer()
        container.alpha = 0f
        container.pivotX = 0f
        container.pivotY = 0f
        list.overlay.add(container)

        list.viewTreeObserver.addOnPreDrawListener(preDraw)
        list.addOnAttachStateChangeListener(detach)
        animateTo(1f)
    }

    /** 메시지 글자가 시작하는 x (아바타 오른쪽) */
    private fun contentInset(row: View): Int? {
        try {
            val cls = row.javaClass.classLoader?.loadClass(ACCESSORIES_VIEW) ?: return null
            val found = find(row, cls) ?: return null
            val r = Rect(0, 0, 0, 0)
            (row as? ViewGroup)?.offsetDescendantRectToMyCoords(found, r) ?: return null
            var x = r.left + found.paddingLeft
            if (found is ViewGroup && found.childCount > 0) {
                var m = Int.MAX_VALUE
                for (i in 0 until found.childCount) m = min(m, found.getChildAt(i).left)
                if (m != Int.MAX_VALUE) x = r.left + m
            }
            return if (x > 0 && x < row.width / 2) x else null
        } catch (e: Throwable) {
            return null
        }
    }

    private fun find(v: View, cls: Class<*>): View? {
        if (cls.isInstance(v)) return v
        if (v is ViewGroup) for (i in 0 until v.childCount) find(v.getChildAt(i), cls)?.let { return it }
        return null
    }

    private fun measureContainer() {
        container.measure(
            View.MeasureSpec.makeMeasureSpec(max(0, list.width - inset - dp(8f)), View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(dp(BUTTON_HEIGHT), View.MeasureSpec.EXACTLY),
        )
        container.layout(0, 0, container.measuredWidth, container.measuredHeight)
    }

    fun matches(child: View) = rv.idOf(list, child) == itemId

    private fun findRow(): View? {
        for (i in 0 until list.childCount) {
            val c = list.getChildAt(i)
            if (matches(c)) return c
        }
        return null
    }

    /** 펼치기(1)·접기(0). 디스코드 기본 스프링 */
    private fun animateTo(target: Float, onEnd: () -> Unit = {}) {
        anim?.cancel()
        val start = progress
        val row = findRow()
        if (row != null) {
            // 처음 펼칠 때, 또는 펼쳐 둔 사이에 스크롤했으면 지금 위치를 기준으로
            if (originTop == Int.MIN_VALUE || row.top != lastTarget) originTop = row.top
            compensating = true
        } else {
            compensating = false
        }
        startListHeight = list.height
        anim = animateSpring(SPRING_STANDARD, {
            progress = start + (target - start) * it
            val h = (fullHeight * progress).roundToInt()
            if (h != height) {
                height = h
                rv.relayout(list)
                keepRow()
            }
            container.alpha = progress
            val s = 0.96f + 0.04f * progress
            container.scaleX = s
            container.scaleY = s
            list.invalidate()
        }, {
            compensating = false
            onEnd()
        })
    }

    /**
     * 이 메시지는 제자리에 두고 밑의 메시지만 밀고 당긴다 (화면 밑에 닿으면 위로 자란다).
     * 사용자가 스크롤하거나 목록 크기가 바뀌면(키보드) 그만둔다
     */
    private fun keepRow() {
        if (!compensating || originTop == Int.MIN_VALUE) return
        if (rv.scrollState(list) != 0 || list.height != startListHeight) {
            compensating = false
            return
        }
        val row = findRow() ?: return
        val bottomLimit = list.height - list.paddingBottom - row.height - height
        val want = min(originTop, max(bottomLimit, list.paddingTop - row.height))
        val dy = row.top - want
        if (dy != 0) list.scrollBy(0, dy)
        lastTarget = findRow()?.top ?: want
    }

    /** 매 프레임 (그리기 직전): 버튼 줄 위치 맞추기 */
    private fun update() {
        val row = findRow()
        if (row == null) {
            container.visibility = View.INVISIBLE
            return
        }
        container.visibility = View.VISIBLE
        val x = (row.left + inset).toFloat()
        val y = (row.bottom + dp(ROW_TOP)).toFloat()
        if (container.translationX != x) container.translationX = x
        if (container.translationY != y) container.translationY = y
        // 자리만큼만 보인다 (밑의 메시지와 겹치지 않게)
        val visible = max(0, height - dp(ROW_TOP))
        clip.set(-dp(8f), -dp(4f), container.width + dp(8f), min(container.height + dp(4f), visible))
        container.clipBounds = clip
    }

    private fun buttonAt(x: Float, y: Float): ButtonView? {
        if (container.visibility != View.VISIBLE || progress < 0.5f) return null
        val cx = x - container.translationX
        val cy = y - container.translationY
        for (b in buttons) {
            if (cx >= b.left && cx <= b.right && cy >= b.top - dp(6f) && cy <= b.bottom + dp(6f)) return b
        }
        return null
    }

    /** 목록의 onInterceptTouchEvent 앞에서. true 면 목록 대신 우리가 받는다 */
    fun intercept(e: MotionEvent): Boolean {
        if (e.actionMasked != MotionEvent.ACTION_DOWN) return capturing
        capturing = false
        if (closing) return false
        val b = buttonAt(e.x, e.y)
        if (b == null) {
            // 다른 곳을 누르면 닫힌다 (누른 건 그대로 전달)
            close("")
            return false
        }
        pressed = b
        downX = e.x
        downY = e.y
        b.press(true)
        capturing = true
        return true
    }

    /** 목록의 onTouchEvent 앞에서. true 면 목록에 넘기지 않는다 */
    fun touch(e: MotionEvent): Boolean {
        if (!capturing) return false
        if (e.actionMasked == MotionEvent.ACTION_UP || e.actionMasked == MotionEvent.ACTION_CANCEL) capturing = false
        onTouch(e)
        return true
    }

    private fun onTouch(e: MotionEvent) {
        val b = pressed ?: return
        when (e.actionMasked) {
            MotionEvent.ACTION_MOVE -> if (abs(e.x - downX) > slop * 2 || abs(e.y - downY) > slop * 2) {
                b.press(false)
                pressed = null
            }
            MotionEvent.ACTION_UP -> {
                b.press(false)
                pressed = null
                if (buttonAt(e.x, e.y) === b) click(b)
            }
            MotionEvent.ACTION_CANCEL -> {
                b.press(false)
                pressed = null
            }
        }
    }

    private fun click(b: ButtonView) {
        try {
            list.performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY)
        } catch (e: Throwable) {
        }
        if (!b.armed) {
            b.arm()
            list.post { measureContainer() }
            return
        }
        close(b.id)
    }

    private fun deliver(result: String) {
        if (delivered) return
        delivered = true
        onResult(result)
    }

    fun close(result: String) {
        deliver(result)
        if (closing) return
        closing = true
        pressed = null
        animateTo(0f) { cleanup() }
    }

    fun finishNow() {
        deliver("")
        anim?.cancel()
        cleanup()
    }

    private fun cleanup() {
        if (cleaned) return
        cleaned = true
        closing = true
        height = 0
        try {
            list.overlay.remove(container)
        } catch (e: Throwable) {
        }
        capturing = false
        try {
            list.viewTreeObserver.removeOnPreDrawListener(preDraw)
        } catch (e: Throwable) {
        }
        list.removeOnAttachStateChangeListener(detach)
        rv.relayout(list)
        keepRow()
        compensating = false
        onClosed(this)
    }
}

private class Touched(val list: WeakReference<ViewGroup>, val row: WeakReference<View>, val at: Long)

/**
 * 당기기 아이콘을 그리는 SwipeHelper. 이름(SwipeHelper, editIcon, drawContextArea)이 줄여져 있어도
 * 채팅 목록 → ItemTouchHelper(장식 목록 안) → 콜백 으로 찾아가서, 필드 모양(Drawable 둘 이상 + Context)으로 알아본다.
 * 연필 아이콘 필드는 ic_swipe_edit 리소스와 같은 그림인 것으로 고른다.
 */
private class SwipeIcon(val cls: Class<*>, val field: java.lang.reflect.Field, val context: java.lang.reflect.Field?)

private fun allFields(c: Class<*>): List<java.lang.reflect.Field> {
    val out = ArrayList<java.lang.reflect.Field>()
    var k: Class<*>? = c
    while (k != null && k != Any::class.java && k != View::class.java && k != ViewGroup::class.java) {
        for (f in k.declaredFields) if (!java.lang.reflect.Modifier.isStatic(f.modifiers)) out.add(f)
        k = k.superclass
    }
    return out
}

private fun looksLikeSwipeHelper(c: Class<*>): Boolean {
    val fs = c.declaredFields.filter { !java.lang.reflect.Modifier.isStatic(it.modifiers) }
    return fs.count { it.type == android.graphics.drawable.Drawable::class.java } >= 2 && fs.any { it.type == Context::class.java }
}

private fun findSwipeIcon(list: ViewGroup, rvClass: Class<*>): Pair<Any, SwipeIcon>? {
    val seen = java.util.IdentityHashMap<Any, Boolean>()
    // 목록 필드 중 ArrayList (장식·터치 리스너 목록) 안의 객체들 → 그 필드들
    for (f in allFields(rvClass)) {
        if (!java.util.List::class.java.isAssignableFrom(f.type)) continue
        val items = try {
            f.isAccessible = true
            (f.get(list) as? List<*>)?.toList()
        } catch (e: Throwable) {
            null
        } ?: continue
        for (item in items) {
            if (item == null || seen.put(item, true) != null) continue
            for (g in allFields(item.javaClass)) {
                if (g.type.isPrimitive || g.type == String::class.java) continue
                val v = try {
                    g.isAccessible = true
                    g.get(item)
                } catch (e: Throwable) {
                    null
                } ?: continue
                if (v is View || !looksLikeSwipeHelper(v.javaClass)) continue
                val icon = pickEditIcon(list.context, v) ?: continue
                return v to icon
            }
        }
    }
    return null
}

private fun pickEditIcon(ctx: Context, helper: Any): SwipeIcon? {
    val c = helper.javaClass
    val drawables = c.declaredFields.filter { !java.lang.reflect.Modifier.isStatic(it.modifiers) && it.type == android.graphics.drawable.Drawable::class.java }
    drawables.forEach { it.isAccessible = true }
    val contextField = c.declaredFields.firstOrNull { !java.lang.reflect.Modifier.isStatic(it.modifiers) && it.type == Context::class.java }?.apply { isAccessible = true }
    // 이름이 남아 있으면 그대로
    drawables.firstOrNull { it.name == "editIcon" }?.let { return SwipeIcon(c, it, contextField) }
    // 같은 리소스라도 테마·캐시에 따라 ConstantState 가 다를 수 있어서, 그려 본 모양(투명도)으로 비교한다
    val res = (contextField?.get(helper) as? Context ?: ctx)
    fun load(name: String): android.graphics.drawable.Drawable? {
        val id = res.resources.getIdentifier(name, "drawable", res.packageName)
        if (id == 0) return null
        return try {
            res.getDrawable(id)
        } catch (e: Throwable) {
            null
        }
    }
    fun valueOf(f: java.lang.reflect.Field) = f.get(helper) as? android.graphics.drawable.Drawable
    val edit = load(SWIPE_EDIT_ICON)
    if (edit != null) {
        drawables.firstOrNull { f -> valueOf(f)?.let { sameShape(it, edit) } == true }?.let { return SwipeIcon(c, it, contextField) }
    }
    // 답장 아이콘이 아닌 나머지 하나
    val reply = load(SWIPE_REPLY_ICON)
    if (reply != null && drawables.size == 2) {
        val others = drawables.filter { f -> valueOf(f)?.let { sameShape(it, reply) } != true }
        if (others.size == 1) return SwipeIcon(c, others[0], contextField)
    }
    return null
}

/** 두 그림의 모양이 같은지 (작게 그려서 투명도만 비교. 색칠·틴트는 무시) */
private fun sameShape(a: android.graphics.drawable.Drawable, b: android.graphics.drawable.Drawable): Boolean {
    fun render(d: android.graphics.drawable.Drawable): android.graphics.Bitmap? {
        // 원래 그림의 크기(bounds)를 건드리지 않게 복사본으로
        val copy = d.constantState?.newDrawable()?.mutate() ?: return null
        val bmp = android.graphics.Bitmap.createBitmap(32, 32, android.graphics.Bitmap.Config.ALPHA_8)
        copy.setBounds(0, 0, 32, 32)
        copy.draw(android.graphics.Canvas(bmp))
        return bmp
    }
    return try {
        val x = render(a) ?: return false
        val y = render(b) ?: return false
        val same = x.sameAs(y)
        x.recycle()
        y.recycle()
        same
    } catch (e: Throwable) {
        false
    }
}

@Suppress("UNUSED")
val messageActionsPlugin = plugin {
    var unhooks = emptyList<XC_MethodHook.Unhook>()
    val originalIcons = WeakHashMap<Any, android.graphics.drawable.Drawable>()
    var swipeIcon: SwipeIcon? = null

    start {
        var touched: Touched? = null
        var active: Bar? = null
        /** 자리를 더해 둔 줄: [마지막으로 넣은 bottom, 더한 양] */
        val added = WeakHashMap<View, IntArray>()

        val cl = classLoader
        // 디스코드 버전마다 안쪽 이름이 바뀔 수 있다. 못 찾으면 JS 가 다른 방식(창)으로 보여 주게 "norow" 만 돌려준다
        val recycler = try {
            Recycler(cl)
        } catch (e: Throwable) {
            null
        }
        val chatListView = findChatListClass(cl)
        if (recycler == null || chatListView == null) {
            log.w("Chat list not found (recycler=${recycler != null}, chat=${chatListView != null}); inline buttons disabled")
            registerNativeAsyncMethod("${manifest.id}.showActions") { "norow" }
            registerNativeMethod("${manifest.id}.setSwipeButtons") { true }
            registerNativeMethod("${manifest.id}.ping") { "pong" }
            return@start
        }
        log.i("RecyclerView: ${recycler.describe()} chat=${chatListView.name}")
        val rv = Rv(recycler)
        val rvClass = recycler.rv

        val fonts = HashMap<String, Typeface?>()
        var fontGetter: Method? = null
        var fontManager: Any? = null
        fun typeface(ctx: Context, family: String?): Typeface? {
            if (family.isNullOrEmpty()) return null
            if (fonts.containsKey(family)) return fonts[family]
            var tf: Typeface? = null
            // RN 과 같은 곳 (assets/fonts/<이름>.ttf|.otf). 안 되면 RN 의 글꼴 관리자 (이름이 남아 있으면)
            for (ext in listOf(".ttf", ".otf")) {
                if (tf != null) break
                tf = try {
                    Typeface.createFromAsset(ctx.assets, "fonts/$family$ext")
                } catch (e: Throwable) {
                    null
                }
            }
            if (tf == null) {
                tf = try {
                    if (fontGetter == null) {
                        val c = cl.loadClass(FONT_MANAGER)
                        fontManager = c.getMethod("getInstance").invoke(null)
                        fontGetter = c.getMethod("getTypeface", String::class.java, Int::class.javaPrimitiveType, AssetManager::class.java)
                    }
                    fontGetter!!.invoke(fontManager, family, Typeface.NORMAL, ctx.assets) as? Typeface
                } catch (e: Throwable) {
                    log.w("font $family: $e")
                    null
                }
            }
            fonts[family] = tf
            return tf
        }

        // 세게 당기기가 "버튼"이면 당길 때 연필 대신 ⋯ 아이콘
        var swipeButtons = false
        val buttonIcons = WeakHashMap<Any, android.graphics.drawable.Drawable>()
        var swipeTries = 0
        val hooks = ArrayList<XC_MethodHook.Unhook>()

        fun swapIcon(h: Any) {
            val si = swipeIcon ?: return
            if (!si.cls.isInstance(h)) return
            try {
                val current = si.field.get(h) as? android.graphics.drawable.Drawable ?: return
                if (swipeButtons) {
                    var icon = buttonIcons[h]
                    if (icon == null) {
                        val ctx = si.context?.get(h) as? Context ?: return
                        val id = ctx.resources.getIdentifier(BUTTONS_ICON, "drawable", ctx.packageName)
                        if (id == 0) return
                        icon = ctx.getDrawable(id)?.mutate() ?: return
                        buttonIcons[h] = icon
                    }
                    if (current !== icon) {
                        originalIcons[h] = current
                        si.field.set(h, icon)
                    }
                } else {
                    val orig = originalIcons.remove(h) ?: return
                    si.field.set(h, orig)
                }
            } catch (e: Throwable) {
            }
        }

        /** 처음 채팅 목록을 만질 때 한 번 SwipeHelper 를 찾아, 캔버스에 그리는 메서드들 앞에서 아이콘을 바꾼다 */
        fun findSwipe(list: ViewGroup) {
            // 못 찾으면 몇 번 더 (채팅 목록이 다 준비되기 전일 수 있다)
            if (swipeIcon != null || swipeTries >= 5) return
            swipeTries++
            try {
                val (helper, si) = findSwipeIcon(list, rvClass) ?: run {
                    log.w("Swipe icon not found")
                    return
                }
                swipeIcon = si
                var n = 0
                for (m in si.cls.declaredMethods) {
                    if (m.parameterTypes.isEmpty() || m.parameterTypes[0] != android.graphics.Canvas::class.java) continue
                    hooks.add(
                        de.robv.android.xposed.XposedBridge.hookMethod(
                            m,
                            object : XC_MethodHook() {
                                override fun beforeHookedMethod(param: MethodHookParam) {
                                    param.thisObject?.let(::swapIcon)
                                }
                            },
                        ),
                    )
                    n++
                }
                unhooks = unhooks + hooks.takeLast(n)
                swapIcon(helper)
                log.i("Swipe icon: ${si.cls.name}.${si.field.name} ($n draw methods)")
            } catch (e: Throwable) {
                log.w("Swipe icon not hooked: $e")
            }
        }

        // 메시지를 누르기 시작한 줄을 기억하고, 버튼 줄이 떠 있으면 그 버튼 누르기를 먼저 받는다
        hooks.add(
            XposedHelpers.findAndHookMethod(
                rvClass,
                "onInterceptTouchEvent",
                MotionEvent::class.java,
                object : XC_MethodHook() {
                    override fun beforeHookedMethod(param: MethodHookParam) {
                        val list = param.thisObject as? ViewGroup ?: return
                        if (!chatListView.isInstance(list)) return
                        val ev = param.args[0] as? MotionEvent ?: return
                        val bar = active
                        if (bar != null && bar.list === list) {
                            try {
                                if (bar.intercept(ev)) {
                                    param.result = true
                                    return
                                }
                            } catch (e: Throwable) {
                                log.e("touch: $e")
                            }
                        }
                        if (ev.actionMasked != MotionEvent.ACTION_DOWN) return
                        findSwipe(list)
                        val row = childUnder(list, ev.x, ev.y) ?: return
                        touched = Touched(WeakReference(list), WeakReference(row), SystemClock.uptimeMillis())
                    }
                },
            ),
        )
        hooks.add(
            XposedHelpers.findAndHookMethod(
                rvClass,
                "onTouchEvent",
                MotionEvent::class.java,
                object : XC_MethodHook() {
                    override fun beforeHookedMethod(param: MethodHookParam) {
                        val bar = active ?: return
                        if (bar.list !== param.thisObject) return
                        val ev = param.args[0] as? MotionEvent ?: return
                        try {
                            if (bar.touch(ev)) param.result = true
                        } catch (e: Throwable) {
                            log.e("touch: $e")
                        }
                    }
                },
            ),
        )
        // 버튼 줄 자리만큼 그 메시지 아래 여백을 더한다 → RecyclerView 가 밑의 메시지를 민다
        val decor = recycler.decorInsets
        if (decor == null) {
            log.w("Item decoration insets not found; buttons will overlap the messages below")
        } else {
            hooks.add(
                de.robv.android.xposed.XposedBridge.hookMethod(
                    decor,
                    object : XC_MethodHook() {
                        override fun afterHookedMethod(param: MethodHookParam) {
                            val bar = active
                            if (bar == null && added.isEmpty()) return
                            val list = param.thisObject as? View ?: return
                            if (!chatListView.isInstance(list)) return
                            val rect = param.result as? Rect ?: return
                            val child = param.args[0] as? View ?: return
                            val prev = added[child]
                            val want = if (bar != null && bar.list === list && bar.height > 0 && bar.matches(child)) bar.height else 0
                            if (prev == null && want == 0) return
                            val base = if (prev != null && rect.bottom == prev[0]) prev[0] - prev[1] else rect.bottom
                            rect.bottom = base + want
                            if (want == 0) added.remove(child) else added[child] = intArrayOf(rect.bottom, want)
                        }
                    },
                ),
            )
        }
        unhooks = hooks.toList()

        /**
         * args[0]: JSON {buttons:[{id,label,icon,colors:{bg,bgActive,border,borderActive,fg},confirm?:{label,colors}}], font:{family,size}, radius, inset}
         * 돌려주는 값: 누른 버튼 id, 닫으면 "", 띄울 줄이 없으면 "norow"
         */
        registerNativeAsyncMethod("${manifest.id}.showActions") { args ->
            val opts = try {
                JSONObject(args.getOrNull(0) as? String ?: "{}")
            } catch (e: Throwable) {
                JSONObject()
            }
            withContext(Dispatchers.Main) {
                val t = touched ?: return@withContext "norow"
                val list = t.list.get()
                val row = t.row.get()
                if (list == null || row == null || !row.isAttachedToWindow || row.parent !== list ||
                    SystemClock.uptimeMillis() - t.at > TOUCH_TTL
                ) {
                    return@withContext "norow"
                }
                val id = rv.idOf(list, row) ?: return@withContext "norow"
                active?.finishNow()
                suspendCancellableCoroutine { cont ->
                    val font = opts.optJSONObject("font")
                    val tf = typeface(list.context, font?.optString("family"))
                    try {
                        val bar = Bar(list, rv, id, row, opts, tf, { result ->
                            if (cont.isActive) cont.resume(result)
                        }, { closed ->
                            if (active === closed) active = null
                        })
                        active = bar
                        cont.invokeOnCancellation { list.post { bar.close("") } }
                    } catch (e: Throwable) {
                        log.e("showActions: $e")
                        if (cont.isActive) cont.resume("norow")
                    }
                }
            }
        }

        registerNativeMethod("${manifest.id}.setSwipeButtons") { args ->
            swipeButtons = args.getOrNull(0) == true
            true
        }

        registerNativeMethod("${manifest.id}.ping") { "pong" }
        log.i("Ready to show message actions")
    }

    stop {
        val si = swipeIcon
        for ((h, icon) in originalIcons) {
            try {
                si?.field?.set(h, icon)
            } catch (e: Throwable) {
            }
        }
        originalIcons.clear()
        for (unhook in unhooks) unhook.unhook()
        unhooks = emptyList()
    }
}
