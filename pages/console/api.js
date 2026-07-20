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

export function createApi(bridge) {
  async function get(endpoint, params) {
    return bridge.apiGet(endpoint, params);
  }

  async function post(endpoint, body) {
    return bridge.apiPost(endpoint, body || {});
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
