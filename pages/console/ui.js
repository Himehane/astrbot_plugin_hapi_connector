/**
 * Shell 渲染、toast、确认框、特效层、打开官方 HAPI
 */
import { PAGE_META } from "./constants.js?v=3.0.0";
import { state, store } from "./state.js?v=3.0.0";
import { $, $$, esc } from "./utils.js?v=3.0.0";
import { getApi, isLive } from "./live.js?v=3.0.0";

/** 由 data.js 注入，避免 ui ↔ data 循环 */
let _refresh = async () => {};
export function setRefresh(fn) {
  _refresh = typeof fn === "function" ? fn : async () => {};
}
async function refresh(opts) {
  return _refresh(opts);
}

function connLabel(c) {
  const st = c?.sse_status || "disconnected";
  if (st === "connected") return "已连接";
  if (st === "hibernated") return "已休眠";
  if (st === "reconnecting") return "重连中";
  if (st === "disconnected") return "未连接";
  return st;
}

function connIsOk(c) {
  return c?.sse_status === "connected";
}

function renderTopConn() {
  const c = state.data?.connection || {};
  const ok = connIsOk(c);
  const label = connLabel(c);
  const host = c.endpoint_host || "—";

  $("#top-conn").className = `conn-chip ${ok ? "ok" : "bad"}`;
  $("#top-conn").innerHTML = `<span class="dot"></span>${esc(label)} · ${esc(host)}`;

  const foot = $("#sidebar-conn");
  foot.className = `sidebar-footer ${ok ? "ok" : "bad"}`;
  $("#sidebar-conn-text").textContent = label;
}

function renderAlert() {
  const c = state.data?.connection || {};
  const el = $("#alert");
  if (c.sse_status === "hibernated") {
    el.hidden = false;
    el.innerHTML = `<div class="alert alert-danger">
      <span>插件 SSE 已休眠（失败 ${c.conn_fail_count || 0} 次）${c.conn_error ? " · " + esc(c.conn_error) : ""}。这是插件↔HAPI 的连接，不是网页本身。</span>
      <button type="button" class="btn btn-sm" id="btn-wake">唤醒</button>
    </div>`;
    $("#btn-wake").onclick = async () => {
      try {
        if (isLive() && getApi()) await getApi().wake();
        else store.wake();
        await refresh();
      } catch (e) {
        toast("唤醒失败: " + (e.message || e));
      }
    };
  } else if (c.sse_status === "reconnecting" && c.conn_error) {
    el.hidden = false;
    el.innerHTML = `<div class="alert alert-danger">
      <span>插件 SSE 重连中（失败 ${c.conn_fail_count || 0} 次）· ${esc(c.conn_error)}</span>
    </div>`;
  } else if (c.sse_status === "disconnected") {
    el.hidden = false;
    el.innerHTML = `<div class="alert alert-danger">
      <span>插件 SSE 未启动${c.conn_error ? " · " + esc(c.conn_error) : "（插件可能未完成 initialize，或配置未连上 HAPI）"}。可点「按配置重连 HAPI」或重载插件。</span>
    </div>`;
  } else if (state.data?.error) {
    el.hidden = false;
    el.innerHTML = `<div class="alert alert-danger"><span>部分数据加载异常: ${esc(state.data.error)}</span></div>`;
  } else {
    el.hidden = true;
    el.innerHTML = "";
  }
}

function setPageChrome(page) {
  const meta = PAGE_META[page] || PAGE_META.overview;
  $("#page-title").textContent = meta.title;
  $("#page-desc").textContent = meta.desc;
  $$("#nav .side-link").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.page === page);
  });
  $$(".view").forEach((v) => {
    v.hidden = v.dataset.view !== page;
  });
}

function closeSidebar() {
  $("#app")?.classList.remove("sidebar-open");
  const scrim = $("#scrim");
  if (scrim) scrim.hidden = true;
}


export { connLabel, connIsOk, renderTopConn, renderAlert, setPageChrome, closeSidebar };

function ensureFxLayer() {
  if (document.getElementById("fx-layer")) return;
  const layer = document.createElement("div");
  layer.id = "fx-layer";
  layer.className = "fx-layer";
  layer.setAttribute("aria-hidden", "true");
  const dots = Array.from({ length: 48 }, (_, i) => {
    const left = ((i * 41 + (i % 7) * 3) % 100) + (i % 5) * 0.25;
    const delay = ((i * 0.37) % 10).toFixed(2);
    const dur = (8 + (i % 9) * 1.35).toFixed(1);
    const size = 1 + (i % 4);
    const dx = ((i % 9) - 4) * 6;
    return `<span class="fx-dot" style="--x:${left.toFixed(1)}%;--d:${delay}s;--t:${dur}s;--s:${size}px;--dx:${dx}px"></span>`;
  }).join("");
  const blobs = Array.from({ length: 5 }, (_, i) => {
    const x = 8 + ((i * 23) % 80);
    const y = 10 + ((i * 31) % 70);
    const s = 90 + (i % 4) * 36;
    const d = (i * 1.7).toFixed(1);
    const t = (14 + i * 2.4).toFixed(1);
    const dx = (i % 2 === 0 ? 1 : -1) * (30 + i * 12);
    const dy = (i % 2 === 0 ? -1 : 1) * (18 + i * 8);
    return `<span class="fx-blob" style="--x:${x}%;--y:${y}%;--s:${s}px;--d:${d}s;--t:${t}s;--dx:${dx}px;--dy:${dy}px"></span>`;
  }).join("");
  layer.innerHTML = `
    <div class="fx-scan"></div>
    <div class="fx-beam"></div>
    <div class="fx-vignette"></div>
    <div class="fx-noise"></div>
    <div class="fx-particles">${blobs}${dots}</div>
  `;
  document.body.prepend(layer);
  document.body.classList.add("has-fx");
}


export { ensureFxLayer };

function askConfirm(message, opts = {}) {
  const msg = String(message || "确定？");
  const danger = Boolean(opts.danger);
  const title = opts.title || "确认";
  const yesText = opts.yes || "确定";
  const noText = opts.no || "取消";

  return new Promise((resolve) => {
    const dlg = $("#dlg-confirm");
    const msgEl = $("#dlg-confirm-msg");
    const titleEl = $("#dlg-confirm-title");
    const yes = $("#dlg-confirm-yes");
    const no = $("#dlg-confirm-no");
    const x = $("#dlg-confirm-x");
    if (!dlg || !msgEl || !yes || !no) {
      toast(msg);
      resolve(true);
      return;
    }
    if (titleEl) titleEl.textContent = title;
    msgEl.textContent = msg;
    yes.textContent = yesText;
    no.textContent = noText;
    yes.classList.toggle("btn-danger", danger);
    yes.classList.toggle("btn-primary", !danger);

    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      yes.onclick = null;
      no.onclick = null;
      if (x) x.onclick = null;
      dlg.removeEventListener("close", onClose);
      try {
        if (dlg.open) dlg.close();
      } catch (_) {}
      resolve(v);
    };
    const onClose = () => finish(false);
    yes.onclick = () => finish(true);
    no.onclick = () => finish(false);
    if (x) x.onclick = () => finish(false);
    dlg.addEventListener("close", onClose);
    try {
      if (dlg.open) dlg.close();
      dlg.showModal();
    } catch (e) {
      console.error("confirm dialog failed", e);
      toast(msg);
      resolve(true);
    }
  });
}

function toast(msg) {
  let el = $("#settings-toast");
  if (!el || $("#view-settings")?.hidden) {
    // 非设置页：用顶栏 alert 短暂提示
    const slot = $("#alert");
    if (!slot) return;
    slot.hidden = false;
    slot.innerHTML = `<div class="alert" style="border-color:var(--cursor);background:var(--cursor-dim)"><span>${esc(msg)}</span></div>`;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      // 不覆盖休眠 alert：仅当仍是我们的 toast 时清空
      if (slot.querySelector(".alert") && !slot.querySelector(".alert-danger")) {
        slot.hidden = true;
        slot.innerHTML = "";
      }
    }, 2400);
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2400);
}


export { askConfirm, toast };

async function copyTextSafe(text) {
  const s = String(text || "");
  if (!s) throw new Error("空内容");
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return;
    }
  } catch (_) {}
  const ta = document.createElement("textarea");
  ta.value = s;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy failed");
}

/** 插件页 iframe 里 window.open 常抛 NotSupportedError，用 <a target=_blank> 打开 */
function openHubUrl(url) {
  if (!url) {
    toast("没有可用链接");
    return false;
  }
  try {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch (_) {}
  try {
    const w = window.open(url, "_blank");
    if (w) return true;
  } catch (_) {}
  copyTextSafe(url)
    .then(() => toast("无法自动打开，链接已复制，请粘贴到新标签页"))
    .catch(() => toast("无法自动打开，请到设置查看 HAPI 地址后手动访问"));
  return false;
}

async function fetchHubLaunch(opts = {}) {
  const autologin = opts.autologin !== false;
  if (isLive() && getApi()) {
    return getApi().hubLaunch({ autologin });
  }
  const cfg = state.data?.config || {};
  const endpoint = String(cfg.hapi_endpoint || "http://127.0.0.1:3006").replace(/\/$/, "");
  const page = endpoint + "/";
  let url = page + "?hub=" + encodeURIComponent(endpoint);
  if (autologin && cfg.access_token_configured) url += "&token=demo";
  return { ok: true, url, url_display: page, origin: endpoint };
}


export { copyTextSafe, openHubUrl, fetchHubLaunch };

export function showAlert(msg) {
  const el = $("#alert");
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `<div class="alert alert-danger"><span>${esc(msg)}</span></div>`;
}
