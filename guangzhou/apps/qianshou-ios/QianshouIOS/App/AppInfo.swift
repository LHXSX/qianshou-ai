//
//  AppInfo.swift
//  应用元数据的唯一来源。
//
//  为什么所有版本号都从 Info.plist 读：硬编码的版本迟早和真实版本对不上，
//  而用户与网页看到的每一个字都必须是真的（手机网页版也踩过同样的坑，
//  那里把版本从 package.json 注入构建产物）。桥的 `getAppInfo` 与「设置」页
//  共用这里的取值，改一处即可全对。
//

import Foundation

enum AppInfo {
    /// 平台标识，与网页侧约定一致。
    static let platform = "ios"

    /// `CFBundleShortVersionString`，例如 `0.1.0`。
    static var version: String { string(for: "CFBundleShortVersionString") }

    /// `CFBundleVersion`，构建号。
    static var build: String { string(for: "CFBundleVersion") }

    static var displayName: String { string(for: "CFBundleDisplayName") }

    static var bundleIdentifier: String { Bundle.main.bundleIdentifier ?? "unknown" }

    /// 桥方法 `getAppInfo` 的返回值。
    /// 字段名是网页侧契约的一部分：改动必须同步改网页调用点与自检用例。
    static func bridgePayload(webViewAvailable: Bool) -> [String: Any] {
        [
            "platform": platform,
            "version": version,
            "webViewAvailable": webViewAvailable,
        ]
    }

    private static func string(for key: String) -> String {
        (Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? "unknown"
    }
}
