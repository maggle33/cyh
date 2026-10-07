/**
 * 日期与时间工具
 * 从微信小程序版 utils/date.js 原样移植，逻辑未改动。
 */

(function (global) {
  'use strict';

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  /** Date -> 'YYYY-MM-DD' */
  function fmt(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** 'YYYY-MM-DD' -> Date */
  function parse(s) {
    const p = String(s).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function today() {
    return fmt(new Date());
  }

  function addDays(dateStr, n) {
    const d = parse(dateStr);
    d.setDate(d.getDate() + n);
    return fmt(d);
  }

  /** 周一=1 ... 周日=7 */
  function weekday(dateStr) {
    const w = parse(dateStr).getDay();
    return w === 0 ? 7 : w;
  }

  /** 该日期所在周的周一 */
  function mondayOf(dateStr) {
    return addDays(dateStr, -(weekday(dateStr) - 1));
  }

  function diffDays(a, b) {
    return Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000);
  }

  /** 相对开学第一周计算第几周 */
  function weekNo(termStart, dateStr) {
    const start = mondayOf(termStart || today());
    const n = Math.floor(diffDays(start, mondayOf(dateStr)) / 7) + 1;
    return n < 1 ? 1 : n;
  }

  /** 'HH:MM' -> 分钟数 */
  function toMin(t) {
    const p = String(t || '00:00').split(':');
    return Number(p[0]) * 60 + Number(p[1]);
  }

  function nowMin() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function nowHM() {
    const d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  /** 9月19日 周六 */
  function friendly(dateStr) {
    const d = parse(dateStr);
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + names[d.getDay()];
  }

  /** 今天 / 明天 / 后天 / 昨天 / 9月22日 周二 */
  function relative(dateStr) {
    const d = diffDays(today(), dateStr);
    if (d === 0) return '今天';
    if (d === 1) return '明天';
    if (d === 2) return '后天';
    if (d === -1) return '昨天';
    return friendly(dateStr);
  }

  /** 分钟差 -> "还有 25 分钟" */
  function humanGap(minutes) {
    if (minutes <= 0) return '已开始';
    if (minutes < 60) return '还有 ' + minutes + ' 分钟';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return '还有 ' + h + ' 小时' + (m ? m + ' 分' : '');
  }

  /** 分钟数 -> 'HH:MM' */
  function fromMin(minutes) {
    const m = Math.max(0, Math.min(23 * 60 + 59, Number(minutes) || 0));
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }

  global.CR = global.CR || {};
  global.CR.date = {
    pad: pad,
    fmt: fmt,
    parse: parse,
    today: today,
    addDays: addDays,
    weekday: weekday,
    mondayOf: mondayOf,
    diffDays: diffDays,
    weekNo: weekNo,
    toMin: toMin,
    nowMin: nowMin,
    nowHM: nowHM,
    friendly: friendly,
    relative: relative,
    humanGap: humanGap,
    fromMin: fromMin
  };
})(window);
