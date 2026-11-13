// ============================ НАСТРОЙКИ ============================

// Адрес приёма заявок (веб-приложение Google Apps Script из файла lead-backend.gs).
// Пока пусто — форма работает «по-старому»: копирует текст заявки и открывает Instagram.
const LEAD_ENDPOINT = 'https://script.google.com/macros/s/AKfycbyWRNRLP-ksQehZTHJuZACTFzVcOrNG86TgpkrWcdW-zAUeGaYDZwIQ7IKnHfy1joSIrw/exec';

// Преподаватели (имена должны совпадать с lead-backend.gs). Появляются в форме записи и в кабинете.
// Капча Cloudflare Turnstile (без картинок, обычно человек её даже не видит).
// Чтобы включить: впишите сюда «ключ сайта» (Site key) и задайте секрет в скрипте Google, см. ПОДКЛЮЧЕНИЕ-ЗАЩИТЫ.md
const TURNSTILE_SITEKEY = '';
const TEACHERS = ['Артём'];

const INSTAGRAM_URL = 'https://www.instagram.com/vector_pmr/';

// Быстрый вариант без Google-скрипта: впишите свою почту, и заявки будут приходить на неё
// через сервис FormSubmit. При самой первой заявке на почту придёт письмо со ссылкой
// «Activate» — нажмите её один раз. Вкладка «Заявки» в кабинете при этом не работает
// (ей нужен LEAD_ENDPOINT).
const LEAD_EMAIL = '';

// Если приём заявок не подключён, можно открывать вашу Google-форму вместо Instagram.
const GOOGLE_FORM_URL = '';

// Количество подписчиков на сайте. Если подключён LEAD_ENDPOINT, число обновляется автоматически (см. инструкцию),
// а это значение показывается, пока оно не загрузилось, и если Instagram недоступен.
const FOLLOWERS = 309;
// Для автоматического счётчика: адрес сервиса, который отдаёт JSON вида {"followers": 321}.
const FOLLOWERS_API = '';

// ============================ ОБЩЕЕ ============================

function showFollowers(n) {
  document.querySelectorAll('[data-followers]').forEach(el => (el.textContent = n));
}
showFollowers(FOLLOWERS);
if (FOLLOWERS_API) {
  fetch(FOLLOWERS_API).then(r => r.json()).then(d => { if (d && d.followers) showFollowers(d.followers); }).catch(() => {});
} else if (LEAD_ENDPOINT) {
  // число подписчиков берёт Google-скрипт (lead-backend.gs): сам спрашивает Instagram, а если не вышло, использует число, введённое в кабинете основателя
  try { const c = Number(localStorage.getItem('vector_followers')); if (c > 0) showFollowers(c); } catch (_) {}
  fetch(LEAD_ENDPOINT + '?action=followers').then(r => r.json()).then(d => {
    if (d && d.ok && d.followers > 0) {
      showFollowers(d.followers);
      try { localStorage.setItem('vector_followers', String(d.followers)); } catch (_) {}
    }
  }).catch(() => {});
}

const y = document.getElementById('year');
if (y) y.textContent = new Date().getFullYear();

// ============================ ФОРМА ЗАПИСИ ============================

const form = document.getElementById('leadForm');
if (form) {
  // список преподавателей в форме
  const sel = form.querySelector('#teacher');
  if (sel) {
    sel.innerHTML = '<option value="">Любой преподаватель</option>' +
      TEACHERS.map(t => '<option value="' + t + '">' + t + '</option>').join('');
    if (TEACHERS.length < 2) {
      sel.value = TEACHERS[0] || '';
      const fld = sel.closest('.field');
      if (fld) fld.hidden = true;
    }
  }

  // подставляем выбор из ссылки: signup.html?goal=exam&teacher=Артём
  const p = new URLSearchParams(location.search);
  const goalMap = { school: 'Подтянуть школьную математику', exam: 'Подготовиться к экзамену' };
  const fmtMap = { solo: 'Индивидуально', pair: 'В паре', group: 'Мини-группа' };
  if (p.get('goal') && goalMap[p.get('goal')]) {
    const r = [...form.querySelectorAll('input[name="goal"]')].find(i => i.value === goalMap[p.get('goal')]);
    if (r) r.checked = true;
  }
  if (p.get('format') && fmtMap[p.get('format')]) {
    const r = [...form.querySelectorAll('input[name="format"]')].find(i => i.value === fmtMap[p.get('format')]);
    if (r) r.checked = true;
  }
  if (p.get('teacher') && sel && TEACHERS.indexOf(p.get('teacher')) >= 0) sel.value = p.get('teacher');

  // список преподавателей берём с сервера (его ведёт основатель); если сервер недоступен, остаётся список из этого файла
  function refreshTeachers() {
    if (!sel) return;
    const want = sel.value || p.get('teacher') || '';
    sel.innerHTML = '<option value="">Любой преподаватель</option>' +
      TEACHERS.map(t => '<option value="' + t + '">' + t + '</option>').join('');
    const fld = sel.closest('.field');
    if (TEACHERS.length < 2) { sel.value = TEACHERS[0] || ''; if (fld) fld.hidden = true; }
    else { if (fld) fld.hidden = false; if (TEACHERS.indexOf(want) >= 0) sel.value = want; }
  }
  if (LEAD_ENDPOINT && sel) {
    fetch(LEAD_ENDPOINT + '?action=teachers&_=' + Date.now(), { cache: 'no-store' }).then(r => r.json()).then(d => {
      if (d && d.ok && Array.isArray(d.teachers) && d.teachers.length) {
        TEACHERS.length = 0; d.teachers.forEach(t => TEACHERS.push(String(t))); refreshTeachers();
      }
    }).catch(() => {});
  }

  // одноразовый токен отправки: защита от ботов, которые шлют заявки вслепую
  let tokenP = null, tokenAt = 0;
  function getToken() {
    if (!LEAD_ENDPOINT) return Promise.resolve(null);
    if (!tokenP) {
      tokenAt = Date.now();
      tokenP = fetch(LEAD_ENDPOINT + '?action=token&_=' + Date.now(), { cache: 'no-store' })
        .then(r => r.json()).then(d => (d && d.ok ? d.token : null)).catch(() => null);
    }
    return tokenP;
  }
  form.addEventListener('focusin', getToken, { once: true });

  // капча: подключается только если задан TURNSTILE_SITEKEY
  let tsToken = null, tsWidget = null, tsLoading = false;
  function initTurnstile() {
    if (!TURNSTILE_SITEKEY || tsLoading) return;
    tsLoading = true;
    const box = document.createElement('div');
    box.style.cssText = 'margin:8px 0 0';
    const submit = form.querySelector('button[type=submit]');
    submit.parentNode.insertBefore(box, submit);
    const sc = document.createElement('script');
    sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    sc.async = true; sc.defer = true;
    sc.onload = function () {
      tsWidget = window.turnstile.render(box, {
        sitekey: TURNSTILE_SITEKEY, appearance: 'interaction-only', language: 'ru',
        callback: function (t) { tsToken = t; },
        'expired-callback': function () { tsToken = null; },
        'error-callback': function () { tsToken = null; }
      });
    };
    document.head.appendChild(sc);
  }
  form.addEventListener('focusin', initTurnstile, { once: true });
  async function waitCaptcha() {
    if (!TURNSTILE_SITEKEY) return null;
    for (let i = 0; i < 40 && !tsToken; i++) await new Promise(r => setTimeout(r, 250)); // ждём до 10 секунд
    return tsToken;
  }

  const btn = form.querySelector('button[type=submit]');
  const note = document.getElementById('formNote');
  const ok = document.getElementById('ok');
  const direct = !!(LEAD_ENDPOINT || LEAD_EMAIL);
  const btnLabel = direct ? 'Отправить заявку' : 'Подготовить заявку';
  btn.innerHTML = btnLabel + '&nbsp; ➜';
  if (note) {
    note.textContent = direct
      ? 'Заявка сразу придёт преподавателю, и он свяжется с тобой по указанному контакту.'
      : 'Откроется Instagram, а текст заявки скопируется. Вставь его в сообщение и отправь.';
  }

  function showMsg(text, bad) {
    if (!ok) return;
    ok.textContent = text;
    ok.classList.toggle('bad', !!bad);
    ok.classList.add('show');
  }

  function buildText(f) {
    const lines = [
      'Здравствуйте! Хочу записаться на занятие по математике.',
      'Имя: ' + f.name,
      'Класс: ' + f.grade,
      'Цель: ' + (f.goal || '—'),
      'Формат: ' + (f.format || '—'),
      'Удобное время: ' + (f.time || '—'),
      'Контакт: ' + (f.contact || '—')
    ];
    if (f.teacher) lines.push('Преподаватель: ' + f.teacher);
    if (f.comment) lines.push('Комментарий: ' + f.comment);
    return lines.join('\n');
  }

  async function fallback(f) {
    let copied = false;
    try { await navigator.clipboard.writeText(buildText(f)); copied = true; } catch (_) {}
    window.open(GOOGLE_FORM_URL || INSTAGRAM_URL, '_blank', 'noopener');
    showMsg(copied
      ? 'Текст заявки скопирован. Вставьте его в сообщение — мы ответим как можно скорее!'
      : 'Не удалось скопировать автоматически. Напишите нам в Instagram: класс, цель и удобное время.');
    btn.innerHTML = (copied ? 'Заявка скопирована ✓' : 'Откройте Instagram и напишите нам');
    setTimeout(() => (btn.innerHTML = btnLabel + '&nbsp; ➜'), 4500);
  }

  let sending = false;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    if (sending) return;
    const d = new FormData(this);
    const f = {
      name: String(d.get('name') || '').trim(),
      grade: d.get('grade') || '',
      goal: d.get('goal') || '',
      format: d.get('format') || '',
      time: String(d.get('time') || '').trim(),
      contact: String(d.get('contact') || '').trim(),
      teacher: d.get('teacher') || '',
      comment: String(d.get('comment') || '').trim(),
      website: d.get('website') || ''
    };

    if (!direct) return fallback(f);

    sending = true;
    btn.disabled = true;
    btn.textContent = 'Отправляем…';
    if (ok) ok.classList.remove('show');
    try {
      if (LEAD_ENDPOINT) {
        const token = await getToken();
        tokenP = null; // токен одноразовый
        if (!token) throw new Error('token');
        const wait = 2300 - (Date.now() - tokenAt); // сервер отсекает отправку быстрее 2 секунд после открытия формы
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        const ts = await waitCaptcha();
        const body = Object.assign({ action: 'lead', token: token, ts: ts || '', page: location.pathname.split('/').pop() }, f);
        let url = LEAD_ENDPOINT + '?action=do&payload=' + encodeURIComponent(JSON.stringify(body));
        if (url.length > 6500) { body.comment = String(body.comment || '').slice(0, 120); url = LEAD_ENDPOINT + '?action=do&payload=' + encodeURIComponent(JSON.stringify(body)); }
        // читаем настоящий ответ сервера: так видно и отказ (слишком много заявок, плохие данные)
        const out = await fetch(url, { cache: 'no-store' }).then(r => r.json());
        if (tsWidget !== null && window.turnstile) { try { window.turnstile.reset(tsWidget); } catch (e) {} tsToken = null; }
        if (!out || !out.ok) throw new Error((out && out.error) || 'fail');
      } else {
        // запасной вариант: письмо на LEAD_EMAIL через FormSubmit
        const res = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(LEAD_EMAIL), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({
            _subject: 'Новая заявка VECTOR: ' + f.name,
            _template: 'table',
            _captcha: 'false',
            _honey: f.website,
            'Имя': f.name, 'Класс': f.grade, 'Цель': f.goal || '—', 'Формат': f.format || '—',
            'Удобное время': f.time || '—', 'Контакт': f.contact,
            'Преподаватель': f.teacher || 'любой', 'Комментарий': f.comment || '—'
          })
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || String(out.success) === 'false') throw new Error('mail');
      }
      showMsg('Заявка отправлена! Преподаватель свяжется с тобой по указанному контакту.');
      this.reset();
      if (sel) sel.value = TEACHERS.length < 2 ? (TEACHERS[0] || '') : '';
      btn.textContent = 'Отправлено ✓';
    } catch (err) {
      const code = String(err && err.message);
      showMsg(code === 'busy'
        ? 'Сейчас приходит очень много заявок. Попробуйте через несколько минут или напишите нам в Instagram.'
        : (code === 'captcha' ? 'Не получилось подтвердить, что вы не робот. Обновите страницу и попробуйте ещё раз или напишите нам в Instagram.'
        : code === 'bad' ? 'Проверьте имя и контакт: без ссылок и лишних символов.'
        : 'Не получилось отправить заявку. Проверьте интернет или напишите нам в Instagram.'), true);
      btn.textContent = 'Не отправилось';
    }
    setTimeout(() => {
      sending = false;
      btn.disabled = false;
      btn.innerHTML = btnLabel + '&nbsp; ➜';
    }, 3500);
  });
}


// ===================== Быстрая запись: короткая форма (имя, класс, контакт) =====================
(function () {
  const ERR = {
    busy: 'Сейчас приходит очень много заявок. Попробуйте через несколько минут или напишите нам в Instagram.',
    captcha: 'Не получилось подтвердить, что вы не робот. Обновите страницу и попробуйте ещё раз или напишите нам в Instagram.',
    bad: 'Проверьте имя и контакт: без ссылок и лишних символов.',
    fail: 'Не получилось отправить. Проверьте интернет или напишите нам в Instagram.'
  };
  let tsAsked = false;
  function loadTurnstile(cb) {
    if (window.turnstile) return cb();
    if (!tsAsked) {
      tsAsked = true;
      const sc = document.createElement('script');
      sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      sc.async = true;
      document.head.appendChild(sc);
    }
    const t = setInterval(function () { if (window.turnstile) { clearInterval(t); cb(); } }, 200);
  }

  function initQform(el) {
    if (el.dataset.ready) return;
    el.dataset.ready = '1';
    const btn = el.querySelector('button[type=submit]');
    const msg = el.querySelector('.qmsg');
    const tsBox = el.querySelector('.qts');
    const label = btn.innerHTML;
    let tokenP = null, tokenAt = 0, tsToken = null, tsWidget = null, sending = false;

    function getToken() {
      if (!LEAD_ENDPOINT) return Promise.resolve(null);
      if (!tokenP) {
        tokenAt = Date.now();
        tokenP = fetch(LEAD_ENDPOINT + '?action=token&_=' + Date.now(), { cache: 'no-store' })
          .then(r => r.json()).then(d => (d && d.ok ? d.token : null)).catch(() => null);
      }
      return tokenP;
    }
    function initTs() {
      if (!TURNSTILE_SITEKEY || !tsBox || tsWidget !== null) return;
      tsWidget = -1;
      loadTurnstile(function () {
        tsWidget = window.turnstile.render(tsBox, {
          sitekey: TURNSTILE_SITEKEY, appearance: 'interaction-only', language: 'ru',
          callback: function (t) { tsToken = t; },
          'expired-callback': function () { tsToken = null; },
          'error-callback': function () { tsToken = null; }
        });
      });
    }
    el.addEventListener('focusin', function () { getToken(); initTs(); }, { once: true });

    function show(text, bad) {
      msg.textContent = text;
      msg.classList.toggle('bad', !!bad);
      msg.classList.add('show');
    }

    el.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (sending) return;
      const fd = new FormData(el);
      const f = {
        name: String(fd.get('name') || '').trim(),
        grade: String(fd.get('grade') || ''),
        contact: String(fd.get('contact') || '').trim(),
        website: String(fd.get('website') || ''),
        goal: '', format: '', time: '', teacher: '', comment: 'Быстрая запись'
      };
      if (f.name.length < 2 || !f.grade || f.contact.length < 4) {
        show('Заполни имя, класс и контакт: телефон или @ник в Instagram.', true);
        return;
      }
      if (!LEAD_ENDPOINT) { location.href = 'signup.html'; return; }
      sending = true;
      btn.disabled = true;
      btn.textContent = 'Отправляем…';
      msg.classList.remove('show');
      try {
        const token = await getToken();
        tokenP = null; // токен одноразовый
        if (!token) throw new Error('token');
        const wait = 2300 - (Date.now() - tokenAt);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        let ts = '';
        if (TURNSTILE_SITEKEY) {
          for (let i = 0; i < 40 && !tsToken; i++) await new Promise(r => setTimeout(r, 250));
          ts = tsToken || '';
        }
        const body = Object.assign({ action: 'lead', token: token, ts: ts, page: location.pathname.split('/').pop() + '#quick' }, f);
        const out = await fetch(LEAD_ENDPOINT + '?action=do&payload=' + encodeURIComponent(JSON.stringify(body)), { cache: 'no-store' }).then(r => r.json());
        if (tsWidget !== null && tsWidget !== -1 && window.turnstile) { try { window.turnstile.reset(tsWidget); } catch (_) {} tsToken = null; }
        if (!out || !out.ok) throw new Error((out && out.error) || 'fail');
        show('Заявка отправлена! Мы свяжемся с тобой по указанному контакту.');
        el.reset();
        btn.textContent = 'Отправлено ✓';
        el.dispatchEvent(new CustomEvent('qsent'));
      } catch (err) {
        show(ERR[String(err && err.message)] || ERR.fail, true);
        btn.textContent = 'Не отправилось';
      }
      setTimeout(function () { sending = false; btn.disabled = false; btn.innerHTML = label; }, 3500);
    });
  }

  const forms = document.querySelectorAll('[data-qform]');
  forms.forEach(initQform);

  // плавающая кнопка «Быстрая запись» (на компьютерах; на телефонах есть нижнее меню)
  if (forms.length) {
    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.type = 'button';
    fab.innerHTML = 'Быстрая запись&nbsp; ➜';
    document.body.appendChild(fab);

    const dlg = document.createElement('dialog');
    dlg.className = 'qdlg';
    dlg.innerHTML = '<div class="qdlg-box"><button class="qdlg-x" type="button" aria-label="Закрыть">×</button>' +
      '<h3>Быстрая запись</h3><p>Оставь имя, класс и контакт. Первое занятие бесплатно.</p></div>';
    const clone = forms[0].cloneNode(true);
    delete clone.dataset.ready;
    clone.querySelectorAll('.qmsg').forEach(m => { m.className = 'qmsg'; m.textContent = ''; });
    clone.querySelectorAll('.qts').forEach(m => { m.innerHTML = ''; });
    dlg.firstChild.appendChild(clone);
    document.body.appendChild(dlg);
    initQform(clone);

    let off = false;
    try { off = sessionStorage.getItem('fabOff') === '1'; } catch (_) {}
    function hideFab() { off = true; fab.classList.remove('show'); try { sessionStorage.setItem('fabOff', '1'); } catch (_) {} }
    function maybeShow() {
      if (off || dlg.open) return;
      const y = window.scrollY || document.documentElement.scrollTop;
      const q = document.getElementById('quick');
      const nearForm = q && q.getBoundingClientRect().top < window.innerHeight; // форма уже на экране, кнопка не нужна
      fab.classList.toggle('show', y > 420 && !nearForm);
    }
    window.addEventListener('scroll', maybeShow, { passive: true });
    setTimeout(maybeShow, 800);
    fab.addEventListener('click', function () { fab.classList.remove('show'); dlg.showModal(); });
    dlg.querySelector('.qdlg-x').addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('close', maybeShow);
    clone.addEventListener('qsent', function () { hideFab(); setTimeout(function () { if (dlg.open) dlg.close(); }, 2600); });
    forms[0].addEventListener('qsent', hideFab);
  }
})();
