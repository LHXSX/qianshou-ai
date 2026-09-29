//
//  logic-checks.swift
//  纯逻辑断言（不需要模拟器，直接编译成 macOS 可执行文件跑）。
//
//  为什么单独有这一层：桥的白名单、JSON→JS 字符串字面量的转义、地址判定这三块
//  是「不可信输入进入原生」的边界，边界必须能被穷举断言；只靠「在模拟器里点一遍」
//  覆盖不到空串、超长串、非 ASCII 方法名、U+2028 这些真实会出问题的输入。
//
//  运行方式（在仓库根目录）：
//    swiftc -o /tmp/qianshou-logic-checks \
//      apps/qianshou-ios/QianshouIOS/Bridge/BridgeProtocol.swift \
//      apps/qianshou-ios/QianshouIOS/Bridge/BridgeOrigin.swift \
//      apps/qianshou-ios/QianshouIOS/App/AppInfo.swift \
//      apps/qianshou-ios/QianshouIOS/Browser/WebAddress.swift \
//      apps/qianshou-ios/QianshouIOS/Browser/BrowserErrorText.swift \
//      apps/qianshou-ios/tests/logic-checks.swift && /tmp/qianshou-logic-checks
//

import Foundation

@main
struct LogicChecks {
    static var checked = 0
    static var failures: [String] = []

    static func expect(_ condition: Bool, _ description: String) {
        checked += 1
        if condition {
            print("  ✓ \(description)")
        } else {
            failures.append(description)
            print("  ✗ \(description)")
        }
    }

    static func group(_ name: String) {
        print("\n[\(name)]")
    }

    static func main() {
        checkBridgeParsing()
        checkJavaScriptLiteral()
        checkReceiveScript()
        checkWebAddress()
        checkWebAddressPolicy()
        checkRedaction()
        checkBridgeOrigin()
        checkErrorText()
        checkAppInfoPayload()

        print("\n合计 \(checked) 项断言，失败 \(failures.count) 项")
        if !failures.isEmpty {
            for failure in failures { print("失败：\(failure)") }
            exit(1)
        }
        print("全部通过")
    }

    // MARK: - 桥的解析与白名单

    static func checkBridgeParsing() {
        group("桥：请求解析与白名单")

        if case .request(let request) = BridgeProtocol.parse(body: ["id": "r1", "method": "getAppInfo"]) {
            expect(request.method == "getAppInfo" && request.id == "r1", "白名单方法 getAppInfo 带 id 被接受")
        } else {
            expect(false, "白名单方法 getAppInfo 带 id 被接受")
        }

        if case .request(let request) = BridgeProtocol.parse(body: ["method": "getAppInfo"]) {
            expect(request.id == nil, "缺省 id 的请求被接受且 id 为 nil")
        } else {
            expect(false, "缺省 id 的请求被接受且 id 为 nil")
        }

        if case .rejection(let rejection, let id) = BridgeProtocol.parse(body: ["id": "r2", "method": "deleteEverything"]) {
            expect(rejection.code == "unknown-method" && id == "r2", "未知方法被拒绝且回执保留 id（拒绝理由=\(rejection.detail)）")
        } else {
            expect(false, "未知方法被拒绝且回执保留 id")
        }

        if case .rejection(let rejection, _) = BridgeProtocol.parse(body: ["id": "r3", "method": "getAppInfo;evil()"]) {
            expect(rejection.code == "malformed-request", "方法名里的分号被当作畸形请求拒绝")
        } else {
            expect(false, "方法名里的分号被当作畸形请求拒绝")
        }

        if case .rejection(let rejection, _) = BridgeProtocol.parse(body: ["method": "取应用信息"]) {
            expect(rejection.code == "malformed-request", "非 ASCII 方法名被拒绝")
        } else {
            expect(false, "非 ASCII 方法名被拒绝")
        }

        if case .rejection(let rejection, _) = BridgeProtocol.parse(body: ["method": "get app info"]) {
            expect(rejection.code == "malformed-request", "含空格的方法名被拒绝")
        } else {
            expect(false, "含空格的方法名被拒绝")
        }

        if case .rejection(let rejection, _) = BridgeProtocol.parse(body: ["method": ""]) {
            expect(rejection.code == "malformed-request", "空方法名被拒绝")
        } else {
            expect(false, "空方法名被拒绝")
        }

        if case .rejection(let rejection, _) = BridgeProtocol.parse(body: "getAppInfo") {
            expect(rejection.code == "malformed-request", "非对象请求体（字符串）被拒绝")
        } else {
            expect(false, "非对象请求体（字符串）被拒绝")
        }

        if case .rejection(let rejection, _) = BridgeProtocol.parse(body: ["method": 42]) {
            expect(rejection.code == "malformed-request", "method 不是字符串时被拒绝")
        } else {
            expect(false, "method 不是字符串时被拒绝")
        }

        if case .rejection(let rejection, _) = BridgeProtocol.parse(body: ["id": 7, "method": "getAppInfo"]) {
            expect(rejection.code == "malformed-request", "id 不是字符串时被拒绝")
        } else {
            expect(false, "id 不是字符串时被拒绝")
        }

        let oversize: [String: Any] = [
            "id": "r9",
            "method": "getAppInfo",
            "params": ["junk": String(repeating: "x", count: BridgeProtocol.maxBodyBytes + 1)],
        ]
        if case .rejection(let rejection, _) = BridgeProtocol.parse(body: oversize) {
            expect(rejection.code == "request-too-large", "超过 \(BridgeProtocol.maxBodyBytes) 字节的请求被拒绝")
        } else {
            expect(false, "超大请求被拒绝")
        }

        expect(BridgeProtocol.allowedMethods == ["getAppInfo"], "白名单当前只有 getAppInfo（新增方法必须同步改网页与自检）")
    }

    // MARK: - JS 字符串字面量转义

    static func checkJavaScriptLiteral() {
        group("桥：JS 字符串字面量转义")

        let payloads: [(String, String)] = [
            ("双引号", "say \"hello\""),
            ("反斜杠", "C:\\path\\to\\file"),
            ("换行与制表", "line1\nline2\ttab"),
            ("回车", "carriage\rreturn"),
            ("U+2028/U+2029", "before\u{2028}middle\u{2029}after"),
            ("控制字符", "bell\u{07}backspace\u{08}"),
            ("HTML 尖括号", "<script>alert(1)</script>&"),
            ("逃逸尝试", "\"]});window.__pwned=true;//"),
            ("emoji 与中文", "千手🤖智能体"),
        ]

        for (name, value) in payloads {
            let literal = JavaScriptLiteral.string(value)
            // 1) 必须是合法 JSON 字符串（JSON 字符串是 JS 字符串字面量的子集）
            let data = Data(literal.utf8)
            let decoded = (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) as? String
            expect(decoded == value, "\(name)：编码后仍是合法 JSON 字符串且内容不变")

            // 2) 危险字符必须被转义，不能原样出现
            expect(!literal.contains("\n") && !literal.contains("\r") && !literal.contains("\t"), "\(name)：不含裸换行/制表符")
            expect(!literal.contains("\u{2028}") && !literal.contains("\u{2029}"), "\(name)：U+2028/U+2029 已转义")
            expect(!literal.contains("<") && !literal.contains(">"), "\(name)：尖括号已转义")
            if value.contains("\"") {
                expect(literal.contains("\\\""), "\(name)：双引号已转义")
            }
        }
    }

    // MARK: - 出站脚本的拼接点

    static func checkReceiveScript() {
        group("桥：出站脚本只把字面量放在参数位置")

        let hostile = "\"]});window.__pwned=true;//"
        let json = "{\"kind\":\"event\",\"payload\":{\"text\":\"\(hostile)\"}}"
        let literal = JavaScriptLiteral.string(json)
        let script = BridgeProtocol.receiveScript(jsonLiteral: literal)

        expect(script.contains("bridge.receive("), "脚本调用 bridge.receive(...)")
        expect(script.contains(literal), "拼进脚本的正是 JavaScriptLiteral 的输出（唯一拼接点）")
        expect(script.hasPrefix("(function ()"), "脚本是自执行函数，避免污染返回值的语义")

        // 最强的一条：把字面量单独拿去按 JSON 解析，必须且只能得到一个字符串，内容与原文逐字符相同。
        // 只要有一个字节没转义（引号、反斜杠、U+2028），payload 就会“逃出”字符串，这条断言必然失败。
        let decoded = (try? JSONSerialization.jsonObject(with: Data(literal.utf8), options: [.fragmentsAllowed])) as? String
        expect(decoded == json, "字面量解析回来只有一个字符串且内容完全一致（说明正文无法逃出字符串）")

        // 参数位置检查：`receive(` 之后紧跟一个字面量，且它的第一个字符是引号。
        let afterCall = script.components(separatedBy: "bridge.receive(")[1]
        expect(afterCall.hasPrefix("\""), "参数位置紧跟一个字符串字面量，正文不是可执行代码")
    }

    // MARK: - 地址判定

    static func checkWebAddress() {
        group("地址规范化")

        expect(WebAddress.normalize(WebAddress.fallback)?.absoluteString == WebAddress.fallback, "默认地址可解析")
        expect(WebAddress.fallback.hasPrefix("https://"), "默认地址是 https（明文入口会让 ?token= 过公网）")
        expect(WebAddress.normalize("203.0.113.20:18090")?.absoluteString == "https://203.0.113.20:18090", "只写公网主机与端口时补 https://（绝不替用户降级成明文）")
        expect(WebAddress.normalize("  https://example.com/x  ")?.absoluteString == "https://example.com/x", "两侧空白被裁剪")
        expect(WebAddress.normalize("file:///etc/passwd") == nil, "file:// 被拒绝（否则本机文件会被当成网页载入）")
        expect(WebAddress.normalize("javascript:alert(1)") == nil, "javascript: 被拒绝")
        expect(WebAddress.normalize("mailto:a@b.com") == nil, "mailto: 被拒绝（本轮不处理外部 scheme）")
        expect(WebAddress.normalize("WIFI:S:test;T:WPA;;") == nil, "二维码里常见的纯文本被判定为不是地址")
        expect(WebAddress.normalize("") == nil, "空串被拒绝")
        expect(WebAddress.normalize("   ") == nil, "全空白被拒绝")
        expect(WebAddress.normalize("http://") == nil, "没有主机名的 http:// 被拒绝")
        expect(WebAddress.normalize("http://" + String(repeating: "a", count: WebAddress.maxLength)) == nil, "超长地址被拒绝")
        expect(WebAddress.looksLikeAddress("https://example.com/") && !WebAddress.looksLikeAddress("随便一段文字"), "looksLikeAddress 与 normalize 一致")
        expect(WebAddress.normalize("随便一段文字") == nil, "没写 scheme 的非 ASCII 文本不算地址（中文不等于网址）")
        expect(WebAddress.normalize("http://中文域名.中国") == nil, "写明 http:// 的公网主机一律拒绝（中文域名也走同一条策略）")
        expect(WebAddress.normalize("https://中文域名.中国") != nil, "写明 https:// 的中文域名仍被接受（走 IDN 转换）")
        expect(WebAddress.normalize("qianshou-server:4174") != nil, "单标签内网主机名+端口被接受")
        expect(WebAddress.normalize("localhost:4174") != nil, "localhost:端口 被接受（不被误判成 scheme）")
        expect(WebAddress.normalize("tel:+8613800000000") == nil, "tel: 被拒绝（不当成网址载入）")
    }

    // MARK: - 明文地址策略（公网 http 一律拒绝）

    static func checkWebAddressPolicy() {
        group("明文地址策略：http 只对本机与局域网放行")

        // 明确写了 http:// 的公网主机：拒绝，并给出「必须用 https」的原因。
        let publicCases = [
            "http://203.0.113.20:18090/",
            "http://203.0.113.20:18443/",
            "http://8.8.8.8/",
            "http://example.com/",
            "http://www.example.com:8080/x",
            "http://qianshousuanli.com/",
            "http://[2001:db8::1]:8080/",
        ]
        for raw in publicCases {
            expect(WebAddress.normalize(raw) == nil, "公网明文被拒绝：\(raw)")
        }
        if case .insecurePublicHost(let host) = WebAddress.evaluate("http://203.0.113.20:18090/") {
            expect(host == "203.0.113.20", "拒绝原因带着主机名，便于给出可操作提示（\(host)）")
        } else {
            expect(false, "公网明文被判为 insecurePublicHost")
        }
        expect(WebAddress.failureMessage(for: .insecurePublicHost("example.com"))?.contains("https") == true,
               "公网明文的提示文案要求改用 https")

        // 本机与局域网：明文仍然放行（局域网设备一般没有受信任证书）。
        let localCases = [
            "http://127.0.0.1:8099/",
            "http://localhost:4174/",
            "http://192.168.1.20:3080/mobile/",
            "http://10.0.0.5/",
            "http://172.16.0.1/",
            "http://172.31.255.254/",
            "http://169.254.10.10/",
            "http://[::1]:8099/",
            "http://[fe80::1]:8099/",
            "http://[fd00::1]:8099/",
            "http://mac-mini.local:3080/",
            "http://qianshou-server:4174/",
        ]
        for raw in localCases {
            expect(WebAddress.normalize(raw) != nil, "本机/局域网明文放行：\(raw)")
        }
        // 相邻但不在私网段里的地址必须仍然被拒：172.32 与 11.x 都不是 RFC1918。
        for raw in ["http://172.32.0.1/", "http://11.0.0.1/", "http://192.169.1.1/", "http://126.0.0.1/"] {
            expect(WebAddress.normalize(raw) == nil, "私网段之外的近似地址仍被拒：\(raw)")
        }

        // https 不受影响。
        expect(WebAddress.normalize("https://203.0.113.20:18443/")?.absoluteString == "https://203.0.113.20:18443/",
               "https 公网地址照常放行")
        expect(WebAddress.normalize("https://example.com/a?b=1#c")?.absoluteString == "https://example.com/a?b=1#c",
               "https 地址的路径与查询串不被改动")

        // 失败原因分类：不同错误给不同文案，地址栏才能说清该改什么。
        expect(WebAddress.evaluate("") == .empty, "空串 → empty")
        expect(WebAddress.evaluate("   ") == .empty, "全空白 → empty")
        expect(WebAddress.evaluate("file:///etc/passwd") == .unsupportedScheme("file"), "file: → unsupportedScheme")
        expect(WebAddress.evaluate("mailto:a@b.com") == .unsupportedScheme("mailto"), "mailto: → unsupportedScheme")
        expect(WebAddress.evaluate("随便一段文字") == .notAnAddress, "非 ASCII 文本 → notAnAddress")
        expect(WebAddress.evaluate("http://") == .notAnAddress, "没有主机名 → notAnAddress")
        expect(WebAddress.evaluate(String(repeating: "a", count: WebAddress.maxLength + 1)) == .tooLong, "超长 → tooLong")
        for evaluation in [WebAddress.Evaluation.empty, .tooLong, .unsupportedScheme("file"), .notAnAddress, .insecurePublicHost("example.com")] {
            expect(WebAddress.failureMessage(for: evaluation)?.isEmpty == false, "每种失败都有中文文案：\(evaluation)")
        }
        expect(WebAddress.failureMessage(for: .address(URL(string: "https://example.com/")!)) == nil, "成功判定没有失败文案")
    }

    // MARK: - 日志脱敏

    static func checkRedaction() {
        group("日志脱敏：令牌不可能进日志")

        let entry = URL(string: "https://203.0.113.20:18443/?token=secret-value-123")!
        let redacted = WebAddress.redacted(entry)
        expect(redacted == "https://203.0.113.20:18443/", "入口地址的 ?token= 被去掉（\(redacted)）")
        expect(!redacted.contains("token"), "脱敏结果里不含 token 字样")
        expect(!redacted.contains("secret-value-123"), "脱敏结果里没有令牌值")

        let withFragment = URL(string: "https://example.com/a/b?x=1#qianshou-pair:abc")!
        expect(WebAddress.redacted(withFragment) == "https://example.com/a/b", "fragment（可能是配对票据）被去掉")

        let withUser = URL(string: "https://user:pass@example.com/private")!
        expect(WebAddress.redacted(withUser) == "https://example.com/private", "userinfo 被去掉")

        expect(WebAddress.redacted(URL(string: "https://example.com/a/b")!) == "https://example.com/a/b", "没有 query 的地址原样保留")
        expect(WebAddress.redacted(nil as URL?) == "nil", "nil 显示为 nil 而不是崩溃")
        expect(WebAddress.redacted("https://h/?token=abc" as String?) == "https://h/", "字符串输入同样脱敏")
        expect(WebAddress.redacted("不是地址" as String?) == "不是地址", "不是地址的字符串原样返回（不丢信息也不崩）")
        expect(WebAddress.redacted(nil as String?) == "nil", "空字符串显示为 nil")

        // 判定结果本身也会进日志：它的描述必须已经脱敏（否则日志里会冒出 address(https://…?token=…)）。
        let described = "\(WebAddress.evaluate("https://h.example/?token=secret-value-123"))"
        expect(described == "address(https://h.example/)", "判定结果的描述已脱敏（\(described)）")
        expect(described.contains("secret-value-123") == false, "判定结果的描述里没有令牌值")
    }

    // MARK: - 桥的 origin 绑定

    static func checkBridgeOrigin() {
        group("桥的 origin 绑定")

        func origin(_ raw: String) -> BridgeOrigin? { BridgeOrigin(url: URL(string: raw)) }

        expect(origin("https://example.com/a")?.description == "https://example.com:443", "https 补默认端口 443")
        expect(origin("http://example.com/a")?.description == "http://example.com:80", "http 补默认端口 80")
        expect(origin("https://example.com:443/")?.description == "https://example.com:443", "显式 443 与默认端口是同一个 origin")
        expect(origin("https://EXAMPLE.com/")?.description == "https://example.com:443", "主机名大小写不敏感")
        expect(origin("https://example.com/a?token=1#x")?.description == "https://example.com:443", "路径/查询/片段不参与 origin")
        expect(origin("https://example.com/a") != origin("https://example.com:8443/a"), "端口不同即不同 origin")
        expect(origin("https://example.com/") != origin("https://sub.example.com/"), "子域是不同 origin")
        expect(origin("https://example.com/") != origin("http://example.com/"), "scheme 不同即不同 origin")
        expect(origin("file:///etc/passwd") == nil, "非 http/https 没有 origin")
        expect(origin("about:blank") == nil, "about:blank 没有 origin")
        expect(origin("https://[::1]:8099/")?.description == "https://[::1]:8099", "IPv6 主机带端口可解析")

        let allowlist = BridgeOriginAllowlist()
        expect(allowlist.allows(URL(string: "https://example.com/")) == false, "空白名单不放行任何地址")
        expect(allowlist.allows(nil) == false, "没有地址时不放行")
        allowlist.allow(URL(string: "https://example.com/?token=abc"))
        expect(allowlist.allows(URL(string: "https://example.com/other/page")) == true, "登记后同 origin 的任意路径都放行")
        expect(allowlist.allows(URL(string: "https://example.com:8443/")) == false, "同主机不同端口不放行")
        expect(allowlist.allows(URL(string: "https://evil.example/")) == false, "第三方 origin 不放行")
        expect(allowlist.summary.contains("token") == false, "白名单摘要只含 origin，不含查询串")

        // 后退回到用户更早打开的站点仍然可信；容量上限之外的旧 origin 被淘汰。
        let bounded = BridgeOriginAllowlist()
        for index in 0..<BridgeOriginAllowlist.capacity { bounded.allow(URL(string: "https://host\(index).example/")) }
        expect(bounded.allows(URL(string: "https://host0.example/")) == true, "容量内最早的 origin 仍在")
        bounded.allow(URL(string: "https://newcomer.example/"))
        expect(bounded.allows(URL(string: "https://host0.example/")) == false, "超出容量后最早的 origin 被淘汰")
        expect(bounded.allows(URL(string: "https://newcomer.example/")) == true, "最新登记的 origin 一定在")
    }

    // MARK: - 失败文案

    static func checkErrorText() {
        group("加载失败的中文文案")

        let cancelled = NSError(domain: "WebKitErrorDomain", code: BrowserErrorText.cancelledCode)
        expect(BrowserErrorText.message(for: cancelled) == nil, "被策略取消的导航不弹错误（避免误报）")

        let refused = NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        expect(BrowserErrorText.message(for: refused)?.contains("连不上") == true, "连不上主机给出中文说明")

        let timeout = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
        expect(BrowserErrorText.message(for: timeout)?.contains("超时") == true, "超时给出中文说明")

        let ats = NSError(domain: NSURLErrorDomain, code: NSURLErrorAppTransportSecurityRequiresSecureConnection)
        expect(BrowserErrorText.message(for: ats)?.contains("明文 HTTP") == true, "ATS 拦截给出可操作的中文说明")

        let ourOwn = NSError(domain: BrowserErrorText.applicationDomain, code: -2, userInfo: [NSLocalizedDescriptionKey: "页面没有真正打开"])
        expect(BrowserErrorText.message(for: ourOwn) == "页面没有真正打开", "本应用构造的错误直接用其中文文案")

        let unknown = NSError(domain: "SomeDomain", code: 5)
        expect(BrowserErrorText.message(for: unknown)?.contains("SomeDomain") == true, "未知错误保留 domain/code 以便排查")
    }

    // MARK: - getAppInfo 返回值

    static func checkAppInfoPayload() {
        group("getAppInfo 返回值")

        let payload = AppInfo.bridgePayload(webViewAvailable: true)
        expect(payload["platform"] as? String == "ios", "platform 固定为 ios")
        expect(payload["webViewAvailable"] as? Bool == true, "webViewAvailable 随真实状态传入")
        expect(AppInfo.bridgePayload(webViewAvailable: false)["webViewAvailable"] as? Bool == false, "WebView 不可用时如实返回 false")
        // 命令行环境下 Bundle.main 没有应用 Info.plist，此时必须退化为 unknown 而不是崩溃或空串。
        expect((payload["version"] as? String)?.isEmpty == false, "version 字段存在且非空（无 bundle 时为 unknown）")
        expect(payload.count == 3, "getAppInfo 只返回约定的三个字段")
    }
}
