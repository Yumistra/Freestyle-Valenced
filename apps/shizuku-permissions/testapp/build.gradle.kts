plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 테스트용 가짜 디스코드: 패키지 com.discord, 화면 com.discord.main.MainActivity.
// 켜지면 플러그인처럼 freestyleperms://open 을 연다
android {
    namespace = "com.discord"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.discord"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "test"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
