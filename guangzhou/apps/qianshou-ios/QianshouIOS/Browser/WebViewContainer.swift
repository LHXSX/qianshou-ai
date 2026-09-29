//
//  WebViewContainer.swift
//  WKWebView 的 SwiftUI 包装：装配桥、导航策略、转发导航回调、跟踪进度。
//
//  为什么桥在这里装配：`WKUserContentController` 必须在 WKWebView 创建之前配好
//  （创建之后无法再注入 document-start 脚本），所以「注入脚本 + 注册 handler + 建视图」
//  必须发生在同一处，否则桥会在某些导航下静默失效。
//
//  为什么导航策略也在这里：`decidePolicyFor` 是「一个文档能不能占据主框架」的唯一关口。
//  桥的 origin 绑定只有在**第三方站点根本进不了主框架**时才成立——否则那个站点同样能拿到
//  `window.qianshouBridge`。所以第三方主框架导航在这里被取消，并交给系统浏览器打开。
//

import SwiftUI
import UIKit
import WebKit

struct WebViewContainer: UIViewRepresentable {
    let model: BrowserViewModel
    let bridge: BridgeRuntime

    func makeCoordinator() -> Coordinator {
        Coordinator(model: model, bridge: bridge)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        // 桥：注册通道 + 注入网页侧脚本。
        configuration.userContentController.add(bridge, name: BridgeProtocol.handlerName)
        configuration.userContentController.addUserScript(BridgeUserScript.makeUserScript())

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true

        context.coordinator.observe(webView)
        model.attach(webView)
        bridge.attach(webView: webView)
        // 视图就绪后再触发首次载入，否则 load 会打在一个还不存在的 webView 上。
        model.loadInitialAddressIfNeeded()
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // 状态全部通过 BrowserViewModel 的命令方法驱动，这里不需要 diff。
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        private let model: BrowserViewModel
        private let bridge: BridgeRuntime
        private var observations: [NSKeyValueObservation] = []

        init(model: BrowserViewModel, bridge: BridgeRuntime) {
            self.model = model
            self.bridge = bridge
            super.init()
        }

        /// WKWebView 的这些属性都是 KVO 兼容的，且回调都在主线程发出。
        /// 用 `MainActor.assumeIsolated` 把这个事实写进代码：Closure 本身不是隔离的，
        /// 直接调用主线程隔离的方法在 Swift 6 语言模式下会被拒（现在是告警）。
        func observe(_ webView: WKWebView) {
            let model = self.model
            observations = [
                webView.observe(\.estimatedProgress, options: [.new]) { webView, _ in
                    let value = webView.estimatedProgress
                    MainActor.assumeIsolated { model.handleProgress(value) }
                },
                webView.observe(\.canGoBack, options: [.new]) { _, _ in
                    MainActor.assumeIsolated { model.refreshNavigationState() }
                },
                webView.observe(\.canGoForward, options: [.new]) { _, _ in
                    MainActor.assumeIsolated { model.refreshNavigationState() }
                },
            ]
        }

        // MARK: - WKNavigationDelegate

        /// 主框架导航策略：只有用户明确打开过的 origin 能在本壳里占据主框架。
        ///
        /// - 已登记 origin（地址栏 / 扫码 / 后退回到用户打开过的站点）→ 放行；
        /// - 其它 http/https（聊天里的第三方链接、`target=_blank` 弹窗）→ 取消，交给系统浏览器；
        /// - 其它 scheme（`file:`、`javascript:`、`data:`）→ 取消，不交给系统；
        /// - `about:blank` → 放行（WebKit 的空白文档，origin 不透明，桥在原生侧仍按 origin 拒绝）。
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let url = navigationAction.request.url
            let scheme = url?.scheme?.lowercased() ?? ""
            let isMainFrame = navigationAction.targetFrame?.isMainFrame ?? true

            if !isMainFrame {
                // 子框架（含第三方 iframe）：放行，但桥只注入主框架、且原生侧拒绝非主框架消息。
                decisionHandler(.allow)
                return
            }
            if scheme == "about" {
                decisionHandler(.allow)
                return
            }
            guard scheme == "http" || scheme == "https", bridge.allowsOrigin(of: url) else {
                decisionHandler(.cancel)
                openExternally(url, scheme: scheme)
                return
            }
            decisionHandler(.allow)
        }

        /// 被拒绝的主框架导航：只把 http/https 交给系统浏览器，其余只记日志。
        private func openExternally(_ url: URL?, scheme: String) {
            guard let url else {
                model.noteBlockedNavigation("没有地址的导航请求")
                return
            }
            let target = WebAddress.redacted(url)
            guard scheme == "http" || scheme == "https" else {
                model.noteBlockedNavigation("不支持在壳内打开的地址类型 \(scheme):（\(target)）")
                return
            }
            model.noteBlockedNavigation("第三方站点不在可信 origin 内，已在系统浏览器打开：\(target)")
            UIApplication.shared.open(url, options: [:]) { opened in
                if !opened { /* 系统没有可打开该地址的应用：日志已记录这次拒绝，不再额外处理。 */ }
            }
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            model.handleLoadStarted()
        }

        func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
            model.handleProgress(webView.estimatedProgress)
            model.refreshNavigationState()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            model.handleLoadFinished()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            model.handleLoadFailure(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            model.handleLoadFailure(error)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            // WebKit 内容进程被系统回收（内存压力）：不重载就会一直白屏。
            model.handleLoadFailure(NSError(
                domain: BrowserErrorText.applicationDomain,
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "网页内容进程被系统回收（通常是内存不足）。"]
            ))
        }
    }
}
