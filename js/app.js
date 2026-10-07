/**
 * 应用主体：四个标签页 + 编辑面板
 * 行为对齐微信小程序版，界面按网页重写。
 */

(function (global) {
  'use strict';

  const CR = global.CR;
  const store = CR.store;
  const dateUtil = CR.date;
  const periods = CR.periods;
  const scheduleUtil = CR.schedule;
  const ui = CR.ui;
  const ics = CR.ics;
  const reminder = CR.reminder;
  const plan = CR.plan;

  const REMIND_VALUES = [0, 5, 10, 15, 20, 30, 60, 120];
  const REMIND_LABELS = ['不提醒', '提前 5 分钟', '提前 10 分钟', '提前 15 分钟', '提前 20 分钟', '提前 30 分钟', '提前 1 小时', '提前 2 小时'];
  const CATEGORIES = ['作业', '考试', '活动', '会议', '其他'];
  const REPEAT_KEYS = ['none', 'daily', 'weekly', 'monthly'];
  const REPEAT_LABELS = ['不重复', '每天', '每周', '每月'];
  const BACK_DAYS = 30;
  const FORWARD_DAYS = 60;

  // 版本号唯一来源。打包安卓 APK 时 tools/build-android.py 会把这一行改写成
  // 它自己的 VERSION_NAME，所以这里改了网页版生效、打包后 APK 里也一定一致。
  // eslint-disable-next-line
  const APP_VERSION = '1.0.15';

  const state = {
    tab: 'today',
    ttWeek: null,
    schTab: 'todo',
    schCategory: '全部',
    schView: 'calendar',   // 日程页视图：calendar 月历 | list 列表
    schMonth: null,        // 月历当前查看的月份 {y, m}
    schSelDate: null,      // 月历里选中的那一天 'YYYY-MM-DD'
    timeline: [],
    edit: null,
    cdFilter: 'all',       // 倒数日筛选：all | future | past
    hwFilter: 'todo',      // 作业筛选：todo 未交 | done 已交
    habitMonth: null       // 打卡日历当前查看的月份，{y, m}
  };

  const $ = id => document.getElementById(id);

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function remindLabelOf(minutes) {
    const i = REMIND_VALUES.indexOf(Number(minutes));
    if (i >= 0) return REMIND_LABELS[i];
    return '提前 ' + minutes + ' 分钟';
  }

  /* =========================================================
     今日
     ========================================================= */

  function buildToday() {
    const todayStr = dateUtil.today();
    const settings = store.getSettings();
    const weekNo = dateUtil.weekNo(settings.termStart, todayStr);
    const wd = dateUtil.weekday(todayStr);
    const nowM = dateUtil.nowMin();

    const courses = store.getCourses()
      .filter(c => Number(c.day) === wd && c.periods && c.periods.length)
      .filter(c => store.isCourseActive(c, weekNo))
      .map(c => {
        const span = periods.spanOf(c.periods);
        const startM = dateUtil.toMin(span.start);
        const endM = span.end ? dateUtil.toMin(span.end) : startM + 60;
        let status = 'wait';
        let statusText = '待上课';
        if (nowM >= endM) { status = 'done'; statusText = '已结束'; }
        else if (nowM >= startM) { status = 'ing'; statusText = '进行中'; }
        return {
          id: c.id,
          name: c.name,
          location: c.location || '',
          teacher: c.teacher || '',
          periodText: periods.label(c.periods),
          timeText: span.start + (span.end ? ' ~ ' + span.end : ' 之后'),
          startM: startM,
          endM: endM,
          color: c.color || '#378ADD',
          status: status,
          statusText: statusText,
          skipped: store.isSkipped(todayStr, c.id)
        };
      })
      .sort((a, b) => a.startM - b.startM);

    const schedules = scheduleUtil.todayList().map(s => {
      let status = 'wait';
      let statusText = s.startTime + ' 开始';
      if (s.done) { status = 'done'; statusText = '已完成'; }
      else if (s.endTime && nowM > dateUtil.toMin(s.endTime)) { status = 'past'; statusText = '已过期'; }
      else if (s.startMinutes <= nowM) { status = 'ing'; statusText = '进行中'; }
      return {
        id: s.id,
        date: s.date,
        title: s.title,
        location: s.location,
        timeText: s.timeText,
        category: s.category,
        color: s.color,
        note: s.note,
        repeatText: s.repeatText,
        done: s.done,
        status: status,
        statusText: statusText,
        startM: s.startMinutes,
        endM: s.endTime ? dateUtil.toMin(s.endTime) : s.startMinutes + 30,
        startTime: s.startTime || '',
        endTime: s.endTime || ''
      };
    }).sort((a, b) => (a.done === b.done ? a.startM - b.startM : (a.done ? 1 : -1)));

    // 时间轴，供倒计时滚动使用
    const timeline = [];
    courses.forEach(c => {
      if (c.skipped || c.status === 'done') return;
      timeline.push({ kind: '课程', name: c.name, startM: c.startM, endM: c.endM, location: c.location });
    });
    schedules.forEach(s => {
      if (s.done) return;
      timeline.push({
        kind: '日程',
        name: s.title,
        startM: s.startM,
        endM: s.endM,
        location: s.location
      });
    });
    timeline.sort((a, b) => a.startM - b.startM);
    state.timeline = timeline;

    return { todayStr, settings, weekNo, courses, schedules };
  }

  function countdownText() {
    const nowM = dateUtil.nowMin();
    const list = state.timeline || [];
    if (!list.length) return '今天没有更多安排，放松一下';
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (nowM >= it.startM && nowM < it.endM) {
        return '「' + it.name + '」正在进行中' + (it.location ? ' · ' + it.location : '') + '，剩余约 ' + (it.endM - nowM) + ' 分钟';
      }
      if (it.startM > nowM) {
        return '距离' + it.kind + '「' + it.name + '」还有 ' + (it.startM - nowM) + ' 分钟' + (it.location ? ' · ' + it.location : '');
      }
    }
    return '今天的安排都结束了';
  }

  function todayTimelineHtml(d) {
    const nowM = dateUtil.nowMin();
    const entries = [];
    d.courses.forEach(c => entries.push({
      kind: '课程', name: c.name, id: c.id, startM: c.startM, endM: c.endM,
      startText: c.timeText.split(' ~ ')[0], location: c.location, color: c.color,
      status: c.skipped ? 'skipped' : c.status, action: 'edit-course'
    }));
    d.schedules.forEach(s => entries.push({
      kind: '日程', name: s.title, id: s.id, date: s.date, startM: s.startM, endM: s.endM,
      startText: s.startTime || s.timeText.split(' ~ ')[0], location: s.location, color: s.color,
      status: s.done ? 'done' : s.status, action: 'schedule-menu'
    }));
    entries.sort((a, b) => a.startM - b.startM);
    const nextIndex = entries.findIndex(item => item.status === 'wait' && item.startM >= nowM);
    if (!entries.length) return '<div class="section-title">今日时间轴</div><div class="empty">今天还没有安排</div>';

    let html = '<div class="section-title timeline-heading">今日时间轴<span class="section-sub">按时间排序</span></div>'
      + '<div class="timeline-card">';
    entries.forEach((item, index) => {
      const isNow = item.status === 'ing';
      const isDone = item.status === 'done' || item.status === 'past' || item.status === 'skipped';
      const isNext = index === nextIndex;
      const cls = (isNow ? ' is-now' : '') + (isDone ? ' is-done' : '') + (isNext ? ' is-next' : '');
      const meta = item.startText + (item.location ? ' · ' + item.location : '');
      html += '<div class="timeline-entry' + cls + '" data-act="' + item.action + '" data-id="' + esc(item.id) + '"'
        + (item.date ? ' data-date="' + esc(item.date) + '"' : '') + '>'
        + '<div class="timeline-time">' + esc(item.startText) + '</div>'
        + '<div class="timeline-rail"><span class="timeline-dot" style="--tl:' + esc(item.color || '#378ADD') + '"></span></div>'
        + '<div class="timeline-content"><div class="timeline-title"><span>' + esc(item.name) + '</span>'
        + (isNow ? '<span class="tag tag-teal">进行中</span>' : isNext ? '<span class="tag tag-blue">下一项</span>' : '')
        + '</div><div class="timeline-meta">' + esc(meta) + '</div></div></div>';
    });
    return html + '</div>';
  }

  function renderToday() {
    const d = buildToday();
    const notif = reminder.permission();

    let html = '';

    html += '<div class="hero">'
      + '<div class="hero-top">'
      + '<span class="hero-date">' + esc(dateUtil.friendly(d.todayStr)) + '</span>'
      + '<span class="hero-week">第 ' + d.weekNo + ' 周</span>'
      + '</div>'
      + '<div class="hero-now" id="heroNow">' + dateUtil.nowHM() + '</div>'
      + '<div class="hero-next" id="heroNext">' + esc(countdownText()) + '</div>'
      + '<div class="hero-count">今天 ' + d.courses.length + ' 门课 · ' + d.schedules.length + ' 个日程</div>'
      + '</div>';

    html += '<div class="quick">'
      + '<button class="quick-btn quick-main" data-act="add-course">'
      + '<span class="quick-plus">＋</span>添加课程</button>'
      + '<button class="quick-btn quick-alt" data-act="add-schedule">'
      + '<span class="quick-plus">＋</span>添加日程</button>'
      + '</div>';

    html += checkinTodayHtml();

    if (notif === 'default') {
      html += '<div class="notice notice-warn">'
        + '<div class="notice-body">开启通知后，应用打开期间到点会直接弹出系统通知</div>'
        + '<button class="notice-btn" data-act="ask-notify">开启</button>'
        + '</div>';
    } else if (notif === 'denied') {
      html += '<div class="notice notice-warn">'
        + '<div class="notice-body">通知被浏览器拒绝了。想要关掉应用也能准时提醒，用「设置 → 导出到系统日历」这条路</div>'
        + '<button class="notice-btn" data-act="go-settings">去设置</button>'
        + '</div>';
    } else if (notif === 'granted') {
      html += '<div class="notice notice-ok"><div class="notice-body">系统通知已开启。关掉应用后的提醒请用「导出到系统日历」</div></div>';
    } else if (notif === 'unsupported' && typeof window.__crIsIOS === 'function' && window.__crIsIOS()) {
      // iOS 上网页拿不到通知权限，与其什么都不显示，不如把唯一有效的
      // 「关掉也能提醒」路径直接摆到首屏，省得用户去设置里翻。
      html += '<div class="notice notice-ok">'
        + '<div class="notice-body">想让 iPhone 关掉应用也能提醒？导出到系统日历即可</div>'
        + '<button class="notice-btn" data-act="export-ics">去导出</button>'
        + '</div>';
    }

    html += todayTimelineHtml(d);

    // 今天的课
    html += '<div class="section-title">今天的课</div>';
    if (!d.courses.length) {
      html += '<div class="empty">今天没有课</div>';
    } else {
      d.courses.forEach(c => {
        const tagCls = c.status === 'done' ? 'tag-gray' : (c.status === 'ing' ? 'tag-teal' : 'tag-blue');
        html += '<div class="item' + (c.skipped ? ' is-skipped' : '') + '" data-act="edit-course" data-id="' + esc(c.id) + '">'
          + '<span class="bar" style="background:' + esc(c.color) + '"></span>'
          + '<div class="grow">'
          + '<div class="row-between"><span class="item-name">' + esc(c.name) + '</span>'
          + '<span class="tag ' + tagCls + '">' + esc(c.skipped ? '本周不上' : c.statusText) + '</span></div>'
          + '<div class="item-meta">' + esc(c.periodText + ' · ' + c.timeText
            + (c.location ? ' · ' + c.location : '')
            + (c.teacher ? ' · ' + c.teacher : '')) + '</div>'
          + '</div></div>';
      });
    }

    // 今日日程
    html += '<div class="section-title">今日日程</div>';
    if (!d.schedules.length) {
      html += '<div class="empty">今天没有日程</div>';
    } else {
      d.schedules.forEach(s => {
        const tagCls = s.status === 'done' ? 'tag-teal' : (s.status === 'past' ? 'tag-red' : (s.status === 'ing' ? 'tag-amber' : 'tag-blue'));
        html += '<div class="item' + (s.done ? ' is-done' : '') + '" data-act="schedule-menu" data-id="' + esc(s.id) + '" data-date="' + esc(s.date) + '">'
          + '<span class="bar" style="background:' + esc(s.color) + '"></span>'
          + '<div class="grow">'
          + '<div class="row-between"><span class="item-name">' + esc(s.title) + '</span>'
          + '<span class="tag ' + tagCls + '">' + esc(s.statusText) + '</span></div>'
          + '<div class="item-meta">' + esc(s.timeText + (s.location ? ' · ' + s.location : '') + (s.repeatText ? ' · ' + s.repeatText : '')) + '</div>'
          + (s.note ? '<div class="item-note">' + esc(s.note) + '</div>' : '')
          + '</div></div>';
      });
    }

    // 今日到期作业
    html += todayHomeworkHtml();

    return html;
  }

  /**
   * 今日页里的「作业」区块。
   *
   * 只显示**今天要交的和已经逾期的**，不是把全部未交作业都铺出来：
   * 今日页的定位是「今天该干什么」，罗列全部未交作业会让它变成第二个作业列表。
   * 完整清单在倒数日页，这里只负责把最紧的两件事顶到眼前。
   *
   * 完全没有作业数据时返回空串——没建过作业的人不该在今日页多看到一个空区块。
   */
  function todayHomeworkHtml() {
    const now = new Date();
    // listHomeworks(now,'todo') 返回的是 homeworkState() 的扁平结果：
    // { item, state, days, bigNum, bigUnit, overdue }，业务字段在 .item 里。
    const todo = plan.listHomeworks(now, 'todo');
    const urgent = todo.filter(st => st.state === 'today' || st.state === 'overdue');
    if (!urgent.length) return '';

    const overdueCount = urgent.filter(st => st.overdue).length;
    const todayCount = urgent.length - overdueCount;
    const badge = [];
    if (overdueCount) badge.push('<span class="hw-count is-overdue">' + overdueCount + ' 项已逾期</span>');
    if (todayCount) badge.push('<span class="hw-count">今天 ' + todayCount + ' 项到期</span>');

    let html = '<div class="section-title">作业' + badge.join('') + '</div>'
      + '<div class="hw-list">';

    urgent.forEach(st => {
      const hw = st.item || {};
      const cls = st.state === 'overdue' ? ' is-overdue' : '';
      const hwColor = hw.color || '#D4537E';
      html += '<div class="hw-row' + cls + '">'
        // 勾选框：今日页也要能直接交作业，否则还得跳去倒数日页
        + '<button class="hw-check" data-act="toggle-hw" data-id="' + esc(hw.id) + '"'
        + ' aria-label="标记为已交"></button>'
        + '<div class="hw-main" data-act="hw-menu" data-id="' + esc(hw.id) + '">'
        + '<div class="hw-title">'
        + (hw.courseName ? '<span class="hw-course" style="--hw:' + esc(hwColor) + '">'
          + esc(hw.courseName) + '</span>' : '')
        + esc(hw.title || '作业')
        + '</div>'
        + '<div class="hw-meta">'
        + (st.dateText ? esc(st.dateText) + ' · ' : '')
        + esc(st.timeText || '')
        + '</div>'
        + '</div>'
        + '<div class="hw-num' + (st.overdue ? ' is-overdue' : '') + '">'
        + '<span class="hw-num-big">' + esc(st.bigNum) + '</span>'
        + (st.bigUnit ? '<span class="hw-num-unit">' + esc(st.bigUnit) + '</span>' : '')
        + '</div>'
        + '</div>';
    });

    html += '</div>'
      + '<button class="btn" data-act="go-homework">查看全部作业</button>';
    return html;
  }

  /* =========================================================
     今日 · 打卡区
     ========================================================= */

  /**
   * 今日页里的打卡区。
   *
   * 放在「今日」页而不是单开一页，是因为打卡本质上是**每天的小动作**：
   * 打开应用第一眼就该看到一个能直接点的按钮，多跳一层反而容易忘。
   * 历史记录与月历放在倒数日页的「打卡」标签里细看。
   */
  function checkinTodayHtml() {
    const list = plan.listHabits();
    const prog = plan.todayProgress();
    const active = list.filter(h => !h.archived);

    if (!active.length) {
      // 空状态：给一个明确的入口，而不是一句「暂无数据」
      return '<div class="section-title">每日打卡</div>'
        + '<div class="empty">还没有打卡项。设一个每天想坚持的小事，点一下就能记录。</div>'
        + '<button class="btn btn-primary" data-act="add-habit">'
        + '<span class="btn-plus">＋</span>新建打卡项</button>';
    }

    let html = '<div class="section-title">每日打卡'
      + '<span class="section-sub">' + prog.done + ' / ' + prog.total + '</span>'
      + '</div>';

    html += '<div class="card checkin-card">';
    active.forEach(h => {
      const hint = plan.streakHint(h.streak, h.done);
      html += '<div class="habit-row' + (h.done ? ' is-done' : '') + '">'
        + '<button class="habit-btn" data-act="toggle-habit" data-id="' + esc(h.id) + '"'
        + ' aria-pressed="' + (h.done ? 'true' : 'false') + '"'
        + ' style="--hc:' + esc(h.color) + '">'
        + '<span class="habit-check">' + (h.done ? '✓' : '') + '</span>'
        + '</button>'
        + '<div class="habit-info" data-act="habit-menu" data-id="' + esc(h.id) + '">'
        + '<div class="habit-name">' + (h.icon ? '<span class="habit-ico">' + esc(h.icon) + '</span>' : '')
        + esc(h.name) + '</div>'
        + '<div class="habit-meta">'
        + (h.streak > 0 ? '<span class="habit-streak">连续 ' + h.streak + ' 天</span>' : '')
        + (h.remindAt ? '<span class="habit-time">' + esc(h.remindAt) + ' 提醒</span>' : '')
        + (hint ? '' : '')
        + '</div>'
        + '</div>'
        + '<button class="habit-more" data-act="habit-menu" data-id="' + esc(h.id) + '" aria-label="更多">⋯</button>'
        + '</div>';
    });
    html += '</div>';

    html += '<button class="btn btn-ghost btn-mini" data-act="add-habit">＋ 新建打卡项</button>';

    return html;
  }

  /* =========================================================
     倒数日
     ========================================================= */

  /* =========================================================
     倒数日页 · 作业
     ========================================================= */

  /**
   * 作业区。放在倒数日页的最上面，因为它是这个页面里最「有事要办」的部分——
   * 倒数日是「还有多少天」，看一眼就走；作业是「还没交」，得动手。
   *
   * 一个都没录过的时候整块不显示（返回空串），不给新用户增加噪音；
   * 录过但全交完了，显示一行「全部交完」的小结，当作正反馈。
   */
  function homeworkSectionHtml(now) {
    const hwList = plan.listHomeworks(now, state.hwFilter || 'todo');
    const todo = plan.homeworkTodoCount();
    const overdue = plan.homeworkOverdueCount(now);
    const allCount = store.getHomeworks().length;

    if (!allCount) return '';

    let html = '<div class="section-title" style="margin:0 0 10px 0">作业'
      + (todo ? '<span class="hw-count">' + todo + ' 项未交</span>' : '')
      + (overdue ? '<span class="hw-count is-overdue">' + overdue + ' 项已逾期</span>' : '')
      + '</div>';

    if (!hwList.length) {
      html += '<div class="card"><div class="hw-empty">'
        + (state.hwFilter === 'done' ? '还没有已交的作业。' : '全部交完了，清静。')
        + '</div></div>';
    } else {
      html += '<div class="card"><div class="hw-list">';
      hwList.forEach(s => {
        const hw = s.item;
        const color = hw.color || '#D4537E';
        const done = s.state === 'done';
        html += '<div class="hw-row' + (done ? ' is-done' : '') + (s.overdue ? ' is-overdue' : '') + '">'
          // 勾选框：点它就切换已交/未交，不必进编辑面板
          + '<button class="hw-check' + (done ? ' on' : '') + '" data-act="toggle-hw" data-id="' + esc(hw.id) + '"'
          + ' aria-label="' + (done ? '标记为未交' : '标记为已交') + '">'
          + (done ? '✓' : '') + '</button>'
          + '<div class="hw-main" data-act="hw-menu" data-id="' + esc(hw.id) + '">'
          + '<div class="hw-title">'
          + (hw.courseName ? '<span class="hw-course" style="--hw:' + esc(color) + '">'
            + esc(hw.courseName) + '</span>' : '')
          + esc(hw.title)
          + '</div>'
          + '<div class="hw-meta">'
          + (s.dateText ? esc(s.dateText) + ' · ' : '')
          + esc(s.timeText)
          + (done && hw.doneAt ? ' · 已于 ' + esc(hw.doneAt) + ' 交' : '')
          + '</div>'
          + '</div>'
          + '<div class="hw-num' + (s.overdue ? ' is-overdue' : '') + '">'
          + '<span class="hw-num-big">' + esc(s.bigNum) + '</span>'
          + (s.bigUnit ? '<span class="hw-num-unit">' + esc(s.bigUnit) + '</span>' : '')
          + '</div>'
          + '</div>';
      });
      html += '</div></div>';
    }

    html += '<div class="tabs hw-tabs">'
      + [['todo', '未交'], ['done', '已交']].map(t =>
        '<button class="tab-item' + ((state.hwFilter || 'todo') === t[0] ? ' on' : '') + '"'
        + ' data-act="hw-filter" data-key="' + t[0] + '">' + t[1] + '</button>'
      ).join('')
      + '</div>';

    html += '<button class="btn btn-primary" data-act="add-homework">'
      + '<span class="btn-plus">＋</span>新建作业</button>';

    return html;
  }

  function renderCountdown() {
    const now = new Date();
    const all = plan.listCountdowns(now);
    let list = all;
    if (state.cdFilter === 'future') list = all.filter(s => s.state !== 'past');
    else if (state.cdFilter === 'past') list = all.filter(s => s.state === 'past');

    // 下一条倒数日做成大卡片放最上面，其余用紧凑列表。
    //
    // 选谁当主角：有「精确到秒」的条目时优先选它——那类条目用户本来就想盯着秒数看，
    // 把秒表放进大卡片才用得上；否则取列表里最近的一条。
    const future = all.filter(s => s.state !== 'past');
    const hero = (state.cdFilter === 'all' || state.cdFilter === 'future')
      ? (future.filter(s => s.item.dateMode === 'sec')[0] || future[0] || null)
      : null;

    let html = '';

    html += homeworkSectionHtml(now);

    if (hero) {
      const sec = hero.item.dateMode === 'sec';
      html += '<div class="cd-hero" style="--cd:' + esc(hero.item.color || '#378ADD') + '">'
        + '<div class="cd-hero-top">'
        + '<span class="cd-hero-title">' + esc(hero.item.title) + '</span>'
        + (hero.item.pinned ? '<span class="cd-pin">已置顶</span>' : '')
        + '</div>'
        + '<div class="cd-hero-main">'
        + '<span class="cd-big">' + esc(hero.bigNum) + '</span>'
        + (hero.bigUnit ? '<span class="cd-unit">' + esc(hero.bigUnit) + '</span>' : '')
        + '</div>'
        + '<div class="cd-hero-date">' + esc(hero.dateText) + '</div>'
        + (sec
          ? '<div class="cd-clock" data-cd-clock="' + esc(hero.item.id) + '">' + esc(hero.clockText) + '</div>'
          : '')
        + (hero.item.note ? '<div class="cd-hero-note">' + esc(hero.item.note) + '</div>' : '')
        + '<div class="cd-hero-acts">'
        + '<button class="cd-hero-btn" data-act="edit-countdown" data-id="' + esc(hero.item.id) + '">编辑</button>'
        + '<button class="cd-hero-btn" data-act="toggle-pin" data-id="' + esc(hero.item.id) + '">'
        + (hero.item.pinned ? '取消置顶' : '置顶') + '</button>'
        + '</div>'
        + '</div>';
    }

    html += '<div class="tabs">'
      + [['all', '全部'], ['future', '未来'], ['past', '已过']].map(t =>
        '<button class="tab-item' + (state.cdFilter === t[0] ? ' on' : '') + '" data-act="cd-filter" data-key="' + t[0] + '">' + t[1] + '</button>'
      ).join('')
      + '</div>';

    if (!list.length) {
      html += '<div class="empty">' + (all.length ? '这里还没有内容' : '还没有倒数日。考试、放假、生日都可以记一笔。') + '</div>';
    } else {
      html += '<div class="card"><div class="cd-list">';
      list.forEach(s => {
        const sec = s.item.dateMode === 'sec';
        html += '<div class="cd-row' + (s.state === 'past' ? ' is-past' : '') + (s.state === 'today' ? ' is-today' : '') + '"'
          + ' data-act="cd-menu" data-id="' + esc(s.item.id) + '">'
          + '<span class="cd-bar" style="background:' + esc(s.item.color || '#378ADD') + '"></span>'
          + '<div class="cd-row-main">'
          + '<div class="cd-row-title">' + (s.item.pinned ? '<span class="cd-mini-pin">📌</span>' : '')
          + esc(s.item.title) + '</div>'
          + '<div class="cd-row-date">' + esc(s.dateText)
          + (sec ? ' · 精确到秒' : '') + '</div>'
          // 精确到秒的条目在列表里也要有自己的一行时钟。
          // 只有最上面那张大卡片显示时钟是不够的——用户可能置顶了别的条目，
          // 那条想盯着秒数的倒数就永远露不出来了。
          + (sec ? '<div class="cd-row-clock" data-cd-clock="' + esc(s.item.id) + '">'
            + esc(s.clockText) + '</div>' : '')
          + '</div>'
          + '<div class="cd-row-num">'
          + '<span class="cd-num">' + esc(s.bigNum) + '</span>'
          + (s.bigUnit ? '<span class="cd-num-unit">' + esc(s.bigUnit) + '</span>' : '')
          + '</div>'
          + '</div>';
      });
      html += '</div></div>';
    }

    html += '<button class="btn btn-primary" data-act="add-countdown">'
      + '<span class="btn-plus">＋</span>新建倒数日</button>';

    html += checkinHistoryHtml();

    return html;
  }

  /* =========================================================
     倒数日页 · 打卡历史
     ========================================================= */

  /**
   * 打卡历史：每个习惯一张卡，含月历热力图与三项统计。
   * 放在倒数日页是因为两者都按天看，切换成本低；
   * 日常打卡动作仍留在今日页，这里只负责「回看」。
   */
  function checkinHistoryHtml() {
    const list = plan.listHabits();
    if (!list.length) return '';

    let html = '<div class="section-title" style="margin-top:22px">打卡记录</div>';

    list.forEach(h => {
      if (h.archived) return;
      const y = state.habitMonth ? state.habitMonth.y : new Date().getFullYear();
      const m = state.habitMonth ? state.habitMonth.m : (new Date().getMonth() + 1);
      const cells = plan.monthGrid(h.id, y, m);

      html += '<div class="card habit-card">'
        + '<div class="habit-card-head">'
        + '<span class="habit-card-name">' + (h.icon ? '<span class="habit-ico">' + esc(h.icon) + '</span>' : '')
        + esc(h.name) + '</span>'
        + '<button class="habit-more" data-act="habit-menu" data-id="' + esc(h.id) + '" aria-label="更多">⋯</button>'
        + '</div>'
        + '<div class="habit-stats">'
        + '<div class="habit-stat"><b>' + h.streak + '</b><span>连续</span></div>'
        + '<div class="habit-stat"><b>' + h.best + '</b><span>最长</span></div>'
        + '<div class="habit-stat"><b>' + h.total + '</b><span>累计</span></div>'
        + '</div>'
        + '<div class="cal-head">'
        + '<button class="cal-nav" data-act="cal-prev" data-id="' + esc(h.id) + '">‹</button>'
        + '<span class="cal-title">' + y + ' 年 ' + m + ' 月</span>'
        + '<button class="cal-nav" data-act="cal-next" data-id="' + esc(h.id) + '">›</button>'
        + '</div>'
        + '<div class="cal-grid">'
        + ['一', '二', '三', '四', '五', '六', '日'].map(d => '<span class="cal-wd">' + d + '</span>').join('')
        + cells.map(c => {
          if (!c) return '<span class="cal-cell is-blank"></span>';
          const cls = 'cal-cell' + (c.on ? ' on' : '') + (c.isToday ? ' is-today' : '')
            + (c.future ? ' is-future' : '');
          return '<span class="' + cls + '" style="--hc:' + esc(h.color) + '"'
            + ' data-act="cal-cell" data-id="' + esc(h.id) + '" data-date="' + esc(c.date) + '"'
            + ' title="' + esc(c.date) + '">' + c.day + '</span>';
        }).join('')
        + '</div>'
        + '<div class="cal-legend">点格子可以补打卡或取消，方便回头补记</div>'
        + '</div>';
    });

    return html;
  }

  /* =========================================================
     课表
     ========================================================= */

  function renderTimetable() {
    const settings = store.getSettings();
    const termWeeks = settings.termWeeks || 20;
    const currentWeekNo = dateUtil.weekNo(settings.termStart, dateUtil.today());
    if (!state.ttWeek) state.ttWeek = currentWeekNo;
    const weekNo = Math.max(1, Math.min(termWeeks, state.ttWeek));
    state.ttWeek = weekNo;

    const todayStr = dateUtil.today();
    const todayWd = dateUtil.weekday(todayStr);
    const monday = dateUtil.addDays(dateUtil.mondayOf(settings.termStart), (weekNo - 1) * 7);

    const days = [];
    for (let i = 1; i <= 7; i++) {
      const ds = dateUtil.addDays(monday, i - 1);
      const dd = dateUtil.parse(ds);
      days.push({
        key: i,
        name: periods.WEEK_NAMES[i - 1],
        date: (dd.getMonth() + 1) + '/' + dd.getDate(),
        isToday: ds === todayStr
      });
    }

    const rows = periods.all();
    const blocks = [];
    store.getCourses().forEach(c => {
      if (!c.periods || !c.periods.length) return;
      if (!store.isCourseActive(c, weekNo)) return;
      const list = c.periods.slice().sort((a, b) => a - b);
      const minP = list[0];
      const maxP = list[list.length - 1];
      const span = periods.spanOf(list);
      blocks.push({
        id: c.id,
        name: c.name,
        location: c.location || '',
        periodText: periods.label(list),
        timeText: span.start + (span.end ? '~' + span.end : ' 之后'),
        color: c.color || '#378ADD',
        day: Number(c.day),
        minP: minP,
        spanRows: maxP - minP + 1,
        isToday: weekNo === currentWeekNo && Number(c.day) === todayWd,
        skipped: store.isSkipped(todayStr, c.id)
      });
    });

    const parts = [];
    parts.push('<div class="tt-corner" style="grid-column:1;grid-row:1"></div>');
    days.forEach((d, i) => {
      parts.push('<div class="tt-day' + (d.isToday ? ' is-today' : '') + '" style="grid-column:' + (i + 2) + ';grid-row:1">'
        + '<span>' + esc(d.name) + '</span><span class="dnum">' + esc(d.date) + '</span></div>');
    });
    rows.forEach((p, r) => {
      parts.push('<div class="tt-timecell" style="grid-column:1;grid-row:' + (r + 2) + '">'
        + '<span class="pno">' + p.index + '</span><span>' + esc(p.start) + '</span></div>');
      days.forEach((d, i) => {
        parts.push('<div class="tt-cell" data-act="cell" data-day="' + d.key + '" data-period="' + p.index + '"'
          + ' style="grid-column:' + (i + 2) + ';grid-row:' + (r + 2) + '"></div>');
      });
    });
    blocks.forEach(b => {
      parts.push('<div class="tt-block' + (b.isToday ? ' is-today' : '') + (b.skipped ? ' is-skipped' : '') + '"'
        + ' data-act="block-menu" data-id="' + esc(b.id) + '"'
        + ' style="grid-column:' + (b.day + 1) + ';grid-row:' + (b.minP + 1) + ' / span ' + b.spanRows
        + ';background:' + esc(b.color) + '">'
        + '<span class="bname">' + esc(b.name) + '</span>'
        // 只有跨 3 行以上的色块才放得下地点；短色块优先保证课名清楚
        + (b.location && b.spanRows >= 3 ? '<span class="bsub">' + esc(b.location) + '</span>' : '')
        + '</div>');
    });

    const isCurrent = weekNo === currentWeekNo;

    let html = '';
    html += '<div class="weekbar">'
      + '<button class="week-nav" data-act="prev-week"' + (weekNo <= 1 ? ' disabled' : '') + '>‹</button>'
      + '<select class="week-pick" data-act="week-pick">'
      + Array.from({ length: termWeeks }, (_, i) =>
        '<option value="' + (i + 1) + '"' + (i + 1 === weekNo ? ' selected' : '') + '>第 ' + (i + 1) + ' 周'
        + (i + 1 === currentWeekNo ? '（本周）' : '') + '</option>').join('')
      + '</select>'
      + '<button class="week-nav" data-act="next-week"' + (weekNo >= termWeeks ? ' disabled' : '') + '>›</button>'
      + (isCurrent ? '' : '<button class="week-nav" data-act="back-week" title="回到本周">◎</button>')
      + '</div>';

    html += '<button class="btn btn-primary tt-add" data-act="add-course">'
      + '<span class="btn-plus">＋</span>添加课程</button>';

    // data-scroll-axis 是 js/ios.js 的手势钩子：课表区域内禁止双指缩放和横向拖拽，
    // 只把单指纵向手势放行。CSS 的 touch-action: pan-y 已覆盖大部分机型，
    // 这个属性是给老 iOS Safari 兜底的，别删。
    html += '<div class="card tt-card"><div class="tt-scroll" data-scroll-axis="vertical"><div class="tt-grid">'
      + parts.join('') + '</div></div></div>';

    html += '<div class="section-title">本周 ' + blocks.length + ' 门课'
      + (isCurrent ? '' : ' · 正在查看第 ' + weekNo + ' 周') + '，点空白格也能快速新建</div>';

    if (blocks.length) {
      // ★ 每项结尾的 '</span>' 不能少：漏掉的话浏览器会把后一项当成前一项的孩子，
      // 10 门课就嵌套成 10 层，整块图例被挤成「一列一个字」，还会把页面撑得比
      // 屏幕还宽 —— 手机上就变成能左右滑、底部标签栏被推到屏幕外。
      html += '<div class="card"><div class="legend">'
        + blocks.map(b => '<span class="legend-item"><i class="legend-dot" style="background:' + esc(b.color) + '"></i>'
          + esc(b.name + ' ' + b.periodText) + '</span>').join('')
        + '</div></div>';
    }

    return html;
  }

  /* =========================================================
     日程
     ========================================================= */

  /* =========================================================
     日程 · 月历
     ========================================================= */

  /**
   * 把某个月展开成「周一开头」的日历格。
   *
   * 每个格子记录当天发生的日程（按开始时间排序）与是否完成。
   * 用 scheduleUtil.expand 逐条展开，比「每天扫全部日程」省——
   * 一个月最多 31 天，日程再多也只是几十次 occursOn 判断，很轻。
   */
  function scheduleMonthGrid(y, m) {
    const first = new Date(y, m - 1, 1);
    const daysInMonth = new Date(y, m, 0).getDate();
    const lead = (first.getDay() + 6) % 7;   // 1 号前空几格（周一开头）
    const todayStr = dateUtil.today();

    const from = dateUtil.fmt(new Date(y, m - 1, 1 - lead));
    const to = dateUtil.fmt(new Date(y, m - 1, daysInMonth));

    // 先算出 [from, to] 里每个日期有哪些日程
    const byDate = {};
    store.getSchedules().forEach(s => {
      scheduleUtil.expand(s, from, to).forEach(d => {
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push(scheduleUtil.toDisplay(s, d));
      });
    });
    // 每天内部按开始时间排序
    Object.keys(byDate).forEach(d => {
      byDate[d].sort((a, b) => a.startMinutes - b.startMinutes);
    });

    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const ds = dateUtil.fmt(new Date(y, m - 1, d));
      cells.push({
        date: ds,
        day: d,
        isToday: ds === todayStr,
        isPast: ds < todayStr,
        items: byDate[ds] || []
      });
    }
    return cells;
  }

  /** 月历视图：顶部月历网格 + 下方选中那天的清单 */
  function scheduleCalendarHtml() {
    const now = new Date();
    const y = state.schMonth ? state.schMonth.y : now.getFullYear();
    const m = state.schMonth ? state.schMonth.m : (now.getMonth() + 1);
    const cells = scheduleMonthGrid(y, m);
    const todayStr = dateUtil.today();

    // 默认选今天；如果切了月，默认选该月 1 号
    let sel = state.schSelDate;
    if (!sel) sel = (y === now.getFullYear() && m === now.getMonth() + 1) ? todayStr : dateUtil.fmt(new Date(y, m - 1, 1));

    let html = '';

    // 视图切换 + 月份导航
    html += '<div class="row-between" style="margin-bottom:10px">'
      + '<div class="tabs" style="margin:0">'
      + '<button class="tab-item' + (state.schView === 'calendar' ? ' on' : '') + '" data-act="sch-view" data-key="calendar">月历</button>'
      + '<button class="tab-item' + (state.schView === 'list' ? ' on' : '') + '" data-act="sch-view" data-key="list">列表</button>'
      + '</div>'
      + '<button class="btn btn-mini btn-primary" data-act="add-schedule">＋ 日程</button>'
      + '</div>';

    html += '<div class="card schcal-card">'
      + '<div class="cal-head">'
      + '<button class="cal-nav" data-act="sch-cal-prev" aria-label="上个月">‹</button>'
      + '<span class="cal-title">' + y + ' 年 ' + m + ' 月</span>'
      + '<button class="cal-nav" data-act="sch-cal-next" aria-label="下个月">›</button>'
      + '</div>'
      + '<div class="cal-grid schcal-grid">'
      + ['一', '二', '三', '四', '五', '六', '日'].map(d => '<span class="cal-wd">' + d + '</span>').join('');

    cells.forEach(c => {
      if (!c) {
        html += '<span class="cal-cell is-blank"></span>';
        return;
      }
      const selCls = c.date === sel ? ' is-selected' : '';
      const todayCls = c.isToday ? ' is-today' : '';
      // has-ev 只加在「当天真的有日程」的格子上，否则圆点行是空的、还会误暗示可点出内容
      const evCls = c.items.length ? ' has-ev' : '';
      html += '<button class="cal-cell' + evCls + selCls + todayCls + '" data-act="sch-cal-cell" data-date="' + esc(c.date) + '">'
        + '<span class="schcal-day">' + c.day + '</span>'
        + '<span class="schcal-dots">'
        + c.items.slice(0, 3).map(it =>
          '<i class="schcal-dot" style="background:' + esc(it.color) + '"></i>').join('')
        + (c.items.length > 3 ? '<i class="schcal-dot more"></i>' : '')
        + '</span>'
        + '</button>';
    });
    html += '</div></div>';

    // 选中那天的清单
    const dayCell = cells.filter(Boolean).filter(c => c.date === sel)[0];
    const list = dayCell ? dayCell.items : [];

    html += '<div class="section-title" style="margin-top:16px">'
      + esc(dateUtil.relative(sel))
      + '<span class="section-sub">' + list.length + ' 项'
      // 选中日期的「添加」入口放在标题右侧，不占额外一行。
      // 之前只有空白天才出现加按钮，结果「已有日程的一天想再加一条」得退回顶部大按钮，
      // 日期还是默认今天——等于绕了一圈。
      + ' <button class="schcal-add" data-act="add-schedule" data-date="' + esc(sel) + '">＋添加</button>'
      + '</span>'
      + '</div>';

    if (!list.length) {
      html += '<div class="empty">这一天没有日程</div>';
      html += '<button class="btn btn-ghost" data-act="add-schedule" data-date="' + esc(sel) + '">'
        + '＋ 在这一天添加日程</button>';
    } else {
      html += '<div class="card"><div class="cd-list">';
      list.forEach(it => {
        html += '<div class="cd-row' + (it.done ? ' is-past' : '') + '"'
          + ' data-act="schedule-menu" data-id="' + esc(it.id) + '" data-date="' + esc(it.date) + '">'
          + '<span class="cd-bar" style="background:' + esc(it.color) + '"></span>'
          + '<div class="cd-row-main">'
          + '<div class="cd-row-title">' + esc(it.title) + '</div>'
          + '<div class="cd-row-date">' + esc(it.timeText
            + (it.location ? ' · ' + it.location : '')
            + (it.repeatText ? ' · ' + it.repeatText : '')) + '</div>'
          + '</div>'
          + '<div class="cd-row-num"><span class="tag ' + (it.done ? 'tag-teal' : 'tag-blue') + '">'
          + esc(it.done ? '已完成' : it.startTime) + '</span></div>'
          + '</div>';
      });
      html += '</div></div>';
    }

    return html;
  }

  function shiftScheduleMonth(delta) {
    const now = new Date();
    const cur = state.schMonth || { y: now.getFullYear(), m: now.getMonth() + 1 };
    let m = cur.m + delta;
    let y = cur.y;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    state.schMonth = { y: y, m: m };
    // 切月后清掉选中日期，让 render 重新挑一个合理的默认
    state.schSelDate = null;
    render();
  }

  function renderSchedule() {
    if (state.schView === 'calendar') return scheduleCalendarHtml();
    return scheduleListHtml();
  }

  function scheduleListHtml() {
    const todayStr = dateUtil.today();
    const from = dateUtil.addDays(todayStr, -BACK_DAYS);
    const to = dateUtil.addDays(todayStr, FORWARD_DAYS);
    let list = scheduleUtil.windowList(from, to, true);

    if (state.schTab === 'todo') list = list.filter(it => !it.done);
    else if (state.schTab === 'done') list = list.filter(it => it.done);

    if (state.schCategory !== '全部') {
      list = list.filter(it => it.category === state.schCategory);
    }

    let html = '<div class="row-between" style="margin-bottom:10px">'
      + '<div class="tabs" style="margin:0">'
      + '<button class="tab-item' + (state.schView === 'calendar' ? ' on' : '') + '" data-act="sch-view" data-key="calendar">月历</button>'
      + '<button class="tab-item' + (state.schView === 'list' ? ' on' : '') + '" data-act="sch-view" data-key="list">列表</button>'
      + '</div>'
      + '<button class="btn btn-mini btn-primary" data-act="add-schedule">＋ 日程</button>'
      + '</div>';

    if (state.schTab === 'todo') {
      const overdue = list.filter(it => it.date < todayStr);
      const rest = list.filter(it => it.date >= todayStr);
      list = overdue.concat(rest);
    } else if (state.schTab === 'done') {
      list = list.slice().reverse();
    }

    const groups = [];
    const indexMap = {};
    list.forEach(it => {
      if (indexMap[it.date] === undefined) {
        indexMap[it.date] = groups.length;
        const friendly = dateUtil.friendly(it.date).split(' ');
        groups.push({
          date: it.date,
          dateText: dateUtil.relative(it.date),
          weekText: friendly[1] || '',
          overdue: it.date < todayStr && !it.done,
          items: []
        });
      }
      groups[indexMap[it.date]].items.push(it);
    });

    html += '<div class="tabs">'
      + [['todo', '待完成'], ['done', '已完成'], ['all', '全部']].map(t =>
        '<button class="tab-item' + (state.schTab === t[0] ? ' on' : '') + '" data-act="sch-tab" data-key="' + t[0] + '">' + t[1] + '</button>'
      ).join('')
      + '</div>';

    html += '<div class="chips" style="margin-bottom:6px">'
      + ['全部'].concat(CATEGORIES).map(c =>
        '<button class="chip' + (state.schCategory === c ? ' on' : '') + '" data-act="sch-cat" data-name="' + esc(c) + '">' + esc(c) + '</button>'
      ).join('')
      + '</div>';

    if (!groups.length) {
      html += '<div class="empty">这里还没有日程</div>';
      html += '<button class="btn btn-primary" data-act="add-schedule">'
        + '<span class="btn-plus">＋</span>添加日程</button>';
      return html;
    }

    groups.forEach(g => {
      html += '<div class="group-head">'
        + '<span class="group-date">' + esc(g.dateText) + '</span>'
        + '<span class="group-week">' + esc(g.weekText) + '</span>'
        + (g.overdue ? '<span class="group-over">已过期未完成</span>' : '')
        + '</div>';
      g.items.forEach(it => {
        html += '<div class="item' + (it.done ? ' is-done' : '') + '" data-act="schedule-menu" data-id="' + esc(it.id) + '" data-date="' + esc(it.date) + '">'
          + '<span class="bar" style="background:' + esc(it.color) + '"></span>'
          + '<div class="grow">'
          + '<div class="row-between"><span class="item-name">' + esc(it.title) + '</span>'
          + '<span class="tag ' + (it.done ? 'tag-teal' : 'tag-blue') + '">' + esc(it.done ? '已完成' : it.category) + '</span></div>'
          + '<div class="item-meta">' + esc(it.timeText + (it.location ? ' · ' + it.location : '') + (it.repeatText ? ' · ' + it.repeatText : '')) + '</div>'
          + (it.note ? '<div class="item-note">' + esc(it.note) + '</div>' : '')
          + '</div></div>';
      });
    });

    html += '<div class="section-title" style="margin-top:14px">共 ' + list.length + ' 项</div>';
    html += '<button class="btn btn-primary" data-act="add-schedule">'
      + '<span class="btn-plus">＋</span>添加日程</button>';

    return html;
  }

  /* =========================================================
     设置
     ========================================================= */

  /**
   * 安卓应用的「后台提醒」卡片。
   *
   * 这是整个应用里唯一一处"关掉应用也能提醒"是真的成立的地方——因为它由系统闹钟
   * （AlarmManager）负责，不依赖应用是否在运行。所以文案要说得确定，不要再带
   * "应用关闭后无法自行唤醒"那种免责声明，那会让用户以为这个功能不可靠。
   *
   * 三件事要如实告诉用户：
   *   1. 已经排上了多少条提醒（有数字才有"它在工作"的实感）
   *   2. 是准点模式还是可能被系统推迟几分钟（Android 12+ 的「闹钟和提醒」权限）
   *   3. 怎么验证（排一条 1 分钟后的提醒，然后真的把应用退到后台）
   *
   * @param {object|null} bg reminder.nativeStatus() 的结果
   * @param {string} perm 通知权限状态
   */
  function buildAndroidBackgroundCard(bg, perm) {
    const count = bg && typeof bg.count === 'number' ? bg.count : 0;
    const exact = !!(bg && bg.exact);
    const notifyOk = perm === 'granted';

    // 一句话状态：能不能真的收到
    let statusTag;
    let statusCls;
    if (!notifyOk) {
      statusTag = '通知未开启';
      statusCls = 'tag-amber';
    } else if (count === 0) {
      statusTag = '暂无可提醒的课';
      statusCls = 'tag-gray';
    } else {
      statusTag = '已安排 ' + count + ' 条';
      statusCls = 'tag-teal';
    }

    let html = '<div class="card">'
      + '<div class="card-title">关掉应用也能提醒'
      + '<span class="tag ' + statusCls + '">' + esc(statusTag) + '</span>'
      + '</div>';

    if (!notifyOk) {
      html += '<div class="hint" style="margin-top:0">'
        + '后台提醒已经排好了，但<b>系统通知权限还没开</b>，到点也弹不出来。先把它打开。'
        + '</div>'
        + '<div class="btn btn-primary mt12" data-act="ask-notify">开启系统通知</div>';
    } else if (count === 0) {
      html += '<div class="hint" style="margin-top:0">'
        + '现在还没有需要提醒的课程或日程。加好课表之后，这里会自动显示已安排的提醒条数。'
        + '</div>';
    } else {
      html += '<div class="hint" style="margin-top:0">'
        + '未来一周的提醒已经交给手机系统了，<b>不需要保持应用在后台</b>——'
        + '应用被划掉、手机重启，到点一样会弹通知。'
        + '</div>';
    }

    // 精确度：只有 Android 12 及以上才会出现"可能被推迟"，低版本直接是准点的
    if (notifyOk) {
      if (exact) {
        html += '<div class="field"><span class="field-label">提醒精度</span>'
          + '<div class="field-body" style="display:flex;justify-content:flex-end">'
          + '<span class="tag tag-teal">准点</span></div></div>';
      } else {
        html += '<div class="field"><span class="field-label">提醒精度</span>'
          + '<div class="field-body" style="display:flex;justify-content:flex-end">'
          + '<span class="tag tag-amber">可能延迟几分钟</span></div></div>'
          + '<div class="hint" style="margin-top:8px">'
          + '系统没给本应用「闹钟和提醒」权限，所以提醒时间可能被推迟几分钟。'
          + '想要准点，点下面的按钮去开启——<b>不开启也能用</b>，只是不够准。'
          + '</div>'
          + '<div class="btn btn-ghost mt8" data-act="request-exact-alarm">开启「闹钟和提醒」</div>';
      }
    }

    // 验证入口：这条最容易让人放心，所以放显眼位置
    if (notifyOk) {
      html += '<div class="btn btn-ghost mt8" data-act="test-background">1 分钟后发一条测试提醒</div>'
        + '<div class="hint">'
        + '<b>怎么验证：</b>点上面的按钮 → 看到提示后<b>按返回键退出应用</b>（划掉也行）'
        + ' → 等一分钟，通知应该照常弹出。这就是"关掉应用也能提醒"的含义。'
        + '</div>';
    }

    html += '<div class="hint">'
      + '<b>和「导出到系统日历」有什么区别：</b>两个都能在关掉应用后提醒，选一个就够。'
      + '这里由应用自己负责，改了课表不用重新导出；导出到日历则完全不依赖本应用，'
      + '你卸载了它也还在提醒。'
      + '</div>';

    // 兜底：后台提醒没排上时（例如网页还没同步过），也让用户能导出日历
    html += '<div class="btn btn-ghost mt8" data-act="export-ics">导出到系统日历（.ics）</div>';

    html += '</div>';
    return html;
  }

  function renderSettings() {
    const settings = store.getSettings();
    const perm = reminder.permission();

    // 是否跑在安卓壳里（由 js/android.js 与安卓侧 Bridge 约定）
    const isAndroidApp = !!(window.Android && typeof window.Android.platform === 'function');

    // 安卓原生后台提醒的实际状态（非安卓环境为 null）
    const bg = isAndroidApp ? reminder.nativeStatus() : null;

    // 是否跑在 iOS 上（由 js/ios.js 标记）。iOS 版本单独走一套文案：
    // 它既不是安卓壳（没有原生通知），也不是普通网页（能装到主屏幕当 App 用）。
    const isIOS = typeof window.__crIsIOS === 'function' && window.__crIsIOS();
    const isIOSStandalone = typeof window.__crIsStandalone === 'function' && window.__crIsStandalone();

    // iOS 上「当前环境不支持」这个说法太技术，用户看了不知道该怎么办。
    // 直接说清楚：这条路上的开关在 iPhone 上不存在，请走导出日历。
    const permText = isIOS
      ? '改用系统日历提醒'
      : ({
        granted: '已开启',
        denied: '已被拒绝',
        default: '未开启',
        unsupported: '当前环境不支持'
      }[perm] || perm);

    const periodList = periods.all();
    const last = periodList[periodList.length - 1] || null;
    const linked = periods.isLinked();

    let html = '';

    /* --- 后台提醒 ---
       三种环境各说各话，别用同一段文案糊过去：
         安卓应用  后台提醒是真的，由系统闹钟负责，可以明说「关掉也能提醒」
         iPhone    系统不允许网页后台发通知，只能导出到日历
         浏览器    同理（标签页关了就没了） */
    if (isAndroidApp) {
      html += buildAndroidBackgroundCard(bg, perm);
    } else {
      html += '<div class="card">'
        + '<div class="card-title">关掉应用也能提醒'
        + '<span class="tag ' + ((!isIOS && perm === 'granted') ? 'tag-teal' : 'tag-amber') + '">' + esc(permText) + '</span>'
        + '</div>'
        + '<div class="hint" style="margin-top:0">'
        + '应用在关闭后无法自行唤醒，这是系统的限制。把课程和日程<b>导出到手机系统日历</b>，'
        + '之后由手机负责提醒——锁屏也叫、静音也震、不需要联网、不需要任何授权。'
        + '</div>'
        + '<div class="btn btn-primary mt12" data-act="export-ics">导出到系统日历（.ics）</div>'
        + (isIOS ? '' : (perm === 'granted' ? '' : '<div class="btn btn-ghost mt8" data-act="ask-notify">开启'
          + '浏览器通知（应用打开时生效）</div>'))
        + '<div class="hint">'
        + (isIOS
          ? '<b>怎么用：</b>点上面的按钮 → 会弹出 iPhone 的分享面板 → 选「日历」即可直接导入'
            + '（若列表里没有「日历」，就选「存储到文件」，再到「文件」App 里点开它）。'
          : '<b>怎么用：</b>点上面的按钮下载 .ics 文件 → 在手机上点开它 → 系统会问是否导入，点「全部添加」。'
            + 'iPhone 上如果没有反应，用「分享 → 存储到文件」，再到「文件」App 里点它。')
        + (isIOS
          ? '<br><b>为什么 iOS 上没有「系统通知」开关：</b>iOS 不允许网页在应用关闭后发通知，'
            + '这是系统的硬限制而非没有实现。导出到日历后由「日历」App 提醒，反而更准时。'
          : '')
        + '<br><b>什么时候重新导出：</b>课表有改动、或者新学期开始时再导一次即可，重复导入不会产生重复项。'
        + '</div>'
        + '</div>';
    }

    /* --- 提醒 --- */
    html += '<div class="card">'
      + '<div class="card-title">提醒</div>'
      + '<div class="field"><span class="field-label">默认提前量</span>'
      + '<div class="field-body"><select data-act="remind-select">'
      + REMIND_LABELS.map((l, i) => '<option value="' + REMIND_VALUES[i] + '"'
        + (Number(settings.remindBefore) === REMIND_VALUES[i] ? ' selected' : '') + '>' + l + '</option>').join('')
      + '</select></div></div>'
      + '<div class="field"><span class="field-label">提醒震动</span>'
      + '<div class="field-body" style="display:flex;justify-content:flex-end">'
      + '<input type="checkbox" class="switch" data-act="toggle-vibrate"' + (settings.vibrate ? ' checked' : '') + '></div></div>'
      + '<div class="field"><span class="field-label">增强动效</span>'
      + '<div class="field-body" style="display:flex;justify-content:flex-end">'
      + '<input type="checkbox" class="switch" data-act="toggle-motion"' + (settings.enhancedMotion ? ' checked' : '') + '></div></div>'
      + '<div class="field"><span class="field-label">立即测试</span>'
      + '<div class="field-body" style="display:flex;justify-content:flex-end">'
      + '<button class="btn btn-ghost btn-mini" data-act="test-reminder">弹出测试提醒</button></div></div>'
      + '<div class="field"><span class="field-label">课表自检</span>'
      + '<div class="field-body" style="display:flex;justify-content:flex-end">'
      + '<button class="btn btn-ghost btn-mini" data-act="check-conflicts">检查时间冲突</button></div></div>'
      + '<div class="hint">新添加的课程与日程默认使用这里的提前量，单条也可以单独调整。</div>'
      + '</div>';

    /* --- 学期 --- */
    html += '<div class="card">'
      + '<div class="card-title">学期</div>'
      + '<div class="field"><span class="field-label">开学第一周</span>'
      + '<div class="field-body"><input type="date" data-act="term-start" value="' + esc(settings.termStart) + '"></div></div>'
      + '<div class="field"><span class="field-label">学期周数</span>'
      + '<div class="field-body"><input type="number" min="1" max="30" data-act="term-weeks" value="' + esc(settings.termWeeks) + '"></div></div>'
      + '<div class="hint">这周是<b>第 ' + dateUtil.weekNo(settings.termStart, dateUtil.today()) + ' 周</b>。'
      + '填「开学第一周的周一」的日期，单双周与周次范围都会按它计算；填错会导致课表显示错周。</div>'
      + '</div>';

    /* --- 作息时间 --- */
    html += '<div class="card">'
      + '<div class="card-title">作息时间'
      + '<span class="tag ' + (periods.isCustom() ? 'tag-amber' : 'tag-gray') + '">'
      + (periods.isCustom() ? '已自定义' : '默认') + '</span>'
      + '</div>'
      + '<div class="plist">'
      + periodList.map((p, i) => {
        const openEnd = !!p.openEnd;
        return '<div class="prow">'
          + '<span class="prow-idx">第' + p.index + '节</span>'
          + '<input type="time" data-pfield="start" data-index="' + p.index + '" value="' + esc(p.start) + '">'
          + '<span class="prow-arrow">' + (openEnd ? '之后' : '→') + '</span>'
          + '<input type="time" data-pfield="end" data-index="' + p.index + '" value="' + esc(p.end) + '"'
          + (openEnd ? ' disabled' : '') + '>'
          + '<span class="prow-flag">' + (openEnd ? '<i class="dotmark"></i>' : '') + '</span>'
          + '</div>';
      }).join('')
      + '</div>'
      + '<div class="field" style="border-top:1px solid var(--line);margin-top:6px">'
      + '<span class="field-label" style="width:auto;flex:1">相邻节次联动<span class="muted" style="display:block;font-size:12px">'
      + (linked ? '改一个边界，相连的邻居一起走' : '每节各自独立，可以留课间空档') + '</span></span>'
      + '<input type="checkbox" class="switch" data-act="toggle-link"' + (linked ? ' checked' : '') + '>'
      + '</div>'
      + '<div class="field"><span class="field-label" style="width:auto;flex:1">最后一节无固定下课时间'
      + '<span class="muted" style="display:block;font-size:12px">对应第 12 节这种「20:20 之后」</span></span>'
      + '<input type="checkbox" class="switch" data-act="toggle-openend" data-index="' + (last ? last.index : 0) + '"'
      + (last && last.openEnd ? ' checked' : '') + '>'
      + '</div>'
      + (periods.isCustom() ? '<button class="btn btn-ghost mt12" data-act="reset-periods">恢复默认作息</button>' : '')
      + '<div class="hint">点时间直接改，改完立刻应用到课表、今日页与提醒——课程只记「第几节」，作息一变时间全部跟着变，不用重新录课。</div>'
      + '</div>';

    /* --- 数据 --- */
    html += '<div class="card">'
      + '<div class="card-title">数据</div>'
      + '<div class="row-between" style="margin-bottom:12px">'
      + '<span class="muted">课程 ' + store.getCourses().length + ' 条</span>'
      + '<span class="muted">日程 ' + store.getSchedules().length + ' 条</span>'
      + '</div>'
      + '<div class="row-between" style="margin-bottom:12px">'
      + '<span class="muted">倒数日 ' + store.getCountdowns().length + ' 条</span>'
      + '<span class="muted">打卡项 ' + store.getHabits().length + ' 个</span>'
      + '</div>'
      + '<div class="btn btn-ghost" data-act="export-json">导出备份（JSON 文件）</div>'
      + '<div class="btn btn-ghost mt8" data-act="import-json">导入备份</div>'
      + (store.getCountdowns().length || store.getHabits().length
        ? ''
        : '<div class="btn btn-ghost mt8" data-act="seed-plan">载入倒数日与打卡示例</div>')
      + '<div class="btn btn-danger mt8" data-act="clear-data">清空所有数据</div>'
      + '<div class="hint">所有数据都保存在这台设备上，不会上传到任何服务器。换手机前记得导出备份。</div>'
      // 只在安卓壳里出现：万一页面卡在旧版本上，不用重装也能刷到最新版
      + (isAndroidApp
        ? '<div class="btn btn-ghost mt8" data-act="reload-fresh">重新加载（清缓存）</div>'
          + '<div class="hint">更新之后发现界面还是旧的，点这个不用卸载重装就能刷到最新版。</div>'
        : '')
      + '</div>';

    /* --- 诊断信息：看本机到底有没有把数据留住 --- */
    let bornText = '';
    const born = store.bornAt();
    if (born) {
      const d = new Date(born);
      bornText = '数据初始化于 ' + dateUtil.pad(d.getMonth() + 1) + '-' + dateUtil.pad(d.getDate())
        + ' ' + dateUtil.pad(d.getHours()) + ':' + dateUtil.pad(d.getMinutes()) + '<br>'
        + '（这个时间每次打开都一样，才说明数据真的存住了）';
    }

    const edition = isAndroidApp ? '安卓版' : (isIOS ? (isIOSStandalone ? 'iOS 版（已安装）' : 'iOS 版') : '网页版');

    html += '<div class="card"><div class="hint" style="margin-top:0;text-align:center">'
      + '课程与日程提醒 · ' + edition + ' ' + APP_VERSION + '<br>'
      + bornText
      + '</div></div>';

    return html;
  }

  /* =========================================================
     编辑面板
     ========================================================= */

  function openEdit(opts) {
    const type = opts.type === 'schedule' ? 'schedule'
      : (opts.type === 'countdown' ? 'countdown'
        : (opts.type === 'habit' ? 'habit'
          : (opts.type === 'homework' ? 'homework' : 'course')));
    const settings = store.getSettings();
    const todayStr = dateUtil.today();

    if (type === 'homework') {
      const exist = opts.id ? store.getHomework(opts.id) : null;
      // 从课程详情「加作业」进来时，opts.courseId 指定归属课程
      const presetCourse = opts.courseId ? store.getCourse(opts.courseId) : null;
      const form = {
        id: '',
        title: '',
        courseId: presetCourse ? presetCourse.id : '',
        due: dateUtil.addDays(todayStr, 7),
        dueTime: '23:59',
        color: (presetCourse && presetCourse.color) || store.COLORS[3],
        remindBefore: [3, 1, 0],
        done: false,
        doneAt: '',
        note: ''
      };
      if (exist) {
        form.id = exist.id;
        form.title = exist.title || '';
        form.courseId = exist.courseId || '';
        form.due = exist.due || todayStr;
        form.dueTime = exist.dueTime || '';
        form.color = exist.color || store.COLORS[3];
        form.remindBefore = (exist.remindBefore || []).slice();
        form.done = !!exist.done;
        form.doneAt = exist.doneAt || '';
        form.note = exist.note || '';
      }
      state.edit = { type: 'homework', form: form, isEdit: !!opts.id };
      renderPanel();
      $('panel').classList.add('on');
      $('panel').scrollTop = 0;
      return;
    }

    if (type === 'countdown') {
      const exist = opts.id ? store.getCountdown(opts.id) : null;
      const form = {
        id: '',
        title: '',
        date: dateUtil.addDays(todayStr, 30),
        dateMode: 'day',
        color: store.COLORS[0],
        pinned: false,
        remindBefore: [],
        note: ''
      };
      if (exist) {
        form.id = exist.id;
        form.title = exist.title || '';
        form.date = exist.date || todayStr;
        form.dateMode = exist.dateMode === 'sec' ? 'sec' : 'day';
        form.color = exist.color || store.COLORS[0];
        form.pinned = !!exist.pinned;
        form.remindBefore = (exist.remindBefore || []).slice();
        form.note = exist.note || '';
      }
      state.edit = { type: 'countdown', form: form, isEdit: !!opts.id };
      renderPanel();
      $('panel').classList.add('on');
      $('panel').scrollTop = 0;
      return;
    }

    if (type === 'habit') {
      const exist = opts.id ? store.getHabit(opts.id) : null;
      const form = {
        id: '',
        name: '',
        icon: plan.ICONS[0],
        color: store.COLORS[1],
        remindAt: '',
        note: '',
        archived: false
      };
      if (exist) {
        form.id = exist.id;
        form.name = exist.name || '';
        form.icon = exist.icon || plan.ICONS[0];
        form.color = exist.color || store.COLORS[1];
        form.remindAt = exist.remindAt || '';
        form.note = exist.note || '';
        form.archived = !!exist.archived;
      }
      state.edit = { type: 'habit', form: form, isEdit: !!opts.id };
      renderPanel();
      $('panel').classList.add('on');
      $('panel').scrollTop = 0;
      return;
    }

    if (type === 'course') {
      const exist = opts.id ? store.getCourse(opts.id) : (opts.copy ? store.getCourse(opts.copy) : null);
      const form = {
        id: opts.copy ? '' : (opts.id || ''),
        name: '',
        teacher: '',
        location: '',
        day: Number(opts.day) || dateUtil.weekday(todayStr),
        periods: opts.period ? [Number(opts.period)] : [],
        weekType: 'all',
        weekFrom: 1,
        weekTo: Math.max(1, (settings.termWeeks || 20) - 2),
        // 自定义周的周号名单；只有 weekType==='custom' 时用得上
        weekList: [],
        color: store.COLORS[0],
        remindBefore: Number(settings.remindBefore),
        note: ''
      };
      if (exist) {
        form.name = exist.name || '';
        form.teacher = exist.teacher || '';
        form.location = exist.location || '';
        form.day = Number(opts.day) || Number(exist.day) || 1;
        form.periods = (exist.periods || []).slice();
        form.weekType = (exist.weeks && exist.weeks.type) || 'all';
        form.weekFrom = (exist.weeks && exist.weeks.from) || 1;
        form.weekTo = (exist.weeks && exist.weeks.to) || Math.max(1, (settings.termWeeks || 20) - 2);
        form.weekList = (exist.weeks && Array.isArray(exist.weeks.list)) ? exist.weeks.list.slice() : [];
        form.color = exist.color || store.COLORS[0];
        form.remindBefore = exist.remindBefore === undefined ? Number(settings.remindBefore) : Number(exist.remindBefore);
        form.note = exist.note || '';
        form.weeks = exist.weeks;
      }
      state.edit = { type: 'course', form: form, isEdit: !!opts.id };
    } else {
      const exist = opts.id ? store.getSchedule(opts.id) : null;
      const startDefault = dateUtil.nowHM();
      const form = {
        id: '',
        title: '',
        // 月历里「在这一天添加」会带 opts.date，用它作为默认日期
        date: exist ? (exist.date || todayStr) : (opts.date || todayStr),
        startTime: startDefault,
        // 新建时给个 1 小时后的结束时间，免得输入框空着像没填完
        endTime: dateUtil.fromMin(dateUtil.toMin(startDefault) + 60),
        location: '',
        category: '作业',
        color: store.COLORS[3],
        remindBefore: Number(settings.remindBefore),
        note: '',
        done: false,
        repeatType: 'none',
        until: '',
        doneDates: []
      };
      if (exist) {
        form.id = exist.id;
        form.title = exist.title || '';
        form.date = exist.date || todayStr;
        form.startTime = exist.startTime || dateUtil.nowHM();
        form.endTime = exist.endTime || '';
        form.location = exist.location || '';
        form.category = exist.category || '其他';
        form.color = exist.color || store.COLORS[3];
        form.remindBefore = (exist.remindBefore === undefined || exist.remindBefore === null)
          ? Number(settings.remindBefore) : Number(exist.remindBefore);
        form.note = exist.note || '';
        form.done = !!exist.done;
        form.repeatType = (exist.repeat && exist.repeat.type) || 'none';
        form.until = (exist.repeat && exist.repeat.until) || '';
        form.doneDates = (exist.doneDates || []).slice();
      }
      state.edit = { type: 'schedule', form: form, isEdit: !!opts.id };
    }

    renderPanel();
    $('panel').classList.add('on');
    $('panel').scrollTop = 0;
  }

  function closeEdit() {
    state.edit = null;
    $('panel').classList.remove('on');
    $('panel').innerHTML = '';
  }

  function field(label, key, opts) {
    const o = opts || {};
    const v = state.edit.form[key];
    const t = o.type || 'text';
    let control;
    if (t === 'textarea') {
      control = '<textarea rows="' + (o.rows || 3) + '" data-efield="' + key + '" placeholder="'
        + esc(o.placeholder || '') + '">' + esc(v) + '</textarea>';
    } else {
      control = '<input type="' + t + '" data-efield="' + key + '" value="' + esc(v) + '"'
        + (o.min != null ? ' min="' + o.min + '"' : '')
        + (o.max != null ? ' max="' + o.max + '"' : '')
        + ' placeholder="' + esc(o.placeholder || '') + '">';
    }
    return '<div class="field' + (t === 'textarea' ? ' field-top' : '') + '">'
      + '<span class="field-label">' + esc(label) + '</span>'
      + '<div class="field-body">' + control + '</div></div>';
  }

  function chipGroup(act, items, isOn, extra) {
    return '<div class="chips">' + items.map(it =>
      '<button class="chip' + (isOn(it) ? ' on' : '') + '" data-act="' + act + '" ' + (extra || '')
      + ' data-key="' + esc(it.key) + '">' + esc(it.text) + '</button>'
    ).join('') + '</div>';
  }

  function colorRow(key) {
    return '<div class="color-row">' + store.COLORS.map(c =>
      '<button class="color-item' + (state.edit.form[key] === c ? ' on' : '') + '"'
      + ' data-act="pick-color" data-key="' + esc(key) + '" data-color="' + esc(c) + '"'
      + ' style="background:' + esc(c) + '"></button>'
    ).join('') + '</div>';
  }

  function renderPanel() {
    if (!state.edit) return;
    const e = state.edit;
    const f = e.form;
    let html = '';

    html += '<div class="panel-head">'
      + '<button class="panel-link" data-act="close-panel">取消</button>'
      + '<span class="panel-title">' + (e.type === 'course'
        ? (e.isEdit ? '编辑课程' : '添加课程')
        : e.type === 'countdown'
          ? (e.isEdit ? '编辑倒数日' : '新建倒数日')
          : e.type === 'habit'
            ? (e.isEdit ? '编辑打卡项' : '新建打卡项')
            : e.type === 'homework'
              ? (e.isEdit ? '编辑作业' : '添加作业')
              : (e.isEdit ? '编辑日程' : '添加日程')) + '</span>'
      + '<button class="panel-link' + (e.isEdit ? '' : '') + '" data-act="save">保存</button>'
      + '</div>';

    html += '<div class="panel-body">';

    if (e.type === 'homework') {
      // 课程下拉：作业挂靠到课，按课程能筛、能看这门课还有什么没交
      const courses = store.getCourses();
      const options = '<option value="">不指定课程</option>'
        + courses.map(c => '<option value="' + esc(c.id) + '"'
          + (f.courseId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('');

      html += '<div class="card">'
        + field('作业标题', 'title', { placeholder: '必填，例如 第三章习题 / 实验报告' })
        + '<div class="field"><span class="field-label">所属课程</span>'
        + '<div class="field-body"><select data-efield="courseId">' + options + '</select></div></div>'
        + '<div class="hint">'
        + (courses.length
          ? '挂到课程上之后，可以按课程看这门课还有什么没交。'
          : '你还没有录入课程。先到「课表」加一门课，作业就能挂上去了。')
        + '</div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">截止时间</div>'
        + field('截止日期', 'due', { type: 'date' })
        + '<div class="field"><span class="field-label">截止时刻</span>'
        + '<div class="field-body row" style="gap:8px">'
        + '<input type="time" data-efield="dueTime" value="' + esc(f.dueTime) + '" style="flex:1">'
        + '<button class="btn btn-ghost btn-mini" data-act="clear-duetime">当天截止</button>'
        + '</div></div>'
        + '<div class="hint">留空表示「当天截止」，按 23:59 算。'
        + '填了时刻的话，提醒会落在截止前 N 天的同一时刻——'
        + '比如截止 23:59、选了「提前 1 天」，就是前一天 23:59 提醒你。</div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">提前提醒'
        + '<span class="tag tag-gray">可多选</span></div>'
        + '<div class="chips">'
        + plan.REMIND_DAYS.map((d, i) =>
          '<button class="chip' + (f.remindBefore.indexOf(d) >= 0 ? ' on' : '') + '"'
          + ' data-act="pick-remindday" data-key="' + d + '">' + plan.REMIND_DAY_LABELS[i] + '</button>'
        ).join('')
        + '</div>'
        + '<div class="hint">选中的日子会在对应时刻提醒你。<b>已标记为已交的作业不会再提醒。</b></div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">颜色与备注</div>'
        + colorRow('color')
        + '<div class="field" style="margin-top:12px"><span class="field-label">已交</span>'
        + '<div class="field-body" style="display:flex;justify-content:flex-end">'
        + '<input type="checkbox" class="switch" data-act="toggle-done-form"' + (f.done ? ' checked' : '') + '></div></div>'
        + field('备注', 'note', { type: 'textarea', placeholder: '选填，例如 要交纸质版' })
        + '</div>';

      if (e.isEdit) {
        html += '<button class="btn btn-danger" data-act="remove">删除作业</button>';
      }
    } else if (e.type === 'countdown') {
      html += '<div class="card">'
        + field('名称', 'title', { placeholder: '必填，例如 期末考试 / 放假回家' })
        + field('日期', 'date', { type: 'date' })
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">倒计时方式</div>'
        + chipGroup('pick-datemode', [
          { key: 'day', text: '按天' }, { key: 'sec', text: '按天 + 精确到秒' }
        ], it => f.dateMode === it.key)
        + '<div class="hint">按天只显示「还有 N 天」；精确到秒会多出一行每秒跳动的时分秒，适合盯着日子倒数。</div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">提前提醒'
        + '<span class="tag tag-gray">可多选</span></div>'
        + '<div class="chips">'
        + plan.REMIND_DAYS.map((d, i) =>
          '<button class="chip' + (f.remindBefore.indexOf(d) >= 0 ? ' on' : '') + '"'
          + ' data-act="pick-remindday" data-key="' + d + '">' + plan.REMIND_DAY_LABELS[i] + '</button>'
        ).join('')
        + '</div>'
        + '<div class="hint">选中的日子会在当天上午 9 点提醒你。'
        + '<br><b>提醒只在应用打开时有效</b>——想让它一定响，请用「设置 → 导出到系统日历」。'
        + '</div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">颜色与备注</div>'
        + colorRow('color')
        + '<div class="field" style="margin-top:12px"><span class="field-label">置顶显示</span>'
        + '<div class="field-body" style="display:flex;justify-content:flex-end">'
        + '<input type="checkbox" class="switch" data-act="toggle-pin-form"' + (f.pinned ? ' checked' : '') + '></div></div>'
        + field('备注', 'note', { type: 'textarea', placeholder: '选填' })
        + '</div>';

      if (e.isEdit) {
        html += '<button class="btn btn-danger" data-act="remove">删除倒数日</button>';
      }
    } else if (e.type === 'habit') {
      html += '<div class="card">'
        + field('想坚持什么', 'name', { placeholder: '必填，例如 早起 / 背单词 / 跑步' })
        + '<div class="field"><span class="field-label">图标</span>'
        + '<div class="field-body"></div></div>'
        + '<div class="icon-row">'
        + plan.ICONS.map(ic =>
          '<button class="icon-item' + (f.icon === ic ? ' on' : '') + '"'
          + ' data-act="pick-icon" data-key="' + esc(ic) + '">' + esc(ic) + '</button>'
        ).join('')
        + '</div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">每日提醒</div>'
        + '<div class="field"><span class="field-label">提醒时间</span>'
        + '<div class="field-body row" style="gap:8px">'
        + '<input type="time" data-efield="remindAt" value="' + esc(f.remindAt) + '" style="flex:1">'
        + '<button class="btn btn-ghost btn-mini" data-act="clear-remindat">不提醒</button>'
        + '</div></div>'
        + '<div class="hint">留空表示不提醒。到点会催你一次；<b>已经打过卡就不打扰</b>。'
        + '<br>同样，这条提醒只在应用打开时有效。</div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">颜色与备注</div>'
        + colorRow('color')
        + field('备注', 'note', { type: 'textarea', placeholder: '选填，例如 每天 30 个' })
        + '</div>';

      if (e.isEdit) {
        html += '<button class="btn btn-ghost" data-act="toggle-archive">'
          + (f.archived ? '恢复打卡项' : '暂时归档（不再显示）') + '</button>';
        html += '<button class="btn btn-danger mt8" data-act="remove">删除打卡项及记录</button>';
      }
    } else if (e.type === 'course') {
      html += '<div class="hint hint-manual">'
        + '课程表需要一门一门手动录入——没有现成的课表可以自动导入，辛苦您手动输入课程表了。'
        + '<br>好在<strong>课程只记「第几节」</strong>，作息时间在「设置 → 作息时间」里统一改，'
        + '之后调整上下课时间不用重新录课。'
        + '</div>';

      html += '<div class="card">'
        + field('课程名称', 'name', { placeholder: '必填，例如 高等数学' })
        + field('上课地点', 'location', { placeholder: '例如 教三楼 305' })
        + field('授课老师', 'teacher', { placeholder: '选填' })
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">上课时间</div>'
        + '<div class="section-title" style="margin:0 0 8px 0">星期</div>'
        + chipGroup('pick-day', periods.WEEK_NAMES.map((n, i) => ({ key: i + 1, text: n })), it => Number(f.day) === Number(it.key))
        + '<div class="section-title" style="margin:14px 0 8px 0">节次（可多选，连堂一次选完）</div>'
        + '<div class="period-grid" id="periodGrid">'
        + periods.all().map(p =>
          '<button class="pchip' + (f.periods.indexOf(p.index) >= 0 ? ' on' : '') + '"'
          + ' data-act="toggle-period" data-key="' + p.index + '">'
          + '<span class="pn">' + p.index + '</span>'
          + '<span>' + esc(p.start) + '</span></button>'
        ).join('')
        + '</div>'
        + '<div id="spanBox">' + spanBoxHtml() + '</div>'
        + '<button class="btn btn-ghost btn-mini mt12" data-act="clear-periods">清空节次</button>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">周次</div>'
        + chipGroup('pick-weektype', [
          { key: 'all', text: '每周' }, { key: 'odd', text: '单周' },
          { key: 'even', text: '双周' }, { key: 'custom', text: '自定义周' }
        ], it => f.weekType === it.key)
        + '<div id="weekBox">' + weekBoxHtml() + '</div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">颜色与提醒</div>'
        + colorRow('color')
        + '<div class="field" style="margin-top:12px"><span class="field-label">提前提醒</span>'
        + '<div class="field-body"><select data-efield="remindBefore">'
        + REMIND_LABELS.map((l, i) => '<option value="' + REMIND_VALUES[i] + '"'
          + (Number(f.remindBefore) === REMIND_VALUES[i] ? ' selected' : '') + '>' + l + '</option>').join('')
        + '</select></div></div>'
        + field('备注', 'note', { type: 'textarea', placeholder: '例如 带课本和作业本' })
        + '</div>';

      if (e.isEdit) {
        html += '<button class="btn btn-danger" data-act="remove">删除课程</button>';
      }
    } else {
      html += '<div class="card">'
        + field('标题', 'title', { placeholder: '必填，例如 交高数作业' })
        + field('日期', 'date', { type: 'date' })
        + '<div class="field"><span class="field-label">时间</span>'
        + '<div class="field-body row" style="gap:8px">'
        + '<input type="time" data-efield="startTime" value="' + esc(f.startTime) + '" style="flex:1">'
        + '<span class="muted">至</span>'
        + '<input type="time" data-efield="endTime" value="' + esc(f.endTime) + '" style="flex:1">'
        + '</div></div>'
        + field('地点', 'location', { placeholder: '选填' })
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">分类与颜色</div>'
        + chipGroup('pick-category', CATEGORIES.map(c => ({ key: c, text: c })), it => f.category === it.key)
        + '<div class="mt12">' + colorRow('color') + '</div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">重复</div>'
        + chipGroup('pick-repeat', REPEAT_KEYS.map((k, i) => ({ key: k, text: REPEAT_LABELS[i] })), it => f.repeatType === it.key)
        + '<div id="untilBox">' + untilBoxHtml() + '</div>'
        + '<div class="hint">重复日程在列表里会展开成每一次安排，<b>可以只把某一次标记完成</b>（这周作业交了，后面的照常提醒）。</div>'
        + '</div>';

      html += '<div class="card">'
        + '<div class="card-title">提醒</div>'
        + '<div class="field"><span class="field-label">提前提醒</span>'
        + '<div class="field-body"><select data-efield="remindBefore">'
        + REMIND_LABELS.map((l, i) => '<option value="' + REMIND_VALUES[i] + '"'
          + (Number(f.remindBefore) === REMIND_VALUES[i] ? ' selected' : '') + '>' + l + '</option>').join('')
        + '</select></div></div>'
        + field('备注', 'note', { type: 'textarea', placeholder: '选填' })
        + '</div>';

      if (e.isEdit) {
        html += '<button class="btn btn-danger" data-act="remove">删除日程</button>';
      }
    }

    html += '</div>';
    $('panel').innerHTML = '<div class="panel-inner">' + html + '</div>';
    // 面板里的时间选择器同样强制 24 小时制显示
    ui.enhanceTimeInputs($('panel'));
  }

  function settingsWeeks() {
    return Math.max(1, Number(store.getSettings().termWeeks) || 20);
  }

  function spanBoxHtml() {
    const f = state.edit.form;
    const list = (f.periods || []).slice().sort((a, b) => a - b);
    if (!list.length) {
      return '<div class="tip-card info" style="margin-top:12px;margin-bottom:0">还没选节次。点上面的方格选择，连堂课可以一次点亮多格。</div>';
    }
    const span = periods.spanOf(list);
    const contig = periods.isContiguous(list);
    const text = periods.label(list) + ' · ' + span.start + (span.end ? ' ~ ' + span.end : ' 之后')
      + ' · 共 ' + list.length + ' 节';
    if (contig) {
      return '<div class="tip-card ok" style="margin-top:12px;margin-bottom:0">' + esc(text) + '</div>';
    }
    return '<div class="tip-card" style="margin-top:12px;margin-bottom:0">'
      + esc(text) + '<br>注意：选中的节次不连续，课表上会显示成跨行的整块。通常连堂课选连续节次。</div>';
  }

  /* ---------------- 周次选择 ---------------- */

  /**
   * 自定义周的名单（第几周）。老数据可能没有 list，返回空数组。
   * 只保留 1..学期周数 范围内的、去重后的周号，升序。
   */
  function weekListOf(f) {
    const max = settingsWeeks();
    const raw = Array.isArray(f.weekList) ? f.weekList : [];
    const seen = {};
    const out = [];
    raw.forEach(n => {
      n = Math.round(Number(n));
      if (!(n >= 1 && n <= max) || seen[n]) return;
      seen[n] = 1;
      out.push(n);
    });
    return out.sort((a, b) => a - b);
  }

  /** 周次卡片的可重绘主体：自定义模式显示方格，其余显示起止周下拉 + 小结 */
  function weekBoxHtml() {
    const f = state.edit.form;
    return (f.weekType === 'custom' ? weekGridHtml() : weekRangeHtml()) + weekSummaryHtml();
  }

  /** 起止周 + 单双周 的下拉（非自定义模式显示这个） */
  function weekRangeHtml() {
    const f = state.edit.form;
    const opts = (sel) => Array.from({ length: settingsWeeks() }, (_, i) =>
      '<option value="' + (i + 1) + '"' + (Number(sel) === i + 1 ? ' selected' : '') + '>第 ' + (i + 1) + ' 周</option>').join('');
    return '<div class="field" style="margin-top:12px"><span class="field-label">起止周</span>'
      + '<div class="field-body row" style="gap:8px">'
      + '<select data-efield="weekFrom" style="flex:1">' + opts(f.weekFrom) + '</select>'
      + '<span class="muted">至</span>'
      + '<select data-efield="weekTo" style="flex:1">' + opts(f.weekTo) + '</select>'
      + '</div></div>'
      + '<div class="hint">单周 = 第 1、3、5… 周；双周 = 第 2、4、6… 周。'
      + '「起止周」决定这门课从第几周上到第几周。</div>';
  }

  /**
   * 自定义周：1..学期周数 的方格，点一下选中/取消。
   * 与「节次」的 period-grid 同一套交互——**允许只选不相邻的周**。
   */
  function weekGridHtml() {
    const f = state.edit.form;
    const picked = weekListOf(f);
    const on = {};
    picked.forEach(n => { on[n] = 1; });
    const total = settingsWeeks();
    let cells = '';
    for (let n = 1; n <= total; n++) {
      cells += '<button class="wchip' + (on[n] ? ' on' : '') + '"'
        + ' data-act="toggle-week" data-key="' + n + '">' + n + '</button>';
    }
    return '<div class="section-title" style="margin:14px 0 8px 0">选周（可多选，允许跳周）</div>'
      + '<div class="week-grid" id="weekGrid">' + cells + '</div>'
      + '<div class="row" style="gap:8px;margin-top:10px">'
      + '<button class="btn btn-ghost btn-mini" data-act="weeks-all">全选</button>'
      + '<button class="btn btn-ghost btn-mini" data-act="weeks-odd">全选单周</button>'
      + '<button class="btn btn-ghost btn-mini" data-act="weeks-even">全选双周</button>'
      + '<button class="btn btn-ghost btn-mini" data-act="clear-weeks">清空</button>'
      + '</div>'
      + '<div class="hint">点数字选周，可以只选不相邻的周（例如第 1、3、7、12 周）。'
      + '点「全选」后也能再点掉中间某几周。</div>';
  }

  /** 周次卡片底部的一行小结语 —— 把这门课到底哪几周上，用人话再确认一次 */
  function weekSummaryHtml() {
    const f = state.edit.form;
    const total = settingsWeeks();
    let list;
    if (f.weekType === 'custom') {
      list = weekListOf(f);
      if (!list.length) {
        return '<div class="tip-card info" style="margin-top:12px;margin-bottom:0">'
          + '还没选周次。点上面的数字选择，允许跳周。</div>';
      }
    } else {
      const from = Math.max(1, Number(f.weekFrom) || 1);
      const to = Math.min(total, Number(f.weekTo) || total);
      list = [];
      for (let n = from; n <= to; n++) {
        if (f.weekType === 'odd' && n % 2 === 0) continue;
        if (f.weekType === 'even' && n % 2 === 1) continue;
        list.push(n);
      }
      if (!list.length) {
        return '<div class="tip-card info" style="margin-top:12px;margin-bottom:0">'
          + '这个范围里没有任何一周符合「' + (f.weekType === 'odd' ? '单周' : '双周') + '」，请调整起止周。</div>';
      }
    }
    const text = compactWeeksText(list) + ' · 共 ' + list.length + ' 周上课';
    const contiguous = list.length > 1 && (list[list.length - 1] - list[0] === list.length - 1);
    if (f.weekType === 'custom' && !contiguous) {
      return '<div class="tip-card" style="margin-top:12px;margin-bottom:0">' + esc(text)
        + '<br>注意：选中的周不连续，课表上这几周的该课会照常显示，其他周不排。</div>';
    }
    return '<div class="tip-card ok" style="margin-top:12px;margin-bottom:0">' + esc(text) + '</div>';
  }

  /**
   * 把周号列表压成好读的短文本：连续的合并成区间。
   * [1,2,3,7,12] -> "第 1–3、7、12 周"
   */
  function compactWeeksText(list) {
    if (!list.length) return '未选择';
    const parts = [];
    let start = list[0];
    let prev = list[0];
    for (let i = 1; i <= list.length; i++) {
      const cur = list[i];
      if (cur === prev + 1) { prev = cur; continue; }
      parts.push(start === prev ? String(start) : (start + '–' + prev));
      start = prev = cur;
    }
    return '第 ' + parts.join('、') + ' 周';
  }

  function untilBoxHtml() {    const f = state.edit.form;
    if (f.repeatType === 'none') return '';
    return '<div class="field" style="margin-top:12px"><span class="field-label">重复至</span>'
      + '<div class="field-body row" style="gap:8px">'
      + '<input type="date" data-efield="until" value="' + esc(f.until) + '" style="flex:1">'
      + '<button class="btn btn-ghost btn-mini" data-act="clear-until">不设截止</button>'
      + '</div></div>'
      + '<div class="hint">留空表示一直重复。默认填的是 8 周后，可以改。</div>';
  }

  /* =========================================================
     保存
     ========================================================= */

  function saveEdit() {
    if (!state.edit) return;
    if (state.edit.type === 'course') saveCourse();
    else if (state.edit.type === 'homework') saveHomework();
    else if (state.edit.type === 'countdown') saveCountdown();
    else if (state.edit.type === 'habit') saveHabit();
    else saveSchedule();
  }

  function saveHomework() {
    const f = state.edit.form;
    if (!String(f.title || '').trim()) { ui.toast('请填写作业标题'); return; }
    if (!f.due) { ui.toast('请选择截止日期'); return; }
    // 课程名冗余存一份，课程被删掉后作业也能正常显示归属
    const course = f.courseId ? store.getCourse(f.courseId) : null;
    const record = {
      id: f.id || store.genId(),
      title: String(f.title).trim(),
      courseId: f.courseId || '',
      courseName: course ? (course.name || '') : '',
      due: f.due,
      dueTime: f.dueTime || '',
      done: !!f.done,
      doneAt: f.done ? (f.doneAt || dateUtil.today()) : '',
      color: f.color,
      remindBefore: (f.remindBefore || []).slice().sort((a, b) => b - a),
      note: String(f.note || '').trim()
    };
    store.upsertHomework(record);
    finishSave('已保存');
  }

  function saveCountdown() {
    const f = state.edit.form;
    if (!String(f.title || '').trim()) { ui.toast('请填写名称'); return; }
    if (!f.date) { ui.toast('请选择日期'); return; }
    const record = {
      id: f.id || store.genId(),
      title: String(f.title).trim(),
      date: f.date,
      dateMode: f.dateMode === 'sec' ? 'sec' : 'day',
      color: f.color,
      pinned: !!f.pinned,
      remindBefore: (f.remindBefore || []).slice().sort((a, b) => b - a),
      note: String(f.note || '').trim()
    };
    store.upsertCountdown(record);
    finishSave('已保存');
  }

  function saveHabit() {
    const f = state.edit.form;
    if (!String(f.name || '').trim()) { ui.toast('请填写打卡项名称'); return; }
    const record = {
      id: f.id || store.genId(),
      name: String(f.name).trim(),
      icon: f.icon || '',
      color: f.color,
      remindAt: f.remindAt || '',
      note: String(f.note || '').trim(),
      archived: !!f.archived
    };
    store.upsertHabit(record);
    finishSave('已保存');
  }

  function saveCourse() {
    const f = state.edit.form;
    if (!String(f.name || '').trim()) { ui.toast('请填写课程名称'); return; }
    if (!f.periods || !f.periods.length) { ui.toast('请至少选择一节课'); return; }

    let from = Number(f.weekFrom) || 1;
    let to = Number(f.weekTo) || 1;
    if (from > to) { const t = from; from = to; to = t; }

    // 自定义周必须至少选一周，否则这门课永远不会出现在课表上
    const weekList = weekListOf(f);
    if (f.weekType === 'custom' && !weekList.length) {
      ui.toast('请至少选择一周');
      return;
    }

    const weeks = { type: f.weekType, from: from, to: to };
    // 只在自定义模式下写 list，其余模式不落这个字段，
    // 免得切换模式时留下一份对不上的旧名单
    if (f.weekType === 'custom') weeks.list = weekList;

    const record = {
      id: f.id || store.genId(),
      name: String(f.name).trim(),
      teacher: String(f.teacher || '').trim(),
      location: String(f.location || '').trim(),
      day: Number(f.day),
      periods: f.periods.slice().sort((a, b) => a - b),
      weeks: weeks,
      color: f.color,
      remindBefore: Number(f.remindBefore),
      note: String(f.note || '').trim(),
      demo: false
    };

    const conflicts = store.findCourseConflicts(record);
    if (conflicts.length) {
      const desc = conflicts.map(item =>
        '「' + item.name + '」第' + item.periods.join('、') + '节' + (item.location ? '（' + item.location + '）' : '')
      ).join('\n');
      ui.dialog({
        title: '时间冲突提醒',
        body: '与已有课程时间重叠：\n' + desc + '\n\n仍然保存吗？',
        confirmText: '仍然保存',
        danger: true
      }).then(ok => {
        if (!ok) return;
        store.upsertCourse(record);
        finishSave('课程已保存');
      });
      return;
    }

    store.upsertCourse(record);
    finishSave('课程已保存');
  }

  function saveSchedule() {
    const f = state.edit.form;
    if (!String(f.title || '').trim()) { ui.toast('请填写日程标题'); return; }
    if (!f.startTime) { ui.toast('请选择开始时间'); return; }
    if (f.repeatType !== 'none' && f.until && f.until < f.date) {
      ui.toast('截止日期早于开始日期');
      return;
    }
    const record = {
      id: f.id || store.genId(),
      title: String(f.title).trim(),
      date: f.date || dateUtil.today(),
      startTime: f.startTime,
      endTime: f.endTime || '',
      location: String(f.location || '').trim(),
      category: f.category || '其他',
      color: f.color,
      remindBefore: Number(f.remindBefore),
      note: String(f.note || '').trim(),
      done: !!f.done,
      demo: false,
      repeat: { type: f.repeatType || 'none', until: f.repeatType === 'none' ? '' : (f.until || '') },
      doneDates: (f.doneDates || []).slice()
    };
    store.upsertSchedule(record);
    finishSave('日程已保存');
  }

  function finishSave(title) {
    ui.toast(title);
    closeEdit();
    render();
  }

  async function removeEditing() {
    const e = state.edit;
    if (!e || !e.isEdit) return;
    const isCourse = e.type === 'course';
    const isCountdown = e.type === 'countdown';
    const isHabit = e.type === 'habit';
    const isHomework = e.type === 'homework';
    const name = isCourse ? e.form.name : (isHabit ? e.form.name : e.form.title);
    const id = e.form.id;

    if (isHabit) {
      const ok = await ui.dialog({
        title: '删除打卡项',
        body: '「' + name + '」以及它的全部打卡记录都会被删除，无法恢复，确定吗？\n\n'
          + '如果只是暂时不想看到它，可以选「暂时归档」而不是删除。',
        confirmText: '删除',
        danger: true
      });
      if (!ok) return;
      store.removeHabit(id);
      ui.toast('已删除');
      closeEdit();
      render();
      return;
    }

    if (isHomework) {
      const ok = await ui.dialog({
        title: '删除作业',
        body: '确定删除「' + name + '」吗？',
        confirmText: '删除',
        danger: true
      });
      if (!ok) return;
      store.removeHomework(id);
      ui.toast('已删除');
      closeEdit();
      render();
      return;
    }

    if (isCountdown) {
      const ok = await ui.dialog({
        title: '删除倒数日',
        body: '确定删除「' + name + '」吗？',
        confirmText: '删除',
        danger: true
      });
      if (!ok) return;
      store.removeCountdown(id);
      ui.toast('已删除');
      closeEdit();
      render();
      return;
    }

    const isRepeat = !isCourse && e.form.repeatType !== 'none';
    // 删课程前提示挂在这门课下的作业——它们不会被删，但会失去课程归属
    const attached = isCourse ? store.homeworksOfCourse(id) : [];
    let body;
    if (isCourse) {
      body = attached.length
        ? '确定删除「' + name + '」吗？\n\n'
          + '这门课下还挂着 ' + attached.length + ' 项作业，它们不会被删除，'
          + '但会失去课程归属（仍能在倒数日页看到）。'
        : '确定删除「' + name + '」吗？';
    } else {
      body = isRepeat
        ? '「' + name + '」是重复日程，将删除整个重复安排及其完成记录，确定吗？'
        : '确定删除「' + name + '」吗？';
    }
    const ok = await ui.dialog({
      title: isCourse ? '删除课程' : '删除日程',
      body: body,
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
    if (isCourse) store.removeCourse(id);
    else store.removeSchedule(id);
    ui.toast('已删除');
    closeEdit();
    render();
  }

  /* =========================================================
     事件
     ========================================================= */

  function bindEvents() {
    const view = $('view');

    view.addEventListener('click', e => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.getAttribute('data-act');
      const id = el.getAttribute('data-id');
      const date = el.getAttribute('data-date');

      switch (act) {
        case 'add-course': openEdit({ type: 'course', day: dateUtil.weekday(dateUtil.today()) }); break;
        case 'add-homework': openEdit({ type: 'homework' }); break;
        case 'edit-homework': openEdit({ type: 'homework', id: id }); break;
        case 'toggle-hw': toggleHomework(id); break;
        case 'hw-filter': state.hwFilter = el.getAttribute('data-key'); render(); break;
        case 'hw-menu': homeworkMenu(id); break;
        case 'go-homework': switchTab('countdown'); break;
        case 'add-schedule': {
          // 月历视图里点「在这一天添加日程」会带 data-date，把它作为默认日期
          const d = el.getAttribute('data-date');
          openEdit({ type: 'schedule', date: d || null });
          break;
        }
        case 'sch-view': state.schView = el.getAttribute('data-key'); render(); break;
        case 'sch-cal-prev': shiftScheduleMonth(-1); break;
        case 'sch-cal-next': shiftScheduleMonth(1); break;
        case 'sch-cal-cell': {
          state.schSelDate = el.getAttribute('data-date');
          render();
          break;
        }
        case 'edit-course': openEdit({ type: 'course', id: id }); break;
        case 'schedule-menu': scheduleMenu(id, date, true); break;
        case 'ask-notify': askNotify(); break;
        case 'go-settings': switchTab('settings'); break;
        case 'cell': openEdit({ type: 'course', day: el.getAttribute('data-day'), period: el.getAttribute('data-period') }); break;
        case 'block-menu': blockMenu(id); break;
        case 'prev-week': state.ttWeek -= 1; render(); break;
        case 'next-week': state.ttWeek += 1; render(); break;
        case 'back-week': state.ttWeek = null; render(); break;
        case 'sch-tab': state.schTab = el.getAttribute('data-key'); render(); break;
        case 'sch-cat': state.schCategory = el.getAttribute('data-name'); render(); break;

        /* --- 倒数日 --- */
        case 'add-countdown': openEdit({ type: 'countdown' }); break;
        case 'edit-countdown': openEdit({ type: 'countdown', id: id }); break;
        case 'cd-filter': state.cdFilter = el.getAttribute('data-key'); render(); break;
        case 'cd-menu': countdownMenu(id); break;
        case 'toggle-pin': togglePin(id); break;

        /* --- 打卡 --- */
        case 'add-habit': openEdit({ type: 'habit' }); break;
        case 'toggle-habit': toggleHabit(id); break;
        case 'habit-menu': habitMenu(id); break;
        case 'cal-prev': shiftMonth(-1); break;
        case 'cal-next': shiftMonth(1); break;
        case 'cal-cell': {
          const date = el.getAttribute('data-date');
          if (date) { store.toggleCheck(id, date); render(); }
          break;
        }

        default: settingsAct(act, el); break;
      }
    });

    view.addEventListener('change', e => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.getAttribute('data-act');
      if (act === 'week-pick') { state.ttWeek = Number(el.value); render(); return; }
      if (act === 'remind-select') {
        store.saveSettings({ remindBefore: Number(el.value) });
        ui.toast('已保存');
        return;
      }
      if (act === 'term-start') {
        store.saveSettings({ termStart: el.value });
        ui.toast('已保存');
        render();
        return;
      }
      if (act === 'term-weeks') {
        const n = Math.max(1, Math.min(30, Number(el.value) || 20));
        el.value = n;
        store.saveSettings({ termWeeks: n });
        render();
        return;
      }
      if (act === 'toggle-vibrate') { store.saveSettings({ vibrate: el.checked }); return; }
      if (act === 'toggle-motion') {
        store.saveSettings({ enhancedMotion: el.checked });
        document.body.classList.toggle('motion-enhanced', el.checked);
        ui.toast(el.checked ? '增强动效已开启' : '增强动效已关闭');
        return;
      }
      if (act === 'toggle-link') {
        periods.setLinked(el.checked);
        ui.toast(el.checked ? '改一边会带一边' : '每节时间各自独立');
        render();
        return;
      }
      if (act === 'toggle-openend') {
        const index = Number(el.getAttribute('data-index')) || periods.total();
        const r = periods.toggleOpenEnd(index, el.checked);
        if (!r.ok && r.message) ui.alert('改不了', r.message);
        else ui.toast(el.checked ? '该节不再设下课时间' : '该节恢复固定下课时间');
        render();
        return;
      }
      if (act === 'export-ics') return;
    });

    // 作息时间：改某一节的上课 / 下课时间
    view.addEventListener('change', e => {
      const el = e.target;
      if (!el.hasAttribute || !el.hasAttribute('data-pfield')) return;
      const index = Number(el.getAttribute('data-index'));
      const f = el.getAttribute('data-pfield');
      const r = periods.setTime(index, f, timeValue24(el));
      if (!r.ok) {
        if (r.message) ui.alert('这个时间不合适', r.message);
        render();
        return;
      }
      render();
      if (r.synced && r.synced.length) {
        const s = r.synced[0];
        ui.toast('第' + s.index + '节的' + (s.field === 'start' ? '上课' : '下课') + '时间已一起调整');
      }
    });

    view.addEventListener('input', e => {
      const el = e.target;
      if (!el.hasAttribute || !el.hasAttribute('data-pfield')) return;
      // 输入过程中不立即校验，等 change 触发
    });

    // 标签栏
    $('tabbar').addEventListener('click', e => {
      const el = e.target.closest('[data-tab]');
      if (!el) return;
      switchTab(el.getAttribute('data-tab'));
    });

    // 编辑面板
    const panel = $('panel');

    panel.addEventListener('click', e => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.getAttribute('data-act');
      const key = el.getAttribute('data-key');
      const f = state.edit ? state.edit.form : null;
      if (!f && act !== 'close-panel') return;

      switch (act) {
        case 'close-panel': closeEdit(); break;
        case 'save': saveEdit(); break;
        case 'remove': removeEditing(); break;
        case 'pick-day': f.day = Number(key); markOn(el); break;
        case 'pick-weektype': {
          const prev = f.weekType;
          f.weekType = key;
          markOn(el);
          // 从别处切到「自定义周」时，若名单还是空的，先用当前起止周填一份，
          // 免得好不容易选好的周次一下子全没了（用户再点几下微调即可）。
          if (key === 'custom' && prev !== 'custom' && !weekListOf(f).length) {
            const total = settingsWeeks();
            const from = Math.max(1, Number(f.weekFrom) || 1);
            const to = Math.min(total, Number(f.weekTo) || total);
            const seed = [];
            for (let n = from; n <= to; n++) {
              // 用切换前的模式决定要不要跳周（单周只留奇数周…）
              if (prev === 'odd' && n % 2 === 0) continue;
              if (prev === 'even' && n % 2 === 1) continue;
              seed.push(n);
            }
            f.weekList = seed;
          }
          const wbox = $('weekBox');
          if (wbox) wbox.innerHTML = weekBoxHtml();
          break;
        }
        case 'toggle-week': {
          const n = Number(key);
          const list = weekListOf(f);
          const i = list.indexOf(n);
          if (i >= 0) list.splice(i, 1);
          else list.push(n);
          f.weekList = list;
          el.classList.toggle('on');
          const sbox = $('weekBox');
          if (sbox) {
            // 只换小结那一段，方格本身的 on/off 由上面的 toggle 负责，
            // 整块重绘会把刚点的按钮换掉、滚动位置也会跳
            const summary = sbox.querySelector('.tip-card');
            if (summary) summary.outerHTML = weekSummaryHtml();
            else sbox.innerHTML = weekBoxHtml();
          }
          break;
        }
        case 'weeks-all':
        case 'weeks-odd':
        case 'weeks-even': {
          const total = settingsWeeks();
          const want = act === 'weeks-all' ? 'all' : (act === 'weeks-odd' ? 'odd' : 'even');
          const list = [];
          for (let n = 1; n <= total; n++) {
            if (want === 'odd' && n % 2 === 0) continue;
            if (want === 'even' && n % 2 === 1) continue;
            list.push(n);
          }
          f.weekList = list;
          const box = $('weekBox');
          if (box) box.innerHTML = weekBoxHtml();
          break;
        }
        case 'clear-weeks': {
          f.weekList = [];
          const box = $('weekBox');
          if (box) box.innerHTML = weekBoxHtml();
          break;
        }
        case 'pick-category': f.category = key; markOn(el); break;
        case 'pick-repeat': {
          f.repeatType = key;
          markOn(el);
          if (key !== 'none' && !f.until) {
            f.until = dateUtil.addDays(f.date || dateUtil.today(), 56);
            ui.toast('默认重复 8 周，可修改截止日期');
          }
          if (key === 'none' && f.until) f.until = '';
          const box = $('untilBox');
          if (box) box.innerHTML = untilBoxHtml();
          break;
        }
        case 'clear-until': {
          f.until = '';
          const box = $('untilBox');
          if (box) box.innerHTML = untilBoxHtml();
          break;
        }
        case 'pick-color': f[el.getAttribute('data-key')] = el.getAttribute('data-color'); markColor(el); break;
        case 'pick-datemode': f.dateMode = key; markOn(el); break;
        case 'pick-icon': f.icon = key; markOn(el); break;
        case 'pick-remindday': {
          // 多选：点一次加入，再点一次移除
          const d = Number(key);
          const i = f.remindBefore.indexOf(d);
          if (i >= 0) f.remindBefore.splice(i, 1);
          else f.remindBefore.push(d);
          el.classList.toggle('on');
          break;
        }
        case 'toggle-pin-form': f.pinned = !f.pinned; break;
        case 'toggle-done-form': f.done = !f.done; break;
        case 'clear-duetime': {
          f.dueTime = '';
          const inp = panel.querySelector('[data-efield="dueTime"]');
          if (inp) { inp.value = ''; ui.refreshTimeInput(inp); }
          ui.toast('按当天 23:59 截止');
          break;
        }
        case 'clear-remindat': {
          f.remindAt = '';
          const inp = panel.querySelector('[data-efield="remindAt"]');
          if (inp) { inp.value = ''; ui.refreshTimeInput(inp); }
          break;
        }
        case 'toggle-archive': {
          f.archived = !f.archived;
          const btn = panel.querySelector('[data-act="toggle-archive"]');
          if (btn) btn.textContent = f.archived ? '恢复打卡项' : '暂时归档（不再显示）';
          ui.toast(f.archived ? '已归档，保存后生效' : '已恢复，保存后生效');
          break;
        }
        case 'toggle-period': {
          const n = Number(key);
          const i = f.periods.indexOf(n);
          if (i >= 0) f.periods.splice(i, 1);
          else f.periods.push(n);
          el.classList.toggle('on');
          const box = $('spanBox');
          if (box) box.innerHTML = spanBoxHtml();
          break;
        }
        case 'clear-periods': {
          f.periods = [];
          panel.querySelectorAll('.pchip.on').forEach(c => c.classList.remove('on'));
          const box = $('spanBox');
          if (box) box.innerHTML = spanBoxHtml();
          break;
        }
        default: break;
      }
    });

    panel.addEventListener('change', e => {
      const el = e.target;
      if (!el.hasAttribute) return;
      const f = state.edit ? state.edit.form : null;
      if (!f) return;

      const ef = el.getAttribute('data-efield');
      if (!ef) return;

      if (ef === 'weekFrom' || ef === 'weekTo') {
        f[ef] = Number(el.value);
        // 起止周互相兜底，避免出现 5 到 3 这种区间
        if (ef === 'weekFrom' && f.weekFrom > f.weekTo) {
          f.weekTo = f.weekFrom;
          const sel = panel.querySelector('[data-efield="weekTo"]');
          if (sel) sel.value = f.weekTo;
        }
        if (ef === 'weekTo' && f.weekTo < f.weekFrom) {
          f.weekFrom = f.weekTo;
          const sel = panel.querySelector('[data-efield="weekFrom"]');
          if (sel) sel.value = f.weekFrom;
        }
        return;
      }

      if (ef === 'date') {
        f.date = el.value;
        if (f.repeatType !== 'none' && f.until && f.until < f.date) {
          f.until = dateUtil.addDays(f.date, 56);
          const box = $('untilBox');
          if (box) box.innerHTML = untilBoxHtml();
        }
        return;
      }

      if (ef === 'startTime') {
        f.startTime = timeValue24(el);
        if (!f.endTime) {
          f.endTime = dateUtil.fromMin(dateUtil.toMin(f.startTime) + 60);
          const endInput = panel.querySelector('[data-efield="endTime"]');
          if (endInput) {
            endInput.value = f.endTime;
            // 直接赋值不触发事件，24 小时只读层要手动刷一下，
            // 否则它会停在空值上、露出原生控件的 12 小时文本
            ui.refreshTimeInput(endInput);
          }
        }
        return;
      }

      if (ef === 'remindBefore') { f.remindBefore = Number(el.value); return; }
      // 下拉框直接取值，不能走 timeValue24（那是给时间控件的）
      if (ef === 'courseId') { f.courseId = el.value; return; }

      f[ef] = timeValue24(el);
    });

    panel.addEventListener('input', e => {
      const el = e.target;
      if (!el.hasAttribute || !state.edit) return;
      const ef = el.getAttribute('data-efield');
      if (!ef) return;
      const f = state.edit.form;
      if (ef === 'remindBefore') f.remindBefore = Number(el.value);
      else if (ef === 'weekFrom' || ef === 'weekTo') f[ef] = Number(el.value);
      else f[ef] = timeValue24(el);
    });
  }

  function markOn(el) {
    const group = el.parentNode;
    if (!group) return;
    Array.prototype.forEach.call(group.children, c => c.classList.remove('on'));
    el.classList.add('on');
  }

  /**
   * 读时间控件的值，永远得到 'HH:MM'。
   *
   * 注意**不要**用 valueAsDate：本机时区 UTC+8 下它会整体偏移 +8 小时。
   * input.value 本身就是稳定的 24 小时 'HH:MM' 字符串，直接取就好。
   * 非时间控件（select、checkbox 等）原样返回 el.value。
   */
  function timeValue24(el) {
    if (el && el.type === 'time') return ui.inputValue24(el);
    return el ? el.value : '';
  }

  function markColor(el) {
    const group = el.parentNode;
    if (!group) return;
    Array.prototype.forEach.call(group.children, c => c.classList.remove('on'));
    el.classList.add('on');
  }

  /* =========================================================
     各种菜单
     ========================================================= */

  /* ---------------- 倒数日与打卡的操作 ---------------- */

  /** 直接切换置顶状态（大卡片上的按钮走这里，不进菜单） */
  function togglePin(id) {
    const item = store.getCountdown(id);
    if (!item) return;
    item.pinned = !item.pinned;
    store.upsertCountdown(item);
    render();
    ui.toast(item.pinned ? '已置顶' : '已取消置顶');
  }

  function shiftMonth(delta) {
    const now = new Date();
    const cur = state.habitMonth || { y: now.getFullYear(), m: now.getMonth() + 1 };
    let m = cur.m + delta;
    let y = cur.y;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    state.habitMonth = { y: y, m: m };
    render();
  }

  /** 打卡：点一下切换，并给一点即时的文字反馈 */
  function toggleHabit(id) {
    const h = store.getHabit(id);
    if (!h) return;
    const on = store.toggleCheck(id, dateUtil.today());
    render();
    if (!on) { ui.toast('已取消打卡'); return; }
    const streak = store.streakOf(id);
    const hint = plan.streakHint(streak, true);
    ui.toast(hint || '已打卡');
  }

  async function countdownMenu(id) {
    const item = store.getCountdown(id);
    if (!item) return;
    const items = [
      { text: '编辑' },
      { text: item.pinned ? '取消置顶' : '置顶显示' },
      { text: '删除', danger: true }
    ];
    const idx = await ui.sheet(items);
    if (idx < 0) return;
    if (idx === 0) {
      openEdit({ type: 'countdown', id: id });
    } else if (idx === 1) {
      togglePin(id);
    } else {
      const ok = await ui.dialog({
        title: '删除倒数日',
        body: '确定删除「' + item.title + '」吗？',
        confirmText: '删除',
        danger: true
      });
      if (ok) { store.removeCountdown(id); render(); ui.toast('已删除'); }
    }
  }

  async function habitMenu(id) {
    const h = store.getHabit(id);
    if (!h) return;
    const todayStr = dateUtil.today();
    const done = store.isChecked(id, todayStr);
    const items = [
      { text: done ? '取消今日打卡' : '完成今日打卡', primary: true },
      { text: '编辑' },
      { text: h.archived ? '恢复显示' : '暂时归档' },
      { text: '删除', danger: true }
    ];
    const idx = await ui.sheet(items);
    if (idx < 0) return;
    if (idx === 0) {
      toggleHabit(id);
    } else if (idx === 1) {
      openEdit({ type: 'habit', id: id });
    } else if (idx === 2) {
      h.archived = !h.archived;
      store.upsertHabit(h);
      render();
      ui.toast(h.archived ? '已归档，不再显示在打卡区' : '已恢复显示');
    } else {
      const ok = await ui.dialog({
        title: '删除打卡项',
        body: '「' + h.name + '」以及它的全部打卡记录都会被删除，无法恢复，确定吗？\n\n'
          + '如果只是暂时不想看到它，选「暂时归档」就好。',
        confirmText: '删除',
        danger: true
      });
      if (ok) { store.removeHabit(id); render(); ui.toast('已删除'); }
    }
  }

  async function blockMenu(id) {
    const course = store.getCourse(id);
    if (!course) return;
    const todayStr = dateUtil.today();
    const settings = store.getSettings();
    const isCurrentWeek = state.ttWeek === dateUtil.weekNo(settings.termStart, todayStr);
    const canSkip = isCurrentWeek && Number(course.day) === dateUtil.weekday(todayStr);

    const items = [
      { text: '编辑课程' },
      { text: '复制为新课程' },
      { text: '删除课程', danger: true }
    ];
    if (canSkip) {
      items.push({ text: store.isSkipped(todayStr, id) ? '恢复本周这节课' : '本周这节课不上' });
    }

    const idx = await ui.sheet(items);
    if (idx < 0) return;
    const label = items[idx].text;

    if (label === '编辑课程') {
      openEdit({ type: 'course', id: id });
    } else if (label === '复制为新课程') {
      openEdit({ type: 'course', copy: id });
    } else if (label === '删除课程') {
      const ok = await ui.dialog({
        title: '删除课程',
        body: '确定删除「' + course.name + '」吗？',
        confirmText: '删除',
        danger: true
      });
      if (ok) { store.removeCourse(id); render(); }
    } else {
      if (store.isSkipped(todayStr, id)) store.removeSkip(todayStr, id);
      else store.addSkip(todayStr, id);
      render();
      ui.toast('已更新');
    }
  }

  /**
   * 勾选/取消「已交」。
   *
   * 刻意做得轻：列表上一个勾选框直接切换，不用进编辑面板——
   * 「交完作业顺手打个勾」是这个功能用得最多的动作，路径必须最短。
   *
   * 交完给一句鼓励，但只说一次，不要每次都弹。
   */
  function toggleHomework(id) {
    const item = store.toggleHomeworkDone(id);
    if (!item) return;
    render();
    if (item.done) {
      const left = plan.homeworkTodoCount();
      ui.toast(left ? '已标记为已交，还剩 ' + left + ' 项' : '已标记为已交，作业全清了');
    } else {
      ui.toast('已恢复为未交');
    }
  }

  /** 作业的长按/点击菜单：勾选 + 编辑 + 删除 */
  async function homeworkMenu(id) {
    const item = store.getHomework(id);
    if (!item) return;
    const items = [
      { text: item.done ? '标记为未交' : '标记为已交', primary: true },
      { text: '编辑' },
      { text: '删除', danger: true }
    ];
    const idx = await ui.sheet(items);
    if (idx < 0) return;

    if (idx === 0) {
      toggleHomework(id);
    } else if (idx === 1) {
      openEdit({ type: 'homework', id: id });
    } else {
      const ok = await ui.dialog({
        title: '删除作业',
        body: '确定删除「' + (item.title || '') + '」吗？',
        confirmText: '删除',
        danger: true
      });
      if (!ok) return;
      store.removeHomework(id);
      ui.toast('已删除');
      render();
    }
  }

  async function scheduleMenu(id, date, fromToday) {    const item = store.getSchedule(id);
    if (!item) return;
    const targetDate = date || item.date;
    const isRepeat = !!(item.repeat && item.repeat.type && item.repeat.type !== 'none');
    const doneNow = scheduleUtil.isDoneOn(item, targetDate);
    const doneLabel = isRepeat
      ? (doneNow ? '本次标记为未完成' : '本次已完成')
      : (doneNow ? '标记为未完成' : '标记为已完成');

    const items = [
      { text: doneLabel, primary: true },
      { text: '编辑' },
      { text: '删除', danger: true }
    ];

    const idx = await ui.sheet(items);
    if (idx < 0) return;

    if (idx === 0) {
      scheduleUtil.toggleDone(item, targetDate);
      store.upsertSchedule(item);
      render();
      ui.toast(doneNow ? '已恢复' : '已完成');
    } else if (idx === 1) {
      openEdit({ type: 'schedule', id: id });
    } else {
      const ok = await ui.dialog({
        title: '删除日程',
        body: isRepeat
          ? '「' + item.title + '」是重复日程，将删除整个重复安排，确定吗？'
          : '确定删除「' + item.title + '」吗？',
        confirmText: '删除',
        danger: true
      });
      if (ok) { store.removeSchedule(id); render(); }
    }
    void fromToday;
  }

  async function askNotify() {
    if (!reminder.supported()) {
      ui.alert('这个环境不支持系统通知', '可能是浏览器太旧，或者页面不是以 https / localhost 打开。'
        + '不影响「导出到系统日历」，那条路一样能准时提醒。');
      return;
    }
    const p = await reminder.requestPermission();
    if (p === 'granted') {
      ui.toast('通知已开启，测试一条看看');
      reminder.testFire();
    } else if (p === 'denied') {
      ui.alert('通知被拒绝了', '浏览器会记住这个选择。想改的话，点地址栏左边的锁形图标 → 通知 → 允许，然后刷新页面。\n\n'
        + '即使不用通知，「导出到系统日历」也能让手机在关掉应用后准时提醒你。');
    }
    render();
  }

  async function settingsAct(act, el) {
    void el;
    switch (act) {
      case 'test-reminder':
        reminder.testFire();
        break;

      /* 安卓壳专用：排一条真的系统闹钟，验证"关掉应用也能提醒" */
      case 'test-background': {
        if (!reminder.testBackground(60)) {
          ui.alert('这个环境不支持后台提醒', '需要在安卓应用里使用。');
          break;
        }
        await ui.alert('测试提醒已排上', '现在按返回键退出应用（或者把应用从后台划掉），'
          + '大约 1 分钟后应该会收到一条通知。\n\n'
          + '如果没收到，检查一下系统设置里「课程提醒」的通知权限是否被关掉了。');
        render();
        break;
      }

      /* 安卓壳专用：跳系统设置页申请「闹钟和提醒」权限 */
      case 'request-exact-alarm': {
        if (window.Android && typeof window.Android.requestExactAlarm === 'function') {
          window.Android.requestExactAlarm();
        } else {
          ui.alert('这个环境不需要设置', '当前系统的提醒本来就是准点触发的。');
        }
        break;
      }

      // 安卓壳专用：清掉离线缓存后重载，把页面刷到包内的最新版本
      case 'reload-fresh': {
        ui.toast('正在清缓存并重新载入…');
        if (typeof window.__crReloadFresh === 'function') window.__crReloadFresh();
        else window.location.reload();
        break;
      }

      case 'check-conflicts': {
        const courses = store.getCourses();
        const seen = {};
        const problems = [];
        courses.forEach(c => {
          store.findCourseConflicts(c).forEach(cf => {
            const key = [c.id, cf.id].sort().join('_');
            if (seen[key]) return;
            seen[key] = true;
            problems.push('「' + c.name + '」与「' + cf.name + '」在' + periods.WEEK_NAMES[Number(c.day) - 1]
              + '第' + cf.periods.join('、') + '节重叠');
          });
        });
        if (!problems.length) ui.alert('课表自检', '没有发现时间冲突的课程。');
        else ui.alert('发现 ' + problems.length + ' 处冲突', problems.join('\n'));
        break;
      }

      case 'reset-periods': {
        const ok = await ui.dialog({
          title: '恢复默认作息',
          body: '将放弃当前自定义的节次时间，回到内置的 12 节作息，确定吗？',
          confirmText: '恢复默认'
        });
        if (!ok) return;
        periods.reset();
        render();
        ui.toast('已恢复默认');
        break;
      }

      case 'export-ics': {
        const choice = await ui.sheet([
          { text: '导出全部（课程 + 日程 + 倒数日 + 打卡）', primary: true },
          { text: '只导出课程' },
          { text: '只导出日程' },
          { text: '只导出倒数日与打卡' }
        ]);
        if (choice < 0) return;
        const opts = choice === 1 ? { courses: true, schedules: false, countdowns: false, habits: false }
          : choice === 2 ? { courses: false, schedules: true, countdowns: false, habits: false }
            : choice === 3 ? { courses: false, schedules: false, countdowns: true, habits: true }
              : { courses: true, schedules: true, countdowns: true, habits: true };
        const r = ics.generate(opts);
        if (!r.count) {
          ui.alert('没有可导出的内容', '先去课表或日程里添加一些内容，再来导出。');
          return;
        }
        const name = '课程与日程.ics';
        const res = await ics.save(name, r.text);
        if (res === 'cancelled') return;
        if (res === 'failed') {
          ui.alert('导出失败', '当前浏览器不允许保存文件。可以换 Chrome 或 Safari 再试。');
          return;
        }
        ui.alert('已生成 ' + r.count + ' 条日程',
          (window.Android && typeof window.Android.platform === 'function'
            ? '文件已存到手机的「下载」文件夹，并会问你用哪个应用打开——选日历应用，点「全部添加」即可。'
            : (typeof window.__crIsIOS === 'function' && window.__crIsIOS())
              ? '分享面板里选「日历」即可直接导入；若没有这一项，选「存储到文件」，再到「文件」App 里点开它。'
              : '打开下载好的 .ics 文件，手机会问是否导入日历，点「全部添加」即可。')
          + '\n\n'
          + '之后由系统负责提醒：锁屏也叫、静音也震、关掉应用照样准点，完全不需要联网。\n\n'
          + '课表有变动时重新导出一次即可，重复导入不会产生重复项。');
        break;
      }

      case 'export-json': {
        const text = JSON.stringify(store.exportAll(), null, 2);
        const stamp = dateUtil.today();
        const res = await ics.save('课程备份-' + stamp + '.json', text, 'application/json');
        if (res !== 'failed') ui.toast('备份已导出');
        break;
      }

      case 'import-json': {
        importJson();
        break;
      }

      case 'seed-plan': {
        seedPlan();
        break;
      }

      case 'clear-data': {
        const ok = await ui.dialog({
          title: '清空所有数据',
          body: '课程与日程都会被删除，且无法恢复，确定吗？',
          confirmText: '清空',
          danger: true
        });
        if (!ok) return;
        store.clearAll();
        render();
        ui.toast('已清空');
        break;
      }

      default:
        break;
    }
    void el;
  }

  /** 设置页里手动载入倒数日与打卡的示例数据 */
  async function seedPlan() {
    const ok = await ui.dialog({
      title: '载入示例数据',
      body: '会补入几条倒数日和打卡项（已有内容不会被覆盖）。示例数据随时可以删掉，确定吗？',
      confirmText: '载入'
    });
    if (!ok) return;
    store.seedPlanData();
    render();
    ui.toast('示例数据已载入');
  }

  function importJson() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json,text/plain';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const text = String(reader.result || '').trim();
        const ok = await ui.dialog({
          title: '导入数据',
          body: '将用备份文件中的数据覆盖现有课程与日程，确定继续吗？',
          confirmText: '继续导入'
        });
        if (!ok) { input.remove(); return; }
        try {
          store.importAll(JSON.parse(text));
          render();
          ui.toast('导入成功');
        } catch (err) {
          ui.alert('导入失败', '这个文件不是有效的备份数据。\n\n' + (err && err.message ? err.message : ''));
        }
        input.remove();
      };
      reader.onerror = () => {
        ui.alert('读取失败', '没能读出这个文件，换一个再试。');
        input.remove();
      };
      reader.readAsText(file);
    });
    document.body.appendChild(input);
    input.click();
  }

  /* =========================================================
     渲染与启动
     ========================================================= */

  // 切页时让内容依次浮上来。只在切换底部导航时放，筛选 / 换周这类重绘不放，
  // 否则每点一下整页都在抖。
  let pageInTimer = null;

  function playPageIn() {
    const view = $('view');
    view.classList.remove('paging');
    void view.offsetWidth;            // 强制重排，动画才会重新播一遍
    view.classList.add('paging');
    if (pageInTimer) clearTimeout(pageInTimer);
    pageInTimer = setTimeout(() => view.classList.remove('paging'), 600);
  }

  function switchTab(tab) {
    const changed = state.tab !== tab;
    state.tab = tab;
    render();
    // 滚动发生在外壳里的 #view 上，window 自己已经不再滚动了
    // （html/body 是 overflow:hidden，标签栏靠 flex 钉在屏幕底边）。
    const view = $('view');
    if (view) view.scrollTop = 0;
    window.scrollTo(0, 0);   // 兼容旧外壳/浏览器里的残留滚动位置
    if (changed) playPageIn();
  }

  function render() {
    const view = $('view');
    document.body.classList.toggle('motion-enhanced', !!store.getSettings().enhancedMotion);
    if (state.tab === 'today') view.innerHTML = renderToday();
    else if (state.tab === 'timetable') view.innerHTML = renderTimetable();
    else if (state.tab === 'schedule') view.innerHTML = renderSchedule();
    else if (state.tab === 'countdown') view.innerHTML = renderCountdown();
    else view.innerHTML = renderSettings();

    // 系统若开着 12 小时制，原生时间控件会显示成「上午/下午」，
    // 这里统一替换成始终 24 小时制的只读显示。
    ui.enhanceTimeInputs(view);

    Array.prototype.forEach.call($('tabbar').children, b => {
      b.classList.toggle('on', b.getAttribute('data-tab') === state.tab);
    });
  }

  /**
   * 倒数日页的秒级刷新。
   *
   * 只改那一行文字，不整页重绘——整页重绘会每秒重建 DOM，
   * 滚动位置和点击状态都会被打断，看起来就是在闪。
   */
  function tickCountdown() {
    if (state.tab !== 'countdown') return;
    const nodes = document.querySelectorAll('[data-cd-clock]');
    if (!nodes.length) return;
    const now = new Date();
    Array.prototype.forEach.call(nodes, el => {
      const id = el.getAttribute('data-cd-clock');
      const item = store.getCountdown(id);
      if (!item) return;
      el.textContent = plan.stateOf(item, now).clockText;
    });
  }

  function startCountdownTick() {
    setInterval(tickCountdown, 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tickCountdown();
    });
  }

  function tickHero() {
    if (state.tab !== 'today') return;
    const now = $('heroNow');
    const next = $('heroNext');
    if (!now || !next) return;
    now.textContent = dateUtil.nowHM();
    next.textContent = countdownText();
  }

  function startHeroTick() {
    setInterval(tickHero, 20000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tickHero();
    });
  }

  function boot() {
    store.init();
    document.body.classList.toggle('motion-enhanced', !!store.getSettings().enhancedMotion);
    bindEvents();
    ui.bindRipple();          // 按下水波纹：一次绑定，之后动态生成的按钮也有效
    reminder.on(item => ui.reminderAlert(item));
    reminder.start();
    render();
    startHeroTick();
    startCountdownTick();

    // 让首页的倒计时立刻反映真实状态
    tickHero();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  CR.app = { render: render, switchTab: switchTab, state: state, closeEdit: closeEdit };
})(window);
