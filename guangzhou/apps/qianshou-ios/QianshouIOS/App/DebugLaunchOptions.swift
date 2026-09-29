//
//  DebugLaunchOptions.swift
//  仅用于模拟器取证的启动参数。
//
//  为什么不需要自己解析：`UserDefaults` 的标准「参数域」会把
//  `-Key Value` 形式的启动参数自动并入读取结果，所以
//  `xcrun simctl launch <udid> <bundleID> -QianshouOpenScanner YES`
//  就能让 App 启动即打开扫一扫——不需要任何命令行解析代码，也不会污染持久化域。
//
//  正式运行时这些键都不存在，各分支全部是 false / nil，对用户行为零影响。
//

import Foundation

struct DebugLaunchOptions {
    /// 覆盖本次启动的地址（默认不写入持久化域，避免调试参数改掉用户自己的设置）。
    var startAddress: String?
    /// 让启动流程走一遍「地址栏 + 载入」的代码路径（含持久化与地址校验）。
    /// 用途：模拟器里无法自动点击按钮，这一步替按钮调同一个入口，
    /// 于是「校验→载入→写 UserDefaults」这段真实逻辑仍然被真的执行过。
    var pressLoad = false
    /// 启动即打开扫一扫（用于截图取证：模拟器无相机的降级界面）。
    var openScanner = false
    /// 启动即弹出相册选择器（用于取证相册入口能正常呈现）。
    var presentPhotoPicker = false
    /// 网页加载完成后自动跑一次桥自检。
    var runBridgeSelfCheck = false
    /// 直接对一张本地图片跑二维码识别（用于取证相册识别代码路径）。
    var scanImagePath: String?
    /// 模拟「扫到了一个二维码」并把它交给地址栏。
    /// 用途：模拟器里点不动相机，但扫码之后的那段逻辑（回填地址栏 → 决定是否载入 → 推给网页）
    /// 是纯代码，必须走真实入口跑一遍才算验证过。
    var simulateScanText: String?

    static func fromUserDefaults(_ defaults: UserDefaults = .standard) -> DebugLaunchOptions {
        var options = DebugLaunchOptions()
        options.startAddress = defaults.string(forKey: "QianshouStartAddress")
        options.pressLoad = defaults.bool(forKey: "QianshouPressLoad")
        options.openScanner = defaults.bool(forKey: "QianshouOpenScanner")
        options.presentPhotoPicker = defaults.bool(forKey: "QianshouPresentPhotoPicker")
        options.runBridgeSelfCheck = defaults.bool(forKey: "QianshouBridgeSelfCheck")
        options.scanImagePath = defaults.string(forKey: "QianshouScanImagePath")
        options.simulateScanText = defaults.string(forKey: "QianshouSimulateScan")
        return options
    }

    var isEmpty: Bool {
        startAddress == nil && !pressLoad && !openScanner && !presentPhotoPicker && !runBridgeSelfCheck
            && scanImagePath == nil && simulateScanText == nil
    }

    var summary: String {
        var parts: [String] = []
        // 地址一律脱敏：调试参数同样可能是带 `?token=` 的入口地址，而这份摘要会进诊断日志。
        if let startAddress { parts.append("地址=\(WebAddress.redacted(startAddress))") }
        if pressLoad { parts.append("按载入") }
        if openScanner { parts.append("打开扫一扫") }
        if presentPhotoPicker { parts.append("弹出相册") }
        if runBridgeSelfCheck { parts.append("桥自检") }
        if let scanImagePath { parts.append("识别图片=\(scanImagePath)") }
        if let simulateScanText { parts.append("模拟扫码=\(WebAddress.redacted(simulateScanText))") }
        return parts.isEmpty ? "无" : parts.joined(separator: "、")
    }
}
