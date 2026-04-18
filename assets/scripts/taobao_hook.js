Java.perform(function() {
    console.log("[*] Frida 注入成功，开始 Hook 淘宝...");

    // ==========================================
    // 1. 拦截 SIM 卡及网络检测 (安抚 AuthSDK 各种报错)
    // ==========================================
    try {
        var TelephonyManager = Java.use("android.telephony.TelephonyManager");

        // Hook 无参 getSimState
        TelephonyManager.getSimState.overload().implementation = function() {
            return 5; // SIM_STATE_READY
        };
        TelephonyManager.getSimState.overload('int').implementation = function(slotIndex) {
            return 5;
        };

        // 伪装运营商信息 (安抚 600009 无法判运营商)
        TelephonyManager.getSimOperator.overload().implementation = function() { return "46000"; };
        TelephonyManager.getSimOperator.overload('int').implementation = function(slotIndex) { return "46000"; };
        TelephonyManager.getSimOperatorName.overload().implementation = function() { return "China Mobile"; };
        TelephonyManager.getNetworkOperator.overload().implementation = function() { return "46000"; };
        TelephonyManager.getNetworkOperatorName.overload().implementation = function() { return "China Mobile"; };

        // 伪装网络类型 (安抚 600008 移动网络未开启)
        TelephonyManager.getNetworkType.overload().implementation = function() { return 13; }; // NETWORK_TYPE_LTE
        TelephonyManager.getDataNetworkType.overload().implementation = function() { return 13; };
        TelephonyManager.isDataEnabled.overload().implementation = function() { return true; };
        
        console.log("[+] 成功注册所有 TelephonyManager Hook (SIM卡和网络伪装)");
    } catch(e) {
        console.log("[-] Hook TelephonyManager failed: " + e);
    }

    // ==========================================
    // 2. 拦截 Window 渲染标志，消除黑屏和防截屏
    // ==========================================
    try {
        var Window = Java.use("android.view.Window");
        var FLAG_SECURE = 0x00002000; // WindowManager.LayoutParams.FLAG_SECURE

        Window.setFlags.implementation = function(flags, mask) {
            if ((flags & FLAG_SECURE) != 0) {
                console.log("[+] Intercepted Window.setFlags! Removing FLAG_SECURE.");
                flags = flags & ~FLAG_SECURE; // 剥离防截屏标志
            }
            this.setFlags(flags, mask);
        };

        // 拦截 Window.setFormat，防止 10-bit color (RGBA_1010102 = 43) 导致渲染黑屏崩溃
        Window.setFormat.implementation = function(format) {
            if (format == 43 || format == 4 || format == 3) { 
                console.log("[+] Intercepted Window.setFormat(" + format + ")! Forcing PixelFormat.RGBA_8888 (1) to fix black screen.");
                format = 1; 
            }
            this.setFormat(format);
        };

        // 拦截 Window.setColorMode 避免 wideColorGamut
        try {
            Window.setColorMode.implementation = function(colorMode) {
                console.log("[+] Intercepted Window.setColorMode(" + colorMode + ")! Forcing COLOR_MODE_DEFAULT (0).");
                this.setColorMode(0);
            };
        } catch(e) {}

        var WindowManager_LayoutParams = Java.use("android.view.WindowManager$LayoutParams");
        var View = Java.use("android.view.View");

        // 拦截 View 的 setBackgroundResource 可能相关的操作？其实主要是 format。
        // 或者强制重写 setFlags 里的 privateFlags
        
    } catch(e) {
        console.log("[-] Hook Window failed: " + e);
    }

    // ==========================================
    // 3. 拦截 Activity.onCreate 强行修正渲染模式
    // ==========================================
    try {
        var Activity = Java.use("android.app.Activity");
        Activity.onCreate.overload('android.os.Bundle').implementation = function(bundle) {
            this.onCreate(bundle);
            var window = this.getWindow();
            if (window != null) {
                // 强行剥离 FLAG_SECURE
                window.clearFlags(0x00002000); // FLAG_SECURE
                // 强行设置 8888 格式
                window.setFormat(1); // PixelFormat.RGBA_8888
                // 强行设置默认色彩模式
                if (typeof window.setColorMode === 'function') {
                    window.setColorMode(0); // COLOR_MODE_DEFAULT
                }
            }
        };
    } catch(e) {
        console.log("[-] Hook Activity.onCreate failed: " + e);
    }

    console.log("[*] 所有 Hook 注册完毕，等待淘宝调用...");
});
