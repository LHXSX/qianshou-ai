//
//  BridgeUserScript.swift
//  注入给网页的原生桥脚本（document start 注入，早于网页自己的脚本）。
//
//  为什么由宿主注入而不是改网页：本轮约定不动 `apps/qianshou-mobile/`（别人正在并行开发），
//  所以「网页怎么调桥」这份契约由宿主提供：`window.qianshouBridge`。
//  网页仍然可以直接用 `window.webkit.messageHandlers.qianshou.postMessage({...})`（原始通道），
//  只是那种写法拿不到「按 id 回执」，回执会以事件形式送到 `onEvent` 订阅者手里。
//
//  为什么幂等并让位：同一个页面可能因为前进/后退或 SPA 重载被注入多次；
//  如果网页自己已经定义了同名对象，我们直接让位，不覆盖别人的实现。
//

import Foundation
import WebKit

enum BridgeUserScript {
    static let source = #"""
    (function () {
      'use strict';
      var existing = window.qianshouBridge;
      if (existing && existing.__hostShim) { return; }
      if (existing) { return; }

      var REQUEST_TIMEOUT_MS = 5000;
      var MAX_EVENTS = 20;
      var pending = Object.create(null);
      var listeners = [];
      var events = [];
      var sequence = 0;

      function post(message) {
        try {
          window.webkit.messageHandlers.qianshou.postMessage(message);
          return true;
        } catch (error) {
          return false;
        }
      }

      // 原生 → 网页的唯一入口：原生用 evaluateJavaScript 调它，参数永远是「一个 JSON 字符串」。
      function receive(payload) {
        if (typeof payload === 'string') {
          try { payload = JSON.parse(payload); } catch (error) { return false; }
        }
        if (!payload || typeof payload !== 'object') { return false; }
        if (payload.kind === 'reply' && typeof payload.id === 'string' && pending[payload.id]) {
          var entry = pending[payload.id];
          delete pending[payload.id];
          if (payload.ok) { entry.resolve(payload.result); } else { entry.reject(new Error(payload.error || 'native-error')); }
          return true;
        }
        events.push(payload);
        if (events.length > MAX_EVENTS) { events.shift(); }
        for (var index = 0; index < listeners.length; index += 1) {
          try { listeners[index](payload); } catch (error) { /* 订阅者自己的异常不能影响其它订阅者 */ }
        }
        return true;
      }

      // 网页 → 原生：返回 Promise，原生回执按 id 配对。
      function request(method, params) {
        return new Promise(function (resolve, reject) {
          sequence += 1;
          var id = 'r' + sequence;
          pending[id] = { resolve: resolve, reject: reject };
          if (!post({ id: id, method: method, params: params || {} })) {
            delete pending[id];
            reject(new Error('bridge-unavailable'));
            return;
          }
          setTimeout(function () {
            if (pending[id]) { delete pending[id]; reject(new Error('bridge-timeout')); }
          }, REQUEST_TIMEOUT_MS);
        });
      }

      function onEvent(listener) {
        if (typeof listener !== 'function') { return function () {}; }
        listeners.push(listener);
        return function () {
          var index = listeners.indexOf(listener);
          if (index >= 0) { listeners.splice(index, 1); }
        };
      }

      window.qianshouBridge = {
        __hostShim: true,
        platform: 'ios',
        request: request,
        receive: receive,
        onEvent: onEvent,
        events: function () { return events.slice(); }
      };
    })();
    """#

    /// 只在主框架注入：第三方 iframe 不该拿到桥，原生侧另外还会拒绝非主框架的消息。
    static func makeUserScript() -> WKUserScript {
        WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }
}
