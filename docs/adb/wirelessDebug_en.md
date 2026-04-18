# Wireless ADB Debugging Guide

[中文版本](./wirelessDebug_zh-cn.md) | *English document translated by AI*

> Connect your phone wirelessly via WiFi to control your Android device using BATTClaw without a USB cable.

---

## Prerequisites

- The phone has **Developer options** and **USB debugging** enabled.
- The computer has the **ADB** tool installed and configured in environment variables.
- The phone and the computer are on the **same WiFi network**.

---

## Android 11+ Native Wireless Debugging (Recommended)

Android 11 and above support native wireless debugging **without a data cable**.

### Steps

1. Open **"Settings"** → **"Developer options"** on your phone.

2. Find and enable the **"Wireless debugging"** switch, then tap **"Allow"** in the confirmation pop-up.

3. Tap into the **"Wireless debugging"** details page, select **"Pair device with pairing code"**. The screen will display a **pairing code** and an **IP address and port**.

4. Run `adb pair <IP:Port shown on phone>` in your computer terminal, and enter the 6-digit pairing code to complete the pairing.

5. After successful pairing, return to the **"Wireless debugging"** main page to check the **"IP address and port"** (Note: This port is different from the pairing port). Run `adb connect <IP:Port>` in the terminal to connect.

6. Run `adb devices` to verify. If you see your device, the connection is successful.

<p align="center">
    <img src="../static/wirelessDebug.png" width="300">
</p>

> [!TIP]
> Pairing only needs to be done **once**. Afterwards, as long as the phone and computer are on the same network, you can directly run `adb connect` after enabling wireless debugging.

---

## Below Android 11: Wireless via USB

Applicable to older Android models that do not support native wireless debugging.

1. First, connect your phone and computer with a **USB cable**, and confirm that `adb devices` can see the device.

2. Run `adb tcpip 5555` in the terminal to switch ADB to wireless mode.

3. Check the phone's IP address: **"Settings"** → **"WLAN"** → Tap the connected WiFi to view the IP.

4. **Unplug the USB cable** and run `adb connect <Phone_IP>:5555` to complete the wireless connection.

5. Run `adb devices` to verify the connection.

> [!IMPORTANT]
> Every time the phone reboots, you need to use USB to run `adb tcpip 5555` once to restore the wireless connection.

---

## FAQ

| Issue | Solution |
|------|----------|
| Connection timeout / unable to connect | Ensure the phone and computer are on the **same WiFi**. Check if AP isolation is enabled on the router. |
| Frequent disconnection | Enable **"Always keep WLAN on"** in **"Developer options"**, and use it closer to the router. |
| Is wireless slower than USB? | Almost imperceptible for BATTClaw's screenshot and command scenarios; only slightly slower when transferring large files. |

---

## After Successful Connection

Once the wireless connection is established, simply start BATTClaw normally. The system will automatically detect the wireless device, providing an experience identical to USB.
