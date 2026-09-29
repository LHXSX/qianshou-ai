//
//  BrowserScreen.swift
//  浏览页：地址栏 + 进度 + 网页 + 错误处理 + 工具条。
//
//  失败形态的设计（本轮明确要求「不要白屏」）：
//  - 从没成功渲染过任何页面 → 整屏中文错误页，带「重试」与「用默认地址」；
//  - 已经渲染过内容、只是本次刷新失败 → 顶部一条提示 + 重试按钮，不遮挡已有内容。
//  两种情况都给出人话的原因（见 BrowserErrorText），不把英文错误码甩给用户。
//

import SwiftUI

struct BrowserScreen: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        // 直接读 AppModel 的持有对象：BrowserViewModel 是 @Observable，
        // body 里读到的每个属性都会被观察系统记录，读法越直白越不容易漏更新。
        let model = app.browser

        return VStack(spacing: 0) {
            addressBar(model: model)
            progressBar(model: model)
            if let notice = app.scanNotice {
                scanBanner(notice: notice)
            }
            if let notice = model.blockedNotice {
                blockedBanner(notice: notice)
            }
            webArea(model: model)
            toolBar(model: model)
        }
        .navigationTitle("千手智能体")
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - 地址栏

    private func addressBar(model: BrowserViewModel) -> some View {
        @Bindable var model = model

        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                TextField("网页地址", text: $model.addressText)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .submitLabel(.go)
                    .onSubmit { model.loadFromAddressField() }
                    .accessibilityIdentifier("address-field")

                Button("载入") { model.loadFromAddressField() }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("address-load")
            }
            Text("当前：\(model.committedURL.map(WebAddress.redacted) ?? "未载入")")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .padding(.bottom, 6)
    }

    // MARK: - 进度

    private func progressBar(model: BrowserViewModel) -> some View {
        Group {
            if model.isLoading {
                ProgressView(value: max(model.progress, 0.03))
                    .progressViewStyle(.linear)
            } else {
                // 固定高度占位：加载结束时布局不跳动。
                Color.clear
            }
        }
        .frame(height: 4)
    }

    // MARK: - 扫码结果提示

    private func scanBanner(notice: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "qrcode.viewfinder")
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text("扫码结果")
                    .font(.caption.bold())
                Text(notice)
                    .font(.caption)
                    .lineLimit(3)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
            Button {
                app.browser.dismissScannedNotice()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(10)
        .background(Color(uiColor: .secondarySystemBackground))
    }

    // MARK: - 导航拦截提示

    /// 第三方链接不在可信 origin 内：导航被取消并交给系统浏览器，这里如实告诉用户。
    private func blockedBanner(notice: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "arrow.up.forward.app")
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text("已在系统浏览器打开")
                    .font(.caption.bold())
                Text(notice)
                    .font(.caption)
                    .lineLimit(3)
                    .textSelection(.enabled)
            }
            Spacer(minLength: 0)
            Button {
                app.browser.dismissBlockedNotice()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(10)
        .background(Color(uiColor: .secondarySystemBackground))
    }

    // MARK: - 网页与错误

    private func webArea(model: BrowserViewModel) -> some View {
        ZStack {
            WebViewContainer(model: model, bridge: app.bridge)

            if let message = model.errorMessage {
                if model.hasContent {
                    VStack {
                        errorBanner(message)
                        Spacer()
                    }
                } else {
                    errorFullScreen(message, model: model)
                }
            }
        }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            Text(message)
                .font(.caption)
                .lineLimit(2)
            Spacer(minLength: 0)
            Button("重试") { app.browser.retry() }
                .font(.caption.bold())
                .accessibilityIdentifier("error-retry-banner")
        }
        .padding(10)
        .background(Color(uiColor: .systemBackground))
        .overlay(alignment: .bottom) { Divider() }
    }

    private func errorFullScreen(_ message: String, model: BrowserViewModel) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 44))
                .foregroundStyle(.orange)
            Text("网页没能打开")
                .font(.title3.bold())
            Text(message)
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Text(model.committedURL.map(WebAddress.redacted) ?? "未载入")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(2)
                .truncationMode(.middle)
            HStack(spacing: 12) {
                Button("重试") { app.browser.retry() }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("error-retry")
                Button("用默认地址") { app.browser.useDefaultAddress() }
                    .buttonStyle(.bordered)
            }
            .padding(.top, 4)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
        .accessibilityIdentifier("error-full-screen")
    }

    // MARK: - 工具条

    private func toolBar(model: BrowserViewModel) -> some View {
        HStack {
            toolbarButton("chevron.backward", label: "后退", enabled: model.canGoBack) { app.browser.goBack() }
            toolbarButton("chevron.forward", label: "前进", enabled: model.canGoForward) { app.browser.goForward() }
            toolbarButton("arrow.clockwise", label: "刷新", enabled: true) { app.browser.reload() }
            Spacer()
            Button {
                app.activeSheet = .scanner
            } label: {
                Label("扫一扫", systemImage: "qrcode.viewfinder")
                    .font(.callout.bold())
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("open-scanner")
            Spacer()
            toolbarButton("gearshape", label: "设置", enabled: true) { app.activeSheet = .settings }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private func toolbarButton(_ systemName: String, label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .frame(width: 34, height: 30)
        }
        .disabled(!enabled)
        .accessibilityLabel(label)
    }
}
