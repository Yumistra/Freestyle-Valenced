package com.discord.main

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle

/** 플러그인의 Linking.openURL('freestyleperms://open') 과 같은 일을 한다 */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("freestyleperms://open")))
    }
}
