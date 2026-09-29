//
//  BridgeProtocol.swift
//  网页 ↔ 原生 最小桥的契约（纯 Foundation，不依赖 WebKit）。
//
//  为什么把契约单独拆出来：桥是唯一一个「不可信输入从网页进入原生」的入口，
//  它的白名单与编码规则必须能被脱离 WKWebView 直接断言（见 tests/logic-checks.swift），
//  否则只能靠「在模拟器里点一遍」，而那种验证覆盖不到边界。
//
//  安全纪律（三条，缺一不可）：
//  1. 方法名白名单：只有 `allowedMethods` 里的方法会被执行，未知方法一律拒绝并记录；
//  2. 体积上限：请求体来自网页，超过上限直接拒绝，避免内存被拖垮；
//  3. 反向调用只传 JSON 字符串：原生 → 网页的正文永远作为「一个字符串参数」传递，
//     拼进 JS 源码的唯一内容是 `JavaScriptLiteral.string(_:)` 的输出，它把引号、反斜杠、
//     控制字符与 U+2028/U+2029 全部转义，因此正文不可能变成代码（注入）。
//

import Foundation

enum BridgeProtocol {
    /// 与网页约定：`window.webkit.messageHandlers.qianshou.postMessage(...)`
    static let handlerName = "qianshou"

    /// 请求体上限 64 KiB。`getAppInfo` 只有几十字节，正常使用永远碰不到这个上限，
    /// 它拦的是「网页被注入后往桥里灌大对象」这一类行为。
    static let maxBodyBytes = 64 * 1024

    /// 出站消息上限 256 KiB，防止原生把超大对象推回网页。
    static let maxPayloadBytes = 256 * 1024

    /// 本轮白名单只有 `getAppInfo`。新增方法必须同时改这里与网页侧调用点，并补一条自检用例。
    static let allowedMethods: Set<String> = ["getAppInfo"]

    /// 方法名长度上限：白名单之外的名字根本不会执行，这个上限只是让日志里不会出现超长噪声。
    static let maxMethodLength = 64

    struct Request: Equatable {
        let id: String?
        let method: String
    }

    enum Rejection: Equatable {
        case malformed(reason: String)
        case unknownMethod(method: String)
        case tooLarge(bytes: Int)

        /// 稳定的英文机器码：网页侧按码判断，人看中文说明。
        var code: String {
            switch self {
            case .malformed: return "malformed-request"
            case .unknownMethod: return "unknown-method"
            case .tooLarge: return "request-too-large"
            }
        }

        /// 给人看的中文说明，进日志。
        var detail: String {
            switch self {
            case .malformed(let reason): return "请求格式不合法（\(reason)）"
            case .unknownMethod(let method): return "方法 \(method) 不在白名单内"
            case .tooLarge(let bytes): return "请求体 \(bytes) 字节，超过上限 \(maxBodyBytes)"
            }
        }
    }

    enum ParseOutcome: Equatable {
        case request(Request)
        case rejection(Rejection, id: String?)
    }

    /// 解析并校验一条来自网页的请求。顺序是「大小 → 形状 → 白名单」：
    /// 先挡体积，再确认字段类型，最后才看方法名是否允许。
    static func parse(body: Any) -> ParseOutcome {
        if let bytes = encodedSize(of: body), bytes > maxBodyBytes {
            return .rejection(.tooLarge(bytes: bytes), id: nil)
        }

        guard let dictionary = body as? [String: Any] else {
            return .rejection(.malformed(reason: "请求体必须是对象"), id: nil)
        }

        var identifier: String?
        if let rawIdentifier = dictionary["id"] {
            guard let value = rawIdentifier as? String, !value.isEmpty, value.count <= maxMethodLength else {
                return .rejection(.malformed(reason: "id 必须是不超过 \(maxMethodLength) 字符的非空字符串"), id: nil)
            }
            identifier = value
        }

        guard let method = dictionary["method"] as? String else {
            return .rejection(.malformed(reason: "缺少 method 字段"), id: identifier)
        }
        guard isWellFormedMethodName(method) else {
            return .rejection(.malformed(reason: "method 必须是不超过 \(maxMethodLength) 字符的 ASCII 标识符"), id: identifier)
        }
        guard allowedMethods.contains(method) else {
            return .rejection(.unknownMethod(method: method), id: identifier)
        }
        return .request(Request(id: identifier, method: method))
    }

    /// JSON 编码后的字节数；无法编码（理论上不会发生，WKScriptMessage 的 body 一定可编码）时返回 nil。
    static func encodedSize(of body: Any) -> Int? {
        guard JSONSerialization.isValidJSONObject(body) else { return nil }
        return try? JSONSerialization.data(withJSONObject: body, options: []).count
    }

    /// 失败回执。`id` 为空表示网页没给回执地址（原始 postMessage 用法），
    /// 此时这条消息会以事件形式落到网页的 `onEvent` 订阅者手里。
    static func failurePayload(id: String?, rejection: Rejection) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "reply",
            "ok": false,
            "error": rejection.code,
            "detail": rejection.detail,
        ]
        if let id { payload["id"] = id }
        return payload
    }

    /// 成功回执。
    static func successPayload(id: String?, result: [String: Any]) -> [String: Any] {
        var payload: [String: Any] = [
            "kind": "reply",
            "ok": true,
            "result": result,
        ]
        if let id { payload["id"] = id }
        return payload
    }

    /// 原生 → 网页的出站脚本。
    ///
    /// `jsonLiteral` 必须是 `JavaScriptLiteral.string(_:)` 的输出——它是本函数唯一的拼接点，
    /// 而且只出现在「参数位置」：正文是 `receive(...)` 的实参，永远不会被当成代码执行。
    /// 脚本本身返回一个字符串，便于调用方在 completion handler 里判断网页有没有装接收器。
    static func receiveScript(jsonLiteral: String) -> String {
        """
        (function () {
          var bridge = window.qianshouBridge;
          if (!bridge || typeof bridge.receive !== 'function') { return 'no-receiver'; }
          bridge.receive(\(jsonLiteral));
          return 'delivered';
        })()
        """
    }

    private static func isWellFormedMethodName(_ method: String) -> Bool {
        guard !method.isEmpty, method.count <= maxMethodLength else { return false }
        return method.allSatisfy { character in
            character.isASCII && (character.isLetter || character.isNumber || character == "_")
        }
    }
}

/// 把 Swift 字符串编码成 JavaScript 字符串字面量。
///
/// 为什么不用 `"\"" + value + "\""`：网页送来的内容里只要出现引号或反斜杠，
/// 就会闭合并逃出字符串、把数据变成代码。`JSONSerialization` 能处理大部分转义，
/// 但不会转义 U+2028/U+2029（这两个字符在旧版 JS 里等同换行，会直接截断代码），
/// 所以这里逐 Unicode scalar 自己编码，一个都不能漏。
enum JavaScriptLiteral {
    static func string(_ value: String) -> String {
        var output = "\""
        output.reserveCapacity(value.count + 2)
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": output += "\\\""
            case "\\": output += "\\\\"
            case "\n": output += "\\n"
            case "\r": output += "\\r"
            case "\t": output += "\\t"
            // U+2028 / U+2029：JSON 允许原样出现，JS 字符串字面量不允许。
            case "\u{2028}": output += "\\u2028"
            case "\u{2029}": output += "\\u2029"
            // `<`、`>`、`&` 在这里不是必需的，但转义它们不改变语义，
            // 且能保证这段字面量即使被贴进 HTML 也不会破坏结构（纵深防御）。
            case "<": output += "\\u003c"
            case ">": output += "\\u003e"
            case "&": output += "\\u0026"
            default:
                if scalar.value < 0x20 {
                    output += String(format: "\\u%04x", scalar.value)
                } else {
                    output.unicodeScalars.append(scalar)
                }
            }
        }
        return output + "\""
    }
}
