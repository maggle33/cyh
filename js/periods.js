/**
 * 节次作息配置：一天 12 节
 *
 * 时间来源有两层：
 *   1. 用户在「设置 → 作息时间」里改过的值（存在设置的 periodTimes 字段里）
 *   2. 没有自定义时，回落到下面的 DEFAULT_PERIODS
 *
 * 依赖说明：本模块只直接读写 localStorage 中的设置项，**不要**引用 CR.store。
 * store.js 依赖本模块，反向依赖会形成循环。
 * 存储 key 与 store.KEY.settings 一致（cr_settings），改 key 时两处要同步。
 */

(function (global) {
  'use strict';

  const SETTINGS_KEY = 'cr_settings';

  /** 默认作息（「恢复默认」就是回到这份数据） */
  const DEFAULT_PERIODS = [
    { index: 1, start: '08:00', end: '08:55' },
    { index: 2, start: '08:55', end: '09:55' },
    { index: 3, start: '09:55', end: '10:50' },
    { index: 4, start: '10:50', end: '11:45' },
    { index: 5, start: '11:45', end: '13:30' },
    { index: 6, start: '13:30', end: '14:25' },
    { index: 7, start: '14:25', end: '15:25' },
    { index: 8, start: '15:25', end: '16:20' },
    { index: 9, start: '16:20', end: '18:30' },
    { index: 10, start: '18:30', end: '19:25' },
    { index: 11, start: '19:25', end: '20:20' },
    // 第 12 节为「20:20 之后」，没有固定下课时间，end 只是占位值，仅用于展示
    { index: 12, start: '20:20', end: '21:15', openEnd: true }
  ];

  const WEEK_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

  /* ---------------- 内部小工具 ---------------- */

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function isValidTime(t) {
    return typeof t === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(t);
  }

  function toMin(t) {
    const p = String(t || '00:00').split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  }

  /** 时间平移若干分钟，结果限制在 00:00 ~ 23:59 */
  function shift(t, minutes) {
    const total = Math.max(0, Math.min(23 * 60 + 59, toMin(t) + minutes));
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  }

  function clone(list) {
    return list.map(p => ({
      index: p.index,
      start: p.start,
      end: p.end,
      openEnd: !!p.openEnd
    }));
  }

  /** 清洗一份作息数据：非法值回落到默认，并保证下课晚于上课 */
  function normalize(raw) {
    if (!Array.isArray(raw) || !raw.length) return null;
    const list = raw.map((p, i) => {
      const base = DEFAULT_PERIODS[i] || { start: '08:00', end: '08:45' };
      return {
        index: i + 1,
        start: (p && isValidTime(p.start)) ? p.start : base.start,
        end: (p && isValidTime(p.end)) ? p.end : base.end,
        openEnd: !!(p && p.openEnd)
      };
    });
    list.forEach(p => {
      if (toMin(p.end) <= toMin(p.start)) p.end = shift(p.start, 55);
    });
    return list;
  }

  function readStorageSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const v = raw ? JSON.parse(raw) : null;
      return (v && typeof v === 'object') ? v : {};
    } catch (e) {
      return {};
    }
  }

  function writeStorageSettings(next) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      return true;
    } catch (e) {
      return false;
    }
  }

  function readCustom() {
    return normalize(readStorageSettings().periodTimes);
  }

  function writeCustom(list) {
    const next = readStorageSettings();
    next.periodTimes = clone(list);
    return writeStorageSettings(next);
  }

  /** 顺序自检：返回第一条错误信息，全部合法返回 '' */
  function validate(list) {
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!isValidTime(p.start)) return '第' + p.index + '节的上课时间格式不正确';
      if (!isValidTime(p.end)) return '第' + p.index + '节的下课时间格式不正确';
      if (toMin(p.end) <= toMin(p.start)) return '第' + p.index + '节的下课时间要晚于上课时间';
    }
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const cur = list[i];
      if (toMin(cur.start) < toMin(prev.end)) {
        return '第' + cur.index + '节的上课时间不能早于第' + prev.index + '节的下课时间（' + prev.end + '）'
          + '。可以先调第' + prev.index + '节的边界，或从后往前改。';
      }
    }
    return '';
  }

  /* ---------------- 对外读取 ---------------- */

  /**
   * 当前生效的作息（自定义优先）。
   * 每次都从存储读取、不做缓存，这样设置页改完，其他页面立刻拿到新值。
   */
  function all() {
    return readCustom() || clone(DEFAULT_PERIODS);
  }

  function total() {
    return all().length;
  }

  /** 是否使用过自定义作息 */
  function isCustom() {
    return !!readCustom();
  }

  /** 取某一节 */
  function get(index) {
    const list = all();
    return list[Math.max(1, Math.min(list.length, Number(index) || 1)) - 1];
  }

  /** "08:00~08:55" 形式的展示文本 */
  function rangeText(index) {
    const p = get(index);
    return p.openEnd ? p.start + ' 之后' : p.start + '~' + p.end;
  }

  /** 多节合并展示："第1-3节" / "第5节" */
  function label(periods) {
    if (!periods || !periods.length) return '';
    const list = periods.slice().sort((a, b) => a - b);
    if (list.length === 1) return '第' + list[0] + '节';
    return '第' + list[0] + '-' + list[list.length - 1] + '节';
  }

  /** 合并后的上课时间段 { start, end, label } */
  function spanOf(periods) {
    if (!periods || !periods.length) return { start: '', end: '', label: '' };
    const list = periods.slice().sort((a, b) => a - b);
    const first = get(list[0]);
    const last = get(list[list.length - 1]);
    return {
      start: first.start,
      end: last.openEnd ? '' : last.end,
      label: label(list)
    };
  }

  /** 连续节次判断，用于给出提示 */
  function isContiguous(periods) {
    if (!periods || periods.length < 2) return true;
    const list = periods.slice().sort((a, b) => a - b);
    for (let i = 1; i < list.length; i++) {
      if (list[i] !== list[i - 1] + 1) return false;
    }
    return true;
  }

  /* ---------------- 修改作息 ----------------
   * 数据里每一节都自带 start / end，但实际作息是「边界」共享的
   * （第 1 节的下课时间就是第 2 节的上课时间）。
   * 「相邻节次联动」开启时（默认），改一个边界会把原本首尾相接的邻居一起带过去，
   * 不会留下时间断层；关闭后每节各自独立，可以留出课间空档。
   */

  /** 相邻节次是否联动（默认开启） */
  function isLinked() {
    return readStorageSettings().periodLink !== false;
  }

  function setLinked(on) {
    const next = readStorageSettings();
    next.periodLink = !!on;
    return writeStorageSettings(next);
  }

  /**
   * 试算一次修改，不落盘。
   * 返回 { ok, message, list, synced }；synced 是被联动修改的节次 [{ index, field }]
   */
  function plan(index, field, value) {
    const list = all();
    const i = (Number(index) || 0) - 1;
    if (i < 0 || i >= list.length) return { ok: false, message: '节次不存在' };
    if (field !== 'start' && field !== 'end') return { ok: false, message: '参数不正确' };
    if (!isValidTime(value)) return { ok: false, message: '时间格式不正确' };

    const old = list[i][field];
    if (old === value) return { ok: false, message: '' };   // 没有变化，静默返回

    const draft = clone(list);
    const synced = [];
    draft[i][field] = value;

    if (isLinked()) {
      if (field === 'end' && i + 1 < draft.length && draft[i + 1].start === old) {
        draft[i + 1].start = value;
        synced.push({ index: draft[i + 1].index, field: 'start' });
      }
      if (field === 'start' && i - 1 >= 0 && draft[i - 1].end === old) {
        draft[i - 1].end = value;
        synced.push({ index: draft[i - 1].index, field: 'end' });
      }
    }

    // 「之后」的节次没有真实下课时间，占位值跟着上课时间顺延
    draft.forEach(p => {
      if (p.openEnd && toMin(p.end) <= toMin(p.start)) p.end = shift(p.start, 55);
    });

    const err = validate(draft);
    if (err) return { ok: false, message: err };
    return { ok: true, message: '', list: draft, synced: synced };
  }

  /** 试算 + 落盘 */
  function setTime(index, field, value) {
    const r = plan(index, field, value);
    if (r.ok && !writeCustom(r.list)) return { ok: false, message: '保存失败，请重试' };
    return r;
  }

  /** 切换某一节「无固定下课时间」 */
  function toggleOpenEnd(index, openEnd) {
    const list = all();
    const i = (Number(index) || 0) - 1;
    if (i < 0 || i >= list.length) return { ok: false, message: '节次不存在' };
    const draft = clone(list);
    draft[i].openEnd = !!openEnd;
    if (draft[i].openEnd && toMin(draft[i].end) <= toMin(draft[i].start)) {
      draft[i].end = shift(draft[i].start, 55);
    }
    const err = validate(draft);
    if (err) return { ok: false, message: err };
    if (!writeCustom(draft)) return { ok: false, message: '保存失败，请重试' };
    return { ok: true, message: '', list: draft };
  }

  /** 恢复默认作息 */
  function reset() {
    const settings = readStorageSettings();
    delete settings.periodTimes;
    writeStorageSettings(settings);
    return clone(DEFAULT_PERIODS);
  }

  global.CR = global.CR || {};
  global.CR.periods = {
    DEFAULT_PERIODS: DEFAULT_PERIODS,
    WEEK_NAMES: WEEK_NAMES,
    all: all,
    total: total,
    isCustom: isCustom,
    get: get,
    rangeText: rangeText,
    label: label,
    spanOf: spanOf,
    isContiguous: isContiguous,
    isLinked: isLinked,
    setLinked: setLinked,
    plan: plan,
    setTime: setTime,
    toggleOpenEnd: toggleOpenEnd,
    reset: reset
  };
})(window);
