/**
 * 界面基础件：提示条、对话框、底部菜单、提醒弹窗
 * 对应小程序里的 wx.showToast / wx.showModal / wx.showActionSheet。
 */

(function (global) {
  'use strict';

  const CR = global.CR;

  /* ---------------- 提示条 ---------------- */

  let toastTimer = null;

  function toast(message, ms) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('on');
      toastTimer = null;
    }, ms || 1800);
  }

  /* ---------------- 关闭动画 ---------------- */

  /**
   * 让弹层带着退场动画再消失。
   * 逻辑上已经「关闭」了（Promise 立刻 resolve），只是视觉上让它滑回去，
   * 免得啪一下不见、像是闪退。setTimeout 是兜底：系统开了「减弱动效」时
   * animationend 不会来，不能把元素永远留在页面上。
   */
  function dismiss(el, after) {
    if (!el) return;
    el.classList.add('closing');
    let done = false;
    function finish() {
      if (done) return;
      done = true;
      if (el.parentNode) el.parentNode.removeChild(el);
      if (after) after();
    }
    el.addEventListener('animationend', finish);
    setTimeout(finish, 400);
  }

  /* ---------------- 按下水波纹 ---------------- */

  const RIPPLE_HOST = '.btn, .quick-btn, .sheet-item, .dialog-btn, .item, .tt-block,'
    + '.chip, .tab-item, .week-nav, .notice-btn, .panel-link, .tab';

  let rippleBound = false;

  function spawnRipple(host, e) {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const size = Math.max(rect.width, rect.height) * 1.9;
    const x = (e.clientX == null ? rect.left + rect.width / 2 : e.clientX) - rect.left;
    const y = (e.clientY == null ? rect.top + rect.height / 2 : e.clientY) - rect.top;

    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.width = size + 'px';
    span.style.height = size + 'px';
    span.style.left = (x - size / 2) + 'px';
    span.style.top = (y - size / 2) + 'px';
    host.appendChild(span);

    let gone = false;
    function drop() {
      if (gone) return;
      gone = true;
      if (span.parentNode) span.parentNode.removeChild(span);
    }
    span.addEventListener('animationend', drop);
    setTimeout(drop, 800);
  }

  function bindRipple() {
    if (rippleBound) return;
    rippleBound = true;
    // 用捕获阶段：手指刚落下就出涟漪，不等 click
    document.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const t = e.target;
      if (!t || !t.closest) return;
      const host = t.closest(RIPPLE_HOST);
      if (!host || host.disabled) return;
      spawnRipple(host, e);
    }, true);
  }

  /* ---------------- 对话框 ---------------- */

  function dialog(opts) {
    const o = Object.assign({
      title: '',
      body: '',
      confirmText: '确定',
      cancelText: '取消',
      danger: false,
      showCancel: true
    }, opts || {});

    return new Promise(resolve => {
      const host = document.getElementById('modalRoot') || document.body;
      const wrap = document.createElement('div');
      wrap.className = 'mask on';
      wrap.innerHTML =
        '<div class="dialog" role="dialog" aria-modal="true">'
        + (o.title ? '<div class="dialog-title"></div>' : '')
        + (o.body ? '<div class="dialog-body"></div>' : '')
        + '<div class="dialog-actions">'
        + (o.showCancel ? '<button class="dialog-btn" data-act="cancel"></button>' : '')
        + '<button class="dialog-btn strong" data-act="confirm"></button>'
        + '</div></div>';

      // 用 textContent 填文字，避免内容里的尖括号被当成 HTML
      if (o.title) wrap.querySelector('.dialog-title').textContent = o.title;
      if (o.body) wrap.querySelector('.dialog-body').textContent = o.body;
      if (o.showCancel) wrap.querySelector('[data-act="cancel"]').textContent = o.cancelText;
      const okBtn = wrap.querySelector('[data-act="confirm"]');
      okBtn.textContent = o.confirmText;
      if (o.danger) okBtn.classList.add('danger');

      function close(result) {
        dismiss(wrap);
        resolve(result);
      }

      wrap.addEventListener('click', e => {
        if (wrap.classList.contains('closing')) return;   // 正在退场，别重复关
        const act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'confirm') close(true);
        else if (act === 'cancel') close(false);
        else if (e.target === wrap && o.showCancel) close(false);
      });

      host.appendChild(wrap);
    });
  }

  function alertBox(title, body) {
    return dialog({ title: title, body: body, showCancel: false, confirmText: '知道了' });
  }

  /* ---------------- 底部菜单 ---------------- */

  function sheet(items) {
    return new Promise(resolve => {
      const host = document.getElementById('sheetRoot');
      const mask = document.getElementById('maskRoot');
      const wrap = document.createElement('div');
      wrap.className = 'sheet on';
      wrap.innerHTML = '<div class="sheet-inner"></div>';
      const inner = wrap.querySelector('.sheet-inner');

      items.forEach((it, i) => {
        const b = document.createElement('button');
        b.className = 'sheet-item' + (it.danger ? ' danger' : '') + (it.primary ? ' primary' : '');
        b.textContent = it.text;
        b.addEventListener('click', () => close(i));
        inner.appendChild(b);
      });

      mask.classList.add('on');

      function close(index) {
        mask.classList.add('closing');
        mask.onclick = null;
        dismiss(wrap, () => {
          mask.classList.remove('on');
          mask.classList.remove('closing');
        });
        resolve(index);
      }

      mask.onclick = () => close(-1);
      host.appendChild(wrap);
    });
  }

  /* ---------------- 提醒弹窗 ---------------- */

  let alertOpen = false;

  function reminderAlert(item) {
    if (alertOpen) return;
    alertOpen = true;

    const host = document.getElementById('modalRoot') || document.body;
    const wrap = document.createElement('div');
    wrap.className = 'mask on';

    const remain = Number(item.remainMinutes);
    const remainText = remain > 0
      ? '还有约 ' + remain + ' 分钟'
      : (remain === 0 ? '现在开始' : '已开始 ' + Math.abs(remain) + ' 分钟');

    wrap.innerHTML =
      '<div class="alert-card">'
      + '<div class="alert-top">'
      + '<div class="alert-kicker"></div>'
      + '<div class="alert-name"></div>'
      + '<div class="alert-time"></div>'
      + '<div class="alert-note"></div>'
      + '</div>'
      + '<div class="alert-bar"></div>'
      + '<div class="dialog-actions">'
      + '<button class="dialog-btn" data-act="snooze">5 分钟后再提醒</button>'
      + '<button class="dialog-btn strong" data-act="ok">知道了</button>'
      + '</div></div>';

    wrap.querySelector('.alert-kicker').textContent =
      (item.typeText || '') + ' · ' + remainText;
    wrap.querySelector('.alert-name').textContent = item.title;
    wrap.querySelector('.alert-time').textContent =
      item.startTime + (item.endTime ? ' ~ ' + item.endTime : '') + (item.subtitle ? ' · ' + item.subtitle : '');
    const noteEl = wrap.querySelector('.alert-note');
    if (item.note) noteEl.textContent = item.note;
    else noteEl.style.display = 'none';
    wrap.querySelector('.alert-bar').style.background = item.color || '#378ADD';

    function close(snooze) {
      dismiss(wrap);
      alertOpen = false;
      if (snooze) {
        CR.reminder.snooze(item, 5);
        toast('5 分钟后再提醒你');
      }
    }

    wrap.addEventListener('click', e => {
      if (wrap.classList.contains('closing')) return;
      const act = e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'ok') close(false);
      else if (act === 'snooze') close(true);
    });

    host.appendChild(wrap);

    // 震动之外再补一次视觉强调（部分设备 navigator.vibrate 不生效）
    try {
      if (navigator.vibrate && CR.store.getSettings().vibrate) navigator.vibrate([120, 60, 120]);
    } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 24 小时制时间选择 ---------------- */

  /**
   * 给页面上所有 <input type="time"> 做一次「24 小时制」处理。
   *
   * 为什么需要：<input type="time"> 的显示格式完全由系统的 12/24 小时设置决定，
   * 手机若开了「12 小时制」，控件就显示成 上午/下午 —— 网页改不了。
   * 所以读值一律改用 getHours()/getMinutes()（永远 24 小时）自己拼，
   * 显示上再放一个只读文本框盖住原生控件：
   *   - 原生控件仍保留尺寸、可点、仍负责弹系统时间选择器（不牺牲原生体验）；
   *   - 只读框 100% 显示 'HH:MM'，不受系统设置影响；
   *   - 点只读框时把它藏起来让原生控件接管，失焦后再盖回来。
   *
   * 同一元素重复调用也不会叠加监听（用 WeakSet 记账）。
   */
  const enhancedTimeInputs = new WeakSet();

  /** Date -> 'HH:MM'，永远 24 小时制，不经过 toLocaleTimeString */
  function hhmm(d) {
    return (d.getHours() < 10 ? '0' : '') + d.getHours()
      + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
  }

  /**
   * 读一个 time 输入框的值，返回 'HH:MM'（24 小时制）。
   *
   * 只用 input.value，**绝对不要用 valueAsDate**——已实测：本机时区 UTC+8 下
   * valueAsDate 会整体偏移 +8 小时（设 '21:30' 读出来是次日 05:30），
   * 拿它来显示会把下午的时间显示成凌晨。
   *
   * 而 input.value 在任何 12/24 制下都稳定返回 'HH:MM' 字符串
   * （12 小时制只影响**控件的外观**，不影响 .value）。所以：
   *   显示用 .value 取 24 小时文本，外观交给上层只读框。
   */
  function inputValue24(input) {
    if (!input) return '';
    const raw = String(input.value || '');
    const m = raw.match(/(\d{1,2}):(\d{2})/);   // '21:30' / '21:30:00'
    if (m) return (Number(m[1]) < 10 ? '0' : '') + Number(m[1]) + ':' + m[2];
    return raw;
  }

  function enhanceTimeInput(input) {
    if (!input || input.type !== 'time' || enhancedTimeInputs.has(input)) return;
    const parent = input.parentNode;
    if (!parent) return;
    enhancedTimeInputs.add(input);

    // 包一层定位容器：只读显示框绝对定位盖在原生控件上面（z-index 更高），
    // 原生控件留在下面当透明的点击层。顺序很重要——如果只读框在下面，
    // 手机的触摸命中还是会落到原生控件上。
    const wrap = document.createElement('span');
    wrap.className = 'time24-wrap';
    parent.insertBefore(wrap, input);
    wrap.appendChild(input);

    const display = document.createElement('input');
    display.type = 'text';
    display.readOnly = true;
    display.tabIndex = -1;
    display.className = 'time24-view';
    display.setAttribute('aria-hidden', 'true');
    wrap.appendChild(display);
    input.classList.add('time24-native');

    function sync() {
      display.value = inputValue24(input);   // 只读不写，显示 24 小时文本
    }

    // 把 sync 挂到元素上：**代码里直接写 input.value 不会触发 input/change 事件**，
    // 覆盖层就会停在旧值上、露出下面原生控件的 12 小时文本。
    // 凡是绕过事件直接赋值的地方，赋值后调一下 ui.refreshTimeInput(el) 即可。
    input.__crTime24Sync = sync;

    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    input.addEventListener('focus', () => input.classList.add('time24-open'));
    input.addEventListener('blur', () => {
      input.classList.remove('time24-open');
      sync();
    });

    display.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();              // 别让点击再冒泡到原生控件
      input.classList.add('time24-open');
      try { input.showPicker(); }
      catch (err) { try { input.focus(); } catch (e2) {} }
    });

    sync();
  }

  /** 把 root（默认整个文档）里所有 time 输入框都增强一遍；动态渲染后调用 */
  function enhanceTimeInputs(root) {
    const scope = root || document;
    const list = scope.querySelectorAll ? scope.querySelectorAll('input[type="time"]') : [];
    for (let i = 0; i < list.length; i++) enhanceTimeInput(list[i]);
  }

  /**
   * 代码里**直接给 time 输入框赋值**（`el.value = '22:30'`）之后必须调这个，
   * 否则上层的 24 小时只读显示不会跟着变，用户会看到下面原生控件的 12 小时文本。
   *
   * 为什么不直接在 app.js 里派发 input 事件：
   *   派发事件会走一遍面板的 change/input 监听，那里面会再次写 form 字段，
   *   等于绕一圈拿旧值覆盖新值。这里只刷新显示层，不碰业务状态，最安全。
   */
  function refreshTimeInput(el) {
    if (!el) return;
    if (typeof el.__crTime24Sync === 'function') el.__crTime24Sync();
  }

  /** 刷新 root 下所有 time 输入框的只读显示层（不改值，只同步外观） */
  function refreshTimeInputs(root) {
    const scope = root || document;
    const list = scope.querySelectorAll ? scope.querySelectorAll('input[type="time"]') : [];
    for (let i = 0; i < list.length; i++) refreshTimeInput(list[i]);
  }

  CR.ui = {
    toast: toast,
    dialog: dialog,
    alert: alertBox,
    sheet: sheet,
    reminderAlert: reminderAlert,
    bindRipple: bindRipple,
    enhanceTimeInputs: enhanceTimeInputs,
    refreshTimeInput: refreshTimeInput,
    refreshTimeInputs: refreshTimeInputs,
    hhmm: hhmm,
    inputValue24: inputValue24
  };
})(window);
