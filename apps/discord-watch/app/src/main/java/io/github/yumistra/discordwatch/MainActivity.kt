package io.github.yumistra.discordwatch

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** 한 화면: 토큰, 디스코드 앱, 켜기/끄기, 상태 */
class MainActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var status: TextView
    private lateinit var toggle: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (16 * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        fun text(s: String, size: Float = 15f) = TextView(this).apply {
            this.text = s
            textSize = size
            setPadding(0, pad / 2, 0, pad / 2)
        }
        col.addView(text("Discord Watch", 24f))
        col.addView(
            text(
                "디스코드가 꺼져 있어도 지운 메시지를 잡아요. 내 계정 토큰으로 연결 하나만 열어 두고, 아무것도 보내지 않아요. " +
                    "공식 앱이 아닌 프로그램으로 접속하는 건 디스코드 약관 위반이라 계정이 정지될 수 있어요.",
                13f,
            ),
        )

        val token = EditText(this).apply {
            hint = if (Store.hasToken(this@MainActivity)) "토큰 저장됨 (바꾸려면 새로 입력)" else "디스코드 토큰"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        col.addView(token)
        col.addView(button("토큰 저장") {
            val t = token.text.toString().trim()
            if (t.length < 20) return@button toast("토큰이 너무 짧아요")
            Store.saveToken(this, t)
            token.setText("")
            token.hint = "토큰 저장됨 (바꾸려면 새로 입력)"
            toast("암호화해서 저장했어요")
        })

        col.addView(text("기록을 보낼 디스코드 앱 (패키지 이름)", 13f))
        val target = EditText(this).apply {
            setText(Store.target(this@MainActivity))
            inputType = InputType.TYPE_CLASS_TEXT
        }
        col.addView(target)
        col.addView(button("저장") {
            Store.setTarget(this, target.text.toString())
            toast("${Store.target(this)} 로 보내요")
        })

        col.addView(CheckBox(this).apply {
            text = "지운 DM, 멘션 휴대폰 알림 (디스코드가 꺼져 있을 때)"
            isChecked = Store.notify(this@MainActivity)
            setOnCheckedChangeListener { _, v -> Store.setNotify(this@MainActivity, v) }
        })

        toggle = button("") {
            if (Store.enabled(this)) {
                Store.setEnabled(this, false)
                WatchService.stop(this)
            } else {
                if (!Store.hasToken(this)) return@button toast("토큰부터 저장해 주세요")
                askNotifications()
                Store.setEnabled(this, true)
                WatchService.start(this)
            }
            refresh()
        }
        col.addView(toggle)
        col.addView(button("배터리 최적화에서 빼기") { askBattery() })
        col.addView(button("지금 디스코드로 보내기") {
            WatchService.deliver(this)
            toast("보냈어요 (디스코드가 켜져 있어야 받아요)")
        })
        col.addView(button("토큰 지우기") {
            Store.setEnabled(this, false)
            WatchService.stop(this)
            Store.clearToken(this)
            token.hint = "디스코드 토큰"
            refresh()
        })

        status = text("", 14f)
        col.addView(status)
        setContentView(ScrollView(this).apply { addView(col, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT) })
    }

    override fun onResume() {
        super.onResume()
        main.post(poll)
    }

    override fun onPause() {
        main.removeCallbacks(poll)
        super.onPause()
    }

    private val poll = object : Runnable {
        override fun run() {
            refresh()
            main.postDelayed(this, 1000)
        }
    }

    private fun refresh() {
        toggle.text = if (Store.enabled(this)) "끄기" else "켜기"
        val sent = if (Status.lastSent > 0) java.text.DateFormat.getTimeInstance().format(java.util.Date(Status.lastSent)) else "아직"
        status.text = buildString {
            append("상태: ${Status.state}\n")
            if (Status.user.isNotBlank()) append("계정: ${Status.user}\n")
            append("디스코드 앱: ${if (Status.discordOpen) "켜져 있음" else "꺼져 있음"}\n")
            append("기억한 메시지: ${Store.cacheSize(this@MainActivity)}개\n")
            append("잡은 것: 지움 ${Status.deleted}, 고침 ${Status.edited}\n")
            append("보낼 기록: ${Store.queueSize(this@MainActivity)}개, 마지막으로 보낸 때: $sent")
        }
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        gravity = Gravity.CENTER
        setOnClickListener { onClick() }
    }

    private fun toast(s: String) = android.widget.Toast.makeText(this, s, android.widget.Toast.LENGTH_SHORT).show()

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    private fun askBattery() {
        val pm = getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(packageName)) return toast("이미 빠져 있어요")
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (_: Throwable) {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }
}

/** 휴대폰을 켜거나 앱을 업데이트하면 다시 켠다 (켜 두었을 때만) */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Store.enabled(context) && Store.hasToken(context)) WatchService.start(context)
    }
}
