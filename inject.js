// 此脚本运行在页面主世界（MAIN world），在 document_start 注入。
// 作用：拦截页面自己的 fetch/XHR 响应，把包含作品详情的 JSON 记下来，
// 供扩展点击时直接取用（数据是抖音自己请求的，带完整签名，不会被拦）。
(() => {
  const store = new Map(); // aweme_id -> aweme_detail
  const MAX = 30;

  function record(json) {
    try {
      const seen = new Set();
      const walk = (o, d) => {
        if (!o || typeof o !== "object" || d > 8 || seen.has(o)) return;
        seen.add(o);
        if (o.aweme_id && (o.video || o.images)) {
          store.delete(o.aweme_id);
          store.set(o.aweme_id, o);
        }
        for (const k in o) {
          try { walk(o[k], d + 1); } catch (e) {}
        }
      };
      walk(json, 0);
      while (store.size > MAX) {
        store.delete(store.keys().next().value);
      }
    } catch (e) {}
  }

  function processText(text) {
    try {
      if (!text || text.length > 3000000 || text[0] !== "{") return;
      record(JSON.parse(text));
    } catch (e) {}
  }

  // ---- 拦截 fetch ----
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const first = args[0];
      const url = typeof first === "string" ? first : (first && first.url) || "";
      if (/douyin\.com\/aweme\//.test(url)) {
        p.then((res) => {
          try {
            res.clone().text().then(processText);
          } catch (e) {}
        }).catch(() => {});
      }
    } catch (e) {}
    return p;
  };

  // ---- 拦截 XHR ----
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dyUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__dyUrl && /douyin\.com\/aweme\//.test(String(this.__dyUrl))) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            processText(this.responseText);
          } else if (this.responseType === "json") {
            record(this.response);
          }
        } catch (e) {}
      });
    }
    return origSend.apply(this, args);
  };

  // ---- 响应内容脚本的取数请求 ----
  window.addEventListener("dy-dl-request", (e) => {
    const { id, reqId } = e.detail || {};
    const payload = (id && store.get(id)) || null;
    window.dispatchEvent(
      new CustomEvent("dy-dl-response", { detail: { reqId, payload } })
    );
  });
})();
