package io.github.yumistra.shizukuperms

import android.app.Activity
import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.PermissionInfo
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import rikka.shizuku.Shizuku
import java.util.concurrent.Executors

/**
 * Shizuku Permissions: Shizuku(셸 권한)로 다른 앱(디스코드)에 권한을 준다.
 *
 * Valenced 플러그인이 freestyleperms://open 으로 연다. 홈 화면에는 없고, 연 앱이 디스코드일 때만 그 앱의 권한을 보여 준다.
 * - 런타임 권한, 개발용 권한: pm grant / pm revoke
 * - 앱 작업(appop) 권한 (다른 앱 위에 표시, 모든 파일 접근 등): appops set
 * - 배터리 최적화 제외, 백그라운드 제한 없음
 * 서명, 시스템 권한은 Shizuku 로도 줄 수 없어서 끌 수 없게 보여 준다.
 */
class MainActivity : Activity() {

    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    private lateinit var list: LinearLayout
    private lateinit var statusView: TextView
    private lateinit var shizukuButton: Button
    private lateinit var allButton: Button

    private var target: String = ""

    /** 명령은 성공했는데 안드로이드가 유지하지 않은 것 (앱이 그 권한을 요청하지 않으면 그렇다) */
    private val notKept = mutableSetOf<String>()
    /** 안드로이드가 거절한 것과 이유 */
    private val refused = mutableMapOf<String, String>()

    private val permissionListener = Shizuku.OnRequestPermissionResultListener { _, _ -> main.post { refresh() } }
    private val binderListener = Shizuku.OnBinderReceivedListener { main.post { refresh() } }
    private val deadListener = Shizuku.OnBinderDeadListener { main.post { refresh() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        target = pickTarget(intent)
        buildUi()
        Shizuku.addRequestPermissionResultListener(permissionListener)
        Shizuku.addBinderReceivedListenerSticky(binderListener)
        Shizuku.addBinderDeadListener(deadListener)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        target = pickTarget(intent)
        refresh()
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onDestroy() {
        Shizuku.removeRequestPermissionResultListener(permissionListener)
        Shizuku.removeBinderReceivedListener(binderListener)
        Shizuku.removeBinderDeadListener(deadListener)
        io.shutdown()
        super.onDestroy()
    }

    // ── 대상 앱 ───────────────────────────────────────────────────────────
    /** 이 화면을 연 앱. 디스코드(패키지 이름을 바꾼 것 포함)가 아니면 빈 값 */
    private fun pickTarget(i: Intent?): String {
        // 여는 쪽이 인텐트에 넣은 referrer 는 지운다. 그래야 getReferrer 가 시스템이 정한 진짜 여는 앱을 준다
        i?.removeExtra(Intent.EXTRA_REFERRER)
        i?.removeExtra(Intent.EXTRA_REFERRER_NAME)
        val ref = try {
            referrer
        } catch (_: Throwable) {
            null
        }
        val pkg = if (ref?.scheme == "android-app") ref.host else null
        if (pkg.isNullOrBlank() || pkg == packageName) return ""
        return if (isDiscord(pkg)) pkg else ""
    }

    /** 디스코드 앱인지: 디스코드의 화면(com.discord.…)을 가지고 있다 */
    private fun isDiscord(pkg: String): Boolean {
        if (pkg == "com.discord") return true
        return try {
            val info = if (Build.VERSION.SDK_INT >= 33) {
                packageManager.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(PackageManager.GET_ACTIVITIES.toLong()))
            } else {
                @Suppress("DEPRECATION") packageManager.getPackageInfo(pkg, PackageManager.GET_ACTIVITIES)
            }
            info.activities?.any { it.name.startsWith("com.discord.") } == true
        } catch (_: Throwable) {
            false
        }
    }

    // ── 화면 ──────────────────────────────────────────────────────────────
    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

    private fun text(s: String, size: Float, bold: Boolean = false, dim: Boolean = false): TextView {
        val t = TextView(this)
        t.text = s
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        if (bold) t.typeface = Typeface.DEFAULT_BOLD
        if (dim) t.alpha = 0.7f
        return t
    }

    private fun buildUi() {
        val scroll = ScrollView(this)
        scroll.isFillViewport = true
        val root = LinearLayout(this)
        root.orientation = LinearLayout.VERTICAL
        root.setPadding(dp(20f), dp(28f), dp(20f), dp(28f))
        scroll.addView(root)

        root.addView(text("Shizuku Permissions", 24f, bold = true))

        statusView = text("", 14f, dim = true)
        root.addView(statusView, margins(top = 6f))

        shizukuButton = Button(this)
        shizukuButton.text = "Allow Shizuku"
        shizukuButton.isAllCaps = false
        shizukuButton.setOnClickListener { requestShizuku() }
        root.addView(shizukuButton, margins(top = 8f))

        val buttons = LinearLayout(this)
        buttons.orientation = LinearLayout.HORIZONTAL
        val all = Button(this)
        allButton = all
        all.text = "Grant all"
        all.setOnClickListener { grantAll() }
        val back = Button(this)
        back.text = "Back"
        back.setOnClickListener { goBack() }
        for (b in listOf(all, back)) b.isAllCaps = false
        for (b in listOf(all, back)) buttons.addView(b, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(buttons, matchWidth(top = 6f))

        list = LinearLayout(this)
        list.orientation = LinearLayout.VERTICAL
        root.addView(list, matchWidth(top = 12f))

        setContentView(scroll)
    }

    private fun margins(top: Float = 0f): LinearLayout.LayoutParams {
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.topMargin = dp(top)
        return lp
    }

    private fun matchWidth(top: Float = 0f): LinearLayout.LayoutParams {
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.topMargin = dp(top)
        return lp
    }

    private fun goBack() {
        // 대상 앱(디스코드)으로 돌아간다
        val launch = if (target.isNotBlank()) packageManager.getLaunchIntentForPackage(target) else null
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                startActivity(launch)
            } catch (_: Throwable) {
            }
        }
        finish()
    }

    // ── Shizuku ───────────────────────────────────────────────────────────
    private enum class Ready { NOT_RUNNING, NO_PERMISSION, OLD, READY }

    private fun shizukuState(): Ready {
        if (!Shizuku.pingBinder()) return Ready.NOT_RUNNING
        if (Shizuku.isPreV11()) return Ready.OLD
        return if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) Ready.READY else Ready.NO_PERMISSION
    }

    private fun requestShizuku() {
        when (shizukuState()) {
            Ready.NO_PERMISSION -> Shizuku.requestPermission(1)
            Ready.NOT_RUNNING -> {
                // Shizuku 앱을 열어서 켜게 한다
                val open = packageManager.getLaunchIntentForPackage("moe.shizuku.privileged.api")
                if (open != null) startActivity(open) else toast("Install and start Shizuku first")
            }
            else -> refresh()
        }
    }

    /** 셸 인자 하나로 감싼다 */
    private fun q(s: String) = "'" + s.replace("'", "'\\''") + "'"

    /** Shizuku 로 셸 명령을 실행한다. (종료 코드, 출력) */
    private fun shell(cmd: String): Pair<Int, String> {
        val m = Shizuku::class.java.getDeclaredMethod("newProcess", Array<String>::class.java, Array<String>::class.java, String::class.java)
        m.isAccessible = true
        val p = m.invoke(null, arrayOf("sh", "-c", cmd), null, null) as Process
        val out = p.inputStream.bufferedReader().readText()
        val err = p.errorStream.bufferedReader().readText()
        val code = p.waitFor()
        return code to (out + err).trim()
    }

    // ── 권한 목록 ─────────────────────────────────────────────────────────
    private enum class Kind { RUNTIME, DEVELOPMENT, APPOP, SPECIAL, UNKNOWN, AUTO, NO, UNAVAILABLE }

    private class Item(
        val title: String,
        val name: String,
        val kind: Kind,
        val granted: Boolean,
        val grant: String?,
        val revoke: String?,
        /** 이름 아래 덧붙이는 설명 (왜 못 바꾸는지 등) */
        val note: String? = null,
    ) {
        val key get() = "$kind/$name"
    }

    private fun refresh() {
        if (!::statusView.isInitialized) return
        val state = shizukuState()
        statusView.text = when (state) {
            Ready.NOT_RUNNING -> "Shizuku isn't running"
            Ready.NO_PERMISSION -> "Shizuku is running, allow this app to use it"
            Ready.OLD -> "Shizuku is too old, update it"
            Ready.READY -> "Shizuku ready"
        } + if (target.isBlank()) "" else "\n$target"
        shizukuButton.visibility = if (state == Ready.READY) View.GONE else View.VISIBLE
        shizukuButton.text = if (state == Ready.NOT_RUNNING) "Open Shizuku" else "Allow Shizuku"
        list.removeAllViews()
        // 디스코드가 아니면 모두 허용할 것이 없다
        allButton.visibility = if (target.isBlank()) View.GONE else View.VISIBLE
        if (target.isBlank()) {
            list.addView(text("Open this from the Shizuku Permissions plugin in Discord.", 15f), matchWidth(top = 12f))
            return
        }
        val items = try {
            items(target)
        } catch (e: PackageManager.NameNotFoundException) {
            list.addView(text("App not found: $target", 14f, dim = true))
            return
        }
        val groups = listOf(
            Kind.SPECIAL to "Special access",
            Kind.APPOP to "App operations",
            Kind.RUNTIME to "Runtime",
            Kind.DEVELOPMENT to "Development",
            Kind.AUTO to "Always granted",
            Kind.UNKNOWN to "Unknown to this device",
            Kind.NO to "Can't be granted (signature or system)",
            Kind.UNAVAILABLE to "Not available for Discord",
        )
        for ((kind, title) in groups) {
            val g = items.filter { it.kind == kind }
            if (g.isEmpty()) continue
            list.addView(text(title, 13f, bold = true, dim = true), matchWidth(top = 16f))
            for (it in g) list.addView(row(it, state == Ready.READY), matchWidth(top = 2f))
        }
    }

    private fun row(item: Item, ready: Boolean): View {
        val r = LinearLayout(this)
        r.orientation = LinearLayout.HORIZONTAL
        r.gravity = Gravity.CENTER_VERTICAL
        r.setPadding(0, dp(6f), 0, dp(6f))
        val texts = LinearLayout(this)
        texts.orientation = LinearLayout.VERTICAL
        texts.addView(text(item.title, 15f))
        if (item.name != item.title) texts.addView(text(item.name, 12f, dim = true))
        val extra = when {
            refused.containsKey(item.key) -> "Android refused: ${refused[item.key]}"
            item.key in notKept -> "Android didn't keep this, Discord doesn't ask for this permission"
            else -> item.note
        }
        extra?.let { texts.addView(text(it, 12f, dim = true)) }
        r.addView(texts, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val sw = Switch(this)
        sw.isChecked = item.granted
        val canChange = ready && (if (item.granted) item.revoke != null else item.grant != null)
        sw.isEnabled = canChange
        sw.setOnClickListener {
            val cmd = if (sw.isChecked) item.grant else item.revoke
            if (cmd == null) {
                sw.isChecked = !sw.isChecked
                return@setOnClickListener
            }
            run(listOf(item to sw.isChecked))
        }
        r.addView(sw)
        return r
    }

    private fun grantAll() {
        if (shizukuState() != Ready.READY) {
            requestShizuku()
            return
        }
        if (target.isBlank()) return
        // 한 번 거절되거나 유지되지 않은 것은 다시 하지 않는다
        val todo = items(target).filter { !it.granted && it.grant != null && it.key !in notKept && !refused.containsKey(it.key) }
        if (todo.isEmpty()) {
            toast("Everything is already granted")
            return
        }
        run(todo.map { it to true })
    }

    /** 바꾸고 나서 실제로 바뀌었는지 다시 읽어 확인한다 */
    private fun run(changes: List<Pair<Item, Boolean>>) {
        if (shizukuState() != Ready.READY) {
            requestShizuku()
            refresh()
            return
        }
        io.execute {
            val ok = mutableListOf<Pair<Item, Boolean>>()
            var failed = 0
            for ((item, on) in changes) {
                val c = (if (on) item.grant else item.revoke) ?: continue
                val (code, out) = try {
                    shell(c)
                } catch (e: Throwable) {
                    -1 to (e.cause?.message ?: e.message ?: e.toString())
                }
                Log.i("ShizukuPerms", "$c -> $code $out")
                if (code == 0) {
                    ok += item to on
                    refused.remove(item.key)
                } else {
                    failed++
                    // 첫 줄은 "Exception occurred …" 라서 그다음 줄의 이유를 쓴다
                    val reason = out.lineSequence().map { it.trim() }.firstOrNull { it.isNotBlank() && !it.startsWith("Exception occurred") } ?: "exit $code"
                    refused[item.key] = reason.substringAfter(": ").take(120)
                }
            }
            main.post {
                val now = try {
                    items(target).associateBy { it.key }
                } catch (_: Throwable) {
                    emptyMap()
                }
                var lost = 0
                for ((item, on) in ok) {
                    val state = now[item.key]?.granted ?: continue
                    if (state != on) {
                        lost++
                        notKept += item.key
                    } else notKept -= item.key
                }
                val parts = mutableListOf<String>()
                val done = ok.size - lost
                if (done > 0) parts += if (changes.size == 1) "Done" else "Done, $done changes"
                if (failed > 0) parts += "$failed refused"
                if (lost > 0) parts += "$lost not kept by Android"
                toast(parts.joinToString(", ").ifBlank { "Nothing changed" })
                refresh()
            }
        }
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()

    // ── 권한 읽기 ─────────────────────────────────────────────────────────
    private fun short(name: String) = name.substringAfterLast('.').replace('_', ' ').lowercase().replaceFirstChar { it.uppercase() }

    /** appop 이름 (android:system_alert_window → SYSTEM_ALERT_WINDOW) */
    private fun opName(op: String) = op.removePrefix("android:").uppercase()

    private fun opMode(op: String, uid: Int, pkg: String): Int {
        val ops = getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        return try {
            if (Build.VERSION.SDK_INT >= 29) ops.unsafeCheckOpNoThrow(op, uid, pkg) else @Suppress("DEPRECATION") ops.checkOpNoThrow(op, uid, pkg)
        } catch (_: Throwable) {
            AppOpsManager.MODE_DEFAULT
        }
    }

    /** 방해 금지 접근을 받은 앱인지. 안드로이드 버전마다 저장하는 곳이 달라서 둘 다 본다 */
    private fun dndAllowed(pkg: String): Boolean {
        val secure = shell("settings get secure enabled_notification_policy_access_packages").second
        if (secure.split(':').any { it.trim() == pkg }) return true
        // 새 버전: dumpsys notification 의 "Allowed condition providers" 아래에 나온다
        val dump = shell("dumpsys notification").second.lines()
        val start = dump.indexOfFirst { it.contains("Allowed condition providers", ignoreCase = true) }
        if (start < 0) return false
        val tokens = Regex("[^A-Za-z0-9_.]+")
        return dump.drop(start + 1).take(12).any { line -> tokens.split(line).any { it == pkg } }
    }

    private fun items(pkg: String): List<Item> {
        val pm = packageManager
        val info: PackageInfo = if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(pkg, PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong()))
        } else {
            @Suppress("DEPRECATION") pm.getPackageInfo(pkg, PackageManager.GET_PERMISSIONS)
        }
        val uid = info.applicationInfo?.uid ?: 0
        val qp = q(pkg)
        val out = mutableListOf<Item>()
        val names = info.requestedPermissions ?: emptyArray()
        val flags = info.requestedPermissionsFlags ?: IntArray(0)
        for ((i, name) in names.withIndex()) {
            val granted = (flags.getOrNull(i) ?: 0) and PackageInfo.REQUESTED_PERMISSION_GRANTED != 0
            val pi: PermissionInfo? = try {
                pm.getPermissionInfo(name, 0)
            } catch (_: Throwable) {
                null
            }
            if (pi == null) {
                // 이 기기에 없는 권한 (다른 앱이 만들었거나 더 새 안드로이드 것). 줘 보기는 할 수 있다
                out += Item(short(name), name, Kind.UNKNOWN, granted, "pm grant $qp ${q(name)}", "pm revoke $qp ${q(name)}", "May fail, Android doesn't know this permission")
                continue
            }
            @Suppress("DEPRECATION") val level = pi.protectionLevel
            val base = level and PermissionInfo.PROTECTION_MASK_BASE
            val development = level and PermissionInfo.PROTECTION_FLAG_DEVELOPMENT != 0
            val appop = level and PermissionInfo.PROTECTION_FLAG_APPOP != 0
            val op = AppOpsManager.permissionToOp(name)
            when {
                base == PermissionInfo.PROTECTION_DANGEROUS ->
                    out += Item(short(name), name, Kind.RUNTIME, granted, "pm grant $qp ${q(name)}", "pm revoke $qp ${q(name)}")
                appop && op != null -> {
                    val mode = opMode(op, uid, pkg)
                    val on = mode == AppOpsManager.MODE_ALLOWED || (mode == AppOpsManager.MODE_DEFAULT && granted)
                    out += Item(short(name), name, Kind.APPOP, on, "appops set $qp ${opName(op)} allow", "appops set $qp ${opName(op)} default")
                }
                development ->
                    out += Item(short(name), name, Kind.DEVELOPMENT, granted, "pm grant $qp ${q(name)}", "pm revoke $qp ${q(name)}")
                base == PermissionInfo.PROTECTION_NORMAL ->
                    out += Item(short(name), name, Kind.AUTO, granted, null, null)
                else ->
                    out += Item(short(name), name, Kind.NO, granted, null, null)
            }
        }
        // 매니페스트와 상관없이 줄 수 있는 것
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        out += Item(
            "Ignore battery optimizations",
            "deviceidle whitelist",
            Kind.SPECIAL,
            power.isIgnoringBatteryOptimizations(pkg),
            "dumpsys deviceidle whitelist +$qp",
            "dumpsys deviceidle whitelist -$qp",
        )
        val bg = opMode("android:run_any_in_background", uid, pkg)
        out += Item(
            "Unrestricted background",
            "RUN_ANY_IN_BACKGROUND",
            Kind.SPECIAL,
            bg == AppOpsManager.MODE_ALLOWED || bg == AppOpsManager.MODE_DEFAULT,
            "appops set $qp RUN_ANY_IN_BACKGROUND allow",
            "appops set $qp RUN_ANY_IN_BACKGROUND ignore",
        )
        // 설정의 "특별한 앱 접근" 항목들. 디스코드가 요청한 권한으로 이미 나온 건 빼고
        val declaredOps = names.mapNotNull { n -> AppOpsManager.permissionToOp(n) }.toSet()
        val ops = mutableListOf(
            Triple("Display over other apps", "android:system_alert_window", 1),
            Triple("All files access", "android:manage_external_storage", 30),
            Triple("Install unknown apps", "android:request_install_packages", 26),
            Triple("Modify system settings", "android:write_settings", 23),
            Triple("Usage access", "android:get_usage_stats", 21),
            Triple("Picture in picture", "android:picture_in_picture", 26),
            Triple("Alarms and reminders", "android:schedule_exact_alarm", 31),
            Triple("Media management", "android:manage_media", 31),
            Triple("Full screen notifications", "android:use_full_screen_intent", 34),
            Triple("Turn screen on", "android:turn_screen_on", 34),
        )
        for ((title, op, api) in ops) {
            if (Build.VERSION.SDK_INT < api || op in declaredOps) continue
            val mode = opMode(op, uid, pkg)
            out += Item(title, opName(op), Kind.SPECIAL, mode == AppOpsManager.MODE_ALLOWED, "appops set $qp ${opName(op)} allow", "appops set $qp ${opName(op)} default")
        }
        if (Build.VERSION.SDK_INT >= 30) {
            // 안 쓰는 앱이면 권한을 자동으로 거두는 것
            val mode = opMode("android:auto_revoke_permissions_if_unused", uid, pkg)
            out += Item(
                "Keep permissions when unused",
                "AUTO_REVOKE_PERMISSIONS_IF_UNUSED",
                Kind.SPECIAL,
                mode == AppOpsManager.MODE_IGNORED,
                "appops set $qp AUTO_REVOKE_PERMISSIONS_IF_UNUSED ignore",
                "appops set $qp AUTO_REVOKE_PERMISSIONS_IF_UNUSED default",
            )
        }
        // 방해 금지 접근: 앱이 요청만 하면 셸로 줄 수 있다
        // 다른 앱의 방해 금지 접근 상태는 앱이 읽을 수 없어서 셸로 읽는다
        val dndOn = shizukuState() == Ready.READY && try {
            dndAllowed(pkg)
        } catch (_: Throwable) {
            false
        }
        out += Item("Do Not Disturb access", "notification policy", Kind.SPECIAL, dndOn, "cmd notification allow_dnd $qp", "cmd notification disallow_dnd $qp")
        // 앱 안에 그 기능용 부분(서비스, 수신기)이 있어야 켤 수 있는 것. 디스코드에는 없다
        val needs = "Discord has no part for this, so it can't be turned on"
        for (t in listOf("Accessibility", "Notification access", "Device admin", "Default apps")) {
            out += Item(t, t, Kind.UNAVAILABLE, false, null, null, needs)
        }
        return out
    }
}
