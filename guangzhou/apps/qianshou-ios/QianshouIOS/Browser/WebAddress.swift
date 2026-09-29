//
//  WebAddress.swift
//  地址规范化（纯 Foundation）、明文地址策略与日志脱敏。
//
//  为什么单独一个文件：地址既来自键盘输入，也来自扫码结果——两个来源都不可信，
//  必须收敛到同一个判定函数。把它做成纯函数才能在 `tests/logic-checks.swift` 里
//  直接对边界（空串、非 http scheme、没有主机名、超长串、公网明文）做断言。
//
//  安全纪律（两条）：
//  1. **公网地址不许走明文**：`http://` 只对本机与局域网主机放行。带 `?token=` 的入口
//     地址会让令牌在公网明文传输，而明文文档也不是安全上下文——WKWebView 在明文页面里
//     不提供 `getUserMedia`（语音）与 `BarcodeDetector`（网页内扫码），功能本身就是坏的。
//  2. **日志只记脱敏地址**：`redacted(_:)` 去掉 query/fragment/userinfo，令牌不可能进日志。
//

import Foundation

enum WebAddress {
    /// 默认地址：上海调度中心的**带 TLS 入口**。
    ///
    /// 为什么是这台主机而不是域名：`http://203.0.113.20:18080/go` 这条公开入口 302 到
    /// `https://203.0.113.20:18443/?token=…`，也就是说这条入口的令牌正是在 18443 上换 cookie 的
    /// （实测 2026-09-16：`/go` → 302 `https://203.0.113.20:18443/?token=…`；裸访问返回 401）。
    /// 域名 `qianshousuanli.com` 只服务官网与下载，18443 这条工作台入口只有 IP 证书（SAN 里是 IP），
    /// 所以默认地址只能是 IP+端口。手机网页版在同源的 `/mobile/` 下。
    static let fallback = "https://203.0.113.20:18443/"

    /// 地址长度上限：扫码结果可能是一整段文本，超长串直接判为「不是地址」。
    static let maxLength = 2048

    /// 判定结果。返回原因而不是只返回 nil，是为了让地址栏能给出**可操作**的中文提示：
    /// 「公网地址必须用 https」和「这不是网址」是两种不同的错误，混成一条会让人不知道该改什么。
    ///
    /// 之所以实现 `CustomStringConvertible`：判定结果会被写进诊断日志，
    /// 而 `address` 分支里装着一个可能是 `?token=…` 的 URL——默认的反射输出会把令牌原样打出来。
    /// 统一走脱敏描述，这条日志路径就不再可能泄露令牌。
    enum Evaluation: Equatable, CustomStringConvertible {
        case address(URL)
        /// 空串或全空白。
        case empty
        case tooLong
        /// 写了 scheme，但不属于本壳能渲染的 http/https。
        case unsupportedScheme(String)
        /// 公网主机写了 `http://`：明文过公网，拒绝。
        case insecurePublicHost(String)
        /// 不像地址：没写 scheme 且不是 ASCII 主机、没有主机名、语法不成立。
        case notAnAddress

        var description: String {
            switch self {
            case .address(let url): return "address(\(WebAddress.redacted(url)))"
            case .empty: return "empty"
            case .tooLong: return "tooLong"
            case .unsupportedScheme(let scheme): return "unsupportedScheme(\(scheme))"
            case .insecurePublicHost(let host): return "insecurePublicHost(\(host))"
            case .notAnAddress: return "notAnAddress"
            }
        }
    }

    /// 规范化成可载入的地址；不是 http/https（或公网明文）就返回 nil。
    ///
    /// 只放行 http 与 https：
    /// - `file://` 会让本机文件被当成网页载入（网页随即能通过桥调用原生），必须拒绝；
    /// - 其它 scheme（`mailto:`、`tel:`、`javascript:`）不是本壳能渲染的内容，一律判为「不是地址」。
    static func normalize(_ raw: String) -> URL? {
        if case .address(let url) = evaluate(raw) { return url }
        return nil
    }

    /// 判定一条输入能变成什么地址。所有判定都收敛在这里，`normalize` 只是它的一个视图。
    static func evaluate(_ raw: String) -> Evaluation {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .empty }
        guard trimmed.count <= maxLength else { return .tooLong }

        let writingScheme = explicitScheme(of: trimmed)
        if let scheme = writingScheme, scheme != "http", scheme != "https" { return .unsupportedScheme(scheme) }

        let candidate: String
        if writingScheme != nil {
            candidate = trimmed
        } else {
            // 没写 scheme 时要求整串是 ASCII，再按主机性质补 scheme。
            //
            // 为什么卡 ASCII：`URL(string:)` 会把中文主机按 IDN 规则转成 punycode，
            // 于是「随便一段文字」也变成 `http://xn--4gq65bp0tbik8whr60e` 这样一个"合法"地址，
            // 「不是网址就不载入」的承诺就失效了。用户若真要访问中文域名，会把 scheme 一起写出来。
            guard trimmed.allSatisfy({ $0.isASCII }) else { return .notAnAddress }
            // 公网主机补 https：绝不替用户把一个公网地址降级成明文。内网/本机补 http——
            // 局域网设备一般没有受信任证书，而这条路径本来也只对 RFC1918/loopback/内网名放行。
            candidate = (hostLooksLocal(hostOfBareInput: trimmed) ? "http://" : "https://") + trimmed
        }

        guard let url = URL(string: candidate),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host,
              isValidHost(host)
        else { return .notAnAddress }

        if scheme == "http", !isLocalHost(host) { return .insecurePublicHost(host) }
        return .address(url)
    }

    /// 给用户看的中文说明；`.address` 没有失败文案。
    static func failureMessage(for evaluation: Evaluation) -> String? {
        switch evaluation {
        case .address:
            return nil
        case .empty:
            return "地址不能为空：请输入网页地址，例如 https://example.com/"
        case .tooLong:
            return "地址过长（超过 \(maxLength) 个字符），请检查是不是把一整段文字当成了网址。"
        case .unsupportedScheme(let scheme):
            return "不支持的地址类型“\(scheme):”：本应用只打开 http:// 与 https:// 开头的网页地址。"
        case .insecurePublicHost(let host):
            return "“\(host)”是公网地址，必须用 https:// 打开；明文 http:// 只允许本机与局域网地址（如 192.168.x.x、localhost）。"
        case .notAnAddress:
            return "地址无效：请输入 https:// 开头的地址，例如 https://example.com/（局域网设备可写 http://192.168.x.x:端口）。"
        }
    }

    // MARK: - 明文地址策略

    /// `http://` 是否只指向本机或局域网。这是「公网不许明文」的唯一判据。
    static func isLocalHost(_ host: String) -> Bool {
        let name = normalizeHost(host)
        guard !name.isEmpty else { return false }
        if name == "localhost" || name.hasSuffix(".localhost") { return true }
        // mDNS 局域网名（mac-mini.local）——证书体系里几乎不会为它签公网证书。
        if name.hasSuffix(".local") { return true }
        if let ipv4 = ipv4Octets(name) { return isPrivateIPv4(ipv4) }
        if isPrivateIPv6(name) { return true }
        // 单标签主机名（`qianshou-server`、`nas`）：只在局域网里有意义，公网 DNS 解析不了。
        // 含冒号的一律先当 IPv6 对待（`2001:db8::1` 是公网地址，绝不能落进这条兜底）。
        return !name.contains(".") && !name.contains(":")
    }

    /// 去掉 IPv6 的方括号与 zone id，并统一小写。
    private static func normalizeHost(_ host: String) -> String {
        var name = host.lowercased()
        if name.hasPrefix("["), name.hasSuffix("]") { name = String(name.dropFirst().dropLast()) }
        if let zone = name.firstIndex(of: "%") { name = String(name[name.startIndex..<zone]) }
        return name
    }

    private static func ipv4Octets(_ name: String) -> [Int]? {
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.count <= 3, part.allSatisfy({ $0.isASCII && $0.isNumber }), let value = Int(part), value <= 255 else { return nil }
            octets.append(value)
        }
        return octets
    }

    /// RFC1918 私网、loopback（127/8）、链路本地（169.254/16）。其余按公网处理。
    private static func isPrivateIPv4(_ octets: [Int]) -> Bool {
        switch (octets[0], octets[1]) {
        case (10, _), (127, _), (169, 254): return true
        case (172, 16...31), (192, 168): return true
        default: return false
        }
    }

    /// IPv6 的 loopback（::1）、链路本地（fe80::/10）、唯一本地（fc00::/7）与 IPv4 映射地址。
    private static func isPrivateIPv6(_ name: String) -> Bool {
        guard name.contains(":") else { return false }
        if name == "::1" { return true }
        if let mapped = name.components(separatedBy: ":").last, let octets = ipv4Octets(mapped), isPrivateIPv4(octets) { return true }
        let first = name.components(separatedBy: ":").first ?? ""
        if first.hasPrefix("fe8") || first.hasPrefix("fe9") || first.hasPrefix("fea") || first.hasPrefix("feb") { return true }
        if first.hasPrefix("fc") || first.hasPrefix("fd") { return true }
        return false
    }

    /// 没写 scheme 的输入：只看主机部分判断该补 http 还是 https。
    private static func hostLooksLocal(hostOfBareInput value: String) -> Bool {
        var host = value
        if let slash = host.firstIndex(of: "/") { host = String(host[host.startIndex..<slash]) }
        if let query = host.firstIndex(where: { $0 == "?" || $0 == "#" }) { host = String(host[host.startIndex..<query]) }
        if let at = host.lastIndex(of: "@") { host = String(host[host.index(after: at)...]) }
        if host.hasPrefix("["), let end = host.firstIndex(of: "]") { host = String(host[host.index(after: host.startIndex)..<end]) }
        else if let colon = host.lastIndex(of: ":"), host[host.index(after: colon)...].allSatisfy({ $0.isNumber }) { host = String(host[host.startIndex..<colon]) }
        return isLocalHost(host)
    }

    /// 识别「写出来的 scheme」，并与 `主机:端口` 区分开。
    ///
    /// 为什么不能只判断有没有 `://`：`mailto:a@b.com` 会被补成 `http://mailto:a@b.com`，
    /// 那是一个语法上合法的 URL（用户信息+主机），于是真的会向 b.com 发请求——
    /// 用户扫到邮箱地址却打开一个网站，是会被当成故障的行为。
    private static func explicitScheme(of value: String) -> String? {
        if let range = value.range(of: "://") {
            let prefix = value[value.startIndex..<range.lowerBound]
            return prefix.isEmpty ? nil : prefix.lowercased()
        }
        guard let colon = value.firstIndex(of: ":") else { return nil }
        let prefix = value[value.startIndex..<colon]
        let remainder = value[value.index(after: colon)...]
        guard !prefix.isEmpty, prefix.allSatisfy({ $0.isASCII && $0.isLetter }) else { return nil }
        // `localhost:4174`、`example:8080` 是主机加端口，不是 scheme。
        if !remainder.isEmpty, remainder.allSatisfy({ $0.isNumber }) { return nil }
        return prefix.lowercased()
    }

    /// 主机名必须是非空 ASCII。
    /// 为什么卡这一条：二维码里最常见的是中文长句，`URL(string:)` 对
    /// `http://随便一段文字` 这样的输入仍会给出非空 host，于是「是不是地址」的判断会失效，
    /// 扫码结果被当成网址直接发出去。中文域名应当以 punycode 形式出现，这里不放行。
    private static func isValidHost(_ host: String) -> Bool {
        guard !host.isEmpty else { return false }
        return host.allSatisfy { $0.isASCII && !$0.isWhitespace }
    }

    static func looksLikeAddress(_ raw: String) -> Bool {
        normalize(raw) != nil
    }

    // MARK: - 日志与展示脱敏

    /// 脱敏后的地址：去掉 query、fragment 与 userinfo。诊断日志与只读展示一律用这个函数。
    ///
    /// 为什么必须脱敏：入口地址形如 `https://host/?token=…`，原样记日志（设置页可看可复制、
    /// 截图会带走）等于把令牌泄露到屏幕与日志里。只去掉这三段，主机与路径仍然保留，
    /// 「打开了哪个站的哪个页面」依然可查——排查需要的正是这部分。
    static func redacted(_ url: URL?) -> String {
        guard let url else { return "nil" }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url.scheme ?? "?"
        }
        components.query = nil
        components.fragment = nil
        components.user = nil
        components.password = nil
        return components.url?.absoluteString ?? (url.scheme ?? "?")
    }

    /// 字符串形式的地址也要能脱敏：日志里出现的既有 `URL`，也有原始输入。
    /// 只有真能解析出 scheme 的字符串才按地址处理——否则「不是地址」的输入会被
    /// `URL(string:)` 当相对路径做百分号编码，日志里出现一串看不懂的转义。
    static func redacted(_ raw: String?) -> String {
        guard let raw, !raw.isEmpty else { return "nil" }
        guard let url = URL(string: raw), url.scheme != nil else { return raw }
        return redacted(url)
    }
}
