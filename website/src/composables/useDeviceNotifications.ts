import { ref, computed, onUnmounted, watch, type Ref } from "vue";
import { auth } from "../services/api";
import { browserSession, type RequestLease } from "../services/browserSession";

interface DeviceNotice {
  key: string;
  message: string;
  time: string;
  read: boolean;
}
/** A socket belongs to one login generation, including when the same account logs in again. */
export function useDeviceNotifications(accountId: Ref<string | undefined>) {
  const notices = ref<DeviceNotice[]>([]);
  const connected = ref(false);
  const unread = computed(() => notices.value.filter((x) => !x.read).length);
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let failures = 0;
  let disposed = false;
  let connecting = false;
  let bound: RequestLease | null = null;
  let rejectedToken: string | null = null;

  function currentLease(): RequestLease | null {
    try {
      return browserSession.capture();
    } catch {
      return null;
    }
  }
  function sameLogin(a: RequestLease | null, b: RequestLease | null) {
    return (
      !!a &&
      !!b &&
      a.scope === b.scope &&
      a.generation === b.generation &&
      a.accountId === b.accountId
    );
  }
  function valid(lease: RequestLease, version: number) {
    if (
      disposed ||
      generation !== version ||
      accountId.value !== lease.accountId ||
      !sameLogin(bound, lease)
    )
      return false;
    try {
      return browserSession.isCurrent(lease);
    } catch {
      return false;
    }
  }
  function stop() {
    generation++;
    clearTimeout(retry);
    retry = undefined;
    clearInterval(heartbeat);
    heartbeat = undefined;
    connecting = false;
    connected.value = false;
    const old = socket;
    socket = null;
    if (old) {
      old.onopen = null;
      old.onmessage = null;
      old.onclose = null;
      old.onerror = null;
      try {
        old.close();
      } catch {
        /* A closing or interrupted handshake needs no retry. */
      }
    }
  }
  function readKeys(id: string): Set<string> {
    try {
      const raw = JSON.parse(
        sessionStorage.getItem("qs.device-notices:" + id) || "[]",
      );
      return new Set(
        Array.isArray(raw)
          ? raw.filter((x) => typeof x === "string").slice(-200)
          : [],
      );
    } catch {
      return new Set();
    }
  }
  function reconcile() {
    if (disposed) return;
    const lease = currentLease();
    if (!lease || lease.accountId !== accountId.value) {
      stop();
      bound = null;
      rejectedToken = null;
      notices.value = [];
      failures = 0;
      return;
    }
    if (!sameLogin(bound, lease)) {
      stop();
      bound = lease;
      rejectedToken = null;
      notices.value = [];
      failures = 0;
    } else bound = lease;
    if (rejectedToken && rejectedToken !== lease.accessToken)
      rejectedToken = null;
    if (!socket && !retry && !connecting && !rejectedToken)
      void connect(lease, generation);
  }
  function schedule(lease: RequestLease, version: number) {
    if (!valid(lease, version)) {
      if (version === generation) reconcile();
      return;
    }
    clearTimeout(retry);
    failures++;
    const delay =
      Math.min(30000, 1000 * 2 ** Math.min(failures, 5)) *
      (0.8 + Math.random() * 0.4);
    retry = setTimeout(() => {
      retry = undefined;
      if (valid(lease, version)) void connect(lease, version);
      else if (version === generation) reconcile();
    }, delay);
  }
  async function connect(lease: RequestLease, version: number) {
    if (connecting || !valid(lease, version)) return;
    connecting = true;
    try {
      // Capture identity before awaiting refresh; a returned token must never attach a new account to old props.
      const token = await auth.ensureAccessToken();
      if (!token || !valid(lease, version)) return;
      const ready = currentLease();
      if (!sameLogin(ready, lease)) return;
      const url = new URL("/api/v8/ws/live", location.origin);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("channels", "node");
      url.searchParams.set("token", ready!.accessToken); // Existing server contract; never log this URL.
      const ws = new WebSocket(url);
      socket = ws;
      const ping = () => {
        if (!valid(lease, version)) {
          if (version === generation) reconcile();
          return;
        }
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "ping" }));
      };
      ws.onopen = () => {
        if (!valid(lease, version)) {
          ws.close();
          if (version === generation) reconcile();
          return;
        }
        ping();
        heartbeat = setInterval(ping, 20000);
      };
      ws.onmessage = (event) => {
        if (!valid(lease, version)) {
          if (version === generation) reconcile();
          return;
        }
        try {
          const frame = JSON.parse(event.data);
          const data = frame.data || {};
          if (frame.type === "connected") {
            if (data.anonymous || String(data.owner_id) !== lease.accountId) {
              rejectedToken = ready!.accessToken;
              stop();
              notices.value = [];
              return;
            }
            connected.value = true;
            failures = 0;
            return;
          }
          if (frame.type === "error" && data.message === "unauthorized") {
            rejectedToken = ready!.accessToken;
            stop();
            notices.value = [];
            return;
          }
          if (frame.type === "ping") {
            ping();
            return;
          }
          if (
            !connected.value ||
            ![
              "worker.online",
              "worker.offline",
              "worker.status",
              "node_event",
            ].includes(frame.type)
          )
            return;
          const owner = data.owner_id ?? data.account_id;
          if (owner != null && String(owner) !== lease.accountId) return;
          const name = String(
            data.name || data.node_name || data.worker_id || "节点",
          ).slice(0, 100);
          const message =
            frame.type === "node_event"
              ? String(data.message || "设备状态更新").slice(0, 300)
              : name +
                (frame.type === "worker.online"
                  ? "已上线"
                  : frame.type === "worker.offline"
                    ? "已离线"
                    : "状态已更新");
          const time = String(
            data.timestamp ||
              frame.timestamp ||
              (typeof frame.ts === "number"
                ? new Date(frame.ts).toISOString()
                : new Date().toISOString()),
          );
          const key = `${frame.type}|${data.worker_id || name}|${time}`;
          if (!notices.value.some((x) => x.key === key))
            notices.value = [
              { key, message, time, read: readKeys(lease.accountId).has(key) },
              ...notices.value,
            ].slice(0, 50);
        } catch {
          /* Invalid unsolicited frames never enter the UI. */
        }
      };
      ws.onclose = (event) => {
        if (!valid(lease, version)) {
          if (version === generation) reconcile();
          return;
        }
        clearInterval(heartbeat);
        heartbeat = undefined;
        connected.value = false;
        socket = null;
        if (event.code === 4401 || event.code === 1008) {
          // Do not reconnect indefinitely with an explicitly rejected bearer.
          rejectedToken = ready!.accessToken;
          notices.value = [];
          reconcile();
        } else schedule(lease, version);
      };
      ws.onerror = () => {
        /* The close handler owns the only retry schedule. */
      };
    } catch {
      if (valid(lease, version)) schedule(lease, version);
    } finally {
      if (version === generation) connecting = false;
    }
  }
  function markRead() {
    if (!bound || !valid(bound, generation)) {
      reconcile();
      return;
    }
    notices.value = notices.value.map((x) => ({ ...x, read: true }));
    try {
      sessionStorage.setItem(
        "qs.device-notices:" + bound.accountId,
        JSON.stringify(notices.value.map((x) => x.key)),
      );
    } catch {
      /* Read state is optional. */
    }
  }
  const stopWatching = watch(accountId, reconcile, { immediate: true });
  const stopSession = browserSession.onStateChange(reconcile);
  onUnmounted(() => {
    disposed = true;
    stopSession();
    stopWatching();
    stop();
    bound = null;
    notices.value = [];
  });
  return { notices, connected, unread, markRead };
}
