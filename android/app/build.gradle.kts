plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.concord.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.concord.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.3.0"
        // Só celulares de 64 bits (todos os atuais): deixa o APK pequeno o bastante
        // para ser baixado direto do servidor do Concord.
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Por enquanto assina com a chave de depuração deste computador. Trocar a chave
            // depois obriga todo mundo a desinstalar e instalar de novo.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures { buildConfig = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    // WebRTC do Google empacotado para Android: captura de tela e envio do vídeo.
    implementation("io.getstream:stream-webrtc-android:1.3.10")
}
