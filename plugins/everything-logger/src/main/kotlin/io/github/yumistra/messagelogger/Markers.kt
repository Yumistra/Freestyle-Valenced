@file:Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")

package io.github.yumistra.messagelogger

import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextPaint
import android.text.style.CharacterStyle
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.UpdateAppearance
import android.view.View

// JS(rows.ts)와 같아야 한다. 사용자가 칠 일이 없는 사용자 정의 영역 문자
private const val FADE_START = ''
private const val FADE_END = ''
private const val LABEL_START = ''
private const val LABEL_SEPARATOR = ''
private const val LABEL_END = ''
private const val BG_START = '\uE005'
private const val BG_SEPARATOR = '\uE006'
private const val BG_END = '\uE007'
/** 이 글자 하나 → 가로줄 (embed 구분선처럼) */
private const val DIVIDER = '\uE008'

/** 디스코드 "(수정됨)" 글자 크기 */
private const val LABEL_SIZE = 0.75f

/** 예전 내용 투명도 */
private const val FADE_ALPHA = 0.6f

/**
 * - FADE_START 내용 FADE_END → 내용을 흐리게
 * - LABEL_START 색 LABEL_SEPARATOR 글자 LABEL_END → 디스코드 "(수정됨)"처럼 작게, 그 색으로
 * 뒤에서부터 처리해서 앞쪽 표시 위치가 바뀌지 않게 한다.
 */
internal fun styleMarkers(text: SpannableStringBuilder, view: View? = null) {
    // 표시 글자(\uE000~\uE007)가 하나도 없으면 (거의 모든 메시지) 바로 끝낸다
    if (!hasMarker(text)) return
    styleDividers(text)
    styleBackground(text, view)
    if (indexOf(text, FADE_START) < 0 && indexOf(text, LABEL_START) < 0) return
    var guard = 0
    while (guard++ < 500) {
        val s = text.toString() as java.lang.String
        val start = maxOf(s.lastIndexOf(FADE_START.code), s.lastIndexOf(LABEL_START.code))
        if (start < 0) return
        if (text[start] == FADE_START) {
            val end = s.indexOf(FADE_END.code, start)
            if (end >= 0) text.delete(end, end + 1)
            text.delete(start, start + 1)
            val contentEnd = if (end >= 0) end - 1 else text.length
            if (contentEnd > start) text.setSpan(FadeSpan(FADE_ALPHA), start, contentEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            continue
        }
        val sep = s.indexOf(LABEL_SEPARATOR.code, start)
        val end = s.indexOf(LABEL_END.code, start)
        if (sep < 0 || end < 0 || sep > end) {
            text.delete(start, start + 1)
            continue
        }
        val color = try {
            Integer.parseInt(s.substring(start + 1, sep))
        } catch (_: NumberFormatException) {
            null
        }
        text.delete(end, end + 1)
        text.delete(start, sep + 1)
        val labelEnd = start + (end - sep - 1)
        if (labelEnd > start) {
            text.setSpan(RelativeSizeSpan(LABEL_SIZE), start, labelEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (color != null) text.setSpan(ForegroundColorSpan(color), start, labelEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }
}

/**
 * BG_START 배경색,막대색 BG_SEPARATOR 줄들 BG_END → 그 줄들 뒤에 핑처럼 배경과 왼쪽 막대를 깐다 (수정 기록 부분만)
 */
private fun styleBackground(text: SpannableStringBuilder, view: View?) {
    var guard = 0
    while (guard++ < 50) {
        val s = text.toString() as java.lang.String
        val start = s.lastIndexOf(BG_START.code)
        if (start < 0) return
        val sep = s.indexOf(BG_SEPARATOR.code, start)
        var end = s.indexOf(BG_END.code, start)
        if (sep < 0) {
            text.delete(start, start + 1)
            continue
        }
        val colors = s.substring(start + 1, sep)
        val comma = (colors as java.lang.String).indexOf(','.code)
        val bg = parse(if (comma >= 0) colors.substring(0, comma) else colors)
        val bar = if (comma >= 0) parse(colors.substring(comma + 1)) else null
        if (end >= 0) text.delete(end, end + 1) else end = text.length
        text.delete(start, sep + 1)
        val contentEnd = end - (sep + 1 - start)
        if (bg != null && contentEnd > start) {
            text.setSpan(HistoryMark(bg, bar ?: bg), start, contentEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }
}

/** 가로줄 글자에 DividerSpan 을 씌운다 (글자는 그대로 두고 그 자리에 선을 그린다) */
private fun styleDividers(text: SpannableStringBuilder) {
    for (i in 0 until text.length) {
        if (text[i] == DIVIDER && text.getSpans(i, i + 1, DividerSpan::class.java).isEmpty())
            text.setSpan(DividerSpan(), i, i + 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
}

/**
 * embed 의 구분선처럼 얇은 가로줄. 줄 높이는 글자보다 낮게, 색은 그 줄 글자색을 흐리게 (지워진 메시지면 빨갛게)
 */
internal class DividerSpan : android.text.style.ReplacementSpan() {
    override fun getSize(paint: android.graphics.Paint, text: CharSequence?, start: Int, end: Int, fm: android.graphics.Paint.FontMetricsInt?): Int {
        if (fm != null) {
            val h = Math.round(paint.textSize * 0.9f)
            fm.ascent = -h / 2
            fm.top = fm.ascent
            fm.descent = h - h / 2
            fm.bottom = fm.descent
            fm.leading = 0
        }
        return 1
    }

    override fun draw(canvas: android.graphics.Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: android.graphics.Paint) {
        val right = canvas.clipBounds.right.toFloat()
        if (right <= x) return
        val stroke = Math.max(1f, paint.textSize / 16f)
        val cy = (top + bottom) / 2f
        val oldColor = paint.color
        val oldStyle = paint.style
        paint.style = android.graphics.Paint.Style.FILL
        paint.color = (oldColor and 0x00ffffff) or (((oldColor ushr 24) * 0.25f).toInt() shl 24)
        canvas.drawRect(x, cy - stroke / 2f, right, cy + stroke / 2f, paint)
        paint.color = oldColor
        paint.style = oldStyle
    }
}

private fun parse(v: String): Int? = try {
    Integer.parseInt(v)
} catch (_: NumberFormatException) {
    null
}

/** 수정 기록이 어디부터 어디까지인지 표시만 한다 (그리는 건 RowBackground) */
internal class HistoryMark(val bg: Int, val bar: Int)

private fun hasMarker(text: CharSequence): Boolean {
    val n = text.length
    var i = 0
    while (i < n) {
        val c = text[i++]
        if (c >= FADE_START && c <= DIVIDER) return true
    }
    return false
}

private fun indexOf(text: CharSequence, c: Char): Int {
    for (i in 0 until text.length) if (text[i] == c) return i
    return -1
}

// 내용의 다른 색 뒤에 붙어서 그 색까지 흐리게
private class FadeSpan(private val alpha: Float) : CharacterStyle(), UpdateAppearance {
    override fun updateDrawState(paint: TextPaint) {
        paint.alpha = (paint.alpha * alpha).toInt()
    }
}
