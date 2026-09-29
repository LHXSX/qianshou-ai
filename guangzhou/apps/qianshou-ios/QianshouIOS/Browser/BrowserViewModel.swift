//
//  BrowserViewModel.swift
//  浏览页状态机：地址、进度、错误、扫码回填。
//
//  为什么模型直接持有 WKWebView 的弱引用：SwiftUI 的 UIViewRepresentable 无法把
//  「命令」（载入/刷新/后退）声明式地传下去而不引入一套命令 diff 机制，
//  而地址栏按钮必须立刻生效。弱引用不会造成环，视图销毁后自动变 nil。
//

import Foundation
import Observation
import WebKit

@MainActor
@Observable
final class BrowserViewModel {
    /// 地址持久化的键（UserDefaults）。只有用户主动「载入」的地址才会写盘。
    static let addressDefaultsKey = "QianshouAddress"

    var addressText: String
    private(set) var committedURL: URL?
    private(set) var progress: Double = 0
    private(set) var isLoading = false
    /// 是否已经成功渲染过至少一个页面。用于区分「首次打开就失败」（整屏错误页）
    /// 与「已有内容但刷新失败」（顶部条提示，不遮挡内容）。
    private(set) var hasContent = false
    private(set) var errorMessage: String?
    private(set) var scannedNotice: String?
    /// 主框架导航被策略拦下时的提示（第三方站点已交给系统浏览器）。
    private(set) var blockedNotice: String?
    private(set) var canGoBack = false
    private(set) var canGoForward = false

    /// 网页加载完成后的钩子（AppModel 用来触发桥自检）。
    var onPageFinished: (() -> Void)?

    /// 用户明确发起载入（地址栏、扫码、调试参数）时的钩子。
    /// AppModel 把它接到桥的 origin 白名单上：只有用户自己指定的站点才可能持有桥。
    var onExplicitLoad: ((URL) -> Void)?

    private weak var webView: WKWebView?
    private let defaults: UserDefaults
    private var hasPerformedInitialLoad = false
    /// 诊断日志：加载链路上的每一步都要留痕，否则「白屏但没有任何报错」这种
    /// 最糟糕的失败形态就只能靠猜（这是本轮真实踩到的坑）。
    private let log: DiagnosticsLog?
    /// 本次「已发起、尚未结束」的目标地址。用于识别 WebKit 只完成空白文档的情况。
    private var pendingURL: URL?
    private var watchdog: Task<Void, Never>?

    /// 自检需要在真实 webView 上执行脚本；这里只给只读出口，不暴露导航能力。
    var webViewForDiagnostics: WKWebView? { webView }

    init(defaults: UserDefaults = .standard, log: DiagnosticsLog? = nil) {
        self.defaults = defaults
        self.log = log
        let stored = defaults.string(forKey: Self.addressDefaultsKey)?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let stored, !stored.isEmpty, let url = WebAddress.normalize(stored) {
            self.addressText = url.absoluteString
            self.committedURL = url
        } else {
            // 旧版本可能存了公网明文地址（例如随壳发布的 `http://203.0.113.20:18090/`）。
            // 明文策略收紧之后它不再合法：回落到默认的 https 入口并留痕，
            // 不让用户停在一个本应用自己都会拒绝的地址上。
            if let stored, !stored.isEmpty {
                log?.record("浏览：已保存的地址不再符合明文策略，回落到默认 https 入口（原因 \(WebAddress.evaluate(stored))）")
            }
            self.addressText = WebAddress.fallback
            self.committedURL = WebAddress.normalize(WebAddress.fallback)
        }
    }

    // MARK: - 视图绑定

    func attach(_ webView: WKWebView) {
        self.webView = webView
        log?.record("浏览：WebView 已挂载，准备首次载入")
    }

    /// 调试启动参数用：只改本次运行的目标，不写盘（避免调试参数改掉用户自己的设置）。
    ///
    /// 无论合法与否都写进地址栏：模拟器取证要看的正是「把这条地址填进地址栏、按载入会怎样」。
    /// 不合法的地址只记日志、不设目标，于是它永远不会被载入。
    func overrideInitialAddress(_ raw: String) {
        let evaluation = WebAddress.evaluate(raw)
        addressText = raw
        if case .address(let url) = evaluation {
            committedURL = url
        } else {
            committedURL = nil
            log?.record("调试：启动地址被拒绝 reason=\(evaluation)")
        }
    }

    // MARK: - 命令

    /// 首次进入时载入一次。`makeUIView` 可能被多次调用，用标志位保证只触发一次。
    func loadInitialAddressIfNeeded() {
        guard !hasPerformedInitialLoad else {
            log?.record("浏览：首次载入已执行过，跳过")
            return
        }
        hasPerformedInitialLoad = true
        guard let url = committedURL else {
            // 不覆盖更具体的提示（例如「公网地址必须用 https」）：那条才是用户需要照做的说明。
            if errorMessage == nil {
                errorMessage = "没有可用的网页地址，请在地址栏填写后点「载入」。"
            }
            log?.record("浏览：没有可用地址，已显示中文提示")
            return
        }
        load(url, persist: false)
    }

    func loadFromAddressField() {
        let evaluation = WebAddress.evaluate(addressText)
        guard case .address(let url) = evaluation else {
            errorMessage = WebAddress.failureMessage(for: evaluation)
            log?.record("浏览：地址被拒绝 reason=\(evaluation)")
            return
        }
        load(url, persist: true)
    }

    func retry() {
        guard let url = committedURL else {
            loadFromAddressField()
            return
        }
        load(url, persist: false)
    }

    func useDefaultAddress() {
        addressText = WebAddress.fallback
        loadFromAddressField()
    }

    func reload() {
        guard let webView else { return }
        if webView.url == nil {
            retry()
        } else {
            errorMessage = nil
            isLoading = true
            webView.reload()
        }
    }

    func goBack() {
        guard let webView, webView.canGoBack else { return }
        errorMessage = nil
        webView.goBack()
    }

    func goForward() {
        guard let webView, webView.canGoForward else { return }
        errorMessage = nil
        webView.goForward()
    }

    func stopLoading() {
        webView?.stopLoading()
        isLoading = false
    }

    func dismissScannedNotice() {
        scannedNotice = nil
    }

    /// 导航拦截的统一出口：既记日志，也在界面上说清「这个链接去哪儿了」。
    /// 为什么必须给用户一个说法：把导航悄悄取消会表现成「点了链接没反应」，比拒绝更难排查。
    func noteBlockedNavigation(_ reason: String) {
        blockedNotice = reason
        log?.record("浏览：拦截主框架导航 — \(reason)")
    }

    func dismissBlockedNotice() {
        blockedNotice = nil
    }

    /// 扫码结果统一入口：明文先回填地址栏，只有内容确实是 http/https 地址时才载入。
    /// 为什么不一概载入：二维码里可能是 `WIFI:`、一段普通文本或 `mailto:`，
    /// 把任意文本当地址去请求既没意义，也会把用户带到预期外的站点。
    func applyScanResult(_ outcome: ScanOutcome) {
        scannedNotice = outcome.text
        addressText = outcome.text
        if let url = WebAddress.normalize(outcome.text) {
            load(url, persist: true)
        } else {
            errorMessage = nil
        }
    }

    // MARK: - 导航回调

    func handleLoadStarted() {
        isLoading = true
        errorMessage = nil
        if let pendingURL { startWatchdog(for: pendingURL) }
        log?.record("浏览：开始加载 \(WebAddress.redacted(committedURL))")
    }

    func handleProgress(_ value: Double) {
        progress = min(max(value, 0), 1)
    }

    func handleLoadFinished() {
        let landed = webView?.url
        log?.record("浏览：加载完成回调，落点=\(WebAddress.redacted(landed))")

        // 关键判定：WebKit 在目标不可达时可能只回调一次 didFinish，而落点是 about:blank。
        // 若把它当成成功，界面就会停在白屏且没有任何提示——这是实测踩到的真实缺陷。
        if let pendingURL, let landed, !Self.isSameTarget(landed, pendingURL) {
            log?.record("浏览：落点 \(WebAddress.redacted(landed)) 与目标 \(WebAddress.redacted(pendingURL)) 不一致，按失败处理")
            handleLoadFailure(NSError(
                domain: "QianshouWebViewDomain",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: "页面没有真正打开（WebKit 只完成了空白文档），通常是地址不可达或服务器没有响应。"]
            ))
            return
        }

        stopWatchdog()
        isLoading = false
        progress = 1
        hasContent = true
        errorMessage = nil
        pendingURL = nil
        refreshNavigationState()
        onPageFinished?()
    }

    func handleLoadFailure(_ error: Error) {
        refreshNavigationState()
        let nsError = error as NSError
        // 先无条件记录回调入口：只有留下 domain/code，「到底有没有回调」才有据可查。
        log?.record("浏览：失败回调 domain=\(nsError.domain) code=\(nsError.code)")
        guard let message = BrowserErrorText.message(for: error) else {
            // 被新导航取代：不改状态，也不闪现错误页。
            log?.record("浏览：忽略被取代的加载 \(nsError.domain) \(nsError.code)")
            return
        }
        stopWatchdog()
        isLoading = false
        progress = 0
        errorMessage = message
        log?.record("浏览：加载失败 \(nsError.domain) \(nsError.code) — \(message)")
    }

    func refreshNavigationState() {
        canGoBack = webView?.canGoBack ?? false
        canGoForward = webView?.canGoForward ?? false
    }

    // MARK: - 内部

    private func load(_ url: URL, persist: Bool) {
        committedURL = url
        addressText = url.absoluteString
        if persist {
            defaults.set(url.absoluteString, forKey: Self.addressDefaultsKey)
        }
        // 这是「用户明确要打开的地址」：登记可信 origin 之后才发起载入，
        // 于是导航策略会在同一次载入里放行它（见 WebViewContainer 的导航拦截）。
        onExplicitLoad?(url)
        errorMessage = nil
        isLoading = true
        progress = 0
        pendingURL = url
        if webView == nil {
            // 视图还没建好（首帧）：地址已记下，loadInitialAddressIfNeeded 会在挂载时载入。
            log?.record("浏览：WebView 尚未就绪，载入推迟到挂载后：\(WebAddress.redacted(url))")
            return
        }
        startWatchdog(for: url)
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        log?.record("浏览：发起载入 \(WebAddress.redacted(url))（持久化=\(persist)）")
        webView?.load(request)
    }

    /// 看门狗：只要还有一次「已发起、未结束」的载入，就必须在有限时间内给用户结论。
    /// 为什么必须有它：模拟器实测发现，目标地址不可达时 WebKit 可能只回调一次
    /// `didFinish`（落点是 `about:blank`）而**不回调任何失败**，界面于是停在白屏——
    /// 这正是本轮要杜绝的失败形态。超时值取 25 秒，略大于请求自身的 20 秒超时。
    private func startWatchdog(for url: URL) {
        watchdog?.cancel()
        watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 25_000_000_000)
            guard !Task.isCancelled, let self else { return }
            guard self.isLoading, self.pendingURL == url else { return }
            self.log?.record("浏览：等待 \(WebAddress.redacted(url)) 超过 25 秒仍未结束，按超时处理")
            self.handleLoadFailure(URLError(.timedOut))
        }
    }

    private func stopWatchdog() {
        watchdog?.cancel()
        watchdog = nil
    }

    /// 判断「这次导航是否真的落在了我们要的地址上」。
    /// `about:blank` 之类的落点不算成功：它只是 WebKit 的空白文档。
    private static func isSameTarget(_ landed: URL, _ requested: URL) -> Bool {
        guard let landedScheme = landed.scheme?.lowercased(),
              let requestedScheme = requested.scheme?.lowercased()
        else { return false }
        guard landedScheme == requestedScheme, landedScheme == "http" || landedScheme == "https" else { return false }
        return landed.host?.lowercased() == requested.host?.lowercased()
            && landed.port == requested.port
    }
}
