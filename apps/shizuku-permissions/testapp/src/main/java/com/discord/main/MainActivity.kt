package com.discord.main

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/** 플러그인의 Linking.openURL('freestyleperms://open') 과 같은 일을 한다 (켜질 때 한 번만, 진짜 디스코드처럼 돌아오면 다시 열지 않는다) */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (opened) return
        opened = true
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("freestyleperms://open")))
    }

    companion object {
        private var opened = false
    }
}
