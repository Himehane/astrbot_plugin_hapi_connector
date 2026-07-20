/**
 * Bridge API 封装。
 * - 有 window.AstrBotPluginPage：走真实插件 API
 * - 本地 file:// 或无 bridge：调用方应使用 mock
 */

export function hasBridge() {
  return Boolean(window.AstrBotPluginPage);
}

export async function initBridge() {
  const bridge = window.AstrBotPluginPage;
  if (!bridge) return null;
  const ctx = await bridge.ready();
  return { bridge, ctx };
}

function formatApiError(err, endpoint) {
  if (!err) return `API ${endpoint} 失败`;
  // axios / fetch-like
  const status = err.status || err.statusCode || err.response?.status;
  const body = err.response?.data || err.data || err.body;
  let detail = "";
  if (typeof body === "string") detail = body;
  else if (body && typeof body === "object") {
    detail = body.message || body.error || body.msg || body.detail || JSON.stringify(body).slice(0, 300);
  } else {
    detail = err.message || String(err);
  }
  if (status) return `API ${endpoint} → ${status}: ${detail}`;
  return `API ${endpoint} 失败: ${detail}`;
}

/** Dashboard 可能包一层 { code, data, message }，尽量解包到业务体 */
function unwrap(payload) {
  if (!payload || typeof payload !== "object") return payload;
  // 常见包装：{ code:0, data:{...} } / { status:"ok", data }
  if (payload.data != null && (payload.code === 0 || payload.code === 200 || payload.status === "ok" || payload.success === true)) {
    return payload.data;
  }
  // 有时 bridge 直接返回业务对象
  return payload;
}

export function createApi(bridge) {
  async function get(endpoint, params) {
    try {
      const raw = await bridge.apiGet(endpoint, params);
      return unwrap(raw);
    } catch (e) {
      const err = new Error(formatApiError(e, endpoint));
      err.cause = e;
      err.endpoint = endpoint;
      throw err;
    }
  }

  async function post(endpoint, body) {
    try {
      const raw = await bridge.apiPost(endpoint, body || {});
      return unwrap(raw);
    } catch (e) {
      const err = new Error(formatApiError(e, endpoint));
      err.cause = e;
      err.endpoint = endpoint;
      throw err;
    }
  }

  return {
    meta: () => get("meta"),
    // fresh=true 时强制打 HAPI；默认走服务端缓存 TTL，不唤醒 SSE
    overview: (opts = {}) => get("overview", opts.fresh ? { fresh: 1 } : undefined),
    config: () => get("config"),
    saveConfig: (patch) => post("config", patch),
    help: () => get("help"),
    wake: () => post("connection/wake"),
    reconnect: () => post("connection/reconnect"),
    sessionsSnapshot: (opts = {}) => get("sessions/snapshot", opts.fresh ? { fresh: 1 } : undefined),
    sessionDetail: (sid) => get(`sessions/${encodeURIComponent(sid)}`),
    setPermission: (sid, mode) => post(`sessions/${encodeURIComponent(sid)}/permission`, { mode }),
    bindSession: (sid, umo) => post(`sessions/${encodeURIComponent(sid)}/bind`, { umo }),
    lifecycle: (sid, action) => post(`sessions/${encodeURIComponent(sid)}/lifecycle`, { action }),
    batchLifecycle: (ids, action) => post("sessions/batch", { ids, action }),
    setPrimaryRoute: (umo, user_id) => post("routes/primary", { umo, user_id }),
    setFlavorRoute: (flavor, umo, user_id) => post("routes/flavor", { flavor, umo, user_id }),
    /** HAPI 官方 Web 启动链（autologin 默认 true） */
    hubLaunch: (opts = {}) =>
      get("hub/launch", {
        autologin: opts.autologin === false ? 0 : 1,
        ...(opts.path ? { path: opts.path } : {}),
      }),
    /** 推送卡片：能力元数据 / 实卡预览 */
    renderMeta: () => get("render/meta"),
    renderPreview: (body) => post("render/preview", body || {}),
  };
}
