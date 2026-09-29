//
//  QianshouIOSApp.swift
//  千手智能体 iOS 原生壳
//
//  方案：原生壳 + 原生桥。
//  - 界面零重写：手机网页版已完成并通过 235 条测试，重写只会制造两套真相；
//  - 原生能力必需：App Store 审核指南 4.2 拒绝「只有网页内容」的 App，
//    所以扫码、权限、地址持久化这些原生能力必须真实可用且被网页真正调用到。
//

import SwiftUI

@main
struct QianshouIOSApp: App {
    /// 唯一的应用状态容器。放在 App 层而不是每个 View 里，是为了让扫码页、浏览页、
    /// 设置页共享同一份「当前地址 / 桥日志 / 扫码结果」，不出现两份状态互相打架。
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootScreen()
                .environment(model)
                .task {
                    // 只在带调试启动参数时有动作（模拟器取证用，见 DebugLaunchOptions）；
                    // 正式启动不传任何参数，这里只写一条启动日志。
                    model.start()
                }
        }
    }
}

/// 根视图：浏览页是主界面；扫一扫与设置用同一个 `sheet(item:)` 弹出，
/// 避免多个 `.sheet` 修饰符争抢同一时刻的呈现权。
struct RootScreen: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model

        NavigationStack {
            BrowserScreen()
        }
        .sheet(item: $model.activeSheet) { sheet in
            switch sheet {
            case .scanner:
                QRScannerScreen()
            case .settings:
                SettingsScreen()
            }
        }
    }
}
