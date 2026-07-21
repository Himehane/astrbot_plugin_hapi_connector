/**
 * HAPI Connector WebUI · pages/console
 * - AstrBot iframe：window.AstrBotPluginPage bridge
 * - 本地预览（无 bridge）：内置 mock
 * 规范见 dev-docs/plugin-pages.md
 *
 * 入口：组装 shell / boot；页面逻辑见 pages/*
 */

import { PERM } from "./constants.js?v=3.0.0";
import { state } from "./state.js?v=3.0.0";
import { $$, $ } from "./utils.js?v=3.0.0";
import {
  closeSidebar,
  ensureFxLayer,
  showAlert,
  toast,
} from "./ui.js?v=3.0.0";
import {
  hasBridge,
  initBridge,
  createApi,
  setLiveApi,
  getApi,
  isLive,
  wireLiveMutations,
  fetchSnapshot,
  refresh,
  startPolling,
  stopPolling,
  onVisibility,
  saveSettings,
} from "./data.js?v=3.0.0";
import "./nav.js?v=3.0.0"; // register go / repaint
import { go } from "./go.js?v=3.0.0";
import { renderSettings } from "./pages/settings.js?v=3.0.0";

function bindShell() {
  ensureFxLayer();
  $$("#nav .side-link").forEach((b) => {
    b.onclick = () => go(b.dataset.page);
  });

  $("#btn-menu")?.addEventListener("click", () => {
    $("#app").classList.add("sidebar-open");
    $("#scrim").hidden = false;
  });
  $("#scrim")?.addEventListener("click", closeSidebar);
  $("#btn-refresh")?.addEventListener("click", () => {
    refresh({ fresh: true });
  });
  $("#dlg-close")?.addEventListener("click", () => $("#dlg").close());
  $("#btn-settings-save")?.addEventListener("click", () => saveSettings());
  $("#btn-settings-reset")?.addEventListener("click", async () => {
    const snap = await fetchSnapshot();
    state.draft = structuredClone(snap.config);
    renderSettings();
    toast("已撤销未保存修改");
  });
}

async function boot() {
  ensureFxLayer();
  bindShell();

  if (hasBridge()) {
    try {
      const { bridge, ctx } = await initBridge();
      const api = createApi(bridge);
      setLiveApi(api, true);
      wireLiveMutations();

      const applyCtx = (c) => {
        const dark = Boolean(c?.isDark);
        document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
        try {
          document.documentElement.lang = bridge.getLocale?.() || c?.locale || "zh-CN";
        } catch (_) {
          /* ignore */
        }
      };
      applyCtx(ctx);
      if (typeof bridge.onContext === "function") {
        const offCtx = bridge.onContext(applyCtx);
        if (typeof offCtx === "function") {
          window.addEventListener("beforeunload", offCtx);
        }
      }

      try {
        const help = await api.help();
        if (help?.topics?.length && help?.commands?.length) {
          state._helpTopics = help.topics;
          state._helpCommands = help.commands;
        }
      } catch (e) {
        console.warn("help load failed, using bundled", e);
      }
      try {
        const meta = await api.meta();
        state.meta = meta || null;
        if (meta?.permission_modes) {
          Object.assign(PERM, meta.permission_modes);
        }
      } catch (e) {
        console.warn("meta load failed", e);
      }
    } catch (e) {
      console.error("bridge init failed", e);
      showAlert("Bridge 初始化失败: " + (e.message || e));
      setLiveApi(null, false);
    }
  }

  try {
    state.data = await fetchSnapshot();
  } catch (e) {
    console.error(e);
    showAlert("加载数据失败: " + (e.message || e) + "（请查 AstrBot 日志中的 WebUI *failed）");
    state.data = {
      connection: {
        sse_status: "disconnected",
        endpoint_host: "—",
        conn_fail_count: 0,
        conn_error: e.message || String(e),
        source: "frontend_fallback",
      },
      metrics: { active: 0, thinking: 0, pending: 0, unrouted: 0, total: 0 },
      sessions: [],
      columns: [],
      defaults: { primary: null, flavor: {}, writable: false },
      window_options: [],
      config: {},
      error: e.message || String(e),
    };
    if (isLive() && getApi()) {
      try {
        const cfgRes = await getApi().config();
        state.data.config = cfgRes?.config || cfgRes || {};
      } catch (e2) {
        console.warn("boot config failed", e2);
      }
    }
  }
  state.focusWindow = state.data.columns[0]?.umo || "__none__";
  go("overview");

  if (isLive()) {
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("beforeunload", stopPolling);
    if (!document.hidden) startPolling();
  }
}

boot();
