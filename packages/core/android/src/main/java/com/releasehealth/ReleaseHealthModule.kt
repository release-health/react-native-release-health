package com.releasehealth

import com.facebook.react.bridge.ReactApplicationContext

class ReleaseHealthModule(reactContext: ReactApplicationContext) :
  NativeReleaseHealthSpec(reactContext) {

  override fun multiply(a: Double, b: Double): Double {
    return a * b
  }

  companion object {
    const val NAME = NativeReleaseHealthSpec.NAME
  }
}
