/**
 * 安卓壳的适配层
 *
 * 这个文件在普通浏览器里**完全空转**——只有检测到 window.Android（安卓应用的
 * WebView 通过 addJavascriptInterface 注入的对象）时才会做事。所以网页版和
 * 安卓版共用同一套 campus-app 代码，不需要分叉。
 *
 * 它负责这几件纯网页做不到的事：
 *   1. 返回键的优先级：先关弹层 → 再回今日页 → 都没有才让系统把应用退到后台
 *   2. 通知权限被用户改动后，让设置页刷新标签
 *   3. **把未来的提醒同步给系统闹钟**，这样应用被关掉也能准点提醒
 *      （见 js/reminder.js 的 buildPlan；调度在安卓侧的 ReminderScheduler）
 *   4. 网页启动完成后通知原生「可以接管返回键了」
 *
 * 另外，导出 .ics 与弹系统通知分别在 ics.js / reminder.js 里分支到 window.Android，
 * 因为 WebView 里既没有 navigator.share，也没有 Notification API。
 */

(function (global) {
  'use strict';

  const Android = global.Android;
  // 普通浏览器：注入对象不存在，本文件什么都不做
  if (!Android || typeof Android.platform !== 'function') return;

  /* =========================================================
     后台提醒同步
     ========================================================= */

  /** 同步的节流时间：短时间内连续改好几处（比如导入课表）只推最后一次 */
  const SYNC_THROTTLE = 1200;

  let syncTimer = null;
  let syncing = false;

  /**
   * 把当前的提醒计划推给原生。
   *
   * 节流而不是防抖：改完课表后如果用户立刻切到后台，防抖可能还没到点没推出去；
   * 节流保证最多等 1.2 秒一定会推一次，配合 MainActivity.onPause 里的兜底足够可靠。
   */
  function syncNow() {
    if (syncing) return;
    const r = global.CR && global.CR.reminder;
    if (!r || typeof r.syncToNative !== 'function') return;
    syncing = true;
    try {
      r.syncToNative();
    } catch (e) {
      // 同步失败不影响页面本身，下次变更还会再试
    }
    syncing = false;
  }

  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = global.setTimeout(function () {
      syncTimer = null;
      syncNow();
    }, SYNC_THROTTLE);
  }

  /** 原生在 onPause / 从设置页返回时调用，要求立刻推一份（不等节流） */
  global.__crSyncReminders = function () {
    if (syncTimer) {
      global.clearTimeout(syncTimer);
      syncTimer = null;
    }
    syncNow();
  };

  /** 原生在「闹钟和提醒」授权页返回后调用，让设置页刷新那一行状态 */
  global.__crOnExactAlarmChange = function () {
    mainThread(function () {
      if (global.CR && global.CR.app && global.CR.app.render) global.CR.app.render();
    });
    syncNow();
  };

  /**
   * 监听页面里会影响提醒的变化。
   *
   * 没有去 hook 每一个"保存课程"的入口——那种做法很容易漏（新增/编辑/删除/跳过/
   * 导入备份/切换学期…各自都要记得加一行）。这里统一监听三种更靠底层的信号：
   *   change / input  编辑面板里的任何输入
   *   click           带 data-act 的按钮（保存、删除、打卡…）
   *   storage         localStorage 被改（store.save 走的就是这条路）
   * 反正同步本身很便宜（一次 JSON 序列化），多推几次没有副作用。
   */
  function watchChanges() {
    const doc = global.document;
    doc.addEventListener('click', function (e) {
      const t = e.target;
      if (t && t.closest && t.closest('[data-act]')) scheduleSync();
    }, true);

    doc.addEventListener('change', function (e) {
      const t = e.target;
      if (t && t.closest && t.closest('#panel')) scheduleSync();
    }, true);

    // localStorage 的变化只在**其他页面**触发 storage 事件，同页写入不会触发，
    // 所以这里主要靠上面两个；storage 事件留着兜住"在别处改了备份"的情况。
    global.addEventListener('storage', scheduleSync);

    // 切到后台前一定要把最新的推过去（onPause 也会再要一次，双保险）
    doc.addEventListener('visibilitychange', function () {
      if (doc.visibilityState === 'hidden') syncNow();
    });
  }

  /* =========================================================
     返回键
     ========================================================= */

  /**
   * 处理返回键。返回 true 表示「已消费」，原生就不再退到后台。
   *
   * 顺序刻意这样定：越「临时」的东西越先关掉。
   */
  function handleBack() {
    // 1) 提醒弹窗、确认对话框
    if (closeTopModal()) return true;

    // 2) 底部菜单（编辑课程 / 标记完成 那个）
    if (closeSheet()) return true;

    // 3) 编辑面板
    const panel = global.document.getElementById('panel');
    if (panel && panel.classList.contains('on')) {
      if (global.CR && global.CR.app && global.CR.app.closeEdit) global.CR.app.closeEdit();
      return true;
    }

    // 4) 不在今日页就先回今日页
    if (global.CR && global.CR.app && global.CR.app.state
        && global.CR.app.state.tab !== 'today') {
      global.CR.app.switchTab('today');
      return true;
    }

    // 5) 已经在最外层，交给原生退到后台
    return false;
  }

  /** 关掉最上层的弹窗/对话框；没有则返回 false */
  function closeTopModal() {
    const host = global.document.getElementById('modalRoot');
    if (!host || !host.children.length) return false;
    const top = host.children[host.children.length - 1];
    // 提醒弹窗用 data-act=ok，普通对话框用 data-act=cancel
    const btn = top.querySelector('[data-act="cancel"]')
      || top.querySelector('[data-act="confirm"]')
      || top.querySelector('[data-act="ok"]');
    if (!btn) return false;
    btn.click();
    return true;
  }

  /** 关掉底部菜单；没有则返回 false */
  function closeSheet() {
    const host = global.document.getElementById('sheetRoot');
    if (!host || !host.children.length) return false;
    const mask = global.document.getElementById('maskRoot');
    if (mask && typeof mask.onclick === 'function') {
      mask.onclick();
      return true;
    }
    // 兜底：直接把菜单节点摘掉
    while (host.firstChild) host.removeChild(host.firstChild);
    return true;
  }

  function mainThread(fn) {
    // 通知权限的结果会在原生侧回调进来，这里只负责让界面刷新
    try {
      fn();
    } catch (e) {
      // 忽略
    }
  }

  /* ---------------- 暴露给原生调用 ---------------- */

  global.__crHandleBack = handleBack;

  /** 原生侧在通知权限对话框关闭后调用 */
  global.__crOnNotifyPermission = function () {
    mainThread(function () {
      if (global.CR && global.CR.app && global.CR.app.render) global.CR.app.render();
    });
  };

  /* ---------------- 通知原生：网页已经跑起来了 ---------------- */

  function markReady() {
    try {
      if (typeof Android.markReady === 'function') Android.markReady();
    } catch (e) {
      // 忽略
    }
  }

  /**
   * 清掉上一版留下的离线缓存。
   *
   * 安卓覆盖安装不会清 WebView 数据，旧安装注册过的 Service Worker 会继续
   * 留在 http://127.0.0.1:18737 这个来源上。新版已经不再注册它了（见
   * index.html 的注释），这里负责把历史上遗留的那个注销掉，并清空
   * Cache Storage，保证页面永远是包内的最新一份。
   */
  function purgeOfflineCache() {
    try {
      if (global.navigator && global.navigator.serviceWorker) {
        global.navigator.serviceWorker.getRegistrations().then(function (list) {
          list.forEach(function (reg) { reg.unregister(); });
        }).catch(function () {});
      }
    } catch (e) { /* 忽略 */ }
    try {
      if (global.caches) {
        global.caches.keys().then(function (keys) {
          keys.forEach(function (k) { global.caches.delete(k); });
        }).catch(function () {});
      }
    } catch (e) { /* 忽略 */ }
  }

  purgeOfflineCache();

  /** 「设置」页的「重新加载」按钮：清完缓存再刷新，用来救活卡在旧版本上的安装 */
  global.__crReloadFresh = function () {
    purgeOfflineCache();
    global.setTimeout(function () { global.location.reload(); }, 300);
  };

  if (global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', function () {
      // 等 boot() 把界面渲染完再把返回键交给网页
      global.setTimeout(function () {
        markReady();
        watchChanges();
        // 启动时立刻把计划推一遍：这样"上次打开应用之后一直没再开"的情况
        // 也能在这一次启动后把未来一周的闹钟补齐
        global.setTimeout(syncNow, 0);
      }, 0);
    });
  } else {
    global.setTimeout(function () {
      markReady();
      watchChanges();
      global.setTimeout(syncNow, 0);
    }, 0);
  }
})(window);
