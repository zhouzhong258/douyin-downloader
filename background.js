// ============ 工具 ============

function notify(message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon128.png",
    title: "抖音内容下载器",
    message
  });
}

function parseAwemeId(url) {
  const m =
    url.match(/modal_id=(\d+)/) ||
    url.match(/\/(?:video|note|slides)\/(\d+)/);
  return m ? m[1] : null;
}

function detailApi(id) {
  return (
    "https://www.douyin.com/aweme/v1/web/aweme/detail/" +
    "?device_platform=webapp&aid=6383&channel=channel_pc_web" +
    "&aweme_id=" + id +
    "&pc_client_type=1&version_code=170400&version_name=17.4.0"
  );
}

const pathOf = (u) => u.split("?")[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============ 在页面上执行：直接从页面元素读媒体地址（主要方式） ============

function domExtract() {
  const vids = [
    ...new Set(
      [...document.querySelectorAll("video")]
        .map((v) => v.currentSrc || v.src || "")
        .filter((u) => /^https:/.test(u) && /douyinvod\.com|\/video\/tos\//.test(u))
    ),
  ];
  const imgs = [
    ...new Set(
      [...document.querySelectorAll("img")]
        .map((i) => i.currentSrc || i.src || "")
        .filter((u) => /douyinpic\.com/.test(u) && /aweme_images/.test(u))
    ),
  ];
  const res = [
    ...new Set(
      performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((u) => /^https:/.test(u) && /douyinvod\.com|\/video\/tos\//.test(u))
    ),
  ];
  // 诊断信息：页面当前整体状态
  const allVideos = document.querySelectorAll("video").length;
  const allImgs = document.querySelectorAll("img").length;
  const blobVids = [
    ...document.querySelectorAll("video"),
  ].filter((v) => (v.currentSrc || v.src || "").startsWith("blob:")).length;
  const modal = document.querySelector(
    '[data-e2e="video-detail"], .xg-modal, [class*="detailModal"]'
  );
  return {
    vids,
    imgs,
    res,
    diag:
      "标题:" + (document.title || "").slice(0, 20) +
      " | 状态:" + document.readyState +
      " | 全部video:" + allVideos +
      "(blob:" + blobVids + ")" +
      " | 全部img:" + allImgs +
      " | 弹窗:" + (modal ? "有" : "无"),
  };
}

// ============ 可选增强：接口数据（更好的命名 + 完整图集） ============

async function fetchDetailFromBackground(id) {
  const r = await fetch(detailApi(id), { credentials: "include" });
  const text = await r.text();
  try {
    const j = JSON.parse(text);
    if (!j.aweme_detail) throw new Error("接口无数据");
    return j.aweme_detail;
  } catch (e) {
    throw new Error("后台:HTTP" + r.status);
  }
}

async function fetchDetailFromPage(tabId, id) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (api) => fetch(api, { credentials: "include" }).then((r) => r.text()),
    args: [detailApi(id)],
  });
  const text = results && results[0] && results[0].result;
  const j = text && text[0] === "{" ? JSON.parse(text) : null;
  if (!j || !j.aweme_detail) throw new Error("页面接口被拦截");
  return j.aweme_detail;
}

function buildItemsFromDetail(a, id) {
  const items = [];
  const safe = (u) => (u && u.startsWith("//") ? "https:" + u : u);
  const dir =
    (a.desc || "").replace(/[\\/:*?"<>|\r\n\t ]+/g, "_").slice(0, 40) ||
    "内容_" + id;
  const v = a.video || {};

  if (v.play_addr && Array.isArray(v.play_addr.url_list) && Number(v.duration) > 0) {
    items.push({ url: safe(v.play_addr.url_list[0]), name: dir + "/视频.mp4" });
  }

  (a.images || []).forEach((im, i) => {
    const n = i + 1;
    const urls = im.url_list || [];
    const jpg = urls.find((u) => /\.jpe?g/i.test(u)) || urls[urls.length - 1];
    if (jpg) {
      items.push({
        url: safe(jpg),
        name: dir + "/图" + n + (/\.webp/i.test(jpg) ? ".webp" : ".jpg"),
      });
    }
    const live =
      (im.video && im.video.play_addr && Array.isArray(im.video.play_addr.url_list) && im.video.play_addr.url_list[0]) ||
      (im.live_photo && Array.isArray(im.live_photo.url_list) && im.live_photo.url_list[0]);
    if (live) {
      items.push({ url: safe(live), name: dir + "/图" + n + "_动图.mp4" });
    }
  });

  return { dir, items };
}

// ============ 合并去重：API 结果 + 页面元素结果 ============

function mergeItems(base, domResult, fallbackDir) {
  const items = [...base.items];
  const have = new Set(items.map((it) => pathOf(it.url)));
  const safe = (u) => (u && u.startsWith("//") ? "https:" + u : u);
  const push = (url, name) => {
    const p = pathOf(url);
    if (url && /^https:/.test(url) && !have.has(p)) {
      have.add(p);
      items.push({ url: safe(url), name });
    }
  };

  // 页面播放器正在用的直链优先；只有 DOM 里没有直链（流式播放）时才用网络记录兜底
  const vids = domResult.vids.length
    ? domResult.vids
    : [...new Set(domResult.res.map(pathOf))].map(
        (p) => domResult.res.find((u) => pathOf(u) === p)
      );
  vids.forEach((u, i) => {
    push(u, (base.dir || fallbackDir) + "/视频.mp4".replace(".mp4", (vids.length > 1 ? "_" + (i + 1) : "") + ".mp4"));
  });
  domResult.imgs.forEach((u, i) => {
    push(u, (base.dir || fallbackDir) + "/图" + (i + 1) + (/\.webp/i.test(u) ? ".webp" : ".jpg"));
  });

  return { dir: base.dir || fallbackDir, items };
}

// ============ 点击扩展图标 ============

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !/https?:\/\/(www\.)?douyin\.com/.test(tab.url)) {
    notify("请先在浏览器里打开 douyin.com 的内容页面，再点击本扩展。");
    return;
  }

  // --- 0. 从页面拿真实网址和内容 ID ---
  let pageUrl = tab.url;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.location.href,
    });
    if (results && results[0] && results[0].result) {
      pageUrl = results[0].result;
    }
  } catch (e) {}
  const id = parseAwemeId(pageUrl) || parseAwemeId(tab.url || "");

  // --- 1. 页面元素直读 + 短暂重试（等内容渲染） ---
  let dom = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: domExtract,
      });
      // 多个 frame 的结果合并（播放器可能在 iframe 里）
      const frames = results.map((r) => r.result).filter(Boolean);
      const merged = {
        vids: [...new Set(frames.flatMap((f) => f.vids))],
        imgs: [...new Set(frames.flatMap((f) => f.imgs))],
        res: [...new Set(frames.flatMap((f) => f.res))],
        diag: frames.map((f) => f.diag).join(" ‖ "),
      };
      if (merged.vids.length || merged.imgs.length || merged.res.length) {
        dom = merged;
        break;
      }
      dom = merged; // 记住最后一次结果用于诊断
    } catch (e) {
      dom = null;
    }
    if (attempt < 3) await sleep(1500);
  }

  if (!dom) {
    notify("无法读取页面内容，请刷新抖音页面后重试。");
    return;
  }

  // --- 2. 可选增强：接口详情，失败不影响下载 ---
  let detail = null;
  if (id) {
    try {
      const hooked = await chrome.tabs.sendMessage(tab.id, { type: "getDetail", id });
      if (hooked && hooked.aweme_id) detail = hooked;
    } catch (e) {}
    if (!detail) {
      try {
        detail = await fetchDetailFromBackground(id);
      } catch (e) {}
    }
    if (!detail) {
      try {
        detail = await fetchDetailFromPage(tab.id, id);
      } catch (e) {}
    }
  }

  const dir = "内容_" + (id || Date.now());
  let base = { dir, items: [] };
  if (detail) {
    base = buildItemsFromDetail(detail, id);
  }

  const merged = mergeItems(base, dom, dir);

  if (!merged.items.length) {
    let hint = "";
    if (dom.diag && /blob:[1-9]/.test(dom.diag)) {
      hint = "检测到流式视频，请先在页面点一下播放，再点击本扩展。";
    } else if (!/弹窗:有/.test(dom.diag)) {
      hint = "看起来内容窗口未打开：请点开视频/图文后立即点击本扩展。";
    } else {
      hint = "请播放几秒后再点击本扩展重试。";
    }
    notify("没有找到可下载的媒体。" + hint + " [诊断:" + dom.diag + "]");
    return;
  }

  // --- 3. 下载 ---
  // 视频直链有 Referer 校验：改由页面代抓成 blob 再保存；图片可直接下载。
  let failCount = 0;
  for (const it of merged.items) {
    const isVideo = /douyinvod\.com|\/video\/tos\//.test(it.url);
    let done = false;

    if (isVideo) {
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, {
          type: "fetchBlob",
          url: it.url,
        });
        if (resp && resp.ok && resp.blobUrl) {
          const dl = await chrome.downloads.download({
            url: resp.blobUrl,
            filename: "抖音下载/" + it.name,
            conflictAction: "uniquify",
          });
          chrome.tabs.sendMessage(tab.id, { type: "revoke", blobUrl: resp.blobUrl })
            .catch(() => {});
          done = !!dl;
        }
      } catch (e) {}
    }

    if (!done) {
      chrome.downloads.download(
        {
          url: it.url,
          filename: "抖音下载/" + it.name,
          conflictAction: "uniquify",
        },
        (downloadId) => {
          if (chrome.runtime.lastError || downloadId === undefined) {
            console.warn("下载失败:", it.name, chrome.runtime.lastError);
          }
        }
      );
      done = true; // 直接下载没有回调确认，先按已提交处理
    }
    if (!done) failCount++;
  }

  chrome.action.setBadgeBackgroundColor({ color: "#34c759", tabId: tab.id });
  chrome.action.setBadgeText({ text: String(merged.items.length), tabId: tab.id });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: "", tabId: tab.id });
  }, 8000);
});
