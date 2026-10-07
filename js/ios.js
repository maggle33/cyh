/**
 * iOS（PWA）适配层
 *
 * 与 android.js 是同一套思路：普通浏览器里**完全空转**。
 * 这里只在「iOS + 已添加到主屏幕（standalone）」或 iOS Safari 下才做事，
 * 所以网页版、安卓版、iOS 版共用同一套 campus-app 代码，不需要分叉。
 *
 * 它负责四件 iOS 特有问题：
 *   1. 安全区（刘海 / 灵动岛 / 底部 Home 指示条）——通过 body 上的 class 暴露给 CSS
 *   2. 主屏幕安装引导——iOS Safari 不弹安装横幅，只能自己提示「分享 → 添加到主屏幕」
 *   3. 键盘弹起时修正视口高度——iOS 的 100vh 在键盘弹出时不会收缩，会把内容顶飞
 *   4. 页面从后台回到前台时补检提醒——iOS 会冻结后台页面，setInterval 不可靠
 *
 * 注意：iOS **不支持** Notification API（Safari 里未暴露给网页），也不支持
 * navigator.vibrate。所以在这两个能力上只能诚实降级：提醒靠「应用打开时的
 * 页面内弹窗」+「导出到系统日历」。这和 android.js 里调用原生通知是本质区别，
 * 因为 PWA 没有原生层可以借力。
 */

(function (global) {
  'use strict';

  const doc = global.document;
  const nav = global.navigator || {};

  /* ---------------- 环境判定 ---------------- */

  const ua = nav.userAgent || '';

  /** 是不是 iOS 设备（iPhone / iPad / iPod）。
   *  注意：iPadOS 13+ 的 Safari 会伪装成 Mac，所以还要看触摸点数。 */
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);

  /** 是不是从主屏幕启动的（display: standalone）。
   *  iOS 用 navigator.standalone；安卓 Chrome 用 display-mode 媒体查询。 */
  const isStandalone = !!(nav.standalone)
    || (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches);

  /** 是不是 iOS 上的 Safari 浏览器本身（而非 Chrome/微信内置等）。
   *  只有 Safari 才有「添加到主屏幕」，所以安装引导只对它显示。 */
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|MicroMessenger|QQ\//.test(ua);

  // 非 iOS：本文件什么都不做，交回给网页 / 安卓逻辑
  if (!isIOS) return;

  /* ---------------- 1. 安全区 ---------------- */

  function applySafeArea() {
    if (!doc.body) return;
    doc.documentElement.classList.add('ios');
    doc.body.classList.add('ios');
    if (isStandalone) doc.body.classList.add('ios-standalone');
    else doc.body.classList.add('ios-browser');

    // 把安全区尺寸量成 CSS 变量，供 app.css 使用。
    // env() 在 CSS 里可直接用，但在 JS 里读不到，所以借一个临时元素量。
    try {
      const probe = doc.createElement('div');
      probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;'
        + 'padding-top:env(safe-area-inset-top);'
        + 'padding-bottom:env(safe-area-inset-bottom);'
        + 'padding-left:env(safe-area-inset-left);'
        + 'padding-right:env(safe-area-inset-right);';
      doc.body.appendChild(probe);
      const cs = global.getComputedStyle(probe);
      const root = doc.documentElement.style;
      root.setProperty('--sat', cs.paddingTop || '0px');
      root.setProperty('--sab', cs.paddingBottom || '0px');
      root.setProperty('--sal', cs.paddingLeft || '0px');
      root.setProperty('--sar', cs.paddingRight || '0px');
      doc.body.removeChild(probe);
    } catch (e) {
      // 量不到就让 CSS 里的 env() 兜底
    }
  }

  /* ---------------- 2. 键盘视口修正 ---------------- */

  /**
   * iOS 上软键盘弹出时，window.innerHeight 不会跟着变小（守旧的 100vh），
   * 底部固定的 tabbar 会被键盘顶到看不见的地方。
   * 用 visualViewport 拿到真实可见高度，写成 --app-h 变量。
   */
  function watchViewport() {
    const vv = global.visualViewport;
    const root = doc.documentElement;

    function sync() {
      const h = vv ? vv.height : global.innerHeight;
      root.style.setProperty('--app-h', Math.round(h) + 'px');
      const panel = doc.getElementById('panel');
      if (panel && panel.classList.contains('on') && h > 0) {
        panel.style.height = Math.round(h) + 'px';
        panel.style.maxHeight = panel.style.height;
      }
      // 键盘是否弹起：可见高度明显小于窗口高度
      const keyboard = vv ? (global.innerHeight - vv.height > 120) : false;
      if (doc.body) doc.body.classList.toggle('kb-open', keyboard);
    }

    sync();
    if (vv) {
      vv.addEventListener('resize', sync);
      vv.addEventListener('scroll', sync);
    }
    global.addEventListener('orientationchange', function () {
      global.setTimeout(sync, 260);
    });
    global.addEventListener('resize', sync);
  }

  /* ---------------- 课表手势约束 ---------------- */

  /**
   * 课表是固定比例的网格：在 iOS 上禁止课表区域的双指缩放和横向拖拽，
   * 只把单指纵向手势交给 .tt-scroll 自己滚动。
   */
  function lockTimetableGestures() {
    let startX = 0;
    let startY = 0;
    let inTimetable = false;

    function timetableOf(target) {
      return target && target.closest ? target.closest('[data-scroll-axis="vertical"]') : null;
    }

    doc.addEventListener('touchstart', function (e) {
      const host = timetableOf(e.target);
      inTimetable = !!host;
      if (!inTimetable || !e.touches.length) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    }, { passive: true });

    doc.addEventListener('touchmove', function (e) {
      if (!inTimetable) return;
      // 双指操作只用于缩放，直接取消，防止课表比例被改变。
      if (e.touches.length > 1) {
        e.preventDefault();
        return;
      }
      if (!e.touches.length) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      // 横向位移更明显时取消默认手势，保留上下滚动。
      if (Math.abs(dx) > Math.abs(dy) + 4) e.preventDefault();
    }, { passive: false });

    doc.addEventListener('touchend', function () { inTimetable = false; }, { passive: true });
    doc.addEventListener('touchcancel', function () { inTimetable = false; }, { passive: true });

    // 兼容较旧 iOS Safari 的手势事件模型。
    ['gesturestart', 'gesturechange'].forEach(function (type) {
      doc.addEventListener(type, function (e) {
        if (timetableOf(e.target)) e.preventDefault();
      }, { passive: false });
    });
  }

  /** 供 app.js 在打开编辑面板后重新对齐 iOS 可见视口。 */
  function syncPanel() {
    const panel = doc.getElementById('panel');
    if (!panel) return;
    const height = global.visualViewport ? global.visualViewport.height : global.innerHeight;
    if (height > 0) panel.style.height = Math.round(height) + 'px';
    panel.style.maxHeight = panel.style.height || 'var(--app-h, 100vh)';
  }

  /* ---------------- 3. 主屏幕安装引导 ---------------- */

  const DISMISS_KEY = 'cr_ios_install_dismissed';

  function hasSeenInstallTip() {
    try {
      return global.localStorage.getItem(DISMISS_KEY) === '1';
    } catch (e) {
      return true; // 存不了就别烦用户
    }
  }

  function markInstallTipSeen() {
    try {
      global.localStorage.setItem(DISMISS_KEY, '1');
    } catch (e) { /* 忽略 */ }
  }

  /** 弹出「添加到主屏幕」引导条。只在 iOS Safari 且未安装、且没关过时显示。 */
  function maybeShowInstallTip() {
    if (isStandalone) return;      // 已经是 App 形态了
    if (!isSafari) return;          // 只有 Safari 能加主屏幕
    if (hasSeenInstallTip()) return;

    const bar = doc.createElement('div');
    bar.className = 'ios-install-tip';
    bar.setAttribute('role', 'dialog');
    bar.innerHTML = ''
      + '<div class="ios-install-ico">'
      + '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">'
      + '    <path d="M12 3v12"/><path d="M8 7l4-4 4 4"/>'
      + '    <path d="M5 13v5a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-5"/>'
      + '  </svg>'
      + '</div>'
      + '<div class="ios-install-txt">'
      + '  <b>装到主屏幕，像 App 一样打开</b>'
      + '  <span>点底部的「分享」按钮，再选「添加到主屏幕」</span>'
      + '</div>'
      + '<button class="ios-install-close" type="button" aria-label="关闭">'
      + '  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'
      + '    <path d="M6 6l12 12M18 6L6 18"/></svg>'
      + '</button>';

    const close = bar.querySelector('.ios-install-close');
    function dismiss() {
      markInstallTipSeen();
      bar.classList.remove('on');
      global.setTimeout(function () {
        if (bar.parentNode) bar.parentNode.removeChild(bar);
      }, 300);
    }
    close.addEventListener('click', dismiss);

    doc.body.appendChild(bar);
    // 下一帧再加 .on，保证过渡动画能触发
    global.requestAnimationFrame(function () {
      global.requestAnimationFrame(function () { bar.classList.add('on'); });
    });

    // 10 秒后自动收起，不长期占着底部
    global.setTimeout(function () {
      if (bar.parentNode && bar.classList.contains('on')) dismiss();
    }, 10000);
  }

  /* ---------------- 4. 回到前台补检 ---------------- */

  function watchForeground() {
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState !== 'visible') return;
      // 通知提醒引擎立刻补检一次，避免锁屏期间错过的提醒不弹
      try {
        if (global.CR && global.CR.reminder && typeof global.CR.reminder.tick === 'function') {
          global.CR.reminder.tick();
        }
      } catch (e) { /* 忽略 */ }
      try {
        if (global.CR && global.CR.app && typeof global.CR.app.render === 'function') {
          global.CR.app.render();
        }
      } catch (e) { /* 忽略 */ }
    });
  }

  /* ---------------- 暴露给网页的能力查询 ---------------- */

  /** 供 app.js 判断文案用：是不是 iOS 版 */
  global.__crIsIOS = function () { return true; };
  global.__crIsStandalone = function () { return isStandalone; };

  /**
   * iOS 上没有 navigator.share 的机型极少，但一旦没有，
   * ics.js 会回落到下载。这里提供能力标记，便于设置页给出准确提示。
   */
  global.__crIOSCapabilities = function () {
    return {
      share: !!(nav.share),
      notification: false,        // iOS Safari 未向网页暴露 Notification API
      vibrate: false,             // iOS 不支持 navigator.vibrate
      standalone: isStandalone,
      safari: isSafari
    };
  };

  global.CR = global.CR || {};
  global.CR.ios = { syncPanel: syncPanel };

  /* ---------------- 启动 ---------------- */

  function boot() {
    applySafeArea();
    watchViewport();
    lockTimetableGestures();
    watchForeground();
    // 安装引导晚一点弹，先让用户看到界面
    global.setTimeout(maybeShowInstallTip, 1600);
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);
