//
//  QRScannerScreen.swift
//  扫一扫界面：相机预览 / 降级说明 / 相册选图 / 明文展示。
//
//  三种状态各有明确出路，任何一种都不是死胡同：
//  - 相机可用 → 预览 + 「把二维码放进取景框内」；
//  - 没有相机（模拟器）→ 中文说明「模拟器没有相机，请用相册选图」+ 相册按钮为主按钮；
//  - 权限被拒 → 中文说明 + 「打开系统设置」+ 相册按钮（不需要相册权限，永远可用）。
//

import PhotosUI
import SwiftUI

struct QRScannerScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    @State private var model: ScannerModel?

    var body: some View {
        NavigationStack {
            Group {
                if let model {
                    content(model: model)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("扫一扫")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("关闭") { dismiss() }
                }
            }
        }
        .task {
            // 模型在 onAppear 时才建，保证注入的 AppModel 已经就绪。
            if model == nil {
                let created = ScannerModel(log: app.log, autoPresentPicker: app.debugOptions.presentPhotoPicker)
                created.onOutcome = { outcome in app.handleScanOutcome(outcome) }
                model = created
            }
            model?.onAppear()
        }
        .onDisappear { model?.onDisappear() }
    }

    @ViewBuilder
    private func content(model: ScannerModel) -> some View {
        VStack(spacing: 16) {
            previewArea(model: model)
            statusArea(model: model)
            actionArea(model: model)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
        .sheet(isPresented: Bindable(model).isPickerPresented) {
            PhotoPickerView(
                onPicked: { image in model.handlePickedImage(image) },
                onCancelled: { model.isPickerPresented = false }
            )
        }
    }

    // MARK: - 预览

    @ViewBuilder
    private func previewArea(model: ScannerModel) -> some View {
        ZStack {
            switch model.cameraState {
            case .running:
                CameraScannerView(controller: model.cameraController)
                    .frame(height: 300)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .overlay(alignment: .bottom) {
                        Text("把二维码放进取景框内")
                            .font(.footnote)
                            .padding(6)
                            .background(.ultraThinMaterial, in: Capsule())
                            .padding(.bottom, 10)
                    }
                    .accessibilityIdentifier("camera-preview")
            default:
                RoundedRectangle(cornerRadius: 16)
                    .fill(Color(uiColor: .secondarySystemBackground))
                    .frame(height: 300)
                    .overlay {
                        VStack(spacing: 12) {
                            Image(systemName: "camera.metering.unknown")
                                .font(.system(size: 40))
                                .foregroundStyle(.secondary)
                            Text(placeholderText(model: model))
                                .font(.callout)
                                .multilineTextAlignment(.center)
                                .foregroundStyle(.secondary)
                                .padding(.horizontal, 20)
                        }
                    }
                    .accessibilityIdentifier("camera-unavailable")
            }
        }
    }

    private func placeholderText(model: ScannerModel) -> String {
        switch model.cameraState {
        case .unavailable(let text): return text
        case .permissionDenied(let text): return text
        case .failed(let text): return text
        case .idle: return "正在检查相机……"
        case .running: return ""
        }
    }

    // MARK: - 状态与结果

    @ViewBuilder
    private func statusArea(model: ScannerModel) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let message = model.statusMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let outcome = model.lastOutcome {
                VStack(alignment: .leading, spacing: 4) {
                    Text("二维码明文（\(outcome.source == .camera ? "相机" : "相册")）")
                        .font(.caption.bold())
                    Text(outcome.text)
                        .font(.callout)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if WebAddress.looksLikeAddress(outcome.text) {
                        Text("已交给地址栏并载入")
                            .font(.caption)
                            .foregroundStyle(.green)
                    } else {
                        Text("内容不是网址，已回填地址栏但不会自动载入")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }
                .padding(12)
                .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier("scan-result")
            }
        }
    }

    // MARK: - 操作

    @ViewBuilder
    private func actionArea(model: ScannerModel) -> some View {
        VStack(spacing: 10) {
            if case .permissionDenied = model.cameraState {
                Button {
                    model.openSystemSettings()
                } label: {
                    Label("打开系统设置", systemImage: "gearshape")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("open-system-settings")
            }

            Button {
                model.presentPhotoPicker()
            } label: {
                Label(model.isProcessingPhoto ? "正在识别……" : "从相册选图", systemImage: "photo.on.rectangle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(model.isProcessingPhoto)
            .accessibilityIdentifier("pick-photo")

            if case .failed = model.cameraState {
                Button("重试相机") { model.startCamera() }
                    .font(.footnote)
            }
        }
    }
}

/// PHPicker：进程外选择器，**不需要相册权限**，所以 Info.plist 里没有
/// `NSPhotoLibraryUsageDescription`——少要一个权限就少一份被审核追问的理由。
struct PhotoPickerView: UIViewControllerRepresentable {
    let onPicked: (UIImage) -> Void
    let onCancelled: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onPicked: onPicked, onCancelled: onCancelled)
    }

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 1
        let controller = PHPickerViewController(configuration: configuration)
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: PHPickerViewController, context: Context) {}

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        private let onPicked: (UIImage) -> Void
        private let onCancelled: () -> Void

        init(onPicked: @escaping (UIImage) -> Void, onCancelled: @escaping () -> Void) {
            self.onPicked = onPicked
            self.onCancelled = onCancelled
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            picker.dismiss(animated: true)
            guard let provider = results.first?.itemProvider, provider.canLoadObject(ofClass: UIImage.self) else {
                onCancelled()
                return
            }
            provider.loadObject(ofClass: UIImage.self) { object, _ in
                guard let image = object as? UIImage else {
                    DispatchQueue.main.async { self.onCancelled() }
                    return
                }
                DispatchQueue.main.async { self.onPicked(image) }
            }
        }
    }
}
