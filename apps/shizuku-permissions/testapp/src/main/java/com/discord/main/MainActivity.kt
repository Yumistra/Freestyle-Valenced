package com.discord.main

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/** 플러그인의 Linking.openURL('freestyleperms://open') 과 같은 일을 한다 (켜질 때 한 번만, 진짜 디스코드처럼 돌아오면 다시 열지 않는다) */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 권한을 거두면 안드로이드가 앱을 껐다 켜서, 기억은 파일에 둔다
        val prefs = getSharedPreferences("test", MODE_PRIVATE)
        if (prefs.getBoolean("opened", false)) return
        prefs.edit().putBoolean("opened", true).commit()
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("freestyleperms://open")))
    }
}
