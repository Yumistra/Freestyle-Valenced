pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "ShizukuPermissions"
include(":app")
// 테스트용 가짜 디스코드 (CI 에뮬레이터 테스트에서만 빌드)
include(":testapp")
