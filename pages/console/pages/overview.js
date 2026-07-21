/**
 * 概览页
 */
import { OUTPUT_LEVELS } from "../constants.js?v=3.0.0";
import { state, store, wTitle } from "../state.js?v=3.0.0";
import { $, $$, esc, attr } from "../utils.js?v=3.0.0";
import {
  renderTopConn,
  renderAlert,
  ensureFxLayer,
  toast,
  askConfirm,
  openHubUrl,
  fetchHubLaunch,
  copyTextSafe,
  connIsOk,
  connLabel,
} from "../ui.js?v=3.0.0";
import { refresh } from "../data.js?v=3.0.0";
import { isLive, getApi } from "../live.js?v=3.0.0";
import { go } from "../go.js?v=3.0.0";


function renderOverview() {
  if (!state.data) return;
  renderTopConn();
  renderAlert();
  ensureFxLayer();

  const c = state.data.connection || {};
  const m = state.data.metrics || {};
  const cfg = state.data.config || {};
  const def = state.data.defaults || { primary: null, flavor: {}, writable: false };
  const winOptsList = Array.isArray(state.data.window_options) ? state.data.window_options : [];
  const ok = connIsOk(c);
  const label = connLabel(c);
  const primaryTitle = def.primary ? wTitle(def.primary) : "未设置";
  const routeWritable = def.writable !== false;

  const levelOpts = OUTPUT_LEVELS.map(
    (o) =>
      `<option value="${o.value}" ${cfg.output_level === o.value ? "selected" : ""}>${esc(o.title)}</option>`,
  ).join("");

  const primarySelectOpts =
    `<option value="">未设置</option>` +
    winOptsList
      .map(
        (w) =>
          `<option value="${attr(w.umo)}" ${def.primary === w.umo ? "selected" : ""}>${esc(w.title || wTitle(w.umo))}</option>`,
      )
      .join("");

  $("#view-overview").innerHTML = `
    <div class="metric-grid">
      <div class="metric ${ok ? "ok" : "danger"}">
        <div class="label">连接</div>
        <div class="value" style="font-size:1.1rem">${esc(label)}</div>
      </div>
      <div class="metric">
        <div class="label">运行中</div>
        <div class="value">${m.active}</div>
      </div>
      <div class="metric">
        <div class="label">思考中</div>
        <div class="value">${m.thinking}</div>
      </div>
      <div class="metric ${m.pending ? "warn" : ""}">
        <div class="label">待审批</div>
        <div class="value">${m.pending}</div>
      </div>
      <div class="metric ${m.unrouted ? "danger" : ""}">
        <div class="label">未投递</div>
        <div class="value">${m.unrouted}</div>
      </div>
      <div class="metric">
        <div class="label">Session</div>
        <div class="value">${m.total}</div>
      </div>
    </div>

    <div class="card card-fx">
      <div class="card-head">
        <div>
          <h2>常用设置</h2>
          <p class="sub">改完立即写入插件配置；完整项在「设置」</p>
        </div>
        <button type="button" class="linkish" data-go="settings">全部设置 →</button>
      </div>
      <div class="quick-settings">
        <label class="qs-field">
          <span class="qs-label">推送详细程度</span>
          <select id="qs-level" class="ctrl">${levelOpts}</select>
        </label>
        ${
          cfg.output_level === "summary"
            ? `<label class="qs-field">
          <span class="qs-label">摘要条数</span>
          <input id="qs-summary" class="ctrl" type="number" min="1" max="50" value="${attr(cfg.summary_msg_count)}" />
        </label>`
            : ""
        }
        <div class="qs-field qs-bool">
          <span class="qs-label">戳一戳快捷</span>
          <label class="switch">
            <input id="qs-poke" type="checkbox" ${cfg.poke_approve ? "checked" : ""} />
            <span class="switch-track" aria-hidden="true"></span>
            <span class="switch-text">${cfg.poke_approve ? "开启" : "关闭"}</span>
          </label>
        </div>
        <div class="qs-field qs-bool">
          <span class="qs-label">忙时托管审批</span>
          <label class="switch">
            <input id="qs-auto" type="checkbox" ${cfg.auto_approve_enabled ? "checked" : ""} />
            <span class="switch-track" aria-hidden="true"></span>
            <span class="switch-text">${cfg.auto_approve_enabled ? "开启托管" : "关闭"}</span>
          </label>
        </div>
        <label class="qs-field">
          <span class="qs-label">托管开始</span>
          <input id="qs-auto-start" class="ctrl" type="time" value="${attr(cfg.auto_approve_start || "23:00")}" />
        </label>
        <label class="qs-field">
          <span class="qs-label">托管结束</span>
          <input id="qs-auto-end" class="ctrl" type="time" value="${attr(cfg.auto_approve_end || "07:00")}" />
        </label>
        <div class="qs-field qs-note">
          <span class="qs-label">说明</span>
          <span class="qs-note-text">${
            cfg.auto_approve_enabled
              ? "时段内权限请求将自动批准，可跨午夜（如 23:00–07:00）"
              : "时间始终可改；开启托管后，该时段内权限请求将自动批准"
          }</span>
        </div>
      </div>
    </div>

    <div class="card card-fx">
      <div class="card-head">
        <div>
          <h2>连接信息</h2>
          <p class="sub">插件当前配置与 SSE 状态</p>
        </div>
        <div class="card-head-actions">
          <button type="button" class="btn btn-sm" id="btn-reconnect">重连</button>
          <button type="button" class="linkish" data-go="settings">改连接 →</button>
        </div>
      </div>
      <dl class="kv">
        <dt>Endpoint</dt><dd>${esc(cfg.hapi_endpoint || c.endpoint || c.endpoint_host || "—")}</dd>
        <dt>Token</dt><dd class="mono break">${esc(cfg.access_token || "—")}</dd>
        <dt>HAPI 网页</dt>
        <dd>${
          cfg.hapi_web_url
            ? `<a class="ext-link mono break" href="${attr(cfg.hapi_web_url)}" target="_blank" rel="noopener noreferrer">${esc(cfg.hapi_web_url)}</a>`
            : `<span class="muted">未配置地址</span>`
        }</dd>
        <dt>插件 SSE</dt><dd>${esc(label)}${c.stream_live ? " · 流活跃" : ""}${c.task_running === false ? " · 任务未运行" : ""}</dd>
        <dt>推送级别</dt><dd>${esc(cfg.output_level || "—")}</dd>
        <dt>默认推送窗口</dt>
        <dd class="kv-stack">
          <div class="primary-now mono break">${esc(primaryTitle)}</div>
          <select id="qs-primary" class="ctrl ctrl-sm" ${routeWritable ? "" : "disabled"} title="${attr(def.writable_reason || "")}">${primarySelectOpts}</select>
          ${
            !winOptsList.length
              ? `<span class="muted xs">尚无聊天窗口记录，请先在聊天里 /hapi bind</span>`
              : !routeWritable
                ? `<span class="muted xs">${esc(def.writable_reason || "当前不可改")}</span>`
                : `<span class="muted xs">与「会话管理」中的默认推送窗口同步</span>`
          }
        </dd>
        ${c.conn_error ? `<dt>最近错误</dt><dd>${esc(c.conn_error)}</dd>` : ""}
      </dl>
    </div>
  `;

  const applyQuick = async (patch) => {
    try {
      if (isLive() && getApi()) {
        const res = await getApi().saveConfig(patch);
        if (res?.message) toast(res.message);
      } else {
        store.saveConfig(patch);
      }
      if (state.draft) Object.assign(state.draft, patch);
      await refresh({ silent: true, repaint: true });
    } catch (e) {
      toast("保存失败: " + (e.message || e));
    }
  };

  $("#qs-level").onchange = () => applyQuick({ output_level: $("#qs-level").value });
  $("#qs-summary") && ($("#qs-summary").onchange = () => applyQuick({ summary_msg_count: Number($("#qs-summary").value) || 5 }));
  $("#qs-poke") &&
    ($("#qs-poke").onchange = () => {
      const on = $("#qs-poke").checked;
      const txt = $("#qs-poke").closest(".switch")?.querySelector(".switch-text");
      if (txt) txt.textContent = on ? "开启" : "关闭";
      applyQuick({ poke_approve: on });
    });
  $("#qs-auto") &&
    ($("#qs-auto").onchange = () => {
      const on = $("#qs-auto").checked;
      const txt = $("#qs-auto").closest(".switch")?.querySelector(".switch-text");
      if (txt) txt.textContent = on ? "开启托管" : "关闭";
      applyQuick({ auto_approve_enabled: on });
    });
  $("#qs-auto-start") &&
    ($("#qs-auto-start").onchange = () => applyQuick({ auto_approve_start: $("#qs-auto-start").value || "23:00" }));
  $("#qs-auto-end") &&
    ($("#qs-auto-end").onchange = () => applyQuick({ auto_approve_end: $("#qs-auto-end").value || "07:00" }));

  $("#qs-primary") &&
    ($("#qs-primary").onchange = async () => {
      const umo = $("#qs-primary").value || null;
      try {
        if (isLive() && getApi()) {
          const res = await getApi().setPrimaryRoute(umo);
          toast(res?.message || "已更新默认推送窗口");
        } else {
          store.setDefault("primary", umo);
          toast("已更新默认推送窗口");
        }
        await refresh({ silent: true, repaint: true });
      } catch (e) {
        toast("更新失败: " + (e.message || e));
      }
    });

  $$("#view-overview [data-go]").forEach((b) => {
    b.onclick = () => go(b.dataset.go);
  });
  $("#btn-reconnect")?.addEventListener("click", async () => {
    const ok = await askConfirm("按当前已保存配置重建连接并重启 SSE？", { title: "重连", yes: "重连" });
    if (!ok) return;
    try {
      if (isLive() && getApi()) {
        const res = await getApi().reconnect();
        toast(res.message || "已重连");
        await refresh();
      } else {
        store.wake();
        toast("已模拟重连");
        await refresh();
      }
    } catch (e) {
      toast("重连失败: " + (e.message || e));
    }
  });
}

export { renderOverview };
