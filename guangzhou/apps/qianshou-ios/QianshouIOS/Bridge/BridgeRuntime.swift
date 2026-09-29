//
//  BridgeRuntime.swift
//  桥的原生端：接收网页消息 → 校验 origin → 执行白名单方法 → 回执 / 拒绝并记录。
//
//  生命周期：`WKUserContentController` 会强引用 handler，所以这里对 webView 只持弱引用；
//  否则 WKWebView → configuration → userContentController → handler → WKWebView 成环，
//  整个页面永远不会释放。
//
//  信任边界（三条，缺一不可）：
//  1. 只信任主框架（iframe 可能是第三方内容）；
//  2. 只信任**用户明确打开过的 origin**（见 BridgeOrigin.swift）——第三方站点即使被载入同一
//     WebView，也拿不到桥的回执，也收不到推送；
//  3. 日志一律写脱敏地址，入口地址里的 `?token=` 不进日志。
//

import Foundation
import WebKit

@MainActor
final class BridgeRuntime: NSObject, WKScriptMessageHandler {
    private let log: DiagnosticsLog
    private let versionProvider: () -> String

    /// 弱引用：见文件头的成环说明。
    private weak var webView: WKWebView?

    /// 可信 origin 集合。只有用户明确发起的载入（地址栏、扫码、调试启动参数）会登记。
    private let origins = BridgeOriginAllowlist()

    init(log: DiagnosticsLog, versionProvider: @escaping () -> String) {
        self.log = log
        self.versionProvider = versionProvider
        super.init()
    }

    func attach(webView: WKWebView) {
        self.webView = webView
    }

    // MARK: - origin 绑定

    /// 用户明确要打开的地址 → 登记为可信 origin。由 BrowserViewModel 在发起载入前调用。
    func allowOrigin(of url: URL) {
        origins.allow(url)
        log.record("桥：登记可信 origin \(BridgeOrigin(url: url)?.description ?? "?")（当前 \(origins.summary)）")
    }

    /// 导航策略与出站推送共用同一个判据：地址是否落在已登记的 origin 上。
    func allowsOrigin(of url: URL?) -> Bool {
        origins.allows(url)
    }

    // MARK: - 网页 → 原生

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == BridgeProtocol.handlerName else {
            log.record("桥：收到未知通道 \(message.name)，已忽略")
            return
        }
        // 只信任主框架：iframe（可能是第三方内容）不该能调用原生能力。
        guard message.frameInfo.isMainFrame else {
            log.record("桥：拒绝来自子框架 \(WebAddress.redacted(message.frameInfo.request.url)) 的消息")
            return
        }
        // origin 绑定：第三方网站即使进了同一个 WebView，也不能调桥。
        guard allowsOrigin(of: message.frameInfo.request.url) else {
            log.record("桥：拒绝来自非可信 origin \(WebAddress.redacted(message.frameInfo.request.url)) 的消息（可信 \(origins.summary)）")
            return
        }

        switch BridgeProtocol.parse(body: message.body) {
        case .rejection(let rejection, let identifier):
            // 未知方法 / 畸形请求一律拒绝并记录。「记录」不是可选项：
            // 网页被第三方脚本注入时，这份日志是唯一能看出「谁在乱调桥」的证据。
            log.record("桥：拒绝请求 id=\(identifier ?? "-") code=\(rejection.code) — \(rejection.detail)")
            deliver(BridgeProtocol.failurePayload(id: identifier, rejection: rejection))
        case .request(let request):
            handle(request)
        }
    }

    private func handle(_ request: BridgeProtocol.Request) {
        switch request.method {
        case "getAppInfo":
            let available = webView != nil
            let payload = AppInfo.bridgePayload(webViewAvailable: available)
            log.record("桥：getAppInfo → platform=\(AppInfo.platform) version=\(versionProvider()) webViewAvailable=\(available)")
            deliver(BridgeProtocol.successPayload(id: request.id, result: payload))
        default:
            // 白名单在 parse 阶段已经拦下未知方法，这里只是穷尽性兜底。
            log.record("桥：拒绝未实现的方法 \(request.method)")
            deliver(BridgeProtocol.failurePayload(id: request.id, rejection: .unknownMethod(method: request.method)))
        }
    }

    // MARK: - 原生 → 网页

    /// 本轮的反向调用示例：把扫码结果推给网页。
    func pushScanResult(_ outcome: ScanOutcome) {
        log.record("桥：推送扫码结果给网页 source=\(outcome.source.rawValue) 长度=\(outcome.text.count)")
        deliver([
            "kind": "event",
            "name": "scanResult",
            "payload": ["text": outcome.text, "source": outcome.source.rawValue],
        ])
    }

    /// 所有出站消息的唯一出口。
    ///
    /// 顺序很重要：先序列化成 JSON 文本，再把「这段 JSON 文本」编码成 JS 字符串字面量，
    /// 最后把它放在 `receive(...)` 的参数位置。正文因此永远是数据，不可能变成代码。
    func deliver(_ payload: [String: Any]) {
        guard let webView else {
            log.record("桥：没有可用的 WebView，出站消息已丢弃 kind=\(payload["kind"] as? String ?? "?")")
            return
        }
        // 出站方向的 origin 绑定：当前文档不在可信 origin 上时一个字节都不推。
        // 这条挡的是「第三方站点已经占据主框架」的情况——扫码结果里可能有配对票据。
        guard allowsOrigin(of: webView.url) else {
            log.record("桥：当前文档 \(WebAddress.redacted(webView.url)) 不是可信 origin，出站消息已丢弃")
            return
        }
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              data.count <= BridgeProtocol.maxPayloadBytes,
              let json = String(data: data, encoding: .utf8) else {
            log.record("桥：出站消息无法序列化或超过上限，已丢弃")
            return
        }

        let script = BridgeProtocol.receiveScript(jsonLiteral: JavaScriptLiteral.string(json))
        webView.evaluateJavaScript(script) { [weak self] result, error in
            if let error {
                self?.log.record("桥：注入失败 \(error.localizedDescription)")
                return
            }
            if let outcome = result as? String, outcome != "delivered" {
                // 网页没装接收器不算错误：本轮网页侧不动，装接收器是网页侧的下一步工作。
                self?.log.record("桥：网页未接收出站消息（\(outcome)），已跳过")
            }
        }
    }
}
