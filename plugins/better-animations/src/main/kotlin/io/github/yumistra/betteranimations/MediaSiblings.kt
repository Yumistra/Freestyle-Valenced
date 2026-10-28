package io.github.yumistra.betteranimations

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs

/**
 * 사진·동영상 보기에서 옆으로 넘긴 사진의 썸네일 자리 찾기.
 *
 * 디스코드는 처음 누른 썸네일 자리만 넘겨준다. 채팅의 첨부 묶음(MessageAccessoriesView) 안에서 그 자리(창 좌표, dp)에
 * 있는 뷰를 찾고, 그 뷰가 든 사진 묶음(모자이크 RecyclerView)의 칸들을 순서대로 모은다.
 * 칸 순서 = 보기의 사진 순서라서, JS 가 처음 누른 칸을 기준으로 몇 번째인지 맞춰 쓴다.
 */
internal object MediaSiblings {
    private val loc = IntArray(2)

    private fun isAccessories(v: View) = v.javaClass.name.endsWith("MessageAccessoriesView")

    /** 플러그인이 시작할 때 넣어 준다 */
    @Volatile
    var recycler: Recycler? = null

    private fun isRecycler(v: View): Boolean {
        recycler?.let { return it.rv.isInstance(v) }
        var c: Class<*>? = v.javaClass
        while (c != null) {
            if (c.name == Recycler.NAME) return true
            c = c.superclass
        }
        return false
    }

    private fun adapterPosition(rv: View, child: View): Int = recycler?.adapterPosition(rv, child) ?: -1

    /** x, y, w, h: 처음 누른 썸네일 (창 좌표, dp). 결과: {index, rects:[{x,y,w,h}]} 또는 null */
    fun find(activity: Activity, x: Double, y: Double, w: Double, h: Double): JSONObject? {
        val decor = activity.window?.decorView ?: return null
        val d = activity.resources.displayMetrics.density
        if (!(w > 0 && h > 0)) return null

        // 채팅 첨부 안에서 그 자리에 가장 잘 맞는 뷰 (보기 화면 자체의 그림은 안 본다)
        var best: View? = null
        var bestScore = 12.0
        fun walk(v: View, inside: Boolean) {
            if (v.visibility != View.VISIBLE) return
            val inAcc = inside || isAccessories(v)
            if (inAcc && v.width > 0 && v.height > 0) {
                v.getLocationInWindow(loc)
                val score = abs(loc[0] / d - x) + abs(loc[1] / d - y) + abs(v.width / d - w) + abs(v.height / d - h)
                // 같으면 안쪽(나중에 보는) 뷰
                if (score <= bestScore) {
                    best = v
                    bestScore = score
                }
            }
            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i), inAcc)
        }
        walk(decor, false)
        val hit = best ?: return null
        hit.getLocationInWindow(loc)
        val hx = loc[0]
        val hy = loc[1]

        // 사진 묶음: 첨부 묶음 아래에서 가장 가까운 RecyclerView
        var item: View = hit
        var p = hit.parent as? View
        var group: ViewGroup? = null
        while (p != null && !isAccessories(p)) {
            if (isRecycler(p)) {
                group = p as ViewGroup
                break
            }
            item = p
            p = p.parent as? View
        }
        val rects = JSONArray()
        fun put(left: Int, top: Int, width: Int, height: Int) {
            rects.put(
                JSONObject()
                    .put("x", (left / d).toDouble())
                    .put("y", (top / d).toDouble())
                    .put("w", (width / d).toDouble())
                    .put("h", (height / d).toDouble()),
            )
        }
        if (group == null) {
            put(hx, hy, hit.width, hit.height)
            return JSONObject().put("index", 0).put("rects", rects)
        }

        // 누른 뷰가 칸 안에서 차지하는 자리(여백)를 다른 칸에도 똑같이
        item.getLocationInWindow(loc)
        val il = hx - loc[0]
        val itop = hy - loc[1]
        val ir = item.width - hit.width - il
        val ib = item.height - hit.height - itop

        val kids = (0 until group.childCount).map { group.getChildAt(it) }.filter { it.visibility == View.VISIBLE }
        val pos = kids.map { adapterPosition(group, it) }
        val order = if (pos.all { it >= 0 } && pos.toSet().size == pos.size) kids.indices.sortedBy { pos[it] } else kids.indices.toList()
        var index = -1
        for ((n, i) in order.withIndex()) {
            val k = kids[i]
            if (k === item) index = n
            k.getLocationInWindow(loc)
            put(loc[0] + il, loc[1] + itop, k.width - il - ir, k.height - itop - ib)
        }
        if (index < 0) return null
        return JSONObject().put("index", index).put("rects", rects)
    }
}
