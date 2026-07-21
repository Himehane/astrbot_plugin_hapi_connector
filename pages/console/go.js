/**
 * 页面跳转句柄（叶子模块，页面可安全 import 而不形成环）
 */
let _go = (page) => {
  console.warn("go() not registered yet", page);
};

export function setGo(fn) {
  _go = typeof fn === "function" ? fn : _go;
}

export function go(page) {
  return _go(page);
}
