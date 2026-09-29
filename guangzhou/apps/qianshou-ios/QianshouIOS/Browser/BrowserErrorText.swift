//
//  BrowserErrorText.swift
//  把加载失败翻译成中文（纯 Foundation）。
//
//  为什么要自己写文案：`error.localizedDescription` 在中文系统里也常常是英文的 NSURLError 文案，
//  用户看不懂；而「白屏 + 一串英文错误码」正是这类壳应用最常见的失败形态。
//  这里把原因分成「网络连不上（可重试）」「地址写错了（要改地址）」「明文 HTTP 被 ATS 拦截」
//  三类，每一类都给一句人话。
//

import Foundation

enum BrowserErrorText {
    /// 应用自己构造的错误域（例如「落点不是目标页面」「内容进程被回收」）。
    static let applicationDomain = "QianshouWebViewDomain"

    /// WebKitErrorFrameLoadInterruptedByPolicyChange：被新导航或策略取消，不是需要展示的错误。
    static let cancelledCode = 102

    /// 返回 nil 表示这不是需要给用户看的错误（例如被新导航直接取代）。
    static func message(for error: Error) -> String? {
        let nsError = error as NSError

        if nsError.domain == "WebKitErrorDomain" && nsError.code == cancelledCode {
            return nil
        }

        // 本应用自己构造的错误（落点不一致、内容进程被回收等）：文案已经是中文，直接用。
        if nsError.domain == Self.applicationDomain {
            return nsError.localizedDescription
        }

        if nsError.domain == NSURLErrorDomain {
            switch nsError.code {
            case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed:
                return "连不上这个地址。请确认服务器已启动、地址与端口写对了；如果服务在电脑上，手机要连同一个局域网。"
            case NSURLErrorTimedOut:
                return "等待服务器响应超时。请确认网络通畅后重试。"
            case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost:
                return "网络不可用，请检查 Wi-Fi 或蜂窝网络后重试。"
            case NSURLErrorAppTransportSecurityRequiresSecureConnection:
                return "系统禁止了明文 HTTP 访问。请在「设置 → 通用 → 关于本机 → 证书信任设置」之外改用 https，或让开发者确认 Info.plist 里的 ATS 例外。"
            case NSURLErrorUnsupportedURL, NSURLErrorBadURL:
                return "这个地址格式不受支持。示例：http://203.0.113.20:18090/"
            default:
                break
            }
        }

        return "网页加载失败：\(nsError.localizedDescription)（\(nsError.domain) \(nsError.code)）"
    }
}
