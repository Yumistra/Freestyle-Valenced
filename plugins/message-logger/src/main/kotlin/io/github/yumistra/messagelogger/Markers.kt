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

private fun parse(v: String): Int? = try {
    Integer.parseInt(v)
} catch (_: NumberFormatException) {
    null
}

/** 수정 기록이 어디부터 어디까지인지 표시만 한다 (그리는 건 RowBackground) */
internal class HistoryMark(val bg: Int, val bar: Int)

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
