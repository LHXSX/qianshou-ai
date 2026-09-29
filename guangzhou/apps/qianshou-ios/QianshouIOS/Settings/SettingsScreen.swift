//
//  SettingsScreen.swift
//  设置与诊断：地址说明、应用信息、桥日志、桥自检、扫码图片探针入口。
//
//  为什么把「桥日志」放进用户可见界面：桥的拒绝记录是排查「网页乱调原生」的唯一线索，
//  只写在控制台里，出问题时用户拿不到；放在这里，用户截个图就能给。
//  地址输入本身固定在浏览页地址栏，这里不重复一份，避免出现两个真相。
//

import SwiftUI

struct SettingsScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("网页地址") {
                    LabeledContent("当前地址", value: app.browser.committedURL?.absoluteString ?? "未载入")
                    LabeledContent("默认地址", value: WebAddress.fallback)
                    Button("恢复默认地址并载入") {
                        app.browser.useDefaultAddress()
                    }
                }

                Section("应用信息") {
                    LabeledContent("平台", value: AppInfo.platform)
                    LabeledContent("版本", value: "\(AppInfo.version)（构建 \(AppInfo.build)）")
                    LabeledContent("Bundle ID", value: AppInfo.bundleIdentifier)
                    LabeledContent("原生桥", value: "通道 \(BridgeProtocol.handlerName)，白名单 \(BridgeProtocol.allowedMethods.sorted().joined(separator: "、"))")
                    LabeledContent("扫码能力", value: CameraScannerController.isCameraAvailable ? "相机 + 相册" : "无相机（模拟器），相册可用")
                }

                Section("原生桥自检") {
                    Button {
                        Task { await app.runBridgeSelfCheck() }
                    } label: {
                        HStack {
                            Text("运行桥自检")
                            Spacer()
                            if app.isRunningSelfCheck { ProgressView() }
                        }
                    }
                    .disabled(app.isRunningSelfCheck)

                    ForEach(app.selfCheckSteps) { step in
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: step.passed ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(step.passed ? .green : .red)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(step.name).font(.callout)
                                Text(step.detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    if app.selfCheckSteps.isEmpty {
                        Text("尚未运行。自检会验证：注入脚本就位、getAppInfo 往返、未知方法被拒绝、反向推送的注入探针只当数据。")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("诊断日志（最近 \(app.log.lines.count) 条）") {
                    if app.log.lines.isEmpty {
                        Text("暂无日志").font(.caption).foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(app.log.lines.enumerated().reversed()), id: \.offset) { _, line in
                            Text(line)
                                .font(.caption2.monospaced())
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }
}
