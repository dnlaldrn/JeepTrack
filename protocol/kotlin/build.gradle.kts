import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "2.4.21"
}

repositories { mavenCentral() }

dependencies {
    testImplementation(kotlin("test"))
    testImplementation("org.json:json:20250517")
}

java { targetCompatibility = JavaVersion.VERSION_21; sourceCompatibility = JavaVersion.VERSION_21 }
kotlin { compilerOptions { jvmTarget.set(JvmTarget.JVM_21) } }

tasks.test {
    useJUnitPlatform()
    testLogging { events("failed"); showStandardStreams = false }
}
