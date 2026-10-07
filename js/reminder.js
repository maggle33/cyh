/**
 * 提醒引擎
 *
 * 移植自微信小程序版 utils/reminder.js，只有「触发后的表现形式」换了实现：
 *   wx.vibrateLong        -> navigator.vibrate（安卓壳里回落原生震动）
 *   （新增）系统通知       -> 浏览器 Notification API / 安卓壳的原生通知
 *   页面内弹窗            -> 由 app.js 监听 emit 后渲染
 *
 * 两条完全不同的通路，别搞混：
 *
 *   1) 页面内提醒（setInterval + Notification API）
 *      只在**应用打开着**的时候有效。页面被关掉、或者系统把后台标签页/进程冻结之后，
 *      setInterval 会被节流甚至停止。浏览器里这是硬限制，没有办法绕开。
 *
 *   2) 后台提醒（安卓应用专属）
 *      把未来几天的提醒算成一张"时间表"，通过 window.Android.syncReminders 交给
 *      安卓原生，由系统的 AlarmManager 负责到点唤醒（见 ReminderScheduler）。
 *      应用被划掉、手机重启都不影响。见下面的 buildPlan / syncToNative。
 *      iOS 上没有这条路（系统不允许网页后台发通知），只能走"导出到系统日历"。
 *
 * 想关掉应用也能准时被提醒：安卓用第 2 条，iPhone / 浏览器用「导出到系统日历」。
 */

(function (global) {
  'use strict';

  const CR = global.CR;
  const store = CR.store;
  const dateUtil = CR.date;
  const periods = CR.periods;
  const scheduleUtil = CR.schedule;

  /**
   * plan 是惰性取的，不在模块顶层直接赋值。
   * 原因：plan.js 在 index.html 里排在 reminder.js **后面**加载，
   * 顶层赋值会拿到 undefined。而 buildPlan() 是运行时才调用，
   * 那时候 CR.plan 早就装好了。
   */
  function planMod() {
    return CR.plan;
  }

  const CHECK_INTERVAL = 30 * 1000;   // 每 30 秒检查一次
  const EXPIRE_AFTER = 60;            // 开始时间过去 60 分钟后不再提醒

  /**
   * 后台提醒往原生推多少天。
   *
   * 一周是自然的选择——用户大致每周会打开一次应用，每次打开都会重新推一遍。
   * 再长的话（比如一学期）会有几百条闹钟，逼近系统对每个应用挂起闹钟数量的上限，
   * 而且课表一改就得全量重推，收益也不大。
   */
  const PLAN_DAYS = 7;

  let timer = null;
  let listeners = [];
  let notifPermission = 'default';

  function on(fn) {
    if (listeners.indexOf(fn) < 0) listeners.push(fn);
  }

  function off(fn) {
    listeners = listeners.filter(f => f !== fn);
  }

  function emit(item) {
    listeners.forEach(fn => {
      try {
        fn(item);
      } catch (e) {
        // 单个监听器出错不影响其他监听器
      }
    });
  }

  /* ---------------- 系统通知 ----------------
   * 两种环境：
   *   浏览器 → Notification API
   *   安卓壳 → window.Android.notify（WebView 里没有 Notification API，只能走原生通知）
   * 对外暴露的 supported / permission / requestPermission 语义保持一致，
   * 这样设置页不用关心自己跑在哪儿。
   */

  /** 安卓壳注入的对象（普通浏览器里为 undefined） */
  function androidBridge() {
    const a = global.Android;
    return (a && typeof a.notify === 'function') ? a : null;
  }

  function supported() {
    return !!androidBridge() || typeof global.Notification === 'function';
  }

  function permission() {
    const a = androidBridge();
    if (a) {
      try {
        return a.notificationPermission() || 'default';
      } catch (e) {
        return 'default';
      }
    }
    return typeof global.Notification === 'function' ? global.Notification.permission : 'unsupported';
  }

  /**
   * 申请通知权限。
   * 注意：必须由用户点击直接触发，否则部分浏览器会直接拒绝。
   */
  function requestPermission() {
    const a = androidBridge();
    if (a) {
      // 原生侧弹出系统授权框，结果会通过 window.__crOnNotifyPermission 回调，
      // 这里先把当前状态返回去，设置页随后会自己刷新
      try {
        const now = a.requestNotification();
        notifPermission = now || 'default';
        return Promise.resolve(notifPermission);
      } catch (e) {
        return Promise.resolve('default');
      }
    }

    if (typeof global.Notification !== 'function') return Promise.resolve('unsupported');
    if (global.Notification.permission !== 'default') {
      notifPermission = global.Notification.permission;
      return Promise.resolve(notifPermission);
    }
    try {
      const r = global.Notification.requestPermission();
      // 老版 Safari 走回调式，返回 undefined
      if (!r || typeof r.then !== 'function') {
        return new Promise(resolve => {
          global.Notification.requestPermission(p => {
            notifPermission = p;
            resolve(p);
          });
        });
      }
      return r.then(p => {
        notifPermission = p;
        return p;
      });
    } catch (e) {
      return Promise.resolve('denied');
    }
  }

  function notifySystem(item) {
    // 安卓壳：走原生通知，这样退出应用到后台也能收到
    const a = androidBridge();
    if (a) {
      try {
        const body = [item.subtitle, item.note, item.timeText].filter(Boolean).join(' · ') || '即将开始';
        a.notify(item.title, body);
      } catch (e) {
        // 忽略
      }
      return;
    }

    if (typeof global.Notification !== 'function') return;
    if (global.Notification.permission !== 'granted') return;
    try {
      const body = [item.subtitle, item.note].filter(Boolean).join('\n') || '即将开始';
      const n = new global.Notification(item.title, {
        body: body,
        tag: item.key,          // 同一条不重复弹
        renotify: false
      });
      setTimeout(() => {
        try { n.close(); } catch (e) { /* 忽略 */ }
      }, 30000);
      n.onclick = function () {
        try {
          global.focus();
          n.close();
        } catch (e) { /* 忽略 */ }
      };
    } catch (e) {
      // 部分浏览器在非 HTTPS 或页面隐藏时不允许构造通知，静默降级
    }
  }

  function vibrate(settings) {
    if (!settings || !settings.vibrate) return;
    try {
      if (navigator.vibrate) {
        navigator.vibrate([120, 60, 120]);
        return;
      }
    } catch (e) {
      // 落到原生震动
    }
    const a = androidBridge();
    if (a && typeof a.vibrate === 'function') {
      try { a.vibrate(160); } catch (e) { /* 忽略 */ }
    }
  }

  /* ---------------- 后台提醒：把未来计划交给安卓原生 ---------------- */

  /** 安卓壳注入的对象（普通浏览器里为 undefined） */
  function nativeScheduler() {
    const a = global.Android;
    return (a && typeof a.syncReminders === 'function') ? a : null;
  }

  /** 能不能走"关掉应用也能提醒"那条路 */
  function backgroundSupported() {
    return !!nativeScheduler();
  }

  /**
   * 把 'YYYY-MM-DD' + 'HH:MM' 转成本地时区的 epoch 毫秒。
   *
   * 刻意不用 new Date('2026-09-22T08:00')——那串没有时区后缀的写法在不同引擎上
   * 解释不一致（老 Safari 会当 UTC 处理），会出现"提醒早了 8 小时"这种很难查的错。
   * 拆成年月日时分交给 Date 构造函数，一定是本地时间。
   */
  function epochAt(dateStr, hm) {
    if (!dateStr || !hm) return 0;
    const d = String(dateStr).split('-');
    const t = String(hm).split(':');
    if (d.length < 3 || t.length < 2) return 0;
    return new Date(
      Number(d[0]), Number(d[1]) - 1, Number(d[2]),
      Number(t[0]), Number(t[1]), 0, 0
    ).getTime();
  }

  /** 通知正文里那句"几点到几点"，尽量短 */
  function spanText(start, end) {
    if (!start) return '';
    return end ? (start + '–' + end) : start;
  }

  /**
   * 算出未来 PLAN_DAYS 天、所有需要后台提醒的条目。
   *
   * 和 collectAll() 的区别：
   *   collectAll()   只看**今天**，是给页面内提醒（到点检查）用的
   *   buildPlan()    看未来若干天，是给系统闹钟用的——因为应用可能好几天不开
   *
   * 已经过去的时间点会被丢掉，已经提醒过的也会跳过（避免重复弹）。
   */
  function buildPlan() {
    const now = Date.now();
    const settings = store.getSettings();
    const todayStr = dateUtil.today();
    const out = [];

    function push(item) {
      if (!item.key || !item.triggerAt) return;
      if (item.triggerAt <= now) return;            // 已经过去的没法再挂
      if (store.isNotified(item.key)) return;        // 已经在应用内提醒过了
      out.push(item);
    }

    for (let i = 0; i < PLAN_DAYS; i++) {
      const dayStr = i === 0 ? todayStr : dateUtil.addDays(todayStr, i);

      /* --- 课程 --- */
      const wd = dateUtil.weekday(dayStr);
      const weekNo = dateUtil.weekNo(settings.termStart, dayStr);
      store.getCourses().forEach(c => {
        if (Number(c.day) !== wd) return;
        if (!c.periods || !c.periods.length) return;
        if (!store.isCourseActive(c, weekNo)) return;
        if (store.isSkipped(dayStr, c.id)) return;

        const span = periods.spanOf(c.periods);
        if (!span.start) return;
        const before = (c.remindBefore === undefined || c.remindBefore === null)
          ? Number(settings.remindBefore) : Number(c.remindBefore);
        if (!before) return;                         // 0 表示这条不提醒

        const startAt = epochAt(dayStr, span.start);
        push({
          key: dayStr + '_course_' + c.id,
          triggerAt: startAt - before * 60000,
          startAt: startAt,
          kind: 'course',
          title: c.name,
          body: [spanText(span.start, span.end), c.location, c.teacher].filter(Boolean).join(' · ')
                || periods.label(c.periods)
        });
      });

      /* --- 日程 --- */
      store.getSchedules().forEach(s => {
        if (!scheduleUtil.occursOn(s, dayStr)) return;
        if (scheduleUtil.isDoneOn(s, dayStr)) return;  // 已完成的不打扰
        if (!s.startTime) return;

        const before = (s.remindBefore === undefined || s.remindBefore === null)
          ? Number(settings.remindBefore) : Number(s.remindBefore);
        if (!before) return;

        const startAt = epochAt(dayStr, s.startTime);
        push({
          key: dayStr + '_schedule_' + s.id,
          triggerAt: startAt - before * 60000,
          startAt: startAt,
          kind: 'schedule',
          title: s.title,
          body: [spanText(s.startTime, s.endTime), s.location, s.category].filter(Boolean).join(' · ')
        });
      });

      /* --- 每日打卡（只在未来几天里预排，当天已打卡的由同步时排除） --- */
      store.getHabits().forEach(h => {
        if (h.archived) return;
        if (!h.remindAt) return;
        if (store.isChecked(h.id, dayStr)) return;

        const triggerAt = epochAt(dayStr, h.remindAt);
        push({
          key: dayStr + '_hb_' + h.id,
          triggerAt: triggerAt,
          startAt: triggerAt,
          kind: 'habit',
          title: (h.icon ? h.icon + ' ' : '') + h.name,
          body: '每日打卡 · 今天还没打卡'
        });
      });

      /* --- 倒数日（提前 N 天，统一上午 9 点） --- */
      store.getCountdowns().forEach(c => {
        if (!c.date) return;
        const daysLeft = dateUtil.diffDays(dayStr, c.date);
        if (daysLeft < 0) return;
        const list = c.remindBefore || [];
        if (list.indexOf(daysLeft) < 0) return;

        const triggerAt = epochAt(dayStr, '09:00');
        push({
          key: dayStr + '_cd_' + c.id,
          triggerAt: triggerAt,
          startAt: triggerAt,
          kind: 'countdown',
          title: c.title,
          body: daysLeft === 0 ? '就是今天' : ('还有 ' + daysLeft + ' 天')
        });
      });

      /* --- 作业（提前 N 天，落在截止时刻的同一时刻） --- */
      store.getHomeworks().forEach(hw => {
        if (!hw.due) return;
        if (hw.done) return;                            // 已交的不再提醒
        const daysLeft = dateUtil.diffDays(dayStr, hw.due);
        if (daysLeft < 0) return;
        const list = hw.remindBefore || [];
        if (list.indexOf(daysLeft) < 0) return;

        // 作业的提醒时刻跟着截止时刻走：截止 23:59 就提前 N 天的 23:59 提醒，
        // 而不是像倒数日那样统一上午 9 点——「今晚就要交」的事 9 点提醒太早了。
        const dueMs = planMod().dueTimeMs(hw);
        const triggerAt = dueMs > 0 && daysLeft === 0
          ? dueMs
          : epochAt(dayStr, hw.dueTime || '09:00');
        if (triggerAt <= now) return;

        push({
          key: dayStr + '_hw_' + hw.id,
          triggerAt: triggerAt,
          startAt: dueMs > 0 ? dueMs : triggerAt,
          kind: 'homework',
          title: (hw.title || '作业'),
          body: [
            hw.courseName || '',
            daysLeft === 0 ? ('今天 ' + (hw.dueTime || '') + ' 截止') : ('还有 ' + daysLeft + ' 天')
          ].filter(Boolean).join(' · ')
        });
      });
    }

    out.sort((a, b) => a.triggerAt - b.triggerAt);
    return out;
  }

  /**
   * 把 buildPlan() 的结果推给安卓原生，由系统闹钟接管。
   *
   * 每次课程/日程/习惯/倒数日发生变化、或者应用切到后台时都会调一次。
   * 全量替换（不是增量），因为网页这边才是唯一的数据源。
   *
   * 返回实际挂上的闹钟条数；没跑在安卓壳里返回 -1。
   */
  function syncToNative() {
    const a = nativeScheduler();
    if (!a) return -1;
    try {
      const plan = buildPlan();
      return a.syncReminders(JSON.stringify(plan));
    } catch (e) {
      return -1;
    }
  }

  /**
   * 清掉原生的全部闹钟。
   * 用在「关闭后台提醒」上（目前没有这个开关，留着给后续版本用）。
   */
  function clearNative() {
    const a = nativeScheduler();
    if (!a || typeof a.cancelReminders !== 'function') return;
    try {
      a.cancelReminders();
    } catch (e) {
      // 忽略
    }
  }

  /** 原生后台提醒的当前状态，设置页用来显示；非安卓环境返回 null */
  function nativeStatus() {
    const a = nativeScheduler();
    if (!a || typeof a.reminderStatus !== 'function') return null;
    try {
      return JSON.parse(a.reminderStatus());
    } catch (e) {
      return null;
    }
  }

  /**
   * 让原生在 N 秒后弹一条测试提醒。
   * 用户按返回键把应用退到后台，就能验证"关掉也能响"。
   */
  function testBackground(delaySeconds) {
    const a = nativeScheduler();
    if (!a || typeof a.scheduleTestReminder !== 'function') return false;
    try {
      a.scheduleTestReminder(delaySeconds || 60);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 候选与判定 ---------------- */

  /** 收集今天需要提醒的课程与日程 */
  function collectToday() {
    const todayStr = dateUtil.today();
    const wd = dateUtil.weekday(todayStr);
    const settings = store.getSettings();
    const weekNo = dateUtil.weekNo(settings.termStart, todayStr);
    const items = [];

    store.getCourses().forEach(c => {
      if (Number(c.day) !== wd) return;
      if (!c.periods || !c.periods.length) return;
      if (!store.isCourseActive(c, weekNo)) return;
      if (store.isSkipped(todayStr, c.id)) return;
      const span = periods.spanOf(c.periods);
      items.push({
        key: todayStr + '_course_' + c.id,
        type: 'course',
        typeText: periods.label(c.periods),
        id: c.id,
        title: c.name,
        subtitle: [c.location, c.teacher].filter(Boolean).join(' · '),
        note: c.note || '',
        color: c.color,
        startTime: span.start,
        endTime: span.end,
        startMinutes: dateUtil.toMin(span.start),
        remindBefore: c.remindBefore === undefined || c.remindBefore === null ? settings.remindBefore : c.remindBefore
      });
    });

    scheduleUtil.todayList().forEach(s => {
      if (s.done) return;
      items.push({
        key: todayStr + '_schedule_' + s.id,
        type: 'schedule',
        typeText: s.category || '日程',
        id: s.id,
        title: s.title,
        subtitle: s.location || '',
        note: s.note || '',
        color: s.color,
        startTime: s.startTime,
        endTime: s.endTime,
        startMinutes: s.startMinutes,
        remindBefore: s.remindBefore === null ? settings.remindBefore : s.remindBefore
      });
    });

    return items.sort((a, b) => a.startMinutes - b.startMinutes);
  }

  /**
   * 倒数日提醒候选。
   *
   * 和课程/日程不同，倒数日提醒的是「提前 N 天」而不是「提前 N 分钟」，
   * 所以没有具体的 startMinutes —— 全部按 09:00 触发，避免凌晨弹提醒。
   * 一天只提醒一次，用 key 里的日期去重。
   */
  function collectCountdowns() {
    const todayStr = dateUtil.today();
    const items = [];
    const REMIND_AT_MIN = 9 * 60;   // 上午 9 点

    store.getCountdowns().forEach(c => {
      if (!c.date) return;
      const daysLeft = dateUtil.diffDays(todayStr, c.date);
      if (daysLeft < 0) return;                       // 已经过去了，不再提醒
      const list = c.remindBefore || [];
      if (list.indexOf(daysLeft) < 0) return;          // 今天不是提醒日
      items.push({
        key: todayStr + '_cd_' + c.id,
        type: 'countdown',
        typeText: '倒数日',
        id: c.id,
        title: c.title,
        subtitle: daysLeft === 0 ? '就是今天' : '还有 ' + daysLeft + ' 天',
        note: c.note || '',
        color: c.color || '#378ADD',
        startTime: '09:00',
        endTime: '',
        startMinutes: REMIND_AT_MIN,
        remindBefore: 0
      });
    });

    return items;
  }

  /**
   * 打卡提醒候选。
   *
   * 只在「今天还没打过卡」的时候提醒——已经打过了还催就变成打扰了。
   * habit.remindAt 为空表示这个习惯不提醒。
   */
  function collectHabits() {
    const todayStr = dateUtil.today();
    const items = [];

    store.getHabits().forEach(h => {
      if (h.archived) return;
      if (!h.remindAt) return;
      if (store.isChecked(h.id, todayStr)) return;     // 已打卡，不打扰
      items.push({
        key: todayStr + '_hb_' + h.id,
        type: 'habit',
        typeText: '每日打卡',
        id: h.id,
        title: (h.icon ? h.icon + ' ' : '') + h.name,
        subtitle: '今天还没打卡',
        note: h.note || '',
        color: h.color || '#1D9E75',
        startTime: h.remindAt,
        endTime: '',
        startMinutes: dateUtil.toMin(h.remindAt),
        remindBefore: 0
      });
    });

    return items;
  }

  /** 把课程/日程、倒数日、打卡三路候选合在一起排序 */
  function collectAll() {
    return collectToday()
      .concat(collectCountdowns())
      .concat(collectHabits())
      .sort((a, b) => a.startMinutes - b.startMinutes);
  }

  /** 找出当前应该提醒的一条（返回 null 表示暂时没有） */
  function pickDue() {
    const nowM = dateUtil.nowMin();
    const list = collectAll();
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const remindAt = it.startMinutes - (Number(it.remindBefore) || 0);
      if (nowM < remindAt) continue;                        // 还没到提醒时间
      if (nowM > it.startMinutes + EXPIRE_AFTER) continue;  // 已经过去太久，跳过
      if (store.isNotified(it.key)) continue;               // 已经提醒过
      const until = store.snoozeUntil(it.key);
      if (until && Date.now() < until) continue;            // 用户选择了稍后提醒
      return it;
    }
    return null;
  }

  function tick() {
    let item = null;
    try {
      item = pickDue();
    } catch (e) {
      return null;
    }
    if (!item) return null;
    item.remainMinutes = item.startMinutes - dateUtil.nowMin();
    store.markNotified(item.key);
    const settings = store.getSettings();
    vibrate(settings);
    notifySystem(item);
    emit(item);
    return item;
  }

  function start() {
    if (timer) return;
    tick();
    timer = setInterval(tick, CHECK_INTERVAL);
    // 手机锁屏 / 标签页切回来后立刻补检一次，避免错过
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }
  }

  function onVisible() {
    if (document.visibilityState === 'visible') tick();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisible);
    }
  }

  /** 稍后提醒：清除已提醒标记，延迟 N 分钟后再提醒 */
  function snooze(item, minutes) {
    store.snooze(item.key, minutes);
  }

  /** 主动测试：立刻触发一条示例提醒 */
  function testFire() {
    const item = {
      key: 'test_' + Date.now(),
      type: 'schedule',
      typeText: '测试',
      id: 'test',
      title: '提醒功能测试',
      subtitle: '看到这条说明提醒可以正常弹出',
      note: '',
      color: '#378ADD',
      startTime: dateUtil.nowHM(),
      endTime: '',
      startMinutes: dateUtil.nowMin(),
      remindBefore: 0,
      remainMinutes: 0
    };
    vibrate(store.getSettings());
    notifySystem(item);
    emit(item);
  }

  CR.reminder = {
    on: on,
    off: off,
    start: start,
    stop: stop,
    tick: tick,
    snooze: snooze,
    testFire: testFire,
    collectToday: collectToday,
    collectCountdowns: collectCountdowns,
    collectHabits: collectHabits,
    collectAll: collectAll,
    supported: supported,
    permission: permission,
    requestPermission: requestPermission,
    // 后台提醒（仅安卓应用）
    buildPlan: buildPlan,
    syncToNative: syncToNative,
    clearNative: clearNative,
    nativeStatus: nativeStatus,
    backgroundSupported: backgroundSupported,
    testBackground: testBackground
  };
})(window);
