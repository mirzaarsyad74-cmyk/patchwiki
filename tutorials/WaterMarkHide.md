---
id: watermarkhide
title: WaterMarkHide
game: WaterMarkHide
author: Ryunosuke
version: 1.0
desc: 🛠️ Hide "Test Mode" & "Windows Insider" Watermark (While Keeping Test Mode ON)
tags: general
date: 2026-11-18
---

# WaterMarkHide

## 🛠️ Hide "Test Mode" & "Windows Insider" Watermark (While Keeping Test Mode ON)

Need `testsigning on` for unsigned drivers, mods, or custom tools—but tired of the **Test Mode** / **Windows Insider Preview** text sitting in the bottom-right corner of your desktop?

Standard `bcdedit` commands turn off Test Mode completely, and third-party patchers often break on newer builds. This standalone `.bat` script patches Windows' local UI strings directly so the desktop stays clean while **Test Mode stays active**.

---

### ✨ What This Script Does
* **Keeps `testsigning` Enabled:** Leaves your BCD boot configuration untouched so unsigned drivers continue working normally.
* **Strips Both Watermarks:** Removes `Test Mode`, `Evaluation copy.`, and `Windows 10/11 Insider Preview` text from `shell32.dll.mui` and `basebrd.dll.mui`.
* **100% Offline & Self-Contained:** No external downloads, no `winget` errors, and no third-party `.exe` files required.
* **Auto-Detects Language & Admin Rights:** Automatically requests UAC elevation and detects your active Windows display language (`en-US`, `en-GB`, etc.).
* **Safe Backup Included:** Saves untouched `.old` copies of the original `.mui` files before patching.

---

### 🚀 How to Run
1. Download the attached **`Hide_Watermark.bat`** file 
2. **Double-click** `Hide_Watermark.bat` and click **Yes** on the Administrator prompt.
3. Wait 2–3 seconds while Windows Explorer automatically restarts.
4. Check the bottom-right corner—the watermark will be gone, and the terminal window will confirm `testsigning Yes`.

> ⚠️ **Note:** Major Windows updates overwrite system UI files. If the watermark ever comes back after an update, just double-click the `.bat` file again.

---

[Download HideWatermark.bat (0.0 MB)](assets/watermarkhide_1572561968798367784.bat)
