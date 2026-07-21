/**
 * live / mock 数据层：snapshot、refresh、轮询、保存设置
 * 不直接 import pages/*，由 nav/app 注入 repaint，避免循环依赖
 */
import { hasBridge, initBridge, createApi } from "./api.js?v=3.0.0";
import { store, state } from "./state.js?v=3.0.0";
import { $ } from "./utils.js?v=3.0.0";
import { getApi, isLive, setLiveApi } from "./live.js?v=3.0.0";
import {
  renderTopConn,
  renderAlert,
  showAlert,
  toast,
  setRefresh,
} from "./ui.js?v=3.0.0";

/** 当前页重绘（由 nav.js 注入） */
let _repaintPage = (_page) => {};
export function setRepaintPage(fn) {
  _repaintPage = typeof fn === "function" ? fn : () => {};
}

/** 设置页字段枚举（由 settings 模块注入，供 saveSettings 用） */
let _allSettingsFields = () => [];
export function setAllSettingsFields(fn) {
  _allSettingsFields = typeof fn === "function" ? fn : () => [];
}

function applySnapFromResult(res) {
  if (res && res.snapshot) {
    state.data = res.snapshot;
    return true;
  }
  return false;
}

async function fetchSnapshot(opts = {}) {
  if (!isLive() || !getApi()) return store.snap();
  const api = getApi();
  const snap = await api.sessionsSnapshot(opts);
  if (!snap || typeof snap !== "object") {
    throw new Error("sessions/snapshot 返回空或非对象");
  }
  if (!snap.columns) snap.columns = [];
  if (!snap.window_options) snap.window_options = [];
  if (!snap.defaults) snap.defaults = { primary: null, flavor: {}, writable: false };
  if (!snap.connection) {
    snap.connection = {
      sse_status: "disconnected",
      endpoint_host: "—",
      conn_fail_count: 0,
      conn_error: "snapshot 未包含 connection",
    };
  }
  if (!snap.config || typeof snap.config !== "object" || snap.config._error) {
    try {
      const cfgRes = await api.config();
      const cfg = cfgRes?.config || cfgRes;
      if (cfg && typeof cfg === "object") snap.config = cfg;
    } catch (e) {
      console.warn("config fallback failed", e);
      if (!snap.config) snap.config = state.data?.config || {};
      snap.config_error = e.message || String(e);
    }
  }
  return snap;
}

/**
 * @param {{fresh?: boolean, silent?: boolean, repaint?: boolean}} opts
 * silent: 轮询/后台刷新——只更新数据与顶栏，不重绘表单
 * repaint: 强制按当前页重绘
 */
async function refresh(opts = {}) {
  try {
    state.data = await fetchSnapshot(opts);
  } catch (e) {
    console.error(e);
    if (!opts.silent) showAlert(e.message || String(e));
    return;
  }
  const live = new Set((state.data.sessions || []).map((s) => s.id));
  for (const id of [...state.selected]) if (!live.has(id)) state.selected.delete(id);
  renderTopConn();
  renderAlert();

  if (opts.silent && !opts.repaint) {
    return;
  }

  _repaintPage(state.page);
}

// 注入 ui 的唤醒按钮等路径
setRefresh(refresh);

const POLL_MS = 12000;
let pollTimer = null;
let pollInFlight = false;

function stopPolling() {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  if (!isLive()) return;
  pollTimer = setInterval(async () => {
    if (document.hidden) return;
    if (pollInFlight) return;
    if ($("#dlg")?.open) return;
    pollInFlight = true;
    try {
      await refresh({ silent: true, fresh: false });
    } catch (_) {
      /* 静默 */
    } finally {
      pollInFlight = false;
    }
  }, POLL_MS);
}

function onVisibility() {
  if (document.hidden) {
    stopPolling();
  } else if (isLive()) {
    refresh({ silent: true, fresh: false }).finally(() => startPolling());
  }
}

function wireLiveMutations() {
  if (!isLive() || !getApi()) return;
  const api = getApi();
  store.saveConfig = async (patch) => api.saveConfig(patch);
  store.wake = async () => {
    await api.wake();
  };
}

async function saveSettings() {
  const prev = state.data.config;
  const draft = state.draft;
  const kindBoxes = [...document.querySelectorAll("[data-settings-kind]")];
  if (kindBoxes.length) {
    const kinds = kindBoxes.filter((el) => el.checked).map((el) => el.value);
    draft.render_kinds = kinds.join(",") || "session_list,pending,message";
    draft.render_kinds_list = kinds;
  }
  const patch = {};
  for (const f of _allSettingsFields()) {
    if (f.sensitive) continue;
    if (draft[f.key] !== prev[f.key]) patch[f.key] = draft[f.key];
  }
  const token = document.querySelector('#settings-form input[name="access_token"]')?.value;
  const secret = document.querySelector('#settings-form input[name="cf_access_client_secret"]')?.value;
  if (token) patch.access_token = token;
  if (secret) patch.cf_access_client_secret = secret;
  if (!Object.keys(patch).length) {
    toast("没有变更");
    return;
  }
  try {
    if (isLive() && getApi()) {
      const res = await getApi().saveConfig(patch);
      toast(res.message || "已保存");
      if (res.reconnect_error || (res.reconnect_required && !res.reconnected)) {
        showAlert(
          res.message ||
            "已保存，但自动重连未成功 — 可点概览「按配置重连 HAPI」重试。",
        );
      }
    } else {
      store.saveConfig(patch);
      toast("已保存");
    }
    state.draft = null;
    await refresh();
    _repaintPage("settings");
  } catch (e) {
    toast("保存失败: " + (e.message || e));
  }
}

export {
  applySnapFromResult,
  fetchSnapshot,
  refresh,
  stopPolling,
  startPolling,
  onVisibility,
  wireLiveMutations,
  saveSettings,
  hasBridge,
  initBridge,
  createApi,
  getApi,
  isLive,
  setLiveApi,
};
