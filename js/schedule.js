/**
 * 日程出现规则：把「重复日程」展开成某一天的具体安排
 * 数据模型：
 *   schedule.repeat = { type: 'none' | 'daily' | 'weekly' | 'monthly', until: 'YYYY-MM-DD' | '' }
 *   schedule.done      单次日程是否完成
 *   schedule.doneDates 重复日程里已完成的日期数组 ['YYYY-MM-DD']
 *
 * 从微信小程序版 utils/schedule.js 原样移植，逻辑未改动。
 */

(function (global) {
  'use strict';

  const CR = global.CR;
  const store = CR.store;
  const dateUtil = CR.date;

  const REPEAT_LABELS = { none: '不重复', daily: '每天', weekly: '每周', monthly: '每月' };

  function repeatType(s) {
    return (s && s.repeat && s.repeat.type) ? s.repeat.type : 'none';
  }

  function untilOf(s) {
    return (s && s.repeat && s.repeat.until) ? s.repeat.until : '';
  }

  /** 该日程在 dateStr 这天是否发生 */
  function occursOn(s, dateStr) {
    if (!s || !s.date || !dateStr) return false;
    if (dateStr < s.date) return false;
    const until = untilOf(s);
    if (until && dateStr > until) return false;

    const type = repeatType(s);
    if (type === 'none') return dateStr === s.date;
    if (type === 'daily') return true;
    if (type === 'weekly') return dateUtil.weekday(dateStr) === dateUtil.weekday(s.date);
    if (type === 'monthly') return dateUtil.parse(dateStr).getDate() === dateUtil.parse(s.date).getDate();
    return false;
  }

  /** 把某条日程展开成 [from, to] 区间内的所有日期 */
  function expand(s, from, to) {
    const out = [];
    if (!s || !s.date || from > to) return out;
    const until = untilOf(s);
    const end = until && until < to ? until : to;
    let d = from < s.date ? s.date : from;
    let guard = 0;
    while (d <= end && guard < 400) {
      if (occursOn(s, d)) out.push(d);
      d = dateUtil.addDays(d, 1);
      guard++;
    }
    return out;
  }

  /** 某一天的这一次是否已完成 */
  function isDoneOn(s, dateStr) {
    if (repeatType(s) === 'none') return !!s.done;
    return (s.doneDates || []).indexOf(dateStr) >= 0;
  }

  /** 切换某一天的完成状态，返回更新后的记录（需自行保存） */
  function toggleDone(s, dateStr) {
    if (repeatType(s) === 'none') {
      s.done = !s.done;
      return s;
    }
    const list = (s.doneDates || []).slice();
    const i = list.indexOf(dateStr);
    if (i >= 0) list.splice(i, 1);
    else list.push(dateStr);
    s.doneDates = list;
    return s;
  }

  /** 转成视图用的展示对象 */
  function toDisplay(s, dateStr) {
    return {
      id: s.id,
      date: dateStr,
      title: s.title,
      startTime: s.startTime,
      endTime: s.endTime || '',
      timeText: s.startTime + (s.endTime ? ' ~ ' + s.endTime : ''),
      startMinutes: dateUtil.toMin(s.startTime),
      location: s.location || '',
      category: s.category || '日程',
      note: s.note || '',
      color: s.color || '#378ADD',
      remindBefore: s.remindBefore === undefined || s.remindBefore === null ? null : Number(s.remindBefore),
      done: isDoneOn(s, dateStr),
      repeatText: repeatType(s) === 'none' ? '' : (REPEAT_LABELS[repeatType(s)] + (untilOf(s) ? '，至 ' + untilOf(s).slice(5) : '')),
      isRepeat: repeatType(s) !== 'none',
      demo: !!s.demo
    };
  }

  /** 今天发生的日程（按开始时间排序） */
  function todayList() {
    const t = dateUtil.today();
    return store.getSchedules()
      .filter(s => occursOn(s, t))
      .map(s => toDisplay(s, t))
      .sort((a, b) => a.startMinutes - b.startMinutes);
  }

  /**
   * 区间内的日程出现列表
   * overdueNonRepeat: 是否把「不重复且已过期未完成」的也带上（放在最前面用的）
   */
  function windowList(from, to, overdueNonRepeat) {
    const todayStr = dateUtil.today();
    const out = [];
    store.getSchedules().forEach(s => {
      expand(s, from, to).forEach(d => out.push(toDisplay(s, d)));
    });
    if (overdueNonRepeat) {
      store.getSchedules().forEach(s => {
        if (repeatType(s) !== 'none') return;
        if (s.done) return;
        if (!s.date || s.date >= todayStr) return;
        if (s.date < from) return;
        out.push(toDisplay(s, s.date));
      });
    }
    out.sort((a, b) => (a.date + a.startTime < b.date + b.startTime ? -1 : 1));
    return out;
  }

  /** 今天还没完成、即将开始的日程 */
  function upcomingToday(nowMinutes) {
    return todayList().filter(it => !it.done && it.startMinutes >= nowMinutes);
  }

  CR.schedule = {
    REPEAT_LABELS: REPEAT_LABELS,
    repeatType: repeatType,
    untilOf: untilOf,
    occursOn: occursOn,
    expand: expand,
    isDoneOn: isDoneOn,
    toggleDone: toggleDone,
    toDisplay: toDisplay,
    todayList: todayList,
    windowList: windowList,
    upcomingToday: upcomingToday
  };
})(window);
