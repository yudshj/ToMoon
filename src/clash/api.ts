import { ApiCallBackend } from "../backend";

/** mihomo external controller, as written into the running config by the backend. */
export const CONTROLLER = "http://127.0.0.1:9090";
export const DEFAULT_TEST_URL = "https://www.gstatic.com/generate_204";

export type ClashMode = "rule" | "global" | "direct";

export interface DelayHistory {
  time: string;
  delay: number;
}

export interface ClashProxy {
  name: string;
  type: string;
  now?: string;
  all?: string[];
  hidden?: boolean;
  udp?: boolean;
  alive?: boolean;
  history: DelayHistory[];
  testUrl?: string;
}

export interface ClashConnection {
  id: string;
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
  metadata: {
    network: string;
    type: string;
    host: string;
    destinationIP: string;
    destinationPort: string;
    process?: string;
    sniffHost?: string;
  };
}

export interface ConnectionsSnapshot {
  downloadTotal: number;
  uploadTotal: number;
  connections: ClashConnection[] | null;
  memory?: number;
}

export interface ClashProvider {
  name: string;
  type: string;
  vehicleType: string;
  behavior?: string;
  ruleCount?: number;
  proxies?: unknown[];
  updatedAt?: string;
}

let secretCache: string | undefined;

async function getSecret(): Promise<string> {
  if (secretCache !== undefined) return secretCache;
  try {
    const res = await ApiCallBackend.getConfig();
    secretCache = (res?.data?.secret as string) || "";
  } catch {
    secretCache = "";
  }
  return secretCache;
}

/** Forget the cached secret, e.g. after the config was reloaded. */
export function resetSecret() {
  secretCache = undefined;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = 8000
): Promise<T> {
  const secret = await getSecret();
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
  };
  if (secret) headers["Authorization"] = `Bearer ${secret}`;
  if (init.body) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CONTROLLER + path, {
      ...init,
      headers,
      signal: init.signal ?? controller.signal,
    });
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body?.message) message = body.message;
      } catch {
        /* empty body */
      }
      throw new Error(message);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;

export const ClashApi = {
  version: () => request<{ version: string; meta?: boolean }>("/version"),

  getProxies: async () =>
    (await request<{ proxies: Record<string, ClashProxy> }>("/proxies"))
      .proxies,

  selectProxy: (group: string, name: string) =>
    request<void>(`/proxies/${enc(group)}`, {
      method: "PUT",
      body: JSON.stringify({ name }),
    }),

  /** Test every member of a group; resolves to name -> delay (ms). */
  testGroup: (group: string, url = DEFAULT_TEST_URL, timeout = 5000) =>
    request<Record<string, number>>(
      `/group/${enc(group)}/delay?url=${enc(url)}&timeout=${timeout}`,
      {},
      timeout + 5000
    ),

  testProxy: (name: string, url = DEFAULT_TEST_URL, timeout = 5000) =>
    request<{ delay: number }>(
      `/proxies/${enc(name)}/delay?url=${enc(url)}&timeout=${timeout}`,
      {},
      timeout + 3000
    ),

  getMode: async () =>
    ((await request<{ mode: string }>("/configs")).mode || "rule")
      .toLowerCase() as ClashMode,

  setMode: (mode: ClashMode) =>
    request<void>("/configs", {
      method: "PATCH",
      body: JSON.stringify({ mode }),
    }),

  getConnections: () => request<ConnectionsSnapshot>("/connections"),

  closeConnection: (id: string) =>
    request<void>(`/connections/${enc(id)}`, { method: "DELETE" }),

  closeAllConnections: () =>
    request<void>("/connections", { method: "DELETE" }),

  /** Re-download GeoIP / GeoSite / ASN databases from geox-url and reload. */
  updateGeo: () => request<void>("/configs/geo", { method: "POST" }, 180000),

  getRuleProviders: async () =>
    Object.values(
      (await request<{ providers: Record<string, ClashProvider> }>(
        "/providers/rules"
      )).providers || {}
    ),

  updateRuleProvider: (name: string) =>
    request<void>(`/providers/rules/${enc(name)}`, { method: "PUT" }, 120000),

  /** Proxy providers backed by a URL or file (skips the built-in "default"). */
  getProxyProviders: async () =>
    Object.values(
      (await request<{ providers: Record<string, ClashProvider> }>(
        "/providers/proxies"
      )).providers || {}
    ).filter((p) => p.vehicleType !== "Compatible"),

  updateProxyProvider: (name: string) =>
    request<void>(`/providers/proxies/${enc(name)}`, { method: "PUT" }, 120000),

  /**
   * Subscribe to the /traffic stream (one JSON object per second).
   * Returns a function that stops the stream.
   */
  streamTraffic(onData: (up: number, down: number) => void): () => void {
    const controller = new AbortController();
    (async () => {
      const secret = await getSecret();
      const res = await fetch(CONTROLLER + "/traffic", {
        headers: secret ? { Authorization: `Bearer ${secret}` } : {},
        signal: controller.signal,
      });
      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const { up, down } = JSON.parse(line);
            onData(up, down);
          } catch {
            /* partial line */
          }
        }
      }
    })().catch(() => {
      /* aborted or core stopped */
    });
    return () => controller.abort();
  },
};

const GROUP_TYPES = new Set([
  "Selector",
  "URLTest",
  "Fallback",
  "LoadBalance",
  "Relay",
]);

export function isGroup(p?: ClashProxy): boolean {
  return !!p && (GROUP_TYPES.has(p.type) || Array.isArray(p.all));
}

/**
 * Proxy groups in config order. mihomo keeps GLOBAL.all in config order,
 * so use it to sort; GLOBAL itself is only shown in global mode.
 */
export function orderedGroups(
  proxies: Record<string, ClashProxy>,
  mode: ClashMode
): ClashProxy[] {
  const order = proxies["GLOBAL"]?.all ?? Object.keys(proxies);
  const groups = order
    .map((name) => proxies[name])
    .filter((p): p is ClashProxy => isGroup(p) && !p.hidden);
  if (mode === "global" && proxies["GLOBAL"]) {
    groups.unshift(proxies["GLOBAL"]);
  }
  return groups;
}

/** Last measured delay in ms; 0 means timed out or never tested. */
export function lastDelay(p?: ClashProxy): number {
  const h = p?.history;
  return h && h.length ? h[h.length - 1].delay : 0;
}

export function delayColor(delay: number | undefined): string {
  if (delay === undefined) return "#8b929a";
  if (delay <= 0) return "#d94126";
  if (delay < 200) return "#59bf40";
  if (delay < 500) return "#e8b923";
  return "#e07b39";
}

export function delayText(
  delay: number | undefined,
  timeoutLabel: string
): string {
  if (delay === undefined) return "—";
  if (delay <= 0) return timeoutLabel;
  return `${delay} ms`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function openWebDashboard(dashboardPath: string, secret: string) {
  const name = dashboardPath.split("/").pop() || "zashboard";
  let param = `/${name}/#`;
  if (secret) {
    const page =
      name === "metacubexd" || name === "zashboard" ? "setup" : "proxies";
    param += `/${page}?hostname=127.0.0.1&port=9090&secret=${secret}`;
  } else if (name === "metacubexd") {
    param += `/setup?hostname=127.0.0.1&port=9090`;
  }
  return `${CONTROLLER}/ui${param}`;
}
