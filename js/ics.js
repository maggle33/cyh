/**
 * 导出为 iCalendar（.ics）
 *
 * 为什么需要它：网页应用无法在关闭后自行唤醒，但手机系统可以。
 * 把课程与日程写成 .ics 交给系统日历，之后由**系统**负责排程提醒——
 * 锁屏也响、静音也震、关掉浏览器照样准点，且不需要任何服务器与授权。
 *
 * 要点：
 *   - 时间用「浮动时间」（不带 Z、不含 VTIMEZONE），日历应用会按手机本地时间处理，
 *     避免时区转换把 08:00 的课变成 07:00。
 *   - 课程用 FREQ=WEEKLY 重复；单双周用 INTERVAL=2 + COUNT 表达。
 *   - 每条事件都带 VALARM，提前量取自各自的 remindBefore。
 */

(function (global) {
  'use strict';

  const CR = global.CR;
  const store = CR.store;
  const dateUtil = CR.date;
  const periods = CR.periods;
  const scheduleUtil = CR.schedule;

  const CRLF = '\r\n';

  /**
   * 是不是 iOS 设备。
   * iPadOS 13+ 的 Safari 会把自己伪装成 Mac，所以补一个触摸点判断。
   */
  const isIOS = /iPad|iPhone|iPod/.test(global.navigator.userAgent || '')
    || (global.navigator.platform === 'MacIntel' && global.navigator.maxTouchPoints > 1);

  /**
   * iOS 上的分享面板里，「日历」并不是一个总能选到的目标——
   * 取决于用户的日历账户配置。若分享面板里没有日历，也可存进「文件」，
   * 再点开该文件由系统导入。这个标记用于设置页给出更准确的说明。
   */
  const isIOSStandalone = !!(global.navigator.standalone);

  /* ---------------- 基础格式 ---------------- */

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  /** 'YYYY-MM-DD' + 'HH:MM' -> Date（本地时间） */
  function toDate(dateStr, timeStr) {
    const d = dateUtil.parse(dateStr);
    d.setMinutes(dateUtil.toMin(timeStr));
    return d;
  }

  /** Date -> 'YYYYMMDDTHHMMSS'（浮动时间，不带 Z） */
  function stamp(d) {
    return d.getFullYear()
      + pad2(d.getMonth() + 1)
      + pad2(d.getDate())
      + 'T'
      + pad2(d.getHours())
      + pad2(d.getMinutes())
      + pad2(d.getSeconds());
  }

  /** Date -> 'YYYYMMDD' */
  function dateStamp(d) {
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  /** iCalendar 文本值转义 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  /**
   * 按 RFC 5545 折行：每行不超过 75 个八位组，续行以一个空格开头。
   * 中文按 UTF-8 计算字节数，不能按字符数算。
   */
  function fold(line) {
    const bytes = [];
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      if (code < 0x80) bytes.push([code, 1]);
      else if (code < 0x800) bytes.push([i, 2]);
      else bytes.push([i, 3]);
    }
    // 逐字符累加字节数，超过 73 就断开（留出续行前导空格）
    const out = [];
    let cur = '';
    let curBytes = 0;
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      const size = code < 0x80 ? 1 : (code < 0x800 ? 2 : 3);
      if (curBytes + size > 73) {
        out.push(cur);
        cur = ' ';
        curBytes = 1;
      }
      cur += line[i];
      curBytes += size;
    }
    out.push(cur);
    return out.join(CRLF);
  }

  function addMinutes(d, minutes) {
    const t = new Date(d.getTime());
    t.setMinutes(t.getMinutes() + Number(minutes || 0));
    return t;
  }

  function uid(prefix, id) {
    return prefix + '-' + id + '@campus-reminder';
  }

  function alarmBlock(minutes, summary) {
    if (!minutes || Number(minutes) <= 0) return '';
    return [
      'BEGIN:VALARM',
      'TRIGGER:-PT' + Number(minutes) + 'M',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + esc(summary || '即将开始'),
      'END:VALARM'
    ].join(CRLF) + CRLF;
  }

  /* ---------------- 课程 ---------------- */

  /**
   * 一门课 -> 一条日历事件。
   *
   * 周次处理统一走 `store.weeksOf()` 拿到真实的周号列表：
   *   - 周号**连续**（等差）、且步长为 1 或 2 → 用紧凑的 RRULE
   *     （all 用 FREQ=WEEKLY;COUNT=n；odd/even 用 FREQ=WEEKLY;INTERVAL=2;COUNT=n）
   *   - 其余情况（比如自定义选了 1、3、7、12，跳得不规则）→ 用 DTSTART + RDATE 逐周列出。
   *     RRULE 表达不了任意周集合，硬凑会导出错误日期，日历上出现「本来没课的日子有课」。
   */
  function courseEvent(course, settings) {
    const span = periods.spanOf(course.periods);
    if (!span.start) return null;

    const termMonday = dateUtil.mondayOf(settings.termStart || dateUtil.today());
    const termWeeks = Number(settings.termWeeks) || 20;

    // 用 store 的统一展开，保证与课表/提醒里「这周上不上课」的判断完全一致
    const weekList = (store && typeof store.weeksOf === 'function')
      ? store.weeksOf(course.weeks, termWeeks)
      : fallbackWeeks(course.weeks, termWeeks);
    if (!weekList.length) return null;

    const firstWeek = weekList[0];
    const firstDate = dateUtil.addDays(termMonday, (firstWeek - 1) * 7 + (Number(course.day) - 1));
    const startAt = toDate(firstDate, span.start);

    // 第 12 节这类「无固定下课时间」的，按 55 分钟估一个时长用于日历展示
    let endAt;
    if (span.end) {
      endAt = toDate(firstDate, span.end);
      if (endAt <= startAt) endAt = addMinutes(startAt, 55);
    } else {
      endAt = addMinutes(startAt, 55);
    }

    const summary = course.name + '（' + periods.label(course.periods) + '）';

    // 判断能不能用一个 RRULE 表达：周号从 firstWeek 起、相邻差值恒定且为 1 或 2
    let step = 0;
    let regular = true;
    for (let i = 1; i < weekList.length; i++) {
      const gap = weekList[i] - weekList[i - 1];
      if (step === 0) step = gap;
      else if (gap !== step) { regular = false; break; }
    }
    if (regular && step !== 0 && step !== 1 && step !== 2) regular = false;
    if (weekList.length === 1) regular = true;      // 单周：没有间隔可谈，按 RRULE COUNT=1 走

    const lines = [
      'BEGIN:VEVENT',
      'UID:' + uid('course', course.id),
      'DTSTAMP:' + stamp(new Date()),
      'DTSTART:' + stamp(startAt),
      'DTEND:' + stamp(endAt)
    ];

    if (regular) {
      const count = weekList.length;
      const rrule = (step === 2)
        ? 'FREQ=WEEKLY;INTERVAL=2;COUNT=' + count
        : 'FREQ=WEEKLY;COUNT=' + count;
      lines.push('RRULE:' + rrule);
    } else {
      // 不规则周次：把每一周的日期显式列成 RDATE（含第一周那天本身）
      const rdates = weekList.map(wn => {
        const ds = dateUtil.addDays(termMonday, (wn - 1) * 7 + (Number(course.day) - 1));
        return stamp(toDate(ds, span.start));
      });
      lines.push('RDATE:' + rdates.join(','));
    }

    lines.push(
      'SUMMARY:' + esc(summary),
      course.location ? 'LOCATION:' + esc(course.location) : '',
      course.teacher ? 'DESCRIPTION:' + esc([course.teacher, course.note].filter(Boolean).join(' · ')) : (course.note ? 'DESCRIPTION:' + esc(course.note) : ''),
      'CATEGORIES:课程',
      alarmBlock(course.remindBefore === undefined || course.remindBefore === null ? settings.remindBefore : course.remindBefore, summary),
      'END:VEVENT'
    );
    return lines.filter(l => l !== '').join(CRLF) + CRLF;
  }

  /**
   * store 未加载时的兜底展开（老数据只有 type/from/to）。
   * 正常路径永远走 store.weeksOf，这里只是防止脚本顺序出问题时整体崩掉。
   */
  function fallbackWeeks(weeks, termWeeks) {
    const w = weeks || { type: 'all' };
    const max = Math.max(1, Number(termWeeks) || 30);
    if (w.type === 'custom') {
      return (Array.isArray(w.list) ? w.list : [])
        .map(n => Math.round(Number(n)))
        .filter(n => n >= 1 && n <= max)
        .sort((a, b) => a - b);
    }
    const from = Math.max(1, Math.round(Number(w.from) || 1));
    const to = Math.min(max, Math.round(Number(w.to) || max));
    const out = [];
    for (let n = from; n <= to; n++) {
      if (w.type === 'odd' && n % 2 === 0) continue;
      if (w.type === 'even' && n % 2 === 1) continue;
      out.push(n);
    }
    return out;
  }

  /* ---------------- 日程 ---------------- */

  function scheduleEvent(s, settings) {
    const type = scheduleUtil.repeatType(s);
    if (type === 'none' && s.done) return null;      // 已完成的一次性日程不再导出
    if (!s.date || !s.startTime) return null;

    const startAt = toDate(s.date, s.startTime);
    const endAt = s.endTime ? toDate(s.date, s.endTime) : addMinutes(startAt, 30);

    const lines = [
      'BEGIN:VEVENT',
      'UID:' + uid('schedule', s.id),
      'DTSTAMP:' + stamp(new Date()),
      'DTSTART:' + stamp(startAt),
      'DTEND:' + stamp(endAt > startAt ? endAt : addMinutes(startAt, 30)),
      'SUMMARY:' + esc(s.title)
    ];

    if (type !== 'none') {
      const until = scheduleUtil.untilOf(s);
      let rule;
      if (type === 'daily') rule = 'FREQ=DAILY';
      else if (type === 'weekly') rule = 'FREQ=WEEKLY';
      else rule = 'FREQ=MONTHLY';

      if (until) {
        const u = dateUtil.parse(until);
        rule += ';UNTIL=' + dateStamp(u) + 'T235959';
      } else {
        // 没设截止就保守地给个上限，避免生成无限重复
        rule += ';COUNT=' + (type === 'monthly' ? 12 : 52);
      }
      lines.push('RRULE:' + rule);

      // 已标记完成的那几次用 EXDATE 排除掉
      const done = (s.doneDates || []).filter(d => d >= s.date);
      if (done.length) {
        lines.push('EXDATE:' + done.map(d => stamp(toDate(d, s.startTime))).join(','));
      }
    }

    if (s.location) lines.push('LOCATION:' + esc(s.location));
    const desc = [s.category, s.note].filter(Boolean).join(' · ');
    if (desc) lines.push('DESCRIPTION:' + esc(desc));
    lines.push('CATEGORIES:' + esc(s.category || '日程'));

    const remind = (s.remindBefore === undefined || s.remindBefore === null)
      ? settings.remindBefore
      : s.remindBefore;
    const alarm = alarmBlock(remind, s.title);
    if (alarm) lines.push(alarm.replace(/\r\n$/, ''));

    lines.push('END:VEVENT');
    return lines.filter(l => l !== '').join(CRLF) + CRLF;
  }

  /* ---------------- 倒数日 ---------------- */

  /**
   * 一个倒数日 -> 一条「全天事件」。
   *
   * 倒数日没有具体时刻，规矩的做法是用 VALUE=DATE 的整天事件（DTSTART 只到日）。
   * 提前提醒用 VALARM 的 -P{N}D 表示「提前 N 天」，正好对上 remindBefore 里的天数；
   * 当天提醒（N=0）不能写 -P0D，用 PT0S 表示到点即提醒。
   *
   * 已过去的不再导出——它们是纪念性质，导到日历里只会多出一堆历史事件。
   */
  function countdownEvent(c) {
    if (!c.date) return null;
    if (dateUtil.diffDays(dateUtil.today(), c.date) < 0) return null;

    const d = dateUtil.parse(c.date);
    const dayAfter = addMinutes(d, 24 * 60);

    const summary = c.title;
    const lines = [
      'BEGIN:VEVENT',
      'UID:' + uid('countdown', c.id),
      'DTSTAMP:' + stamp(new Date()),
      'DTSTART;VALUE=DATE:' + dateStamp(d),
      'DTEND;VALUE=DATE:' + dateStamp(dayAfter),
      'SUMMARY:' + esc(summary),
      c.note ? 'DESCRIPTION:' + esc(c.note) : '',
      'CATEGORIES:倒数日'
    ];

    (c.remindBefore || []).forEach(days => {
      const n = Number(days);
      lines.push('BEGIN:VALARM');
      lines.push('TRIGGER:' + (n > 0 ? '-P' + n + 'D' : 'PT0S'));
      lines.push('ACTION:DISPLAY');
      lines.push('DESCRIPTION:' + esc(summary + (n > 0 ? '（还有 ' + n + ' 天）' : '（就是今天）')));
      lines.push('END:VALARM');
    });

    lines.push('END:VEVENT');
    return lines.filter(l => l !== '').join(CRLF) + CRLF;
  }

  /* ---------------- 每日打卡 ---------------- */

  /**
   * 一个打卡习惯 -> 一条每日重复事件。
   *
   * 为什么也导出：打卡提醒同样属于「关掉应用就没了」的提醒，
   * 交给系统日历才能真正准时。重复上限给 90 天——打卡是长期的，
   * 但无限重复会让日历里堆出一条永远不结束的日程，反而碍事。
   *
   * 已经打过卡的今天不额外排除：日历是「提醒你做」，完成后忽略提醒即可。
   */
  function habitEvent(h) {
    if (h.archived) return null;
    if (!h.remindAt) return null;              // 没设提醒时间的不导出

    const startAt = toDate(dateUtil.today(), h.remindAt);
    const endAt = addMinutes(startAt, 15);
    const summary = (h.icon ? h.icon + ' ' : '') + h.name;

    const lines = [
      'BEGIN:VEVENT',
      'UID:' + uid('habit', h.id),
      'DTSTAMP:' + stamp(new Date()),
      'DTSTART:' + stamp(startAt),
      'DTEND:' + stamp(endAt),
      'RRULE:FREQ=DAILY;COUNT=90',
      'SUMMARY:' + esc(summary),
      h.note ? 'DESCRIPTION:' + esc(h.note) : '',
      'CATEGORIES:每日打卡',
      alarmBlock(0, summary),
      'END:VEVENT'
    ];
    return lines.filter(l => l !== '').join(CRLF) + CRLF;
  }

  /* ---------------- 组装 ---------------- */

  /**
   * 生成 .ics 文本
   * opts: { courses: bool, schedules: bool, countdowns: bool, habits: bool }
   */
  function generate(opts) {
    const options = Object.assign(
      { courses: true, schedules: true, countdowns: true, habits: true },
      opts || {}
    );
    const settings = store.getSettings();
    const events = [];

    if (options.courses) {
      store.getCourses().forEach(c => {
        if (!c.periods || !c.periods.length) return;
        const ev = courseEvent(c, settings);
        if (ev) events.push(ev);
      });
    }
    if (options.schedules) {
      store.getSchedules().forEach(s => {
        const ev = scheduleEvent(s, settings);
        if (ev) events.push(ev);
      });
    }
    if (options.countdowns) {
      store.getCountdowns().forEach(c => {
        const ev = countdownEvent(c);
        if (ev) events.push(ev);
      });
    }
    if (options.habits) {
      store.getHabits().forEach(h => {
        const ev = habitEvent(h);
        if (ev) events.push(ev);
      });
    }

    const head = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Campus Reminder//Course & Schedule//CN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:课程与日程',
      'X-WR-TIMEZONE:Asia/Shanghai'
    ].join(CRLF) + CRLF;

    const raw = head + events.join('') + 'END:VCALENDAR' + CRLF;

    // 对外只暴露折行后的版本：符合 RFC 5545 的每行 75 字节限制，
    // 直接拿去保存即可。raw 留着便于排查问题，不要拿去写文件。
    return {
      text: raw.split(CRLF).map(fold).join(CRLF),
      raw: raw,
      count: events.length
    };
  }

  /* ---------------- 交给系统 ---------------- */

  /**
   * 保存 / 分享一个文件
   *
   * 四条路，按环境选：
   *   1. 安卓应用里 → 交给原生写进系统「下载」目录；text/calendar 还会让日历应用接手
   *      （WebView 不支持 navigator.share，而且 blob 链接的下载在 WebView 里会被丢弃）
   *   2. iOS（Safari / 已加到主屏幕）→ 系统分享面板。iOS 上这是唯一能把 .ics
   *      直接交给「日历」的途径：分享面板里选「日历」即可导入，锁屏提醒也就有了。
   *   3. 其它手机浏览器 → 系统分享面板（部分安卓支持，能直接存进「文件」或交给日历 App）
   *   4. 其余 → 普通下载
   *
   * mimeType 默认 text/calendar（导出课表）；导出 JSON 备份时传 application/json。
   * 返回 'shared' | 'saved' | 'downloaded' | 'cancelled' | 'failed'
   */
  function save(filename, text, mimeType) {
    const mime = mimeType || 'text/calendar';

    // 路径一：安卓壳
    const android = global.Android;
    if (android) {
      try {
        if (typeof android.saveFile === 'function') {
          android.saveFile(filename, mime, text);
          return Promise.resolve('saved');
        }
        if (mime === 'text/calendar' && typeof android.saveIcs === 'function') {
          android.saveIcs(filename, text);
          return Promise.resolve('saved');
        }
      } catch (e) {
        // 落到下面的网页路径
      }
    }

    const blob = new Blob([text], { type: mime + ';charset=utf-8' });

    // 路径二 / 三：系统分享（带文件）
    if (global.navigator && global.navigator.canShare && global.File) {
      try {
        const file = new global.File([blob], filename, { type: mime });
        if (global.navigator.canShare({ files: [file] })) {
          return global.navigator.share({ files: [file], title: filename })
            .then(() => 'shared')
            .catch(err => (err && err.name === 'AbortError') ? 'cancelled' : download(blob, filename));
        }
      } catch (e) {
        // 落到下载
      }
    }

    // iOS 上若不支持带文件的分享（老系统），退回文本分享：
    // 至少让用户能把 .ics 内容复制出去，而不是直接失败。
    if (isIOS && global.navigator && typeof global.navigator.share === 'function' && mime === 'text/calendar') {
      return global.navigator.share({ title: filename, text: text })
        .then(() => 'shared')
        .catch(err => (err && err.name === 'AbortError') ? 'cancelled' : download(blob, filename));
    }

    // 路径四：普通下载
    return Promise.resolve(download(blob, filename));
  }

  function download(blob, filename) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (e) { /* 忽略 */ }
      }, 1500);
      return 'downloaded';
    } catch (e) {
      return 'failed';
    }
  }

  CR.ics = {
    generate: generate,
    save: save
  };
})(window);
