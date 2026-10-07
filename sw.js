/**
 * Service Worker：把整份应用缓存到本机，断网也能打开。
 *
 * 说明：这里**不**负责定时提醒。Service Worker 里没有可靠的定时器，
 * 页面关闭后无法自行唤醒——这是浏览器的硬性限制，不是没实现。
 * 关掉应用后仍要准时提醒，请用「设置 → 导出到系统日历」，
 * 由手机系统来排程。
 */

// v6：外壳改成「页面不滚动 + 内容区纵向滚动 + 标签栏固定在屏幕底边」，
// 并修掉课表图例漏闭合标签导致页面被撑宽的问题。老用户更新后要拿到新的
// css/app.css 与 js/app.js，所以缓存名必须跟着换。
const CACHE = 'campus-app-ios-v6';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/date.js',
  './js/periods.js',
  './js/store.js',
  './js/schedule.js',
  './js/reminder.js',
  './js/ics.js',
  './js/plan.js',
  './js/ui.js',
  './js/app.js',
  './js/android.js',
  './js/ios.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 页面发来「立即更新」时让新 SW 立刻接管。
// 没有这个监听的话，新 SW 会一直停在 waiting，要等所有旧标签页关掉才生效，
// 用户就会一直看到旧版本——这正是要解决的痛点。
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

/*
 * 策略：网络优先，失败时回落到缓存。
 *
 * 特意没用「缓存优先」：这个应用很小，联网时每次直接取最新的，
 * 改完刷新就能看到变化；断网时再用缓存，离线照样能打开。
 * 用缓存优先的话，更新要等下一次后台刷新才生效，容易让人以为没改到。
 */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // 只处理同源的静态资源，其他请求不插手
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then(cached => {
      if (cached) return cached;
      // 导航请求离线时退回首页
      if (req.mode === 'navigate') return caches.match('./index.html');
      return new Response('离线且没有缓存', { status: 504, statusText: 'offline' });
    }))
  );
});
