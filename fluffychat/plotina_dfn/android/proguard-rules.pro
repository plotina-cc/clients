# R8 runs on the app side with `isMinifyEnabled = true`. JNI resolves the
# native methods by class and method name at call time, so both must survive.
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}
-keep class cc.plotina.dfn.** { *; }
