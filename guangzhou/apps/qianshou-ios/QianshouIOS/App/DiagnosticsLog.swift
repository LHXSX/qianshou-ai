//
//  DiagnosticsLog.swift
//  有界诊断日志。
//
//  为什么有界：桥的输入来自网页，任何一条都不该让日志无限增长（内存会被拖垮）。
//  为什么打标准输出：模拟器取证用 `xcrun simctl launch --console-pty` 抓的就是标准输出。
//  「跑过」的证据必须来自真实进程的输出，而不是我看代码觉得它能跑。
//

import Foundation
import Observation

@MainActor
@Observable
final class DiagnosticsLog {
    /// 上限 80 条：屏幕上一屏能看完，内存占用恒定。
    private static let capacity = 80

    private(set) var lines: [String] = []

    func record(_ line: String) {
        let stamped = "\(Self.formatter.string(from: Date())) \(line)"
        lines.append(stamped)
        if lines.count > Self.capacity {
            lines.removeFirst(lines.count - Self.capacity)
        }
        print("[千手] \(stamped)")
    }

    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        return formatter
    }()
}
