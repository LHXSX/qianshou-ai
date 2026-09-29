//
//  PhotoBarcodeScanner.swift
//  从相册图片识别二维码（Vision，本机推理）。
//
//  为什么用 Vision 而不是 ZXing/CoreImage：仓库原则是不新增第三方依赖；
//  `VNDetectBarcodesRequest` 是 Apple 自带框架，识别在本机完成，图片不出设备。
//  为什么不用 `CIDetector`：CIDetector 的二维码识别在倾斜、反光、低对比度图片上明显更差，
//  而相册里的图正是这三类情况最多的。
//

import CoreImage
import UIKit
// Vision 的旧版类（VNDetectBarcodesRequest 等）在 SDK 里没有标注 Sendable；
// 这里的用法是「请求构造后一次性交给 perform」，不存在跨线程共享，用 @preconcurrency
// 抑制由此产生的噪音警告，而不是靠关掉并发检查来掩盖。
@preconcurrency import Vision

/// 识别结果。带上引擎名：模拟器里 Vision 的 ML 后端可能不可用，
/// 用户与排查者都需要知道这次到底是哪条路径给出的结果。
struct BarcodeScanResult {
    let values: [String]
    let engine: String
}

enum PhotoBarcodeScanner {
    enum ScanError: Error {
        case invalidImage
        case visionFailed(String)

        /// 给用户看的中文说明，不暴露 Vision 的英文错误码。
        var message: String {
            switch self {
            case .invalidImage:
                return "这张图读不出来（可能是 iCloud 还没下载完或格式不支持），换一张试试。"
            case .visionFailed(let detail):
                return "识别过程出错：\(detail)"
            }
        }
    }

    /// 识别图片里的二维码。
    ///
    /// 先用 Vision（识别率最好，Apple 官方推荐）。若 Vision 连推理上下文都建不起来
    /// ——实测 iOS 模拟器在缺少 Metal toolchain 时就会报 "Could not create inference context"
    /// ——则退回 CoreImage 的 CPU 识别器，让「从相册选图」在任何环境下都有结果，
    /// 而不是给用户一句「识别过程出错」就结束。
    static func scan(_ image: UIImage) async -> Result<BarcodeScanResult, ScanError> {
        let visionResult = await scanWithVision(image)
        if case .success = visionResult { return visionResult }
        if case .failure(let error) = visionResult {
            let fallback = scanWithCoreImage(image)
            if case .success(let values) = fallback, !values.isEmpty {
                return .success(BarcodeScanResult(values: values, engine: "CoreImage（Vision 后端不可用时的 CPU 兜底）"))
            }
            return .failure(error)
        }
        return visionResult
    }

    /// Vision 路径：本机推理，图片不出设备。
    private static func scanWithVision(_ image: UIImage) async -> Result<BarcodeScanResult, ScanError> {
        guard let cgImage = image.cgImage else {
            return .failure(.invalidImage)
        }
        let orientation = cgImagePropertyOrientation(from: image.imageOrientation)

        return await withCheckedContinuation { continuation in
            // 两个可能先到的出口（Vision 回调、perform 抛错）都可能 resume；
            // 而 continuation 被 resume 两次会直接崩进程，所以用一次性闸门收口。
            let gate = OneShotContinuation()
            let request = VNDetectBarcodesRequest { request, error in
                guard gate.claim() else { return }
                if let error {
                    continuation.resume(returning: .failure(.visionFailed(error.localizedDescription)))
                    return
                }
                let observations = (request.results as? [VNBarcodeObservation]) ?? []
                let values = observations
                    .filter { $0.symbology == .qr }
                    .compactMap { $0.payloadStringValue }
                    .filter { !$0.isEmpty }
                continuation.resume(returning: .success(BarcodeScanResult(values: values, engine: "Vision")))
            }
            // 只找二维码：相册照片里的一维码（条形码）不是本轮的交付范围，
            // 限定 symbology 也能减少误识别。
            request.symbologies = [.qr]

            let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
            // Vision 的 perform 是同步阻塞的，放到后台队列，避免卡住界面。
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try handler.perform([request])
                } catch {
                    guard gate.claim() else { return }
                    continuation.resume(returning: .failure(.visionFailed(error.localizedDescription)))
                }
            }
        }
    }

    /// 只放行第一个调用者的一次性闸门。
    private final class OneShotContinuation: @unchecked Sendable {
        private let lock = NSLock()
        private var fired = false

        func claim() -> Bool {
            lock.lock()
            defer { lock.unlock() }
            if fired { return false }
            fired = true
            return true
        }
    }

    /// CoreImage 兜底路径：CPU 识别，不依赖 ML 推理上下文。
    private static func scanWithCoreImage(_ image: UIImage) -> Result<[String], ScanError> {
        guard let cgImage = image.cgImage else { return .failure(.invalidImage) }
        let detector = CIDetector(
            ofType: CIDetectorTypeQRCode,
            context: nil,
            options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]
        )
        let features = detector?.features(in: CIImage(cgImage: cgImage)) ?? []
        let values = features
            .compactMap { ($0 as? CIQRCodeFeature)?.messageString }
            .filter { !$0.isEmpty }
        return .success(values)
    }

    /// UIImage 的方向枚举与 Vision/CGImage 的方向枚举是两套值，必须显式映射，
    /// 否则竖拍照片会被当成横图，二维码识别率明显下降。
    private static func cgImagePropertyOrientation(from orientation: UIImage.Orientation) -> CGImagePropertyOrientation {
        switch orientation {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }
}
