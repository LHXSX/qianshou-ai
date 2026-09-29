//
//  AppModel.swift
//  应用级状态容器。
//
//  它只做三件事，其余逻辑都在各自的模型里，避免这里长成一个上帝对象：
//  1. 持有子系统：浏览（BrowserViewModel）、桥（BridgeRuntime）、诊断日志；
//  2. 把扫码结果在「扫一扫 → 浏览页 → 网页」之间传递，顺序固定；
//  3. 处理调试启动参数（模拟器取证）与桥自检的触发。
//

import Foundation
import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class AppModel {
    /// 同一时刻只可能有一个 sheet，用枚举而不是两个 `.sheet` 修饰符。
    enum ActiveSheet: String, Identifiable {
        case scanner
        case settings

        var id: String { rawValue }
    }

    let log: DiagnosticsLog
    let browser: BrowserViewModel
    let bridge: BridgeRuntime
    let debugOptions: DebugLaunchOptions

    var activeSheet: ActiveSheet?
    /// 最近一次扫码的明文：浏览页顶部提示条显示它，用户随时能看到扫到了什么。
    var scanNotice: String?
    var selfCheckSteps: [BridgeSelfCheck.Step] = []
    var isRunningSelfCheck = false

    init(defaults: UserDefaults = .standard, debugOptions: DebugLaunchOptions? = nil) {
        // 先建日志再用局部常量传给桥：Swift 不允许在初始化完成前读 self.log。
        let log = DiagnosticsLog()
        let options = debugOptions ?? DebugLaunchOptions.fromUserDefaults(defaults)
        let browser = BrowserViewModel(defaults: defaults, log: log)
        let bridge = BridgeRuntime(log: log, versionProvider: { AppInfo.version })

        self.log = log
        self.debugOptions = options
        self.browser = browser
        self.bridge = bridge

        browser.onPageFinished = { [weak self] in
            self?.handlePageFinished()
        }
        // 用户明确打开的地址 → 可信 origin。这是桥的 origin 绑定的**唯一**入口：
        // 只有地址栏、扫码与调试参数指定的站点能拿到桥；第三方链接由导航策略交给系统浏览器。
        browser.onExplicitLoad = { [weak bridge] url in
            bridge?.allowOrigin(of: url)
        }
        if let startAddress = options.startAddress {
            browser.overrideInitialAddress(startAddress)
            if options.pressLoad {
                // 走「地址栏 → 载入」那一个入口：校验地址、写 UserDefaults、发起加载。
                browser.loadFromAddressField()
            }
        }
    }

    // MARK: - 启动

    /// App 启动后调用一次。没有调试参数时只写一条启动日志。
    func start() {
        log.record("启动：平台=\(AppInfo.platform) 版本=\(AppInfo.version)（构建 \(AppInfo.build)）地址=\(WebAddress.redacted(browser.addressText))")
        if !debugOptions.isEmpty {
            log.record("调试启动参数：\(debugOptions.summary)")
        }
        if debugOptions.openScanner {
            activeSheet = .scanner
        }
        if let path = debugOptions.scanImagePath {
            runPhotoScanProbe(at: path)
        }
        if let text = debugOptions.simulateScanText {
            // 等首屏加载完再模拟扫码：真实使用顺序是「先打开 App，再扫」，
            // 立刻扫码会让「推给网页」这一步撞在空白文档上，测不出真实链路。
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 6_000_000_000)
                log.record("调试：把模拟扫码结果交给地址栏（已等待首屏加载）")
                handleScanOutcome(ScanOutcome(text: text, source: .photoLibrary))
            }
        }
    }

    // MARK: - 扫码

    /// 扫码结果统一入口。顺序是「先回填地址栏、再推给网页」：
    /// 网页可能依赖这次推送立刻更新自己的界面，回填地址栏是纯本地动作，更快。
    func handleScanOutcome(_ outcome: ScanOutcome) {
        scanNotice = outcome.text
        browser.applyScanResult(outcome)
        bridge.pushScanResult(outcome)
        if activeSheet == .scanner {
            activeSheet = nil
        }
    }

    // MARK: - 桥自检

    private func handlePageFinished() {
        guard debugOptions.runBridgeSelfCheck, !isRunningSelfCheck else { return }
        Task { await runBridgeSelfCheck() }
    }

    func runBridgeSelfCheck() async {
        guard let webView = browser.webViewForDiagnostics else {
            log.record("自检：还没有 WebView，跳过")
            return
        }
        isRunningSelfCheck = true
        let steps = await BridgeSelfCheck.run(
            webView: webView,
            bridge: bridge,
            expectedVersion: AppInfo.version,
            log: log
        )
        selfCheckSteps = steps
        isRunningSelfCheck = false
    }

    // MARK: - 相册识别探针（仅调试启动参数触发）

    /// 对一张本地图片直接跑 Vision 识别。
    /// 为什么需要它：相册选择器是系统进程外的 UI，自动化点不到；
    /// 但「选中的图片能否被识别出二维码」这一段是纯代码，必须真的跑一遍才算验证过。
    private func runPhotoScanProbe(at path: String) {
        guard let image = UIImage(contentsOfFile: path) else {
            log.record("探针：读不到图片 \(path)")
            return
        }
        log.record("探针：对 \(path) 跑 Vision 二维码识别（尺寸 \(Int(image.size.width))x\(Int(image.size.height))）")
        Task { @MainActor in
            let result = await PhotoBarcodeScanner.scan(image)
            switch result {
            case .success(let scanned):
                log.record("探针：识别到 \(scanned.values.count) 个二维码（引擎 \(scanned.engine)），第一个内容长度 \(scanned.values.first?.count ?? 0)")
            case .failure(let error):
                log.record("探针：识别失败 — \(error.message)")
            }
        }
    }
}
