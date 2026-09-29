//
//  CameraScannerView.swift
//  AVFoundation 相机取景 + AVCaptureMetadataOutput 二维码识别。
//
//  为什么自己包一层 UIView：`AVCaptureVideoPreviewLayer` 要作为 view 的 backing layer
//  才能随视图自动布局；用 `addSublayer` 就得手动同步 frame，横竖屏切换必然错位。
//
//  为什么会话放在 controller 而不是 view：`AVCaptureSession` 的启停是异步且昂贵的，
//  SwiftUI 会在滚动/切页时重建 representable 的 UIView；会话一旦跟着 UIView 走，
//  每次重建都要重新配置设备，扫码会一顿一顿。
//

import AVFoundation
import SwiftUI
import UIKit

struct CameraScannerView: UIViewRepresentable {
    let controller: CameraScannerController

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.backgroundColor = .black
        view.previewLayer.session = controller.session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}

final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    var previewLayer: AVCaptureVideoPreviewLayer {
        // layerClass 已保证类型，这里的强转不会失败。
        guard let layer = layer as? AVCaptureVideoPreviewLayer else {
            fatalError("PreviewView 的 backing layer 必须是 AVCaptureVideoPreviewLayer")
        }
        return layer
    }
}

final class CameraScannerController: NSObject, AVCaptureMetadataOutputObjectsDelegate {
    /// 相机启动失败的原因。用结构体而不是裸 String：`Result` 的失败类型必须符合 `Error`，
    /// 而裸 String 在 Swift 里不是 Error（这是编译期就能拦住的设计约束）。
    struct StartFailure: Error {
        let message: String
    }

    let session = AVCaptureSession()

    /// 会话配置与启停都在这个串行队列上做：`startRunning()` 会阻塞，放在主线程会卡住界面。
    private let sessionQueue = DispatchQueue(label: "com.qianshou.qianshouios.camera.session")

    private var isConfigured = false
    /// 只交付第一份结果：同一个二维码在一帧里可能连续命中，不拦住会把同一份内容推很多次。
    private var hasDelivered = false

    /// 识别到二维码时回调（主线程）。
    var onCode: ((String) -> Void)?

    /// 有没有摄像头。模拟器返回 false——这是降级到相册的判定依据，
    /// 也是为什么 iOS 模拟器上永远不会走到权限申请：先判断硬件，再谈权限。
    static var isCameraAvailable: Bool {
        #if targetEnvironment(simulator)
        // 模拟器没有摄像头硬件，直接判否：既避免弹一个没有意义的权限框，
        // 也让「模拟器没有相机，请用相册选图」这条降级路径稳定可复现。
        return false
        #else
        return AVCaptureDevice.default(for: .video) != nil
        #endif
    }

    /// 配置并启动采集。结果通过 completion 回主线程。
    func start(completion: @escaping (Result<Void, StartFailure>) -> Void) {
        guard Self.isCameraAvailable else {
            completion(.failure(StartFailure(message: "这台设备没有可用摄像头")))
            return
        }
        sessionQueue.async { [weak self] in
            guard let self else { return }
            let configuration = self.configureIfNeeded()
            guard case .success = configuration else {
                if case .failure(let failure) = configuration {
                    DispatchQueue.main.async { completion(.failure(failure)) }
                }
                return
            }
            if !self.session.isRunning {
                self.session.startRunning()
            }
            DispatchQueue.main.async { completion(.success(())) }
        }
    }

    func stop() {
        hasDelivered = false
        sessionQueue.async { [weak self] in
            guard let self, self.session.isRunning else { return }
            self.session.stopRunning()
        }
    }

    /// 允许再次交付（例如识别失败后用户手动重扫）。
    func resetDelivery() {
        hasDelivered = false
    }

    private func configureIfNeeded() -> Result<Void, StartFailure> {
        if isConfigured { return .success(()) }

        guard let device = AVCaptureDevice.default(for: .video) else {
            return .failure(StartFailure(message: "找不到可用的摄像头"))
        }
        guard let input = try? AVCaptureDeviceInput(device: device) else {
            return .failure(StartFailure(message: "无法读取摄像头输入（可能被其它 App 占用）"))
        }

        session.beginConfiguration()
        defer { session.commitConfiguration() }

        guard session.canAddInput(input) else {
            return .failure(StartFailure(message: "摄像头输入无法加入采集会话"))
        }
        session.sessionPreset = .high
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            return .failure(StartFailure(message: "二维码识别输出无法加入采集会话"))
        }
        session.addOutput(output)

        // 委托队列用主线程：识别结果直接驱动界面状态，省一次线程跳转。
        output.setMetadataObjectsDelegate(self, queue: .main)

        // 关键顺序：metadataObjectTypes 必须在 addOutput 之后设置。
        // 在此之前 availableMetadataObjectTypes 是空的，直接赋值 .qr 会抛 ObjC 异常（崩溃），
        // 所以这里先判断可用性再赋值。
        guard output.availableMetadataObjectTypes.contains(.qr) else {
            return .failure(StartFailure(message: "这台设备的摄像头不支持二维码识别"))
        }
        output.metadataObjectTypes = [.qr]

        isConfigured = true
        return .success(())
    }

    // MARK: - AVCaptureMetadataOutputObjectsDelegate

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !hasDelivered else { return }
        guard let object = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first(where: { $0.type == .qr }),
              let value = object.stringValue,
              !value.isEmpty
        else { return }

        hasDelivered = true
        onCode?(value)
    }
}
