package io.github.yumistra.betteranimations

import android.graphics.Rect
import android.view.View
import java.lang.reflect.Field
import java.lang.reflect.Method
import java.lang.reflect.Modifier

/**
 * 앱의 RecyclerView 를 이름 말고 모양으로 찾는다.
 *
 * 디스코드는 버전에 따라 androidx 안쪽 이름까지 줄여 버린다 (352.7: getChildViewHolder → M, ViewHolder → k3.k1 …).
 * RecyclerView 클래스 이름과 안드로이드 기본 메서드(onLayout 등)는 남으니, 나머지는 인자·반환 타입으로 고른다:
 *  - ViewHolder: (View) → X 메서드의 X 중, 추상 클래스이고 View 필드(itemView)가 있는 것
 *  - 줄의 ViewHolder: (View) → ViewHolder (static 이 있으면 그것)
 *  - 어댑터 위치: (ViewHolder) → int  (getAdapterPositionInRecyclerView. 지워진 줄이면 -1)
 *  - 장식 여백: (View) → Rect  (getItemDecorInsetsForChild)
 *  - 항목 id: ViewHolder 의 하나뿐인 long 필드 (mItemId)
 * 못 찾은 건 null 이고, 그걸 쓰는 기능만 꺼진다.
 */
internal class Recycler(cl: ClassLoader) {
    val rv: Class<*> = cl.loadClass(NAME)
    val holderClass: Class<*>?
    private val holderOf: Method?
    private val adapterPos: Method?
    private val itemIdField: Field?
    val decorInsets: Method?
    private val scrollState: Method?

    init {
        val methods = rv.declaredMethods
        val view = View::class.java
        fun oneView(m: Method) = m.parameterTypes.size == 1 && m.parameterTypes[0] == view
        holderClass = methods.filter(::oneView).map { it.returnType }.firstOrNull { t ->
            !t.isPrimitive && t != view && t != Rect::class.java && !view.isAssignableFrom(t) &&
                Modifier.isAbstract(t.modifiers) && !t.isInterface &&
                t.declaredFields.any { f -> f.type == view && !Modifier.isStatic(f.modifiers) }
        }
        holderOf = holderClass?.let { h ->
            methods.filter { oneView(it) && it.returnType == h }.minByOrNull { if (Modifier.isStatic(it.modifiers)) 0 else 1 }
        }?.apply { isAccessible = true }
        adapterPos = holderClass?.let { h ->
            methods.firstOrNull { !Modifier.isStatic(it.modifiers) && it.parameterTypes.size == 1 && it.parameterTypes[0] == h && it.returnType == Int::class.javaPrimitiveType }
        }?.apply { isAccessible = true }
        itemIdField = holderClass?.declaredFields?.filter { !Modifier.isStatic(it.modifiers) && it.type == Long::class.javaPrimitiveType }
            ?.singleOrNull()?.apply { isAccessible = true }
        decorInsets = methods.firstOrNull { !Modifier.isStatic(it.modifiers) && oneView(it) && it.returnType == Rect::class.java }
            ?.apply { isAccessible = true }
        scrollState = try {
            rv.getMethod("getScrollState")
        } catch (e: Throwable) {
            null
        }
    }

    /** 무엇을 찾았는지 (로그용) */
    fun describe() = "holder=${holderClass?.name} holderOf=${holderOf?.name} pos=${adapterPos?.name} id=${itemIdField?.name} decor=${decorInsets?.name}"

    fun holder(list: View, child: View): Any? = try {
        val m = holderOf
        when {
            m == null -> null
            Modifier.isStatic(m.modifiers) -> m.invoke(null, child)
            else -> m.invoke(list, child)
        }
    } catch (e: Throwable) {
        null
    }

    /** 어댑터 위치. 지워졌거나(-1) 알 수 없으면 null 이 아닌 -1, 찾을 방법이 없으면 null */
    fun adapterPosition(list: View, child: View): Int? {
        val m = adapterPos ?: return null
        val h = holder(list, child) ?: return null
        return try {
            m.invoke(list, h) as Int
        } catch (e: Throwable) {
            null
        }
    }

    val canTellRemoved get() = holderOf != null && adapterPos != null

    /** 레이아웃 중에 떨어지는 줄이 "지워진" 항목인지 (스크롤로 빠지는 줄은 위치가 남아 있다) */
    fun isRemoved(list: View, child: View): Boolean = adapterPosition(list, child) == -1

    fun itemId(list: View, child: View): Long? {
        val f = itemIdField ?: return null
        val h = holder(list, child) ?: return null
        return try {
            f.getLong(h)
        } catch (e: Throwable) {
            null
        }
    }

    fun scrollState(list: View): Int = try {
        scrollState?.invoke(list) as? Int ?: 0
    } catch (e: Throwable) {
        0
    }

    companion object {
        const val NAME = "androidx.recyclerview.widget.RecyclerView"
    }
}

/**
 * 채팅 목록 클래스. 이름(ChatListView)이 줄여져 있어도 RN 뷰 매니저(ChatListViewManager)는 이름이 남으니
 * 그 매니저가 만드는 뷰의 타입으로 찾는다.
 */
internal fun findChatListClass(cl: ClassLoader): Class<*>? {
    try {
        val manager = cl.loadClass("com.discord.chat.presentation.list.ChatListViewManager")
        manager.declaredMethods
            .filter { it.name == "createViewInstance" && it.returnType != View::class.java && View::class.java.isAssignableFrom(it.returnType) }
            .map { it.returnType }
            .firstOrNull()
            ?.let { return it }
    } catch (e: Throwable) {
    }
    return try {
        cl.loadClass("com.discord.chat.presentation.list.ChatListView")
    } catch (e: Throwable) {
        null
    }
}
