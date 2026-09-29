//
//  ScannerModel.swift
//  扫码状态机：相机可用性 → 权限 → 采集；相册识别；结果交付。
//
//  分支顺序是本文件最重要的设计决定：
//  1. 先看有没有相机（模拟器没有），没有就直接给「模拟器没有相机，请用相册选图」，
//     并且**不申请权限**——在一个没有相机的设备上弹权限框只会让人困惑；
//  2. 有相机才走权限分支：未决定 → 系统弹框；已拒绝 → 给中文说明并引导到系统设置；
//  3. 相册路径始终可用（PHPicker 是进程外选择器，不需要相册权限），
//     所以「没有相机」永远有一条走得通的路，不是死胡同。
//

import AVFoundation
import Observation
import UIKit

/// 扫码结果。`source` 会随「原生 → 网页」推送一起发出去，网页可以据此区分相机与相册。
struct ScanOutcome: Equatable {
    enum Source: String {
        case camera
        case photoLibrary
    }

    let text: String
    let source: Source
}

@MainActor
@Observable
final class ScannerModel {
    enum CameraState: Equatable {
        case idle
        case running
        /// 设备没有可用摄像头（模拟器）。降级到相册。
        case unavailable(String)
        /// 用户拒绝或系统限制了相机权限。引导到系统设置。
        case permissionDenied(String)
        case failed(String)
    }

    var cameraState: CameraState = .idle
    var lastOutcome: ScanOutcome?
    var statusMessage: String?
    var isPickerPresented = false
    var isProcessingPhoto = false

    /// 结果出口：由 AppModel 注入——回填地址栏、推给网页、关掉扫码页。
    var onOutcome: ((ScanOutcome) -> Void)?

    private let controller = CameraScannerController()
    private let log: DiagnosticsLog
    private let autoPresentPicker: Bool

    /// 供相机预览视图绑定会话（会话由模型持有，不随 UIView 重建而重建）。
    var cameraController: CameraScannerController { controller }

    init(log: DiagnosticsLog, autoPresentPicker: Bool = false) {
        self.log = log
        self.autoPresentPicker = autoPresentPicker
        controller.onCode = { [weak self] code in
            self?.deliver(ScanOutcome(text: code, source: .camera))
        }
    }

    static let deniedText = "相机权限已关闭，无法扫码。请在「设置 → 隐私与安全性 → 相机」里允许千手智能体使用相机；也可以直接用「从相册选图」。"
    static let unavailableText = "模拟器没有相机，请用相册选图"

    // MARK: - 生命周期

    func onAppear() {
        if cameraState == .idle { startCamera() }
        if autoPresentPicker && !isPickerPresented { isPickerPresented = true }
    }

    func onDisappear() {
        controller.stop()
    }

    // MARK: - 相机

    func startCamera() {
        guard CameraScannerController.isCameraAvailable else {
            cameraState = .unavailable(Self.unavailableText)
            statusMessage = Self.unavailableText
            log.record("扫码：无可用摄像头（模拟器或设备无相机），已降级为相册选图")
            return
        }

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            beginCapture()
        case .notDetermined:
            statusMessage = "正在请求相机权限……"
            AVCaptureDevice.requestAccess(for: .video) { granted in
                Task { @MainActor in
                    if granted {
                        self.beginCapture()
                    } else {
                        self.cameraState = .permissionDenied(Self.deniedText)
                        self.statusMessage = Self.deniedText
                        self.log.record("扫码：用户拒绝了相机权限，已保留相册路径")
                    }
                }
            }
        case .denied, .restricted:
            cameraState = .permissionDenied(Self.deniedText)
            statusMessage = Self.deniedText
            log.record("扫码：相机权限不可用（denied/restricted），引导到系统设置")
        @unknown default:
            cameraState = .permissionDenied(Self.deniedText)
        }
    }

    private func beginCapture() {
        statusMessage = "正在启动相机……"
        controller.start { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.cameraState = .running
                self.statusMessage = "把二维码放进取景框内"
                self.log.record("扫码：相机已启动，识别类型 qr")
            case .failure(let failure):
                self.cameraState = .failed(failure.message)
                self.statusMessage = failure.message
                self.log.record("扫码：相机启动失败 — \(failure.message)")
            }
        }
    }

    /// 引导到系统设置：被拒绝后用户唯一能自救的入口。
    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString), UIApplication.shared.canOpenURL(url) else {
            statusMessage = "无法打开系统设置，请手动进入「设置 → 隐私与安全性 → 相机」。"
            return
        }
        UIApplication.shared.open(url)
    }

    // MARK: - 相册

    func presentPhotoPicker() {
        isPickerPresented = true
    }

    func handlePickedImage(_ image: UIImage) {
        isPickerPresented = false
        isProcessingPhoto = true
        statusMessage = "正在识别图片里的二维码……"

        Task { @MainActor in
            let result = await PhotoBarcodeScanner.scan(image)
            self.isProcessingPhoto = false
            switch result {
            case .success(let scanned):
                guard let first = scanned.values.first else {
                    self.statusMessage = "这张图里没有识别到二维码，换一张试试。"
                    self.log.record("扫码：相册图片未识别到二维码（引擎 \(scanned.engine)）")
                    return
                }
                self.statusMessage = "识别成功（\(scanned.engine)，共 \(scanned.values.count) 个结果）"
                self.log.record("扫码：相册识别成功，引擎 \(scanned.engine)，内容长度 \(first.count)")
                self.deliver(ScanOutcome(text: first, source: .photoLibrary))
            case .failure(let error):
                self.statusMessage = error.message
                self.log.record("扫码：相册识别失败 — \(error.message)")
            }
        }
    }

    // MARK: - 结果

    private func deliver(_ outcome: ScanOutcome) {
        lastOutcome = outcome
        if case .unavailable = cameraState {
            // 相册路径在「没有相机」的设备上就是主路径，不改状态文案。
        } else if case .permissionDenied = cameraState {
            // 同上：权限被拒时相册依然可用。
        } else {
            statusMessage = "已识别到二维码内容（\(outcome.source == .camera ? "相机" : "相册")）"
        }
        controller.stop()
        onOutcome?(outcome)
    }
}
