/**
 * dsh-local-background —— 宿主半侧（Node / ESM）
 *
 * 职责：把「一个装着壁纸的本地文件夹」变成一个同源 HTTP 接口，供客户端半侧取用。
 * 这样图片**不需要打包进 client.js**，可以随便加减、保持原画质。
 *
 * 提供的路由（都挂在 DSH 自带 webServer 上，只监听回环地址）：
 *   GET  /dsh-local-background/list             → { dir, rotateMinutes, dim, surface, imageOpacity, files:[...] }
 *   GET  /dsh-local-background/img/<文件名>      → 图片字节流（Content-Type 按扩展名）
 *   GET  /dsh-local-background/pick             → 打开系统「选择文件夹」对话框，返回 { path }
 *   GET  /dsh-local-background/dirs?path=<绝对路径> → { path, parent, dirs:[子目录名] }（内置浏览器的后备）
 *   POST /dsh-local-background/config           → 写入 { dir?, dim?, surface?, imageOpacity?, rotateMinutes? }，立即生效并落盘
 *   GET  /dsh-local-background/report           → 客户端诊断上报（写进用户态目录的 report.log）
 *
 * 配置来源（后者覆盖前者）：
 *   ① profile 的 cordis.patch.yml 里该条目的 config（dir / rotateMinutes / dim / surface / imageOpacity）
 *   ② 用户态目录里的 settings.json —— 插件界面里改的值写在这里，**改完立刻生效，不需要重启**
 *      （老版本写在插件目录里，那份仍在就会一并读回来兜底）
 *
 * 安全：只服务 dir 里的图片；做了 basename 归一化 + 真实路径前缀校验，挡掉路径穿越；
 *       只放行图片扩展名。DSH 的 webServer 仅监听回环地址。
 */

import { createReadStream, readFileSync } from 'node:fs';
import { appendFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件名（与 package.json name、cordis.patch.yml 的 id 一致）。 */
export const name = 'dsh-local-background';

/** 需要 DSH 的 webServer 服务。 */
export const inject = ['webServer'];

/** 允许的图片扩展名 → MIME。 */
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 用户数据的家目录：**不要**放进 PLUGIN_DIR / node_modules。
 *
 * 从市场安装的插件物理落在 `…/node_modules/dsh-local-background/`，那里会在
 * 升级时被整个换掉；而且 PLUGIN_DIR 里的 settings.json 会被打进发布包，
 * 等于把作者自己的壁纸路径发给了每一个用户。
 *
 * 所以运行时状态一律写到用户态目录（和 dsh-pet 写 `~/.dsh/pet.json` 同理）：
 *   $DSH_HOME/dsh-local-background/  （缺省 ~/.dsh/dsh-local-background/）
 */
const DATA_HOME = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-local-background');
const DATA_HOME_READY = mkdir(DATA_HOME, { recursive: true }).catch(() => {});

const LIST_PATH = '/dsh-local-background/list';
const IMG_PREFIX = '/dsh-local-background/img';
const REPORT_PATH = '/dsh-local-background/report';
const CONFIG_PATH = '/dsh-local-background/config';
const PICK_PATH = '/dsh-local-background/pick';
const DIRS_PATH = '/dsh-local-background/dirs';

/** 插件界面里改过的值：写在用户态目录，升级插件不会被清掉，也不会随发布包外泄。 */
const SETTINGS_FILE = join(DATA_HOME, 'settings.json');
/** 客户端上报落盘的文件：同样写在用户态目录，不污染插件目录。 */
const REPORT_LOG = join(DATA_HOME, 'report.log');

/** 老版本把这两个文件放在 PLUGIN_DIR 里，读的时候兜底回去一层，保证升级不掉配置。 */
const LEGACY_SETTINGS_FILE = join(PLUGIN_DIR, 'settings.json');

/** 兜底默认值（与 client.js 的 CONFIG 区块保持一致）。 */
const DEFAULTS = { rotateMinutes: 5, dim: 0.45, surface: 0.72, imageOpacity: 1 };

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

function clampMinutes(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1440, Math.max(0, Math.round(n)));
}

function readSettingsFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 读已保存的配置。
 *
 * 优先 `<DATA_HOME>/settings.json`；老版本写在插件目录里，那份仍然存在就一并读回来
 * （新值覆盖旧值），这样从旧版升级不会丢掉已经选好的壁纸目录。
 */
function readSettings() {
  return { ...readSettingsFile(LEGACY_SETTINGS_FILE), ...readSettingsFile(SETTINGS_FILE) };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJsonBody(request) {
  let text = '';
  try {
    for await (const chunk of request) {
      text += chunk;
      if (text.length > 65536) return undefined;
    }
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 把 URL 里的文件名归一化成 dir 下的一个真实图片路径。
 * @returns 绝对路径，或 undefined（非法 / 越界 / 非图片 / 不存在）
 */
async function resolveImage(dir, rawName) {
  if (!dir) return undefined;
  let name;
  try {
    // URL 里的中文与特殊字符是百分号编码的
    name = decodeURIComponent(rawName);
  } catch {
    return undefined;
  }
  // basename 剥掉任何目录成分：`../a.jpg`、`..\\a.jpg`、`/etc/x` 都退化成纯文件名
  name = basename(name.replaceAll('\\', '/'));
  if (!name || name.startsWith('.')) return undefined;
  if (!MIME[extname(name).toLowerCase()]) return undefined;

  const root = resolve(dir);
  const full = resolve(join(root, name));
  // 真实路径必须仍在根目录内，再兜一层
  if (full !== join(root, name) || !full.startsWith(root + sep)) return undefined;

  try {
    const info = await stat(full);
    if (!info.isFile()) return undefined;
  } catch {
    return undefined;
  }
  return full;
}

/**
 * 取目录选择器服务的能力对象。
 * 该服务由 `@deepseek-ai/dsh-host-directory-picker-auto` 挂载：
 * 本机回环 + 非 SSH 时是 `native`（真的弹系统文件夹对话框），否则是 `browse`。
 * @returns {{kind: string, pick?: (signal: AbortSignal) => Promise<string | null>} | undefined}
 */
function pickerCapability(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('directoryPicker') : undefined;
    if (!service || typeof service.capability !== 'function') return undefined;
    const capability = service.capability();
    return capability && typeof capability === 'object' ? capability : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 宿主侧装配。
 * @param ctx 宿主 Context（本插件 inject 了 webServer）
 * @param config cordis.patch.yml 中该条目的 config
 */
export function apply(ctx, config) {
  // —— 生效配置：profile config 打底，settings.json（插件界面里改过的）覆盖 ——
  const live = {
    dir: typeof config?.dir === 'string' ? config.dir : '',
    rotateMinutes: clampMinutes(config?.rotateMinutes, DEFAULTS.rotateMinutes),
    dim: clamp01(config?.dim, DEFAULTS.dim),
    surface: clamp01(config?.surface, DEFAULTS.surface),
    imageOpacity: clamp01(config?.imageOpacity, DEFAULTS.imageOpacity),
  };
  const saved = readSettings();
  if (typeof saved.dir === 'string') live.dir = saved.dir;
  live.rotateMinutes = clampMinutes(saved.rotateMinutes, live.rotateMinutes);
  live.dim = clamp01(saved.dim, live.dim);
  live.surface = clamp01(saved.surface, live.surface);
  live.imageOpacity = clamp01(saved.imageOpacity, live.imageOpacity);

  const webServer = ctx?.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    ctx?.logger?.warn?.('[dsh-local-background] 未拿到 webServer 服务，背景图接口未注册。');
    return;
  }

  const disposers = [];
  const register = (route) => {
    const dispose = webServer.register(route);
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  /** 当前生效值的对外投影。picker 让设置页知道要不要显示「选择文件夹…」。 */
  const snapshot = (extra) => ({
    dir: live.dir,
    rotateMinutes: live.rotateMinutes,
    dim: live.dim,
    surface: live.surface,
    imageOpacity: live.imageOpacity,
    picker: pickerCapability(ctx)?.kind ?? null,
    files: [],
    ...extra,
  });

  // ① 图片清单 + 生效配置
  register({
    kind: 'exact',
    path: LIST_PATH,
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      if (!live.dir) {
        sendJson(response, 200, snapshot({ error: '还没有选择壁纸文件夹' }));
        return;
      }
      try {
        const entries = await readdir(live.dir, { withFileTypes: true });
        const files = entries
          .filter((entry) => entry.isFile() && MIME[extname(entry.name).toLowerCase()])
          .map((entry) => entry.name)
          .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        sendJson(response, 200, snapshot({ files }));
      } catch (error) {
        sendJson(response, 200, snapshot({
          error: `读取目录失败：${error instanceof Error ? error.message : String(error)}`,
        }));
      }
    },
  });

  // ② 图片字节流。注意：prefix 路由的 path **不能以 `/` 结尾**
  //    （DSH 用 `${prefix}/` 做 startsWith 匹配，带尾斜杠只会匹配到双斜杠 URL）。
  register({
    kind: 'prefix',
    path: IMG_PREFIX,
    handler: async (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD' });
        response.end();
        return;
      }
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const rawName = pathname.slice(IMG_PREFIX.length).replace(/^\/+/, '');
      const full = await resolveImage(live.dir, rawName);
      if (!full) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return;
      }
      let info;
      try {
        info = await stat(full);
      } catch {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return;
      }
      response.writeHead(200, {
        'content-type': MIME[extname(full).toLowerCase()],
        'content-length': info.size,
        'cache-control': 'no-cache',
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      const stream = createReadStream(full);
      stream.on('error', () => response.destroy());
      stream.pipe(response);
    },
  });

  // ③ 打开系统「选择文件夹」对话框（官方 directoryPicker 服务的 native 能力）
  register({
    kind: 'exact',
    path: PICK_PATH,
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      const capability = pickerCapability(ctx);
      if (!capability || capability.kind !== 'native' || typeof capability.pick !== 'function') {
        sendJson(response, 200, {
          supported: false,
          reason: '本机没有可用的系统文件夹对话框（远程/无显示环境）',
        });
        return;
      }
      try {
        // 对话框是模态的，用户不选完不会返回；这里给它一个真实的可中止信号
        const path = await capability.pick(new AbortController().signal);
        if (typeof path !== 'string' || path.length === 0) {
          sendJson(response, 200, { supported: true, cancelled: true });
          return;
        }
        sendJson(response, 200, { supported: true, path });
      } catch (error) {
        sendJson(response, 200, {
          supported: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  // ④ 目录浏览（系统对话框不可用时的后备；只列子目录，不读文件内容）
  register({
    kind: 'exact',
    path: DIRS_PATH,
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' });
        response.end();
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      // 前端不拼路径：给它一个 base + child，由宿主用平台分隔符连接
      const child = url.searchParams.get('child') || '';
      const base = url.searchParams.get('path') || live.dir || '';
      let requested = base;
      if (child && base) {
        const leaf = basename(child.replaceAll('\\', '/'));
        if (!leaf || leaf === '.' || leaf === '..') {
          sendJson(response, 200, { path: base, parent: null, dirs: [], error: '非法的子目录名' });
          return;
        }
        requested = join(base, leaf);
      }
      if (!requested) { requested = homedir(); }
      const context = { separator: sep, home: homedir() };
      if (!isAbsolute(requested)) {
        sendJson(response, 200, {
          ...context,
          path: requested,
          parent: null,
          dirs: [],
          error: '需要一个绝对路径',
        });
        return;
      }
      const target = resolve(requested);
      try {
        const entries = await readdir(target, { withFileTypes: true });
        const dirs = entries
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
          .map((entry) => entry.name)
          .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
        const parent = dirname(target);
        sendJson(response, 200, {
          ...context,
          path: target,
          parent: parent === target ? null : parent,
          dirs,
        });
      } catch (error) {
        const parent = dirname(target);
        sendJson(response, 200, {
          ...context,
          path: target,
          parent: parent === target ? null : parent,
          dirs: [],
          error: `读取目录失败：${error instanceof Error ? error.message : String(error)}`,
        });
      }
    },
  });

  // ⑤ 写入配置：立即生效（内存）+ 落盘（settings.json），改完不用重启
  register({
    kind: 'exact',
    path: CONFIG_PATH,
    handler: async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      const patch = await readJsonBody(request);
      if (!patch) {
        sendJson(response, 400, { ok: false, error: '请求体不是合法 JSON' });
        return;
      }
      const applied = {};
      if (typeof patch.dir === 'string') {
        live.dir = patch.dir.trim();
        applied.dir = live.dir;
      }
      if (patch.dim !== undefined) {
        live.dim = clamp01(patch.dim, live.dim);
        applied.dim = live.dim;
      }
      if (patch.surface !== undefined) {
        live.surface = clamp01(patch.surface, live.surface);
        applied.surface = live.surface;
      }
      if (patch.imageOpacity !== undefined) {
        live.imageOpacity = clamp01(patch.imageOpacity, live.imageOpacity);
        applied.imageOpacity = live.imageOpacity;
      }
      if (patch.rotateMinutes !== undefined) {
        live.rotateMinutes = clampMinutes(patch.rotateMinutes, live.rotateMinutes);
        applied.rotateMinutes = live.rotateMinutes;
      }

      let persisted = true;
      try {
        await DATA_HOME_READY;
        await writeFile(
          SETTINGS_FILE,
          JSON.stringify(
            {
              dir: live.dir,
              dim: live.dim,
              surface: live.surface,
              imageOpacity: live.imageOpacity,
              rotateMinutes: live.rotateMinutes,
            },
            null,
            2,
          ) + '\n',
          'utf8',
        );
      } catch {
        persisted = false;
      }
      sendJson(response, 200, { ok: true, persisted, applied, ...snapshot() });
    },
  });

  // ⑥ 客户端上报：把 query 原样追加到 report.log（诊断用，只写本地文件）
  register({
    kind: 'exact',
    path: REPORT_PATH,
    handler: async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const line = new Date().toISOString() + '  ' + (url.search.slice(1) || '(empty)');
      try {
        await DATA_HOME_READY;
        await appendFile(REPORT_LOG, line + '\n', 'utf8');
      } catch {
        /* 写不进去也不影响页面 */
      }
      sendJson(response, 200, { ok: true });
    },
  });

  // 卸载时撤销路由
  ctx.effect(() => () => {
    while (disposers.length > 0) {
      try {
        disposers.pop()();
      } catch {
        /* 撤销失败不影响卸载 */
      }
    }
  }, 'dsh-local-background: routes');
}
