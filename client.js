/**
 * dsh-local-background —— 客户端半侧（浏览器）
 *
 * 图片**不打包在本文件里**：向宿主半侧取清单，再定时切换 background-image。
 *   GET  /dsh-local-background/list     → { dir, rotateMinutes, dim, surface, imageOpacity, files:[...] }
 *   GET  /dsh-local-background/img/<名> → 图片字节流
 *   GET  /dsh-local-background/pick     → 弹系统「选择文件夹」对话框
 *   POST /dsh-local-background/config   → 改配置，立即生效
 *   GET  /dsh-local-background/report   → 诊断上报（宿主写进用户目录的 report.log）
 *
 * CONFIG 区块里的是**兜底默认值**；服务器值（cordis.patch.yml + 用户目录的 settings.json）优先。
 * 目录里没有可用图片时 IMAGE 为空 = 插件一句背景样式都不注入，界面就是客户端自己的默认配色。
 *
 * 设置界面挂在「插件 → dsh-local-background → 配置」这一行的配置页上
 * （ui-plugin-manager 声明的 `plugins.row.config` 槽位，key = `<包名>#<行 id>`）。
 * 控件改动**就地生效并落盘**，不需要重启。
 *
 * DSH 客户端 bundle 外壳：window.__ModuleLoader__.load({ id, factory })
 */

(function () {
  /* ======================== CONFIG-BEGIN ======================== */
  // 兜底图：目录里没有图片 / 清单取不到时使用。
  // 留空 = **不画兜底渐变**，直接露出桌面客户端自己的默认底色（最干净，也不会串色）；
  // 想要一张固定的兜底图就填渐变或地址，例如 'linear-gradient(135deg,#0f2027,#2c5364)'。
  var IMAGE = '';
  // DIM = 背景图上的压暗遮罩，0 = 不压暗，1 = 全黑
  var DIM = 0.25;
  // SURFACE = 主面板不透明度，1 = 完全不透明（看不到背景），0 = 全透明（文字可能看不清）
  var SURFACE = 0.15;
  // IMAGE_OPACITY = 背景图自身的透明度，1 = 原图，0 = 完全看不见背景图
  var IMAGE_OPACITY = 1;
  // ROTATE_MINUTES = 每隔几分钟换一张；0 = 不轮换（只显示第一张）
  var ROTATE_MINUTES = 5;
  // SETTINGS_OPAQUE = 浮层（宿主「设置」弹窗、对话框、菜单等）是否用宿主的默认（不透明）背景，
  //                   否则字会浮在壁纸上、看不清；关掉则浮层也跟着一起半透明
  var SETTINGS_OPAQUE = true;
  /* ========================= CONFIG-END ========================= */

  var STYLE_ID = 'dsh-local-background-style';
  var PANEL_STYLE_ID = 'dsh-local-background-panel-style';
  var PROBE_KEY = 'dsh-local-background:probe';
  var DIAG_KEY = 'dsh-local-background:diag';
  var BASE_URL = '/dsh-local-background';
  var LIST_URL = BASE_URL + '/list';
  var IMG_URL = BASE_URL + '/img/';
  var REPORT_URL = BASE_URL + '/report';
  var CONFIG_URL = BASE_URL + '/config';
  var PICK_URL = BASE_URL + '/pick';
  var CLIENT_VERSION = 7;
  /** 设置页在「插件」页上的槽位 key：`<包名>#<cordis.patch.yml 里该行的 id>`。 */
  var ROW_KEY = 'dsh-local-background#dsh-local-background';
  /** 打在「本插件自己的配置页所在浮层」上的标记：带它的浮层继续透壁纸，其余浮层用默认不透明底色。 */
  var WALLPAPER_ATTR = 'data-dslb-wallpaper';

  var state = {
    dim: DIM,
    surface: SURFACE,
    imageOpacity: IMAGE_OPACITY,
    rotateMinutes: ROTATE_MINUTES,
    settingsOpaque: SETTINGS_OPAQUE,
    dir: '',
    files: 0,
    fileList: [],
    queue: [],
    lastImage: null,
    currentImage: null,
    serverError: '',
    mounting: false,
    mounts: 0,
    timer: null,
  };

  /** 设置页订阅用的监听器（设置页与背景渲染共享同一份 state）。 */
  var listeners = new Set();

  function notify() {
    listeners.forEach(function (fn) {
      try { fn(); } catch (e) { /* 单个监听器出错不影响别的 */ }
    });
  }

  function subscribe(fn) {
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }

  function write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 隐私模式等忽略 */ }
  }

  function probe(phase, extra) {
    var payload = {
      v: CLIENT_VERSION,
      phase: phase,
      at: new Date().toISOString(),
      mounted: state.mounts,
      files: state.files,
      rotateMinutes: state.rotateMinutes,
      currentImage: state.currentImage,
      serverError: state.serverError,
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) { payload[k] = extra[k]; }
      }
    }
    write(PROBE_KEY, payload);
  }

  /** 上报给宿主半侧，落进插件目录的 report.log —— 比 localStorage(leveldb) 可靠，便于宿主排查。 */
  function report(phase, detail) {
    try {
      if (typeof fetch !== 'function') { return; }
      var q = REPORT_URL
        + '?v=' + CLIENT_VERSION
        + '&phase=' + encodeURIComponent(phase)
        + '&detail=' + encodeURIComponent(detail == null ? '' : String(detail)).slice(0, 400);
      fetch(q, { cache: 'no-store' }).catch(function () { /* 上报失败不影响功能 */ });
    } catch (e) { /* 忽略 */ }
  }

  /** 真正加载一次图片，回报成功/失败 —— 用来区分「URL 取不到」与「取到了但没显示」。 */
  function preflight(url) {
    try {
      var im = new Image();
      im.onload = function () { report('img-ok', url + ' | ' + im.naturalWidth + 'x' + im.naturalHeight); };
      im.onerror = function () { report('img-error', url); };
      im.src = url;
    } catch (e) {
      report('img-except', String(e));
    }
  }

  /** 把「裸图片地址」包成 url()；已经是 url()/渐变的原样返回。
   * 裸地址（/path/x.jpg、data:...、https:...）直接写进 background-image 都是非法值，
   * 会让整条声明作废（计算值变成 none）—— 这是踩过两次的坑。 */
  function cssImage(value) {
    // 空值 = 「没有图可画」：此时**不要**输出 background-image，让桌面客户端自己的默认底色露出来
    // （输出 none 也能做到，但会连带清掉宿主在 html/body 上原有的背景层）。
    var v = String(value == null ? '' : value).trim();
    if (!v) { return null; }
    if (/^(url\(|none$|linear-gradient|radial-gradient|conic-gradient|repeating-linear-gradient|repeating-radial-gradient|repeating-conic-gradient|image-set)/i.test(v)) { return v; }
    return 'url("' + v + '")';
  }

  function num(value, fallback) {
    var n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp01(value, fallback) {
    var n = Number(value);
    if (!Number.isFinite(n)) { return fallback; }
    return Math.min(1, Math.max(0, n));
  }

  /** 本插件配置页所在的那支浮层（如果它确实渲染在浮层里的话）。
   *  给它打 WALLPAPER_ATTR，overlayCss 就会放过它 —— 那一页是调透明度的预览区，得看得见壁纸。
   *  宿主可能晚一步才把浮层插进 DOM、或复用节点重复挂载，所以用一个低频轮询兜住，
   *  而不是只在挂载那一刻找一次。 */
  var ownLayer = { el: null, marked: null, timer: 0 };

  function markOwnLayer(node) {
    var el = node;
    while (el && el.nodeType === 1) {
      var role = el.getAttribute ? el.getAttribute('role') : null;
      if (role === 'dialog' || role === 'menu') {
        if (ownLayer.marked !== el) {
          if (ownLayer.marked && ownLayer.marked.removeAttribute) {
            ownLayer.marked.removeAttribute(WALLPAPER_ATTR);
          }
          el.setAttribute(WALLPAPER_ATTR, '');
          ownLayer.marked = el;
        }
        return;
      }
      el = el.parentElement;
    }
  }

  function watchOwnLayer(node) {
    ownLayer.el = node;
    markOwnLayer(node);
    if (ownLayer.timer) { clearInterval(ownLayer.timer); }
    ownLayer.timer = setInterval(function () {
      if (ownLayer.el && ownLayer.el.isConnected) { markOwnLayer(ownLayer.el); }
    }, 400);
  }

  function unwatchOwnLayer() {
    if (ownLayer.timer) { clearInterval(ownLayer.timer); }
    ownLayer.timer = 0;
    ownLayer.el = null;
    if (ownLayer.marked && ownLayer.marked.removeAttribute) { ownLayer.marked.removeAttribute(WALLPAPER_ATTR); }
    ownLayer.marked = null;
  }

  /** 单独一支 CSS：把「浮层」的背景色重新指回宿主的默认不透明色。
   *
   *  为什么要这一段：壁纸是靠改 body 上的 --dsw-alias-bg-* 透出来的，而自定义属性会被
   *  弹窗/对话框/菜单这些浮层继承 —— 于是宿主自己的「设置」弹窗（背景是
   *  var(--dsw-alias-bg-layer-2)）也跟着半透明，字就看不清了（用户反馈的原问题）。
   *
   *  做法：给所有浮层（[role=dialog]、[role=menu]）重新声明这些别名，值直接用 static 色板
   *  （static token 不受我们在 body 上的覆盖影响），并且 !important 压过继承来的半透明值。
   *  只有本插件自己的配置页那支浮层带 WALLPAPER_ATTR 标记，被 :not() 排除在外 —— 那一页
   *  本来就是调透明度的预览区，得看得见壁纸。 */
  function overlayCss() {
    var light = [
      '--dsw-alias-bg-base: var(--dsw-static-neutral-bluish-00) !important;',
      '--dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-00) !important;',
      '--dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-00) !important;',
      '--dsw-specific-sidebar-fill: var(--dsw-static-neutral-bluish-50) !important;',
    ].join(' ');
    var dark = [
      '--dsw-alias-bg-base: var(--dsw-static-neutral-bluish-950) !important;',
      '--dsw-alias-bg-layer-1: var(--dsw-static-neutral-bluish-875) !important;',
      '--dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-850) !important;',
      '--dsw-specific-sidebar-fill: var(--dsw-static-neutral-bluish-900) !important;',
    ].join(' ');
    var sel = '[role="dialog"]:not([' + WALLPAPER_ATTR + ']), [role="menu"]:not([' + WALLPAPER_ATTR + '])';
    return [
      sel + ' { ' + light + ' }',
      '[data-ds-dark-theme] ' + sel + ' { ' + dark + ' }',
      '[data-ds-dark-theme]' + sel + ' { ' + dark + ' }',
    ].join('\n');
  }

  function buildCss(imageValue) {
    var image = cssImage(imageValue);
    // 没有图可画（目录为空 / 清单取不到 / IMAGE 留空）：返回空串 = 一支样式都不注入 ——
    // body 上的 --dsw-alias-bg-* 不再被改动，桌面客户端回到它自己的默认配色，
    // 不会留一个跟主题不搭的渐变。「弹窗恢复默认底色」那段此时也用不上，一并省掉。
    if (!image) { return ''; }
    var pct = Math.round(clamp01(state.surface, SURFACE) * 100) + '%';
    var veil = Math.round((1 - clamp01(state.imageOpacity, IMAGE_OPACITY)) * 100) + '%';
    var dim = clamp01(state.dim, DIM);
    var bg = [
      // 图层自下而上：图片 → 底色纱幕（按「背景图不透明度」加浓）→ 压暗遮罩。
      // 不透明度 = 1 时纱幕全透明，与旧版渲染完全一致。
      'html, body {',
      '  --dslb-veil: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) ' + veil + ', transparent);',
      '  background-image: linear-gradient(rgba(0,0,0,' + dim + '), rgba(0,0,0,' + dim + ')),',
      '    linear-gradient(var(--dslb-veil), var(--dslb-veil)),',
      '    ' + image + ' !important;',
      '  background-position: center center, center center, center center !important;',
      '  background-size: cover, cover, cover !important;',
      '  background-repeat: no-repeat, no-repeat, no-repeat !important;',
      '  background-attachment: fixed, fixed, fixed !important;',
      '}',
      // --dsw-alias-bg-base = 「Application base background」，透明化后图才露得出来。
      // layer-1/2 与 sidebar-fill 才是真正铺满视口的表层 —— 实测它们不透明时会把背景整个盖住，
      // 所以用 color-mix 保留原色值、只加透明度（明暗主题各自引用对应的 static token，不会串色）。
      'body {',
      '  --dsw-alias-bg-base: transparent !important;',
      '  --dsw-alias-bg-layer-1: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) ' + pct + ', transparent) !important;',
      '  --dsw-alias-bg-layer-2: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) ' + pct + ', transparent) !important;',
      '  --dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-50) ' + pct + ', transparent) !important;',
      '}',
      'body[data-ds-dark-theme] {',
      '  --dslb-veil: color-mix(in srgb, var(--dsw-static-neutral-bluish-875) ' + veil + ', transparent);',
      '  --dsw-alias-bg-base: transparent !important;',
      '  --dsw-alias-bg-layer-1: color-mix(in srgb, var(--dsw-static-neutral-bluish-875) ' + pct + ', transparent) !important;',
      '  --dsw-alias-bg-layer-2: color-mix(in srgb, var(--dsw-static-neutral-bluish-850) ' + pct + ', transparent) !important;',
      '  --dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-900) ' + pct + ', transparent) !important;',
      '}',
    ].join('\n');
    // 「弹窗用默认背景」关掉时就是插件原本的行为：浮层跟着一起半透明。
    return (state.settingsOpaque === false ? '' : overlayCss() + '\n') + bg;
  }

  function unmount() {
    if (typeof document === 'undefined') { return; }
    var old = document.getElementById(STYLE_ID);
    if (old && old.parentNode) { old.parentNode.removeChild(old); }
  }

  function mount(imageValue) {
    if (typeof document === 'undefined') { return false; }
    try {
      unmount();
      var css = buildCss(imageValue);
      // 空值 = 没有图可画：不注入样式（而不是注入一条空的 background-image），
      // 让桌面客户端自己的默认配色原样露出来。
      if (!css) { return false; }
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = css;
      (document.head || document.documentElement).appendChild(style);
      state.mounts += 1;
      var iv = String(imageValue == null ? '' : imageValue);
      report('mount', iv.slice(0, 90) + ' | imgOp=' + state.imageOpacity);
      if (iv.charAt(0) === '/' || /^https?:/i.test(iv)) { preflight(iv); }
      return true;
    } catch (e) {
      probe('mount-error', { message: String(e && e.message ? e.message : e) });
      report('mount-error', String(e && e.message ? e.message : e));
      return false;
    }
  }

  /** 当前该显示的图（有轮播结果就用它，否则用兜底渐变）。 */
  function currentImageValue() {
    return state.currentImage ? IMG_URL + encodeURIComponent(state.currentImage) : IMAGE;
  }

  /** 设置项变了就地重画 —— 这就是「改完马上看见效果」。 */
  function remount() {
    mount(currentImageValue());
  }

  /** Fisher–Yates 洗牌，尽量不把上一张排到下一轮第一个。 */
  function shuffle(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    if (a.length > 1 && a[0] === state.lastImage) {
      var tmp = a[0];
      a[0] = a[1];
      a[1] = tmp;
    }
    return a;
  }

  function nextImage() {
    if (state.queue.length === 0) {
      if (!state.fileList || state.fileList.length === 0) { return; }
      state.queue = shuffle(state.fileList);
    }
    var name = state.queue.shift();
    state.lastImage = name;
    state.currentImage = name;
    mount(IMG_URL + encodeURIComponent(name));
    probe('rotating', { queued: state.queue.length });
  }

  function stopRotation() {
    if (state.timer !== null) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function startRotation() {
    stopRotation();
    if (!state.fileList || state.fileList.length === 0) { return; }
    nextImage();
    var minutes = Number(state.rotateMinutes);
    if (!(minutes > 0) || state.fileList.length < 2) { notify(); return; }
    state.timer = setInterval(nextImage, Math.round(minutes * 60000));
    notify();
  }

  function loadList(attempt) {
    if (attempt === undefined) { attempt = 0; }
    if (typeof fetch !== 'function') { probe('no-fetch'); report('no-fetch'); return; }
    // 宿主路由可能比客户端 bundle 晚就绪：退避重试几次再放弃
    fetch(LIST_URL + '?t=' + Date.now() + '&attempt=' + attempt, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) { throw new Error('HTTP ' + res.status); }
        return res.text();
      })
      .then(function (text) {
        if (!text) { throw new Error('empty body'); }
        return JSON.parse(text);
      })
      .then(function (data) {
        if (data && Number.isFinite(Number(data.dim))) { state.dim = Number(data.dim); }
        if (data && Number.isFinite(Number(data.surface))) { state.surface = Number(data.surface); }
        if (data && Number.isFinite(Number(data.imageOpacity))) { state.imageOpacity = Number(data.imageOpacity); }
        if (data && Number.isFinite(Number(data.rotateMinutes))) { state.rotateMinutes = Number(data.rotateMinutes); }
        if (data && typeof data.settingsOpaque === 'boolean') { state.settingsOpaque = data.settingsOpaque; }
        state.dir = (data && data.dir) || '';
        state.serverError = (data && data.error) || '';
        state.fileList = (data && Array.isArray(data.files)) ? data.files : [];
        state.files = state.fileList.length;
        report('list-ok', state.files + ' files; rotate=' + state.rotateMinutes + '; dir=' + state.dir);
        if (state.files === 0) {
          // 目录里没图：收掉之前可能挂过的壁纸样式，交还给客户端默认配色
          state.currentImage = null;
          unmount();
          probe('fallback', { reason: state.serverError || '目录里没有图片' });
          notify();
          return;
        }
        state.queue = [];
        startRotation();
        probe('rotating', { queued: state.fileList.length });
      })
      .catch(function (error) {
        var message = String(error && error.message ? error.message : error);
        if (attempt < 5) {
          report('list-retry', 'attempt=' + attempt + '; ' + message);
          setTimeout(function () { loadList(attempt + 1); }, 400 * Math.pow(2, attempt));
          return;
        }
        unmount();
        report('list-fail', 'attempts=' + (attempt + 1) + '; ' + message);
        probe('list-error', { attempts: attempt + 1, message: message });
        notify();
      });
  }

  /** 三个控件的改动都走这里：先落盘，再把服务端认下来的值同步回本地并重画。 */
  function postConfig(patch) {
    if (typeof fetch !== 'function') { return Promise.reject(new Error('no fetch')); }
    return fetch(CONFIG_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(patch),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || data.ok !== true) { throw new Error((data && data.error) || '写入失败'); }
        if (Number.isFinite(Number(data.dim))) { state.dim = Number(data.dim); }
        if (Number.isFinite(Number(data.surface))) { state.surface = Number(data.surface); }
        if (Number.isFinite(Number(data.imageOpacity))) { state.imageOpacity = Number(data.imageOpacity); }
        if (Number.isFinite(Number(data.rotateMinutes))) { state.rotateMinutes = Number(data.rotateMinutes); }
        if (typeof data.settingsOpaque === 'boolean') { state.settingsOpaque = data.settingsOpaque; }
        if (typeof data.dir === 'string') { state.dir = data.dir; }
        report('config-ok', JSON.stringify(patch) + ' -> ' + JSON.stringify(data.applied || {}) + '; persisted=' + data.persisted);
        return data;
      });
  }

  /** 合并同一字段上的连续改动（拖滑杆时不要每像素发一次请求）。 */
  var pendingConfig = {};
  var pendingTimer = null;
  var pendingWaiters = [];

  function flushConfig() {
    var patch = pendingConfig;
    var waiters = pendingWaiters;
    pendingConfig = {};
    pendingWaiters = [];
    pendingTimer = null;
    var keys = Object.keys(patch);
    if (keys.length === 0) {
      waiters.forEach(function (w) { try { w.resolve(); } catch (e) { /* ignore */ } });
      return;
    }
    postConfig(patch).then(
      function () { waiters.forEach(function (w) { try { w.resolve(); } catch (e) { /* ignore */ } }); },
      function (error) { waiters.forEach(function (w) { try { w.reject(error); } catch (e) { /* ignore */ } }); },
    );
  }

  /** 排队一次写入；同一个字段的旧值会被新值覆盖。
   *  immediate = true 时立刻发（换目录必须这样：紧接着的 loadList 依赖宿主已切目录）。 */
  function queueConfig(patch, immediate) {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) { pendingConfig[k] = patch[k]; }
    }
    var promise = new Promise(function (resolve, reject) {
      pendingWaiters.push({ resolve: resolve, reject: reject });
    });
    if (pendingTimer !== null) { clearTimeout(pendingTimer); }
    pendingTimer = setTimeout(flushConfig, immediate ? 0 : 220);
    return promise;
  }

  // ---------- 诊断（供宿主机侧读 localStorage / report.log 排查）----------
  function desc(el) {
    var cs;
    try { cs = getComputedStyle(el); } catch (e) { return { tag: el.tagName, err: 'computedStyle' }; }
    var cls = '';
    try {
      if (typeof el.className === 'string') { cls = el.className; }
      else if (el.className && typeof el.className.baseVal === 'string') { cls = el.className.baseVal; }
    } catch (e) { /* ignore */ }
    return {
      tag: el.tagName,
      id: el.id || '',
      cls: String(cls).slice(0, 90),
      bg: cs.backgroundColor,
      bgImg: (cs.backgroundImage && cs.backgroundImage !== 'none') ? String(cs.backgroundImage).slice(0, 40) : '',
      pos: cs.position,
      z: cs.zIndex,
      op: cs.opacity,
      rect: (function () { try { var r = el.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); } catch (e) { return ''; } })(),
    };
  }

  function diagnose() {
    var out = { at: new Date().toISOString(), viewport: window.innerWidth + 'x' + window.innerHeight };
    try {
      var st = document.getElementById(STYLE_ID);
      out.stylePresent = !!st;
      try { out.styleRules = st && st.sheet ? st.sheet.cssRules.length : -1; } catch (e) { out.styleRules = 'blocked'; }
      out.bodyTokens = (function () {
        try {
          var cs = getComputedStyle(document.body);
          return {
            bgBase: cs.getPropertyValue('--dsw-alias-bg-base').trim(),
            layer1: cs.getPropertyValue('--dsw-alias-bg-layer-1').trim(),
            sidebarFill: cs.getPropertyValue('--dsw-specific-sidebar-fill').trim(),
          };
        } catch (e) { return 'err'; }
      })();
      out.backgroundImage = (function () {
        try { return String(getComputedStyle(document.body).backgroundImage).slice(0, 80); } catch (e) { return 'err'; }
      })();

      var chains = {};
      var points = {
        center: [window.innerWidth / 2, window.innerHeight / 2],
        topleft: [8, 8],
        bottom: [window.innerWidth / 2, window.innerHeight - 8],
      };
      for (var name in points) {
        if (!Object.prototype.hasOwnProperty.call(points, name)) { continue; }
        var el = document.elementFromPoint(points[name][0], points[name][1]);
        var arr = [];
        var guard = 0;
        while (el && guard++ < 20) { arr.push(desc(el)); el = el.parentElement; }
        chains[name] = arr;
      }
      out.chains = chains;

      // 扫描铺满视口且不透明的元素 —— 这些就是挡住背景的元凶
      out.opaquePainters = (function () {
        var res = [];
        try {
          var all = document.querySelectorAll('body *');
          var vw = window.innerWidth;
          var vh = window.innerHeight;
          for (var i = 0; i < all.length && res.length < 15; i++) {
            var el = all[i];
            var cs = getComputedStyle(el);
            var bg = cs.backgroundColor || '';
            if (bg === '' || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') { continue; }
            var alpha = 1;
            var m = bg.match(/rgba?\(([^)]+)\)/);
            if (m) { var ps = m[1].split(','); if (ps.length === 4) { alpha = parseFloat(ps[3]); } }
            var cm = bg.match(/\/\s*([0-9.]+)\s*\)/);
            if (cm) { alpha = parseFloat(cm[1]); }
            if (alpha < 0.9) { continue; }
            var r = el.getBoundingClientRect();
            if (r.width * r.height < vw * vh * 0.8) { continue; }
            var d = desc(el);
            d.alpha = alpha;
            d.vp = Math.round(r.width * r.height / (vw * vh) * 100) + '%';
            res.push(d);
          }
        } catch (e) { res.push({ err: String(e) }); }
        return res;
      })();
    } catch (e) {
      out.error = String(e && e.message ? e.message : e);
    }
    return out;
  }

  // ==================== 设置页（插件 → dsh-local-background → 配置）====================
  // 只用 DSH 客户端**基线模块**（react 等都在平台种子表里），所以不需要任何构建步骤。

  var TOKENS = {
    text: 'var(--dsw-alias-label-primary, currentColor)',
    sub: 'var(--dsw-alias-label-secondary, currentColor)',
    border: 'var(--dsw-alias-border-l4, rgba(128,128,128,.35))',
    field: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12))',
    accent: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
  };

  var rowStyle = { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', flexWrap: 'wrap' };
  var labelStyle = { minWidth: '150px', fontSize: '13px', color: TOKENS.text };
  var hintStyle = { fontSize: '12px', color: TOKENS.sub, margin: '2px 0 0' };
  var inputStyle = {
    flex: '1 1 260px', minWidth: '220px', boxSizing: 'border-box',
    padding: '6px 8px', fontSize: '13px', fontFamily: 'inherit',
    color: TOKENS.text, background: TOKENS.field,
    border: '1px solid ' + TOKENS.border, borderRadius: '6px',
  };
  var buttonStyle = {
    padding: '6px 12px', fontSize: '13px', fontFamily: 'inherit', cursor: 'pointer',
    color: TOKENS.text, background: TOKENS.field,
    border: '1px solid ' + TOKENS.border, borderRadius: '6px',
  };
  var rangeStyle = { flex: '1 1 220px', minWidth: '180px', accentColor: TOKENS.accent };
  var readoutStyle = { minWidth: '48px', fontSize: '12px', color: TOKENS.sub, fontVariantNumeric: 'tabular-nums' };
  var sectionStyle = { marginTop: '18px' };
  var sectionTitleStyle = { fontSize: '13px', fontWeight: 600, color: TOKENS.text, margin: '0 0 2px' };

  /** 一个「滑杆 + 百分比」控件。 */
  function PercentRow(props) {
    var React = props.React;
    return React.createElement('div', { style: rowStyle },
      React.createElement('div', { style: { flex: '1 1 100%' } },
        React.createElement('div', { style: labelStyle }, props.label),
        props.hint ? React.createElement('p', { style: hintStyle }, props.hint) : null),
      React.createElement('input', {
        type: 'range', min: 0, max: 100, step: 1,
        style: rangeStyle,
        value: Math.round(props.value * 100),
        disabled: !!props.disabled,
        onChange: function (event) { props.onChange(Number(event.target.value) / 100); },
      }),
      React.createElement('span', { style: readoutStyle }, Math.round(props.value * 100) + '%'));
  }

  /** 设置页组件：`view === 'summary'` 时只给一行摘要。 */
  function makeSettingsPage(React) {
    return function SettingsPage(props) {
      var view = props && props.view;
      var React_ = React;
      var rootRef = React_.useRef(null);
      var pair = React_.useState(null);
      var snapshot = pair[0];
      var setSnapshot = pair[1];
      var statusPair = React_.useState('');
      var status = statusPair[0];
      var setStatus = statusPair[1];
      var savingPair = React_.useState(false);
      var saving = savingPair[0];
      var setSaving = savingPair[1];

      /** 把渲染状态同步成组件可见的快照。 */
      var sync = React_.useCallback(function () {
        setSnapshot({
          dim: state.dim,
          surface: state.surface,
          imageOpacity: state.imageOpacity,
          rotateMinutes: state.rotateMinutes,
          settingsOpaque: state.settingsOpaque,
          dir: state.dir,
          files: state.files,
          error: state.serverError,
        });
      }, []);

      React_.useEffect(function () {
        sync();
        var off = subscribe(sync);
        // 页面打开时顺手刷一次清单，保证显示的目录/张数是当下的
        loadList();
        return off;
      }, [sync]);

      // 本插件自己的配置页：给它所在的浮层打上 WALLPAPER_ATTR。
      // 其它浮层（宿主「设置」弹窗、通用 Modal、菜单）会被 overlayCss 拉回默认不透明底色，
      // 唯独这一层要继续透着壁纸 —— 不然调「面板不透明度」滑杆时看不见效果。
      // 依赖里带上 hasSnapshot：首次渲染 snapshot 还是 null（那时只画「正在读取…」、根 div 还没挂上），
      // 等清单回来重渲染出根 div 后要再看一眼，否则会永远错过这一页。
      var hasSnapshot = !!snapshot;
      React_.useEffect(function () {
        if (view === 'summary' || !hasSnapshot) { return undefined; }
        watchOwnLayer(rootRef.current);
        return unwatchOwnLayer;
      }, [view, hasSnapshot]);

      /** 改动统一入口：先就地生效（立刻看见），再落盘。
       *  返回写入的 Promise —— 换目录时要等它落定再 loadList，否则宿主还是旧目录。 */
      var change = React_.useCallback(function (patch, preview) {
        // 换目录时不重挂：旧目录的图在新目录里多半不存在，重挂只会闪一下空白；
        // 紧接着的 loadList() 会取回新目录的图并自己挂上。
        if (preview) {
          preview();
          if (!('dir' in patch)) { remount(); }
          sync();
        }
        setSaving(true);
        var done = queueConfig(patch, 'dir' in patch)
          .then(function () { setStatus(''); })
          .catch(function (error) {
            setStatus('写入失败：' + String(error && error.message ? error.message : error));
          })
          .then(function () { setSaving(false); sync(); });
        return done;
      }, [sync]);

      if (view === 'summary') {
        var s = snapshot;
        if (!s) { return React_.createElement('span', null, '本地壁纸'); }
        var parts = [];
        parts.push(s.dir ? s.dir : '未选择文件夹');
        if (s.files) { parts.push(s.files + ' 张'); }
        parts.push('背景图 ' + Math.round(s.imageOpacity * 100) + '%');
        return React_.createElement('span', null, parts.join(' · '));
      }

      if (!snapshot) {
        return React_.createElement('p', { style: hintStyle }, '正在读取当前设置…');
      }

      /** 选择文件夹：弹系统的文件夹对话框（远程 / 无显示环境时宿主会直接说不支持）。 */
      var chooseFolder = function () {
        setStatus('正在打开选择窗口…');
        fetch(PICK_URL, { cache: 'no-store' })
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (data && data.path) {
              setStatus('');
              change({ dir: data.path }, function () { state.dir = data.path; }).then(loadList);
              return;
            }
            if (data && data.supported === false) {
              setStatus('这台机器上没有可用的系统文件夹对话框（远程 / 无显示环境），请在上面的输入框里直接填绝对路径。');
              return;
            }
            if (data && data.cancelled) { setStatus('已取消。'); return; }
            setStatus('打开失败：' + ((data && data.error) || '未知原因'));
          })
          .catch(function (error) { setStatus('打开失败：' + String(error && error.message ? error.message : error)); });
      };

      var children = [];
      children.push(React_.createElement('p', { key: 'lead', style: hintStyle },
        '改动会立刻生效，并写进用户目录的 settings.json（不用重启）。'));

      // —— 壁纸文件夹 ——
      children.push(React_.createElement('div', { key: 'dir', style: sectionStyle },
        React_.createElement('div', { style: rowStyle },
          React_.createElement('div', { style: labelStyle }, '壁纸文件夹'),
          React_.createElement('input', {
            type: 'text', style: inputStyle, spellCheck: false,
            value: snapshot.dir || '',
            placeholder: '例如 C:\\Users\\你的用户名\\Pictures',
            onChange: function (event) { state.dir = event.target.value; sync(); },
            onBlur: function (event) {
              var next = event.target.value.trim();
              if (next === snapshot.dir) { return; }
              change({ dir: next }, function () { state.dir = next; }).then(loadList);
            },
          }),
          React_.createElement('button', {
            type: 'button', style: buttonStyle, onClick: chooseFolder,
          }, '选择文件夹…'),
          React_.createElement('button', {
            type: 'button', style: buttonStyle,
            onClick: function () { loadList(); setStatus('已重新读取。'); },
          }, '重新读取'))));

      // —— 背景图 ——
      children.push(React_.createElement('div', { key: 'bg', style: sectionStyle },
        React_.createElement('h4', { style: sectionTitleStyle }, '背景图'),
        React_.createElement(PercentRow, {
          React: React_, label: '背景图不透明度',
          hint: '0% = 完全看不见背景图，100% = 原图',
          value: snapshot.imageOpacity,
          onChange: function (v) { change({ imageOpacity: v }, function () { state.imageOpacity = v; }); },
        }),
        React_.createElement(PercentRow, {
          React: React_, label: '背景压暗',
          hint: '在背景图上盖一层黑，越大越暗（0% = 不压暗）',
          value: snapshot.dim,
          onChange: function (v) { change({ dim: v }, function () { state.dim = v; }); },
        })));

      // —— 界面 ——
      children.push(React_.createElement('div', { key: 'ui', style: sectionStyle },
        React_.createElement('h4', { style: sectionTitleStyle }, '界面'),
        React_.createElement(PercentRow, {
          React: React_, label: '面板不透明度',
          hint: '面板越透明，越能看见背景图；0% 时文字可能看不清',
          value: snapshot.surface,
          onChange: function (v) { change({ surface: v }, function () { state.surface = v; }); },
        }),
        React_.createElement('div', { style: rowStyle },
          React_.createElement('div', { style: { flex: '1 1 100%' } },
            React_.createElement('div', { style: labelStyle }, '自动轮换'),
            React_.createElement('p', { style: hintStyle }, '每隔几分钟换一张；0 = 不轮换')),
          React_.createElement('input', {
            type: 'number', min: 0, max: 1440, step: 1,
            style: { ...inputStyle, flex: '0 0 90px', minWidth: '90px' },
            value: snapshot.rotateMinutes,
            onChange: function (event) {
              var v = Math.max(0, Math.min(1440, Math.round(Number(event.target.value) || 0)));
              change({ rotateMinutes: v }, function () { state.rotateMinutes = v; });
            },
          }),
          React_.createElement('span', { style: readoutStyle }, '分钟'))));

      // —— 浮层（弹窗 / 对话框 / 菜单）的背景 ——
      children.push(React_.createElement('div', { key: 'pagebg', style: sectionStyle },
        React_.createElement('h4', { style: sectionTitleStyle }, '弹窗背景'),
        React_.createElement('div', { style: rowStyle },
          React_.createElement('input', {
            type: 'checkbox', id: 'dslb-settings-opaque',
            checked: snapshot.settingsOpaque !== false,
            onChange: function (event) {
              var v = event.target.checked === true;
              change({ settingsOpaque: v }, function () { state.settingsOpaque = v; });
            },
          }),
          React_.createElement('label', {
            htmlFor: 'dslb-settings-opaque',
            style: { fontSize: '13px', color: TOKENS.text, cursor: 'pointer' },
          }, '弹窗用默认（不透明）背景'),
          React_.createElement('p', {
            style: { ...hintStyle, flex: '1 1 100%' },
          }, '勾上：宿主「设置」等弹窗按默认底色显示，字更清楚。取消勾选：弹窗也跟着半透明。'))));

      // —— 状态 ——
      var statusLine = status
        || (saving ? '正在写入…' : '')
        || (snapshot.error ? '宿主报告：' + snapshot.error : '')
        || ('当前目录 ' + (snapshot.files || 0) + ' 张图片');
      children.push(React_.createElement('p', {
        key: 'status',
        style: { marginTop: '16px', fontSize: '12px', color: snapshot.error ? 'var(--dsw-alias-state-warning-primary, #d98600)' : TOKENS.sub },
      }, statusLine));

      return React_.createElement('div', { ref: rootRef, style: { maxWidth: '640px' } }, children);
    };
  }

  /** 把设置页挂到「插件」页该行的配置槽位上。 */
  function registerSettingsPage(ctx, React) {
    var slots = ctx && ctx.slots;
    if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
      report('settings-noslots', 'ctx.slots 不可用');
      return;
    }
    var Page = makeSettingsPage(React);
    var unregister = null;
    try {
      ctx.effect(function () {
        var off = slots.inject('plugins.row.config', function () {
          unregister = slots.register({
            name: 'plugins.row.config',
            key: ROW_KEY,
          }, Page);
          report('settings-page', 'registered ' + ROW_KEY);
        });
        return function () {
          try { if (typeof unregister === 'function') { unregister(); } } catch (e) { /* ignore */ }
          try { if (typeof off === 'function') { off(); } } catch (e) { /* ignore */ }
        };
      }, 'dsh-local-background: settings page');
    } catch (error) {
      report('settings-error', String(error && error.message ? error.message : error));
    }
  }

  /** 设置页自身的一点点样式（滑杆外观），只注入一次。 */
  function mountPanelStyle() {
    try {
      if (typeof document === 'undefined' || document.getElementById(PANEL_STYLE_ID)) { return; }
      var style = document.createElement('style');
      style.id = PANEL_STYLE_ID;
      style.textContent = [
        'input[type="range"] { height: 4px; cursor: pointer; }',
        'input[type="number"] { text-align: center; }',
      ].join('\n');
      (document.head || document.documentElement).appendChild(style);
    } catch (e) { /* ignore */ }
  }

  // ---------- 启动 ----------
  report('boot', 'client v' + CLIENT_VERSION + '; origin=' + String(location && location.origin));

  // ① 先挂一次：目录里已经有图就把图顶上；还没有（或还没取到清单）就什么也不改，
  //    界面保持桌面客户端自己的默认配色，不会闪一下渐变。
  mount(currentImageValue());
  probe('boot');

  // ② 注册 factory（DSH 客户端模块约定）
  var loader = typeof window !== 'undefined' ? window.__ModuleLoader__ : undefined;
  if (loader && typeof loader.load === 'function') {
    loader.load({
      id: 'dsh-local-background',
      factory: function (require) {
        var module = { exports: {} };
        var exports = module.exports;
        exports.name = 'dsh-local-background';
        exports.inject = ['slots'];
        exports.apply = function (ctx) {
          mount(currentImageValue());
          var React;
          try {
            React = typeof require === 'function' ? require('react') : undefined;
          } catch (error) {
            report('react-missing', String(error && error.message ? error.message : error));
          }
          if (!React || typeof React.createElement !== 'function') {
            report('settings-noreact', 'require("react") 没拿到 React');
            return;
          }
          mountPanelStyle();
          registerSettingsPage(ctx, React);
        };
        return module.exports;
      },
    });
  } else {
    probe('no-loader', { loaderType: typeof loader });
    report('no-loader', 'loaderType=' + typeof loader);
  }

  // ③ 取清单并开始轮播
  loadList();

  // ④ 界面渲染完抓一次 DOM 诊断
  setTimeout(function () {
    write(DIAG_KEY, diagnose());
    report('diag', 'styleRules=' + (function () {
      try { var st = document.getElementById(STYLE_ID); return st && st.sheet ? st.sheet.cssRules.length : -1; } catch (e) { return 'blocked'; }
    })() + '; ownLayer=' + (ownLayer.marked ? 'marked' : 'none') + '; bgImg=' + (function () {
      try { return String(getComputedStyle(document.body).backgroundImage).slice(0, 50); } catch (e) { return 'err'; }
    })());
  }, 2500);
})();
