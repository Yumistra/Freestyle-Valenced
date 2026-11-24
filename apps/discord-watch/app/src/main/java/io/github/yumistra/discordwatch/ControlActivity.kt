package io.github.yumistra.discordwatch

import android.Manifest
import android.app.Activity
import android.app.BroadcastOptions
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import org.json.JSONObject

/**
 * 화면 없는 앱. Message Logger 플러그인(디스코드 안)이 이 투명한 Activity 를 열어서 명령을 보낸다.
 *  cmd = status | setup | deliver | clearToken | battery | uninstall
 *  setup 은 token, notify, enabled 중 보낸 것만 바꾼다.
 * 연 앱이 디스코드인지 확인하고, 그 앱을 기록을 보낼 곳으로 정한다 (패키지 이름을 따로 적지 않는다).
 * 할 일을 하고 상태를 디스코드로 보낸 뒤 바로 닫힌다.
 */
class ControlActivity : Activity() {
    private var handled = false
    private var waitingPermission = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 34) overrideActivityTransition(OVERRIDE_TRANSITION_OPEN, 0, 0)
    }

    override fun onResume() {
        super.onResume()
        if (handled) {
            if (!waitingPermission) close()
            return
        }
        handled = true
        try {
            handle()
        } catch (_: Throwable) {
        }
        if (!waitingPermission) close()
    }

    private fun handle() {
        val from = caller() ?: return
        Store.setTarget(this, from)
        val i = intent
        when (i.getStringExtra("cmd")) {
            "setup" -> {
                var newToken = false
                i.getStringExtra("token")?.trim()?.takeIf { it.length >= 20 }?.let {
                    if (Store.token(this) != it) {
                        Store.saveToken(this, it)
                        newToken = true
                        Status.user = ""
                        Status.userId = ""
                    }
                }
                if (i.hasExtra("notify")) Store.setNotify(this, i.getBooleanExtra("notify", true))
                if (i.hasExtra("enabled")) {
                    val on = i.getBooleanExtra("enabled", false) && Store.hasToken(this)
                    Store.setEnabled(this, on)
                    if (on) {
                        // 다른 계정 토큰으로 바꿨으면 새로 연결한다
                        if (newToken && Status.running) WatchService.stop(this)
                        WatchService.start(this)
                    } else {
                        WatchService.stop(this)
                        Status.state = "Off"
                    }
                }
                if (Store.enabled(this) && Store.notify(this)) askNotifications()
            }
            "clearToken" -> {
                Store.setEnabled(this, false)
                WatchService.stop(this)
                Store.clearToken(this)
                Status.state = "Off"
                Status.user = ""
                Status.userId = ""
            }
            "deliver" -> WatchService.deliver(this)
            "uninstall" -> {
                // 계정과 기록부터 지우고 안드로이드의 앱 지우기 창을 연다
                Store.setEnabled(this, false)
                WatchService.stop(this)
                Store.clearToken(this)
                Status.state = "Off"
                Status.user = ""
                Status.userId = ""
                Control.report(this)
                try {
                    startActivity(Intent(Intent.ACTION_DELETE, Uri.parse("package:$packageName")))
                } catch (_: Throwable) {
                    try {
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                    } catch (_: Throwable) {
                    }
                }
                return
            }
            "battery" -> askBattery()
            else -> {
                // 켜 두었는데 꺼져 있으면 (휴대폰이 껐다든가) 다시 켠다
                if (Store.enabled(this) && Store.hasToken(this) && !Status.running) WatchService.start(this)
            }
        }
        Control.report(this)
    }

    /** 연 앱의 패키지 이름. 디스코드가 아니면 null */
    private fun caller(): String? {
        var pkg: String? = null
        if (Build.VERSION.SDK_INT >= 34) pkg = launchedFromPackage
        if (pkg == null) {
            val r = referrer
            if (r != null && r.scheme == "android-app") pkg = r.host
        }
        if (pkg == null || pkg == packageName) return null
        return if (Control.isDiscord(this, pkg)) pkg else null
    }

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            waitingPermission = true
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        waitingPermission = false
        Control.report(this)
        close()
    }

    private fun askBattery() {
        val pm = getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (_: Throwable) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: Throwable) {
            }
        }
    }

    private fun close() {
        finish()
        if (Build.VERSION.SDK_INT >= 34) overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
        else @Suppress("DEPRECATION") overridePendingTransition(0, 0)
    }
}

/** 상태를 디스코드(Message Logger)로 보낸다 */
object Control {
    const val ACTION_STATUS = "io.github.yumistra.discordwatch.STATUS"
    private var lastReport = 0L

    fun isDiscord(ctx: Context, pkg: String): Boolean = try {
        @Suppress("DEPRECATION")
        val info = ctx.packageManager.getPackageInfo(pkg, PackageManager.GET_ACTIVITIES)
        info.activities?.any { it.name.startsWith("com.discord.") } == true
    } catch (_: Throwable) {
        false
    }

    fun status(ctx: Context): JSONObject {
        val pm = ctx.getSystemService(PowerManager::class.java)
        val notif = Build.VERSION.SDK_INT < 33 || ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val version = try {
            ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
        } catch (_: Throwable) {
            ""
        }
        return JSONObject()
            .put("version", version)
            .put("enabled", Store.enabled(ctx))
            .put("hasToken", Store.hasToken(ctx))
            .put("notify", Store.notify(ctx))
            .put("running", Status.running)
            .put("state", Status.state)
            .put("user", Status.user)
            .put("userId", Status.userId)
            .put("discordOpen", Status.discordOpen)
            .put("remembered", Store.cacheSize(ctx))
            .put("queued", Store.queueSize(ctx))
            .put("deleted", Status.deleted)
            .put("edited", Status.edited)
            .put("lastSent", Status.lastSent)
            .put("notifPermission", notif)
            .put("battery", pm.isIgnoringBatteryOptimizations(ctx.packageName))
            .put("at", System.currentTimeMillis())
    }

    fun report(ctx: Context) {
        lastReport = System.currentTimeMillis()
        val i = Intent(ACTION_STATUS).setPackage(Store.target(ctx)).putExtra("json", status(ctx).toString())
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                ctx.sendBroadcast(i, null, BroadcastOptions.makeBasic().setShareIdentityEnabled(true).toBundle())
            } else ctx.sendBroadcast(i)
        } catch (_: Throwable) {
        }
    }

    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private var pending = false

    /** 자주 바뀌는 상태는 2초에 한 번만. 그 사이 바뀐 건 2초가 지나면 마지막 상태로 한 번 더 보낸다 */
    fun reportSoon(ctx: Context) {
        val app = ctx.applicationContext ?: ctx
        val wait = 2000 - (System.currentTimeMillis() - lastReport)
        if (wait <= 0) return report(app)
        synchronized(this) {
            if (pending) return
            pending = true
        }
        main.postDelayed({
            synchronized(this) { pending = false }
            report(app)
        }, wait)
    }
}

/** 휴대폰을 켜거나 앱을 업데이트하면 다시 켠다 (켜 두었을 때만) */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Store.enabled(context) && Store.hasToken(context)) {
            try {
                WatchService.start(context)
            } catch (_: Throwable) {
            }
        }
    }
}

/**
 * 디스코드가 화면에 돌아왔을 때 보내는 "쌓인 기록 보내 줘" (화면 없이).
 * 디스코드는 화면 뒤에 있는 동안 기록을 받지 않는다 (얼어 있는 앱에 보내면 안드로이드가 그 앱을 끈다)
 */
class DeliverReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try {
            WatchService.deliver(context, drain = true)
            Control.report(context)
        } catch (_: Throwable) {
        }
    }
}
