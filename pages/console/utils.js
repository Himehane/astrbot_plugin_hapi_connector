/**
 * DOM / 字符串 / UMO 纯工具（不依赖 state，避免循环）
 */
import { LAYER } from "./constants.js?v=3.0.1";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const attr = (s) => esc(s).replace(/'/g, "&#39;");

function parseUmo(u) {
  const raw = String(u || "").trim();
  if (!raw) return { platform: "", kindLabel: "窗口", sid: "" };
  const parts = raw.split(":");
  const platform = parts[0] || "bot";
  const msgType = parts[1] || "";
  const sid = parts.length >= 3 ? parts.slice(2).join(":") : parts[1] || raw;
  const mt = msgType.toLowerCase();
  let kindLabel = "窗口";
  if (mt.includes("group") || msgType === "GroupMessage") kindLabel = "群聊";
  else if (mt.includes("friend") || mt.includes("private") || msgType === "FriendMessage")
    kindLabel = "私聊";
  else if (mt.includes("channel") || mt.includes("guild")) kindLabel = "频道";
  else if (msgType) kindLabel = msgType;
  return { platform, kindLabel, sid };
}

function resolve(s, owners, defaults) {
  if (s.forceNone) return { umo: null, layer: "none" };
  if (owners[s.id]) return { umo: owners[s.id], layer: "session_bind" };
  const f = defaults.flavor[s.flavor];
  if (f) return { umo: f, layer: "flavor_default" };
  if (defaults.primary) return { umo: defaults.primary, layer: "primary" };
  return { umo: null, layer: "none" };
}

function statusLabel(s) {
  if (s.thinking) return "思考中";
  if (s.active) return "运行中";
  return "已归档";
}

function pill(s) {
  if (s.thinking) return `<span class="tag tag-warn">思考中</span>`;
  if (s.active) return `<span class="tag tag-ok">运行中</span>`;
  return `<span class="tag tag-muted">已归档</span>`;
}

function layerTag(layer) {
  const L = LAYER[layer] || LAYER.none;
  return `<span class="tag ${L.cls}">${esc(L.text)}</span>`;
}

export { $, $$, esc, attr, parseUmo, resolve, statusLabel, pill, layerTag };
