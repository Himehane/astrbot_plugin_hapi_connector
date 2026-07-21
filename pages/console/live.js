/**
 * Bridge 连接态（独立小模块，避免 data ↔ pages 循环依赖）
 */

let api = null;
let liveMode = false;

export function getApi() {
  return api;
}

export function isLive() {
  return liveMode;
}

export function setLiveApi(nextApi, nextLive) {
  api = nextApi;
  liveMode = Boolean(nextLive);
}
