//
//  BridgeOrigin.swift
//  桥的 origin 绑定（纯 Foundation，不依赖 WebKit）。
//
//  为什么需要它：桥只检查了「是不是主框架」，没检查「是哪个站点的框架」。
//  聊天里点开一个第三方链接，WebView 载入该站点后，那个站点就和本应用同处一个
//  顶层文档里——它同样能拿到 `window.qianshouBridge`，能收到推送的 `scanResult`
//  （里面可能是 `qianshou-pair:<ticket>` 配对票据）。origin 绑定是补上这一课的最小机制：
//
//  1. **用户明确要打开的地址**（地址栏、扫码、调试参数）才登记为一个可信 origin；
//  2. 主框架导航只有落在已登记的 origin 上才放行，其余交给系统浏览器打开；
//  3. 网页 → 原生的每条消息、原生 → 网页的每条推送，都要比对当前文档 origin。
//
//  做成纯值类型 + 纯容器，是为了能在 `tests/logic-checks.swift` 里穷举断言
//  （默认端口、大小写、子域、IP、容量淘汰），不必真的开一个 WKWebView。
//

import Foundation

/// 一个 origin：scheme + host + 有效端口。路径、query、fragment 不参与比较。
struct BridgeOrigin: Hashable, CustomStringConvertible {
    let scheme: String
    let host: String
    /// 有效端口：URL 里没写时补协议默认端口，于是 `https://a.com` 与 `https://a.com:443` 是同一个 origin。
    let port: Int

    init?(url: URL?) {
        guard let url, let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host?.lowercased(), !host.isEmpty
        else { return nil }
        let defaultPort = scheme == "https" ? 443 : 80
        self.scheme = scheme
        self.host = host
        self.port = url.port ?? defaultPort
    }

    /// 给日志用的规范写法。IPv6 主机加回方括号（`URL.host` 会去掉它），否则 `https://::1:8099`
    /// 这种输出分不清端口在哪里。
    var description: String {
        let text = host.contains(":") ? "[\(host)]" : host
        return "\(scheme)://\(text):\(port)"
    }
}

/// 已登记 origin 的有界集合。只由「用户明确发起的载入」写入。
final class BridgeOriginAllowlist {
    /// 容量上限：保留最近若干个用户主动打开的 origin，让「后退」仍能落在可信页面上，
    /// 同时不允许集合随浏览历史无限增长。
    static let capacity = 8

    private var recent: [BridgeOrigin] = []

    /// 登记一个用户主动打开的地址；不是 http/https 的输入不进集合。
    func allow(_ url: URL?) {
        guard let origin = BridgeOrigin(url: url) else { return }
        recent.removeAll { $0 == origin }
        recent.append(origin)
        if recent.count > Self.capacity { recent.removeFirst(recent.count - Self.capacity) }
    }

    /// 当前地址是否落在已登记的 origin 上。
    func allows(_ url: URL?) -> Bool {
        guard let origin = BridgeOrigin(url: url) else { return false }
        return recent.contains(origin)
    }

    /// 给日志用：永远只输出 origin，不输出路径或 query（令牌不可能经这条路径进日志）。
    var summary: String {
        recent.isEmpty ? "（空）" : recent.map(\.description).joined(separator: "、")
    }
}
