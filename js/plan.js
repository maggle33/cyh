/**
 * 计划模块：倒数日 + 作业 + 每日打卡
 *
 * 三者放在同一个文件里，因为它们的共同点是「都按天计算」——
 * 课程/日程是「几点几分开始」，倒数日/作业/打卡是「还有几天 / 今天做没做」，
 * 时间尺度不同，放在一起反而比塞进 schedule.js 清楚。
 *
 * 作业之所以不并入倒数日（虽然结构很像），关键差异有两个：
 *   ① 作业有「已交」状态，交了就撤下提醒；倒数日过了就是过了。
 *   ② 作业的截止时刻可能是 23:59 这种明确时间，提醒得落在那个时刻上；
 *      倒数日统一按上午 9 点提醒。
 *
 * 本文件只负责**计算与数据整理**，DOM 渲染仍归 app.js，这样：
 *   ① 渲染层能像对待课程/日程那样统一处理倒数日与打卡；
 *   ② 这个文件可以被单独测试，不需要 DOM。
 */

(function (global) {
  'use strict';

  const CR = global.CR;
  const store = CR.store;
  const dateUtil = CR.date;

  /* =========================================================
     倒数日
     ========================================================= */

  const WEEK_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  /** 提前提醒的可选天数，对应编辑面板里的多选按钮 */
  const REMIND_DAYS = [30, 14, 7, 3, 1, 0];
  const REMIND_DAY_LABELS = ['提前 30 天', '提前 14 天', '提前 7 天', '提前 3 天', '提前 1 天', '当天'];

  /**
   * 把某个时刻拆成「天 / 时 / 分 / 秒」，供 JS 或倒计时使用。
   * 返回的 days 是**完整的天数差**，不是自然日差——跨年时也能算对。
   */
  function breakdown(target, from) {
    const t0 = (from instanceof Date ? from : new Date()).getTime();
    const t1 = target instanceof Date ? target.getTime() : new Date(target).getTime();
    let ms = t1 - t0;
    const past = ms < 0;
    ms = Math.abs(ms);
    const totalSec = Math.floor(ms / 1000);
    return {
      past: past,
      days: Math.floor(totalSec / 86400),
      hours: Math.floor((totalSec % 86400) / 3600),
      minutes: Math.floor((totalSec % 3600) / 60),
      seconds: totalSec % 60
    };
  }

  /**
   * 倒数日的完整状态。
   *
   * dateMode === 'sec' 时给到秒，'day' 时只给天数（不显示时分秒）。
   * 「当天」被特意分成三种：今天开始前 / 今天进行中 / 今天已过 0 点，
   * 因为用户最关心的就是「今天到底是不是那一天」。
   */
  function stateOf(item, now) {
    const d = dateUtil.parse(item.date);
    // 目标时刻：按天算就是当天 00:00；按秒算给个明确的 00:00:00，
    // 用户想要的「还有多少秒」到那一刻归零
    const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
    const bd = breakdown(target, now || new Date());
    const todayStr = dateUtil.today();
    const dayDiff = dateUtil.diffDays(todayStr, item.date);   // 自然日差

    let state;   // 'future' | 'today' | 'past'
    if (dayDiff > 0) state = 'future';
    else if (dayDiff === 0) state = 'today';
    else state = 'past';

    // 主标题上的大字
    let bigNum;
    let bigUnit;
    if (state === 'future') {
      bigNum = dayDiff;
      bigUnit = '天';
    } else if (state === 'today') {
      bigNum = '今天';
      bigUnit = '';
    } else {
      bigNum = Math.abs(dayDiff);
      bigUnit = '天前';
    }

    return {
      item: item,
      days: dayDiff,
      state: state,
      past: bd.past,
      bd: bd,
      bigNum: bigNum,
      bigUnit: bigUnit,
      // 精确到秒的文本，只有 sec 模式才用
      clockText: (bd.past ? '已过去 ' : '还有 ')
        + bd.days + ' 天 '
        + dateUtil.pad(bd.hours) + ' 时 '
        + dateUtil.pad(bd.minutes) + ' 分 '
        + dateUtil.pad(bd.seconds) + ' 秒',
      dateText: (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK_NAMES[d.getDay()],
      // 排序用：越近的越靠前
      sortKey: Math.abs(dayDiff)
    };
  }

  /**
   * 列表：置顶的在前，其余按「离今天由近到远」排。
   * 已过去的排在最后——它们不会被删掉（纪念日还要回头看），但不该占着首屏。
   */
  function listCountdowns(now) {
    const list = store.getCountdowns().map(c => stateOf(c, now));
    return list.sort((a, b) => {
      if (a.item.pinned !== b.item.pinned) return a.item.pinned ? -1 : 1;
      const ap = a.state === 'past';
      const bp = b.state === 'past';
      if (ap !== bp) return ap ? 1 : -1;
      return a.sortKey - b.sortKey;
    });
  }

  /** 首屏摘要：最近的那条未来的倒数日 */
  function nextCountdown(now) {
    const list = store.getCountdowns()
      .map(c => stateOf(c, now))
      .filter(s => s.state !== 'past')
      .sort((a, b) => a.sortKey - b.sortKey);
    return list[0] || null;
  }

  /* =========================================================
     作业
     ========================================================= */

  /**
   * 一条作业的当前状态。
   *
   * 跟倒数日最大的不同：
   *   ① 作业有 done——交了就是交了，不管截没截止，界面上都归到「已交」去；
   *   ② 作业可能有截止时刻（dueTime）。截止时刻不是 00:00 的，当天就是「今天 23:59 截止」，
   *      过期判断也要等到那个时刻过去才算——22:00 交的作业在 23:00 时还没过期。
   *
   * state 三态：
   *   'done'    已交（不管日期）
   *   'overdue' 过期未交（红色，最该被看到）
   *   'future'  待交
   *   'today'   今天截止
   */
  function homeworkState(hw, now) {
    const t0 = now instanceof Date ? now.getTime() : Date.now();
    if (hw.done) {
      return { item: hw, state: 'done', days: 0, bigNum: '已交', bigUnit: '', overdue: false };
    }

    const dueStr = hw.due;
    const dayDiff = dueStr ? dateUtil.diffDays(dateUtil.today(), dueStr) : 0;

    // 有截止时刻时，「今天」的过期与否要看具体时刻
    let overdue = false;
    if (dueStr) {
      const dueMs = dueTimeMs(hw);
      overdue = dueMs > 0 ? dueMs < t0 : dayDiff < 0;
    }

    let state;
    let bigNum;
    let bigUnit;
    if (overdue) {
      state = 'overdue';
      bigNum = Math.abs(dayDiff) || 0;
      bigUnit = '天前';
    } else if (dayDiff === 0) {
      state = 'today';
      bigNum = '今天';
      bigUnit = '';
    } else if (dayDiff > 0) {
      state = 'future';
      bigNum = dayDiff;
      bigUnit = '天';
    } else {
      // 日期已过但时刻还没到（例如 23:59 截止，现在是当天），兜底为今天
      state = 'today';
      bigNum = '今天';
      bigUnit = '';
    }

    return {
      item: hw,
      state: state,
      days: dayDiff,
      bigNum: bigNum,
      bigUnit: bigUnit,
      overdue: overdue,
      timeText: hw.dueTime ? (hw.dueTime + ' 截止') : '当天截止',
      dateText: dueStr
        ? (dateUtil.parse(dueStr).getMonth() + 1) + '月' + dateUtil.parse(dueStr).getDate() + '日 '
          + WEEK_NAMES[dateUtil.parse(dueStr).getDay()]
        : '',
      sortKey: overdue ? -1000 + Math.abs(dayDiff) : Math.abs(dayDiff)
    };
  }

  /** 截止时刻的毫秒数；没填时刻就按当天 23:59 算（比 00:00 更符合「当天交完」的直觉） */
  function dueTimeMs(hw) {
    if (!hw || !hw.due) return 0;
    const hm = hw.dueTime && /^\d{1,2}:\d{2}$/.test(hw.dueTime) ? hw.dueTime : '23:59';
    const d = String(hw.due).split('-');
    const t = hm.split(':');
    if (d.length < 3) return 0;
    return new Date(Number(d[0]), Number(d[1]) - 1, Number(d[2]),
                    Number(t[0]), Number(t[1]), 0, 0).getTime();
  }

  /**
   * 作业列表。
   * 排序是这个列表最要紧的事，顺序刻意定成：
   *   1) 未交的排前面——已交的看一眼就放心了，不用占首屏
   *   2) 未交里，已过期的排最前——那是真正需要立刻处理的
   *   3) 其余按离截止由近到远
   */
  function listHomeworks(now, filter) {
    const all = store.getHomeworks().map(h => homeworkState(h, now));
    let list = all;
    if (filter === 'todo') list = all.filter(s => s.state !== 'done');
    else if (filter === 'done') list = all.filter(s => s.state === 'done');

    return list.sort((a, b) => {
      const ad = a.state === 'done';
      const bd = b.state === 'done';
      if (ad !== bd) return ad ? 1 : -1;
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return a.sortKey - b.sortKey;
    });
  }

  /** 未交作业计数，给页签/标题上用 */
  function homeworkTodoCount() {
    return store.getHomeworks().filter(h => !h.done).length;
  }

  /** 已过期未交的数量——用红色标出来催一下 */
  function homeworkOverdueCount(now) {
    return store.getHomeworks().filter(h => !h.done && homeworkState(h, now).overdue).length;
  }

  /* =========================================================
     打卡
     ========================================================= */

  /** 最近 N 天的打卡情况，供「打卡历史」与热力图使用 */
  function recentDays(habitId, n) {
    const todayStr = dateUtil.today();
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const ds = dateUtil.addDays(todayStr, -i);
      out.push({
        date: ds,
        day: dateUtil.parse(ds).getDate(),
        weekday: dateUtil.weekday(ds),
        on: store.isChecked(habitId, ds),
        isToday: i === 0
      });
    }
    return out;
  }

  /** 某个月每一天的打卡状态，供月历热力图使用 */
  function monthGrid(habitId, year, month) {
    const first = new Date(year, month - 1, 1);
    const daysInMonth = new Date(year, month, 0).getDate();
    // 周一开头：把 1 号之前空出来的格子补上
    const lead = (first.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = dateUtil.fmt(new Date(year, month - 1, d));
      cells.push({
        date: ds,
        day: d,
        on: store.isChecked(habitId, ds),
        isToday: ds === dateUtil.today(),
        future: ds > dateUtil.today()
      });
    }
    return cells;
  }

  /**
   * 全部习惯的今日概览，供今日页顶部的打卡区使用。
   * 已归档的排在最后；其余按「今天还没打」在前，让用户一眼看到该做什么。
   */
  function listHabits() {
    const todayStr = dateUtil.today();
    const list = store.getHabits().map(h => {
      const done = store.isChecked(h.id, todayStr);
      return {
        habit: h,
        id: h.id,
        name: h.name,
        icon: h.icon || '',
        color: h.color || '#1D9E75',
        remindAt: h.remindAt || '',
        note: h.note || '',
        archived: !!h.archived,
        done: done,
        streak: store.streakOf(h.id),
        best: store.bestStreakOf(h.id),
        total: store.totalChecksOf(h.id)
      };
    });
    return list.sort((a, b) => {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      if (a.done !== b.done) return a.done ? 1 : -1;
      return 0;
    });
  }

  /** 今日打卡进度，例如「3 / 5」 */
  function todayProgress() {
    const list = listHabits().filter(h => !h.archived);
    const done = list.filter(h => h.done).length;
    return { done: done, total: list.length };
  }

  /**
   * 连续打卡的鼓励语。刻意不做得太花哨——它是给用户看的反馈，
   * 不是装饰；只有真的达成了什么才出现。
   */
  function streakHint(streak, done) {
    if (!done) return '';
    if (streak >= 100) return '连续 ' + streak + ' 天，已经成习惯了';
    if (streak >= 30) return '连续 ' + streak + ' 天，很稳';
    if (streak >= 7) return '连续 ' + streak + ' 天，保持住';
    if (streak >= 3) return '连续 ' + streak + ' 天';
    if (streak === 1) return '今天开始了';
    return '';
  }

  /* =========================================================
     工具
     ========================================================= */

  /** 取 ICON 列表，供编辑面板选择 */
  const ICONS = ['✨', '☀', '📖', '🏃', '💪', '🎯', '💧', '🌙', '✍', '🎧', '🧘', '🍎'];

  CR.plan = {
    REMIND_DAYS: REMIND_DAYS,
    REMIND_DAY_LABELS: REMIND_DAY_LABELS,
    ICONS: ICONS,
    breakdown: breakdown,
    stateOf: stateOf,
    listCountdowns: listCountdowns,
    nextCountdown: nextCountdown,
    homeworkState: homeworkState,
    dueTimeMs: dueTimeMs,
    listHomeworks: listHomeworks,
    homeworkTodoCount: homeworkTodoCount,
    homeworkOverdueCount: homeworkOverdueCount,
    recentDays: recentDays,
    monthGrid: monthGrid,
    listHabits: listHabits,
    todayProgress: todayProgress,
    streakHint: streakHint
  };
})(window);
