// 运行在隔离环境：负责在扩展后台和页面之间传话 + 代抓媒体文件
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // 1) 从截获的详情缓存里取数据
  if (msg.type === "getDetail") {
    const reqId = Math.random().toString(36).slice(2);
    const onResp = (e) => {
      if (e.detail && e.detail.reqId === reqId) {
        window.removeEventListener("dy-dl-response", onResp);
        sendResponse(e.detail.payload || null);
      }
    };
    window.addEventListener("dy-dl-response", onResp);
    window.dispatchEvent(
      new CustomEvent("dy-dl-request", { detail: { id: msg.id, reqId } })
    );
    setTimeout(() => {
      window.removeEventListener("dy-dl-response", onResp);
      try { sendResponse(null); } catch (e) {}
    }, 2000);
    return true;
  }

  // 2) 代抓视频文件：用页面的网络环境下载（自动带 Referer，绕过 CDN 校验），
  //    转成本地 blob 地址交还给后台保存
  if (msg.type === "fetchBlob") {
    (async () => {
      for (const creds of ["omit", "include"]) {
        try {
          const r = await fetch(msg.url, { credentials: creds });
          if (!r.ok) continue;
          const blob = await r.blob();
          if (!blob || blob.size < 2000 || /^text\//i.test(blob.type)) continue;
          sendResponse({
            ok: true,
            blobUrl: URL.createObjectURL(blob),
            size: blob.size,
          });
          return;
        } catch (e) {}
      }
      sendResponse({ ok: false });
    })();
    return true;
  }

  // 3) 下载完成后释放内存
  if (msg.type === "revoke") {
    try { URL.revokeObjectURL(msg.blobUrl); } catch (e) {}
    return false;
  }

  return false;
});
