plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.yumistra.discordwatch"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.yumistra.discordwatch"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "1.1.1"
    }

    // 업데이트가 덮어써지게 늘 같은 키로 서명한다
    signingConfigs {
        create("fixed") {
            storeFile = file("../keystore.jks")
            storePassword = "freestyle"
            keyAlias = "watch"
            keyPassword = "freestyle"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("fixed")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
