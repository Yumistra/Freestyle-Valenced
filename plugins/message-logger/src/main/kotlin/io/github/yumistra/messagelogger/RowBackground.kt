@file:Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")

package io.github.yumistra.messagelogger

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.text.Spanned
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import java.lang.ref.WeakReference
import java.util.WeakHashMap

/**
 * 수정 기록 줄 뒤에 핑처럼 배경을 깐다.
 * 메시지 글은 메시지 안의 작은 목록(MessageAccessoriesView) 안에 있으므로,
 * 가장 바깥 목록(채팅 목록) 바로 아래 뷰 = 메시지 한 줄 전체의 배경으로 그린다.
 * 디스코드 핑 표시처럼 줄 왼쪽 끝~오른쪽 끝, 맨 왼쪽에 막대(message_gutter_width).
 */
internal object RowBackground {
    @Volatile
    var listClass: Class<*>? = null

    private val listening = WeakHashMap<View, Boolean>()
    private val waiting = WeakHashMap<View, Boolean>()

    /** 우리가 일부러 배경을 되돌리는 중 */
    @Volatile
    var removing = false

    fun update(view: View?) {
        val tv = view as? TextView ?: return
        val r = object : Runnable {
            override fun run() {
                try {
                    apply(tv)
                } catch (t: Throwable) {
                    Diag.error = t.toString()
                }
            }
        }
        tv.post(r)
    }

    private fun apply(tv: TextView) {
        val has = markOf(tv) != null
        if (has) Diag.marked++
        val row = rowOf(tv)
        if (row == null) {
            if (has) {
                Diag.miss = "no row"
                // 아직 목록에 안 붙었다 (채널을 열거나 메시지로 바로 갈 때). 붙는 순간 다시 한다
                if (waiting[tv] == null) {
                    waiting[tv] = true
                    tv.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                        override fun onViewAttachedToWindow(v: View) {
                            v.removeOnAttachStateChangeListener(this)
                            waiting.remove(v)
                            update(v)
                        }

                        override fun onViewDetachedFromWindow(v: View) {}
                    })
                }
            }
            return
        }
        val cur = row.background
        if (has) {
            Diag.listName = row.javaClass.name + " in " + (row.parent as Any).javaClass.name
            if (cur is HistoryDrawable) {
                cur.owner = WeakReference(tv)
                cur.invalidateSelf()
            } else {
                row.background = HistoryDrawable(cur, WeakReference(tv), row)
                Diag.bgSet++
            }
            row.invalidate()
            if (listening[tv] == null) {
                listening[tv] = true
                tv.addOnLayoutChangeListener(object : View.OnLayoutChangeListener {
                    override fun onLayoutChange(v: View, l: Int, t: Int, r: Int, b: Int, ol: Int, ot: Int, or: Int, ob: Int) {
                        val bg = rowOf(v)?.background
                        if (bg is HistoryDrawable) bg.invalidateSelf()
                    }
                })
            }
        } else if (cur is HistoryDrawable && cur.owner.get() === tv) {
            removing = true
            try {
                row.background = cur.prev
            } finally {
                removing = false
            }
        }
    }

    /** 가장 바깥 목록(RecyclerView) 바로 아래 뷰 = 채팅의 메시지 한 줄 */
    fun rowOf(v: View): View? {
        val c = listClass
        var child: View = v
        var p = v.parent
        var n = 0
        var found: View? = null
        while (p is ViewGroup && n++ < 40) {
            if (if (c != null) c.isInstance(p) else (p.javaClass.name as java.lang.String).indexOf("RecyclerView") >= 0) found = child
            child = p
            p = p.parent
        }
        return found
    }

    fun markOf(tv: TextView): HistoryMark? {
        val t = tv.text as? Spanned ?: return null
        val marks = t.getSpans(0, t.length, HistoryMark::class.java)
        return if (marks != null && marks.size > 0) marks[0] else null
    }
}

internal class HistoryDrawable(prev: Drawable?, var owner: WeakReference<TextView>, row: View) : Drawable(), Drawable.Callback {
    /** 원래(또는 디스코드가 나중에 넣은) 배경. 그 위에 그린다 */
    var prev: Drawable? = null
        set(v) {
            field?.callback = null
            field = v
            v?.callback = this
            invalidateSelf()
        }

    init {
        this.prev = prev
    }

    // 원래 배경이 움직이면(반짝임 등) 같이 다시 그린다
    override fun invalidateDrawable(who: Drawable) = invalidateSelf()
    override fun scheduleDrawable(who: Drawable, what: Runnable, `when`: Long) = scheduleSelf(what, `when`)
    override fun unscheduleDrawable(who: Drawable, what: Runnable) = unscheduleSelf(what)

    private val row = WeakReference(row)
    private val paint = Paint()
    private var gutter = -1

    override fun draw(canvas: Canvas) {
        val p = prev
        if (p != null) {
            p.bounds = bounds
            p.draw(canvas)
        }
        val tv = owner.get() ?: return
        val r = row.get() ?: return
        val mark = RowBackground.markOf(tv) ?: return
        val layout = tv.layout ?: return
        val t = tv.text as? Spanned ?: return
        val s = t.getSpanStart(mark)
        val e = t.getSpanEnd(mark)
        if (s < 0 || e <= s) return
        // 글 칸이 줄 안에서 어디 있는지
        var y = 0f
        var v: View = tv
        var n = 0
        while (v !== r && n++ < 40) {
            y += v.top + v.translationY - (if (v !== tv) v.scrollY else 0)
            val parent = v.parent as? View ?: return
            v = parent
        }
        y += tv.totalPaddingTop - tv.scrollY
        val firstLine = layout.getLineForOffset(s)
        // 수정 기록이 글 맨 위부터면 그 위(아바타·이름 줄 포함)도 핑처럼 줄 맨 위부터 채운다
        val top = if (firstLine == 0) bounds.top.toFloat() else y + layout.getLineTop(firstLine)
        val bottom = y + layout.getLineBottom(layout.getLineForOffset(Math.max(s, e - 1)))
        if (gutter < 0) {
            gutter = try {
                val res = tv.resources
                val id = res.getIdentifier("message_gutter_width", "dimen", tv.context.packageName)
                if (id != 0) res.getDimensionPixelSize(id) else Math.round(res.displayMetrics.density * 2f)
            } catch (_: Throwable) {
                4
            }
        }
        val left = bounds.left.toFloat()
        paint.style = Paint.Style.FILL
        paint.color = mark.bg
        canvas.drawRect(left, top, bounds.right.toFloat(), bottom, paint)
        paint.color = mark.bar
        canvas.drawRect(left, top, left + gutter, bottom, paint)
        Diag.drawn++
    }

    override fun getPadding(padding: Rect): Boolean = prev?.getPadding(padding) ?: false
    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(colorFilter: ColorFilter?) {}
    @Deprecated("") override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}

/**
 * View.setBackgroundDrawable 앞: 우리 배경이 깔린 줄에 디스코드가 다른 배경을 넣으면(메시지로 바로 갈 때 반짝임 등)
 * 우리 걸 치우지 않고 그 배경을 우리 안에 넣어 같이 그린다 (깜빡이지 않게)
 */
internal object OnSetBackground : de.robv.android.xposed.XC_MethodHook() {
    override fun beforeHookedMethod(param: MethodHookParam) {
        val v = param.thisObject as? View ?: return
        val cur = v.background as? HistoryDrawable ?: return
        val next = param.args[0] as? Drawable
        if (next is HistoryDrawable) return
        if (RowBackground.removing) return
        cur.prev = next
        param.result = null
    }
}
