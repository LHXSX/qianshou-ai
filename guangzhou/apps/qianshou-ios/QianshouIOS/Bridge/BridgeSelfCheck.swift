//
//  BridgeSelfCheck.swift
//  桥的端到端自检。
//
//  为什么要有它：桥的两端（网页 JS 与原生 Swift）都无法靠单侧测试证明对方的行为。
//  只有在真实 WKWebView 里跑一遍，才能证明这四件事：
//  1. 注入脚本真的就位（`window.qianshouBridge` 存在）；
//  2. 网页 → 原生 → 网页 的往返真的通（getAppInfo 拿到真实版本号）；
//  3. 未知方法真的被白名单拒绝（不是「应该会拒绝」）；
//  4. 反向推送里带引号/换行的注入探针，真的只当数据（`window.__qianshouPwned` 保持 false）。
//
//  触发方式：`-QianshouBridgeSelfCheck YES` 启动（网页加载完成后自动跑），
//  或在「设置 → 运行桥自检」手动跑。结果同时进诊断日志与界面。
//

import Foundation
import WebKit

@MainActor
enum BridgeSelfCheck {
    struct Step: Identifiable {
        let id: Int
        let name: String
        let passed: Bool
        let detail: String

        var line: String { "\(passed ? "通过" : "失败") — \(name)：\(detail)" }
    }

    /// 注入探针。刻意包含 `"`、`}`、`;` 与 U+2028：
    /// 如果出站消息的拼接有任何一处漏转义，`window.__qianshouPwned` 就会被置为 true。
    static let injectionProbe = "探针\"]});window.__qianshouPwned=true;//" + "\u{2028}" + "尾"

    static func run(webView: WKWebView, bridge: BridgeRuntime, expectedVersion: String, log: DiagnosticsLog) async -> [Step] {
        var steps: [Step] = []

        // 1. 注入脚本就位
        steps.append(await step(index: 1, name: "网页侧桥脚本就位") {
            let value = try await evaluate(
                "return (typeof window.qianshouBridge === 'object' && window.qianshouBridge !== null && typeof window.qianshouBridge.request === 'function') ? 'ready' : 'missing'",
                in: webView)
            let text = value as? String ?? "nil"
            return (text == "ready", "window.qianshouBridge=\(text)")
        })

        // 2. 往返：getAppInfo 必须回真实版本号
        steps.append(await step(index: 2, name: "网页调用 getAppInfo 并拿到回执") {
            let value = try await evaluate(
                "const info = await window.qianshouBridge.request('getAppInfo'); return JSON.stringify(info);",
                in: webView)
            let text = value as? String ?? ""
            let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
            let platform = object?["platform"] as? String
            let version = object?["version"] as? String
            let available = object?["webViewAvailable"] as? Bool
            let passed = platform == "ios" && version == expectedVersion && available == true
            return (passed, "platform=\(platform ?? "nil") version=\(version ?? "nil") webViewAvailable=\(available.map(String.init) ?? "nil") 期望版本=\(expectedVersion)")
        })

        // 3. 未知方法必须被拒绝
        steps.append(await step(index: 3, name: "未知方法被白名单拒绝") {
            let value = try await evaluate(
                "return await window.qianshouBridge.request('deleteEverything').then(function () { return 'accepted'; }, function (error) { return 'rejected:' + error.message; });",
                in: webView)
            let text = value as? String ?? "nil"
            return (text == "rejected:unknown-method", "网页收到 \(text)")
        })

        // 4. 注入探针：带引号/换行的字符串推给网页，只能当数据
        steps.append(await step(index: 4, name: "反向推送的注入探针只当数据") {
            _ = try await evaluate(
                "window.__qianshouPwned = false; window.__qianshouProbe = null; window.qianshouBridge.onEvent(function (payload) { window.__qianshouProbe = payload; }); return 'armed'",
                in: webView)
            bridge.pushScanResult(ScanOutcome(text: injectionProbe, source: .camera))
            // 出站消息经 evaluateJavaScript 异步送达，给它一个回合再读回结果。
            try? await Task.sleep(nanoseconds: 400_000_000)
            let value = try await evaluate(
                "return JSON.stringify({ pwned: window.__qianshouPwned === true, probe: window.__qianshouProbe });",
                in: webView)
            let text = value as? String ?? ""
            let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
            let pwned = object?["pwned"] as? Bool ?? true
            let probe = object?["probe"] as? [String: Any]
            let payload = probe?["payload"] as? [String: Any]
            let received = payload?["text"] as? String
            let passed = !pwned && received == injectionProbe
            return (passed, "被注入执行=\(pwned) 收到的正文与原文一致=\(received == injectionProbe) 收到长度=\(received?.count ?? -1)")
        })

        for step in steps {
            log.record("自检 \(step.id)/\(steps.count) \(step.line)")
        }
        let failed = steps.filter { !$0.passed }.count
        log.record("自检完成：\(steps.count - failed)/\(steps.count) 通过")
        return steps
    }

    /// `callAsyncJavaScript` 的脚本体被当作 async 函数体，必须用 `return` 产出结果。
    /// 为什么用它而不是 `evaluateJavaScript`：自检脚本里有 `await`，而生产代码里的反向调用
    /// 按本轮要求用 `evaluateJavaScript` + JSON 字符串字面量（见 BridgeRuntime.deliver）。
    private static func evaluate(_ body: String, in webView: WKWebView) async throws -> Any {
        // SDK 的 async 重载返回 `Any?`；这里显式收成 `Any`，避免调用方在
        // Optional 与 Any 之间反复解包（也消除了「implicitly coerced from Any?」的告警）。
        let result = try await webView.callAsyncJavaScript(body, arguments: [:], in: nil, contentWorld: .page)
        return result as Any
    }

    private static func step(index: Int, name: String, body: () async throws -> (Bool, String)) async -> Step {
        do {
            let (passed, detail) = try await body()
            return Step(id: index, name: name, passed: passed, detail: detail)
        } catch {
            return Step(id: index, name: name, passed: false, detail: "调用失败：\(error.localizedDescription)")
        }
    }
}
