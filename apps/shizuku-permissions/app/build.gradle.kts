plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.yumistra.shizukuperms"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.yumistra.shizukuperms"
        minSdk = 24
        targetSdk = 35
        versionCode = 6
        versionName = "1.0.5"
    }

    // 업데이트가 덮어써지게 늘 같은 키로 서명한다
    signingConfigs {
        create("fixed") {
            storeFile = file("../keystore.jks")
            storePassword = "freestyle"
            keyAlias = "perms"
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

dependencies {
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
}
