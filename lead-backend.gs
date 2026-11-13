/**
 * VECTOR — заявки, кабинет преподавателя и кабинет основателя.
 * Вставьте этот код в Google Apps Script (script.google.com) вместо старого и обновите развёртывание:
 * Развернуть → Управление развёртываниями → карандаш → Версия: Новая → Развернуть.
 *
 * Что нового (версия 4):
 *  • у каждого преподавателя свой код доступа; основатель добавляет преподавателей в своём кабинете
 *  • код хранится в таблице только в виде хэша, его нельзя прочитать даже в Google-таблице
 *  • преподаватель может сменить код на свой (кабинет → «Сменить код»)
 *  • преподаватель видит и меняет ТОЛЬКО свои занятия и свои заявки
 *  • защита от потока заявок: лимиты, одноразовые токены, защита от подбора кодов
 *  • (необязательно) капча Cloudflare Turnstile: включается свойством скрипта TURNSTILE_SECRET
 *  • ежедневный резерв данных внутри самой таблицы (лист «Резерв»), почти не занимает места
 */

// ===================== НАСТРОЙКИ (заполните) =====================

// Ключ основателя: открывает сводку по ВСЕМ преподавателям и деньгам.
// ВАЖНО: замените на свой длинный пароль (от 12 символов), старый уже засветился. Лучше всего задать его
// в «Настройки проекта» → «Свойства скрипта» под именем FOUNDER_KEY, тогда его не будет в коде.
const FOUNDER_KEY = 'vectorpmrteachershub';

// Ваш процент с занятий преподавателей (0-100).
const FOUNDER_PERCENT = 30;

// Цена за ЧАС с одного человека, ₽. Занятие считается так: цена × человек × часы.
const PRICES = { 'Индивидуально': 100, 'В паре': 70, 'Мини-группа': 50 };

// Преподаватели, которые заводятся автоматически ОДИН РАЗ при первом запуске новой версии.
// Дальше всё делается в кабинете основателя (добавить, выдать новый код, отключить).
// Коды им при этом не выдаются: откройте кабинет основателя и нажмите «Новый код» у каждого.
const SEED_TEACHERS = {
  'Артём': { email: 'email-artema@example.com', telegramChatId: '' }
};

// Защита от наплыва заявок. Если когда-нибудь честных заявок станет больше, поднимите числа.
const LIMITS = {
  perMinute: 6,        // всего заявок в минуту на весь сайт
  perHour: 30,         // всего заявок в час
  perDay: 120,         // всего заявок в сутки
  contactPer6h: 3,     // заявок с одного контакта за 6 часов
  notifyPerHour: 15,   // писем и сообщений в Telegram в час (чтобы не выбрать дневную квоту Google)
  legacyPerHour: 10,   // заявок в час от старых страниц без токена
  tokensPerMinute: 120,// выданных токенов в минуту
  loginFailsLock: 40   // неудачных попыток ввода кода за 10 минут, после чего вход блокируется на время
};

// Токен Telegram-бота от @BotFather (необязательно, можно оставить пустым).
// Токен и chat id лучше задать в «Настройки проекта» → «Свойства скрипта»:
//   TELEGRAM_BOT_TOKEN — токен бота
//   TELEGRAM_CHAT_ID   — ваш chat id (используется, если у преподавателя свой не указан)
const TELEGRAM_BOT_TOKEN = '';
function tgToken_() {
  return PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN') || TELEGRAM_BOT_TOKEN;
}
function tgChat_(t) {
  return String((t && t.telegram) || PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID') || '');
}

// Если ученик не выбрал преподавателя, заявка уходит ВСЕМ активным преподавателям.

// ===================== ДАЛЬШЕ НИЧЕГО МЕНЯТЬ НЕ НУЖНО =====================

const SHEET_NAME = 'Заявки';
const HEADERS = ['id', 'created', 'name', 'grade', 'goal', 'format', 'time', 'contact', 'teacher', 'comment', 'status', 'page'];
const SCRIPT_VERSION = 4;
const IG_USERNAME = 'vector_pmr';
const L_SHEET = 'Занятия';
const L_HEADERS = ['id', 'date', 'teacher', 'student', 'format', 'people', 'hours', 'amount', 'note', 'created', 'time', 'done', 'paid'];
const P_SHEET = 'Выплаты';
const P_HEADERS = ['id', 'date', 'teacher', 'amount', 'note', 'created'];
const T_SHEET = 'Преподаватели';
const T_HEADERS = ['id', 'name', 'email', 'telegram', 'salt', 'hash', 'active', 'created'];
const STATUSES = ['новая', 'в работе', 'записан', 'закрыта'];

// ---------- общее ----------

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet() || createSpreadsheet_();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function createSpreadsheet_() {
  // Скрипт, созданный не из таблицы, сам заводит таблицу «VECTOR — заявки».
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create('VECTOR — заявки');
  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function clean_(v, max) {
  v = (v === undefined || v === null) ? '' : String(v);
  v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return v.slice(0, max || 300);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { ok: false, error: 'busy' };
  try { return fn(); } finally { lock.releaseLock(); }
}

function bump_(key, ttl) {
  const c = CacheService.getScriptCache();
  const n = (Number(c.get(key)) || 0) + 1;
  c.put(key, String(n), ttl);
  return n;
}
function bucket_(name, sec) { return name + '_' + Math.floor(Date.now() / (sec * 1000)); }

function readRows_(sh, headers) {
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues().map(function (r) {
    const o = {};
    headers.forEach(function (h, i) {
      let v = r[i];
      if (v instanceof Date) v = h === 'date' ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : v.toISOString();
      o[h] = String(v === undefined ? '' : v);
    });
    return o;
  }).filter(function (o) { return o.id; });
}

// ---------- коды доступа и вход ----------

function founderKey_() {
  return PropertiesService.getScriptProperties().getProperty('FOUNDER_KEY') || FOUNDER_KEY;
}
function founderOk_(key) {
  const fk = founderKey_();
  return fk.length >= 8 && String(key || '') === fk;
}

function normCode_(c) { return String(c == null ? '' : c).toUpperCase().replace(/[\s\-_]/g, ''); }
function isWeakCode_(n) { return n.length < 8 || n.length > 40 || /^(.)\1+$/.test(n); }

function hash_(salt, code) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + normCode_(code), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// Случайный код вида K7M2Q-9XH4P (без похожих символов 0/O, 1/I/L)
function genCode_() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const u = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  let s = '';
  for (let i = 0; i < 10; i++) s += A.charAt(parseInt(u.substr(i * 2, 2), 16) % A.length);
  return s.slice(0, 5) + '-' + s.slice(5);
}

function teachersSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet() || createSpreadsheet_();
  let sh = ss.getSheetByName(T_SHEET);
  if (!sh) {
    sh = ss.insertSheet(T_SHEET);
    sh.appendRow(T_HEADERS);
    sh.setFrozenRows(1);
    seedTeachers_(sh);
  }
  return sh;
}

function appendTeacherRow_(sh, row) {
  const rng = sh.getRange(sh.getLastRow() + 1, 1, 1, T_HEADERS.length);
  rng.setNumberFormat('@');
  rng.setValues([T_HEADERS.map(function (h) { return String(row[h] === undefined ? '' : row[h]); })]);
}

function seedTeachers_(sh) {
  Object.keys(SEED_TEACHERS).forEach(function (name) {
    const t = SEED_TEACHERS[name] || {};
    const salt = Utilities.getUuid();
    appendTeacherRow_(sh, {
      id: Utilities.getUuid().slice(0, 8), name: name,
      email: (t.email && t.email.indexOf('example.com') < 0) ? t.email : '',
      telegram: t.telegramChatId || '', salt: salt, hash: hash_(salt, genCode_()), // код неизвестен: выдайте новый в кабинете основателя
      active: '1', created: new Date().toISOString()
    });
  });
}

function readTeachers_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('teachers_all');
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  const list = readRows_(teachersSheet_(), T_HEADERS);
  try { cache.put('teachers_all', JSON.stringify(list), 300); } catch (e) {}
  return list;
}
function dropTeacherCache_() {
  const c = CacheService.getScriptCache();
  c.remove('teachers_all');
  c.remove('pub_teachers');
}
function findTeacher_(name) {
  name = String(name || '').toLowerCase();
  const l = readTeachers_();
  for (let i = 0; i < l.length; i++) if (l[i].name.toLowerCase() === name) return l[i];
  return null;
}
function teacherNames_(activeOnly) {
  return readTeachers_().filter(function (t) { return !activeOnly || t.active === '1'; }).map(function (t) { return t.name; });
}
function findTeacherByCode_(code) {
  const l = readTeachers_();
  for (let i = 0; i < l.length; i++) {
    const t = l[i];
    if (t.active === '1' && t.salt && t.hash && hash_(t.salt, code) === t.hash) return t;
  }
  return null;
}

function updateTeacher_(name, fields) {
  const sh = teachersSheet_();
  if (sh.getLastRow() < 2) return false;
  const names = sh.getRange(2, 2, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < names.length; i++) {
    if (String(names[i][0]).toLowerCase() !== String(name).toLowerCase()) continue;
    Object.keys(fields).forEach(function (h) {
      const c = sh.getRange(i + 2, T_HEADERS.indexOf(h) + 1);
      c.setNumberFormat('@');
      c.setValue(String(fields[h]));
    });
    dropTeacherCache_();
    return true;
  }
  return false;
}

// Защита от подбора кодов: после многих неудач вход ненадолго блокируется для всех
function authLocked_() { return (Number(CacheService.getScriptCache().get('auth_fail')) || 0) >= LIMITS.loginFailsLock; }
function authFail_() {
  bump_('auth_fail', 600);
  Utilities.sleep(400);
}

// Кто пришёл: {role:'founder'} | {role:'teacher', name} | {locked:true} | null
function auth_(key) {
  key = String(key == null ? '' : key);
  if (!key) return null;
  if (authLocked_()) return { locked: true };
  if (founderOk_(key)) return { role: 'founder' };
  const t = findTeacherByCode_(key);
  if (t) return { role: 'teacher', name: t.name };
  authFail_();
  return null;
}
function deny_(a) { return { ok: false, error: a && a.locked ? 'locked' : 'forbidden' }; }
function needFounder_(key) {
  const a = auth_(key);
  if (!a || a.locked) return { err: deny_(a) };
  if (a.role !== 'founder') return { err: { ok: false, error: 'forbidden' } };
  return { a: a };
}

// ---------- преподаватели (кабинет основателя) ----------

function addTeacher_(data) {
  const f = needFounder_(data.key); if (f.err) return f.err;
  const name = clean_(data.name, 40);
  if (!/^[A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9 \-.']{1,39}$/.test(name)) return { ok: false, error: 'bad_name' };
  const email = clean_(data.email, 100);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'bad_email' };
  const tg = clean_(data.telegram, 30);
  if (tg && !/^-?\d{4,20}$/.test(tg)) return { ok: false, error: 'bad_telegram' };
  return withLock_(function () {
    dropTeacherCache_();
    if (findTeacher_(name)) return { ok: false, error: 'exists' };
    const code = genCode_(), salt = Utilities.getUuid();
    appendTeacherRow_(teachersSheet_(), {
      id: Utilities.getUuid().slice(0, 8), name: name, email: email, telegram: tg,
      salt: salt, hash: hash_(salt, code), active: '1', created: new Date().toISOString()
    });
    dropTeacherCache_();
    return { ok: true, name: name, code: code };
  });
}

function resetTeacherCode_(data) {
  const f = needFounder_(data.key); if (f.err) return f.err;
  const name = clean_(data.name, 40);
  return withLock_(function () {
    dropTeacherCache_();
    const t = findTeacher_(name);
    if (!t) return { ok: false, error: 'not_found' };
    const code = genCode_(), salt = Utilities.getUuid();
    updateTeacher_(t.name, { salt: salt, hash: hash_(salt, code) });
    return { ok: true, name: t.name, code: code };
  });
}

function setTeacher_(data) {
  const f = needFounder_(data.key); if (f.err) return f.err;
  const t = findTeacher_(clean_(data.name, 40));
  if (!t) return { ok: false, error: 'not_found' };
  const fields = {};
  if (data.active !== undefined) fields.active = data.active ? '1' : '0';
  if (data.email !== undefined) {
    const e = clean_(data.email, 100);
    if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { ok: false, error: 'bad_email' };
    fields.email = e;
  }
  if (data.telegram !== undefined) {
    const g = clean_(data.telegram, 30);
    if (g && !/^-?\d{4,20}$/.test(g)) return { ok: false, error: 'bad_telegram' };
    fields.telegram = g;
  }
  return withLock_(function () { updateTeacher_(t.name, fields); return { ok: true }; });
}

// Преподаватель меняет свой код на любой другой (8–40 символов)
function changeCode_(data) {
  const a = auth_(data.key);
  if (!a || a.locked) return deny_(a);
  if (a.role !== 'teacher') return { ok: false, error: 'forbidden' };
  const n = normCode_(data.newCode);
  if (isWeakCode_(n)) return { ok: false, error: 'weak' };
  if (n === normCode_(founderKey_())) return { ok: false, error: 'taken' };
  return withLock_(function () {
    dropTeacherCache_();
    const other = findTeacherByCode_(n);
    if (other && other.name !== a.name) return { ok: false, error: 'taken' };
    const salt = Utilities.getUuid();
    updateTeacher_(a.name, { salt: salt, hash: hash_(salt, n) });
    return { ok: true };
  });
}

// ---------- занятия ----------

function lessonsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet() || createSpreadsheet_();
  let sh = ss.getSheetByName(L_SHEET);
  if (!sh) {
    sh = ss.insertSheet(L_SHEET);
    sh.appendRow(L_HEADERS);
    sh.setFrozenRows(1);
  } else if (sh.getRange(1, L_HEADERS.length).getValue() !== L_HEADERS[L_HEADERS.length - 1]) {
    sh.getRange(1, 1, 1, L_HEADERS.length).setValues([L_HEADERS]); // добавляем новые колонки в старую таблицу
  }
  return sh;
}

// Новое занятие. Преподаватель создаёт занятия только себе, основатель может любому.
function addLesson_(data) {
  const a = auth_(data.key);
  if (!a || a.locked) return deny_(a);
  const teacher = a.role === 'teacher' ? a.name : clean_(data.teacher, 40);
  const tr = findTeacher_(teacher);
  if (!tr) return { ok: false, error: 'bad_teacher' };
  const date = clean_(data.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'bad_date' };
  const format = clean_(data.format, 30);
  if (PRICES[format] === undefined) return { ok: false, error: 'bad_format' };
  const people = Math.max(1, Math.min(20, Math.round(Number(data.people) || 1)));
  const hours = Math.max(0.25, Math.min(6, Number(data.hours) || 1));
  let amount = Number(data.amount);
  if (!isFinite(amount) || amount < 0) amount = PRICES[format] * people * hours;
  amount = Math.min(Math.round(amount * 100) / 100, 20000);
  const time = /^\d{1,2}:\d{2}$/.test(String(data.time || '')) ? String(data.time) : '';
  const repeat = Math.max(1, Math.min(12, Math.round(Number(data.repeat) || 1)));
  const student = clean_(data.student, 80);
  const note = clean_(data.note, 200);
  const rows = [];
  for (let i = 0; i < repeat; i++) {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + 7 * i);
    const first = i === 0;
    rows.push({
      id: Utilities.getUuid().slice(0, 8), date: d.toISOString().slice(0, 10), teacher: tr.name,
      student: student, format: format, people: people, hours: hours, amount: amount, note: note,
      created: new Date().toISOString(), time: time,
      done: first && data.done ? '1' : '', paid: first && data.done && data.paid ? '1' : ''
    });
  }
  return withLock_(function () {
    const sh = lessonsSheet_();
    const rng = sh.getRange(sh.getLastRow() + 1, 1, rows.length, L_HEADERS.length);
    rng.setNumberFormat('@');
    rng.setValues(rows.map(function (row) { return L_HEADERS.map(function (h) { return String(row[h]); }); }));
    return { ok: true, id: rows[0].id, count: rows.length };
  });
}

// Найти строку занятия и проверить, что оно принадлежит преподавателю
function lessonRow_(sh, id, a) {
  if (sh.getLastRow() < 2) return { err: { ok: false, error: 'not_found' } };
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) !== id) continue;
    if (a.role === 'teacher' && String(vals[i][2]) !== a.name) return { err: { ok: false, error: 'forbidden' } };
    return { row: i + 2 };
  }
  return { err: { ok: false, error: 'not_found' } };
}

function setLesson_(data) {
  const a = auth_(data.key);
  if (!a || a.locked) return deny_(a);
  const sh = lessonsSheet_();
  const f = lessonRow_(sh, clean_(data.id, 40), a);
  if (f.err) return f.err;
  const row = f.row;
  const set = function (h, v) { const c = sh.getRange(row, L_HEADERS.indexOf(h) + 1); c.setNumberFormat('@'); c.setValue(String(v)); };
  if (data.done !== undefined) {
    set('done', data.done ? '1' : '');
    if (!data.done) set('paid', ''); // не проведено, значит и не оплачено
  }
  if (data.paid !== undefined) {
    set('paid', data.paid ? '1' : '');
    if (data.paid) set('done', '1');
  }
  if (data.student !== undefined) set('student', clean_(data.student, 80));
  if (data.note !== undefined) set('note', clean_(data.note, 200));
  if (data.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(data.date))) set('date', data.date);
  if (data.time !== undefined) set('time', /^\d{1,2}:\d{2}$/.test(String(data.time)) ? data.time : '');
  if (data.hours !== undefined) set('hours', Math.max(0.25, Math.min(6, Number(data.hours) || 1)));
  if (data.amount !== undefined && isFinite(Number(data.amount)) && Number(data.amount) >= 0) set('amount', Math.min(Number(data.amount), 20000));
  return { ok: true };
}

function deleteLesson_(data) {
  const a = auth_(data.key);
  if (!a || a.locked) return deny_(a);
  const sh = lessonsSheet_();
  const f = lessonRow_(sh, clean_(data.id, 40), a);
  if (f.err) return f.err;
  sh.deleteRow(f.row);
  return { ok: true };
}

function paymentsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet() || createSpreadsheet_();
  let sh = ss.getSheetByName(P_SHEET);
  if (!sh) {
    sh = ss.insertSheet(P_SHEET);
    sh.appendRow(P_HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function listLessons_(p) {
  const a = auth_(p.key);
  if (!a || a.locked) return deny_(a);
  const isFounder = a.role === 'founder';
  const month = clean_(p.month, 7); // YYYY-MM
  const only = isFounder ? '' : a.name; // преподаватель видит только свои занятия
  const all = readRows_(lessonsSheet_(), L_HEADERS);
  const rows = all.filter(function (o) {
    return (!month || o.date.slice(0, 7) === month) && (!only || o.teacher === only);
  }).sort(function (x, y) { return x.date < y.date ? 1 : -1; });
  // баланс преподавателя за всё время: заработал − выплачено = ему должны
  let balance = null;
  if (!isFounder) {
    const earned = all.filter(function (o) { return o.teacher === only && o.done === '1' && o.paid === '1'; })
      .reduce(function (s, o) { return s + (Number(o.amount) || 0); }, 0) * (100 - FOUNDER_PERCENT) / 100;
    const paid = readRows_(paymentsSheet_(), P_HEADERS).filter(function (o) { return o.teacher === only; })
      .reduce(function (s, o) { return s + (Number(o.amount) || 0); }, 0);
    balance = { earned: Math.round(earned * 100) / 100, paid: paid, owed: Math.round((earned - paid) * 100) / 100 };
  }
  const students = [];
  all.forEach(function (o) {
    if ((isFounder || o.teacher === only) && o.student && students.indexOf(o.student) < 0) students.push(o.student);
  });
  return { ok: true, version: SCRIPT_VERSION, founder: isFounder, name: isFounder ? '' : a.name, percent: FOUNDER_PERCENT, prices: PRICES, balance: balance, students: students.slice(-200), lessons: rows.slice(0, 1000) };
}

// ---------- выплаты (только основатель) ----------

function addPayment_(data) {
  const f = needFounder_(data.key); if (f.err) return f.err;
  const tr = findTeacher_(clean_(data.teacher, 40));
  if (!tr) return { ok: false, error: 'bad_teacher' };
  const date = clean_(data.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'bad_date' };
  const amount = Math.round(Number(data.amount) * 100) / 100;
  if (!isFinite(amount) || amount <= 0 || amount > 200000) return { ok: false, error: 'bad_amount' };
  const row = { id: Utilities.getUuid().slice(0, 8), date: date, teacher: tr.name, amount: amount, note: clean_(data.note, 200), created: new Date().toISOString() };
  return withLock_(function () {
    const sh = paymentsSheet_();
    const rng = sh.getRange(sh.getLastRow() + 1, 1, 1, P_HEADERS.length);
    rng.setNumberFormat('@');
    rng.setValues([P_HEADERS.map(function (h) { return String(row[h]); })]);
    return { ok: true, id: row.id };
  });
}

function deletePayment_(data) {
  const f = needFounder_(data.key); if (f.err) return f.err;
  const id = clean_(data.id, 40);
  const sh = paymentsSheet_();
  if (sh.getLastRow() < 2) return { ok: false, error: 'not_found' };
  const ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === id) { sh.deleteRow(i + 2); return { ok: true }; }
  }
  return { ok: false, error: 'not_found' };
}

// Всё для кабинета основателя: занятия, выплаты, процент, преподаватели
function founderData_(p) {
  const f = needFounder_(p.key); if (f.err) return f.err;
  const ts = readTeachers_();
  return {
    ok: true, version: SCRIPT_VERSION, percent: FOUNDER_PERCENT,
    teachers: ts.map(function (t) { return t.name; }),
    teacherInfo: ts.map(function (t) { return { name: t.name, email: t.email, telegram: t.telegram, active: t.active === '1', created: t.created }; }),
    lessons: readRows_(lessonsSheet_(), L_HEADERS).slice(-5000),
    payments: readRows_(paymentsSheet_(), P_HEADERS).slice(-2000)
  };
}

// ---------- заявки ----------

function setStatus_(id, status, a) {
  if (!id || STATUSES.indexOf(status) < 0) return { ok: false, error: 'bad_args' };
  const sh = sheet_();
  if (sh.getLastRow() < 2) return { ok: false, error: 'not_found' };
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS.length).getValues();
  const ti = HEADERS.indexOf('teacher');
  for (let i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) !== id) continue;
    const lt = String(vals[i][ti]);
    if (a.role === 'teacher' && lt && lt !== a.name) return { ok: false, error: 'forbidden' };
    sh.getRange(i + 2, HEADERS.indexOf('status') + 1).setValue(status);
    return { ok: true };
  }
  return { ok: false, error: 'not_found' };
}

// Одноразовый токен для отправки заявки: бот, который шлёт запросы вслепую, сюда не пройдёт
function leadToken_() {
  if (bump_(bucket_('tk_m', 60), 120) > LIMITS.tokensPerMinute) return { ok: false, error: 'busy' };
  const t = Utilities.getUuid().replace(/-/g, '');
  CacheService.getScriptCache().put('tk_' + t, String(Date.now()), 3600);
  return { ok: true, token: t };
}

function dayCount_(inc) {
  const props = PropertiesService.getScriptProperties();
  const k = 'LEADS_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  const n = (Number(props.getProperty(k)) || 0) + (inc ? 1 : 0);
  if (inc) {
    props.setProperty(k, String(n));
    props.getKeys().forEach(function (x) { if (x.indexOf('LEADS_') === 0 && x !== k) props.deleteProperty(x); });
  }
  return n;
}

// Проверка ответа капчи на стороне Cloudflare. Если сам Cloudflare недоступен, не блокируем людей (остальная защита работает).
function verifyTurnstile_(secret, token) {
  token = String(token || '');
  if (!token || token.length > 2048) return false;
  try {
    const r = UrlFetchApp.fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'post', payload: { secret: secret, response: token }, muteHttpExceptions: true
    });
    return JSON.parse(r.getContentText()).success === true;
  } catch (err) {
    console.warn('Turnstile недоступен: ' + err);
    return true;
  }
}

function badText_(s) { return /(https?:\/\/|www\.|\bt\.me\/|<\/?[a-z]|\[url)/i.test(s); }

// Приём заявки. legacy = пришла от старой страницы без токена (допускается, но с жёстким лимитом).
function submitLead_(data, legacy) {
  if (data.website) return { ok: true }; // ловушка для ботов: поле должно быть пустым
  const cache = CacheService.getScriptCache();

  if (legacy) {
    if (bump_(bucket_('lg_h', 3600), 7200) > LIMITS.legacyPerHour) return { ok: false, error: 'busy' };
  } else {
    const tk = String(data.token || '');
    const issued = tk ? Number(cache.get('tk_' + tk)) : 0;
    if (!issued) return { ok: false, error: 'token' };
    cache.remove('tk_' + tk); // токен одноразовый
    if (Date.now() - issued < 2000) return { ok: false, error: 'fast' };
  }

  const name = clean_(data.name, 80);
  const contact = clean_(data.contact, 120);
  const comment = clean_(data.comment, 600);
  const time = clean_(data.time, 120);
  if (!name || !contact) return { ok: false, error: 'missing' };
  if (!/[A-Za-zА-Яа-яЁё]/.test(name) || contact.length < 4) return { ok: false, error: 'bad' };
  if (badText_(name) || badText_(comment) || badText_(time)) return { ok: false, error: 'bad' };
  if (/https?:\/\//i.test(contact) && !/(instagram\.com|t\.me|telegram\.me)/i.test(contact)) return { ok: false, error: 'bad' };

  // капча Cloudflare Turnstile (если включена): проверяем до лимитов, чтобы боты не съедали квоту честных заявок
  const secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET');
  if (secret && (legacy || !verifyTurnstile_(secret, data.ts))) return { ok: false, error: 'captcha' };

  // общие лимиты на весь сайт
  if (bump_(bucket_('rl_m', 60), 120) > LIMITS.perMinute) return { ok: false, error: 'busy' };
  if (bump_(bucket_('rl_h', 3600), 7200) > LIMITS.perHour) return { ok: false, error: 'busy' };
  if (dayCount_(false) >= LIMITS.perDay) return { ok: false, error: 'busy' };

  // повторы с одного контакта считаем успехом, но не записываем
  const ck = 'lead_' + Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, contact.toLowerCase()));
  if (cache.get(ck + '_t')) return { ok: true, duplicate: true };
  if (bump_(ck, 21600) > LIMITS.contactPer6h) return { ok: true, duplicate: true };
  cache.put(ck + '_t', '1', 120);

  let teacher = clean_(data.teacher, 40);
  const tr = teacher ? findTeacher_(teacher) : null;
  teacher = tr && tr.active === '1' ? tr.name : '';

  const lead = {
    id: Utilities.getUuid().slice(0, 8), created: new Date().toISOString(), name: name,
    grade: clean_(data.grade, 30), goal: clean_(data.goal, 80), format: clean_(data.format, 60),
    time: time, contact: contact, teacher: teacher, comment: comment, status: 'новая', page: clean_(data.page, 80)
  };

  const res = withLock_(function () {
    // пишем как чистый текст: так «+373…» не станет числом, а «=…» не выполнится как формула
    const sh = sheet_();
    const rng = sh.getRange(sh.getLastRow() + 1, 1, 1, HEADERS.length);
    rng.setNumberFormat('@');
    rng.setValues([HEADERS.map(function (h) { return lead[h] === undefined ? '' : String(lead[h]); })]);
    return { ok: true, id: lead.id };
  });
  if (!res.ok) return res;
  dayCount_(true);
  try { notify_(lead); } catch (err) { console.error('notify failed: ' + err); }
  return res;
}

// Действия, которым нужен ключ. Вызываются и из doPost, и из doGet (action=do), чтобы сайт мог прочитать ответ.
function handle_(data) {
  switch (data.action) {
    case 'status': {
      const a = auth_(data.key);
      if (!a || a.locked) return deny_(a);
      return setStatus_(clean_(data.id, 40), clean_(data.status, 20), a);
    }
    case 'lead': return submitLead_(data, false);
    case 'lessonAdd': return addLesson_(data);
    case 'lessonDel': return deleteLesson_(data);
    case 'lessonSet': return setLesson_(data);
    case 'payAdd': return addPayment_(data);
    case 'payDel': return deletePayment_(data);
    case 'followersSet': return setFollowers_(data);
    case 'teacherAdd': return addTeacher_(data);
    case 'teacherReset': return resetTeacherCode_(data);
    case 'teacherSet': return setTeacher_(data);
    case 'codeChange': return changeCode_(data);
  }
  return null;
}

// ---- Счётчик подписчиков Instagram ----
// 1) пробуем спросить Instagram (раз в 6 часов), 2) если не вышло, берём последнее известное или введённое вручную число.
function fetchFollowers_() {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  try {
    const r = UrlFetchApp.fetch('https://i.instagram.com/api/v1/users/web_profile_info/?username=' + IG_USERNAME, {
      headers: { 'x-ig-app-id': '936619743392459', 'User-Agent': ua }, muteHttpExceptions: true
    });
    if (r.getResponseCode() === 200) {
      const n = JSON.parse(r.getContentText()).data.user.edge_followed_by.count;
      if (isFinite(n) && n >= 0) return Number(n);
    }
  } catch (err) {}
  try {
    const r = UrlFetchApp.fetch('https://www.instagram.com/' + IG_USERNAME + '/', { headers: { 'User-Agent': ua }, muteHttpExceptions: true });
    const m = r.getContentText().match(/content="([\d.,\s]+[KkMmКк]?)\s*(?:Followers|подписчик)/i);
    if (m) {
      let s = m[1].replace(/\s/g, '').replace(',', '.'), mult = 1;
      if (/[Kk]$/.test(s)) { mult = 1000; s = s.slice(0, -1); } else if (/[Mm]$/.test(s)) { mult = 1e6; s = s.slice(0, -1); } else s = s.replace(/\./g, '');
      const n = Math.round(parseFloat(s) * mult);
      if (isFinite(n) && n > 0) return n;
    }
  } catch (err) {}
  return null;
}

function followers_() {
  const props = PropertiesService.getScriptProperties();
  const cache = CacheService.getScriptCache();
  const hit = cache.get('ig_followers');
  if (hit) return { ok: true, followers: Number(hit), source: 'cache' };
  const saved = Number(props.getProperty('IG_FOLLOWERS'));
  // если Instagram недавно не ответил, не дёргаем его снова (иначе поток запросов исчерпает квоту UrlFetch)
  if (!cache.get('ig_fail')) {
    const n = fetchFollowers_();
    if (n !== null) {
      props.setProperty('IG_FOLLOWERS', String(n));
      cache.put('ig_followers', String(n), 21600);
      return { ok: true, followers: n, source: 'instagram' };
    }
    cache.put('ig_fail', '1', 1800);
  }
  if (saved > 0) { cache.put('ig_followers', String(saved), 1800); return { ok: true, followers: saved, source: 'saved' }; }
  return { ok: false, error: 'unknown' };
}

// Ввести число вручную (из кабинета основателя): работает, пока Instagram не отдаёт данные сам
function setFollowers_(data) {
  const f = needFounder_(data.key); if (f.err) return f.err;
  const n = Math.round(Number(data.followers));
  if (!isFinite(n) || n < 0 || n > 100000000) return { ok: false, error: 'bad_number' };
  PropertiesService.getScriptProperties().setProperty('IG_FOLLOWERS', String(n));
  CacheService.getScriptCache().remove('ig_followers');
  return { ok: true, followers: n };
}

// Приём заявки (старые страницы шлют её POST-запросом без токена)
function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'bad_json' });
  }
  if (!data.action || data.action === 'lead') return json_(submitLead_(data, !data.token));
  const handled = handle_(data);
  return json_(handled || { ok: false, error: 'unknown_action' });
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  switch (p.action) {
    case 'ping': return json_({ ok: true, version: SCRIPT_VERSION });
    case 'followers': return json_(followers_());
    case 'token': return json_(leadToken_());
    case 'teachers': {
      const cache = CacheService.getScriptCache();
      let names = cache.get('pub_teachers');
      if (!names) { names = JSON.stringify(teacherNames_(true)); cache.put('pub_teachers', names, 300); }
      return json_({ ok: true, teachers: JSON.parse(names) });
    }
    case 'login': {
      const a = auth_(p.code);
      if (!a || a.locked) return json_(deny_(a));
      if (a.role !== 'teacher') return json_({ ok: false, error: 'forbidden' });
      return json_({ ok: true, name: a.name, version: SCRIPT_VERSION });
    }
    case 'do': {
      // запись через GET, чтобы сайт получил ответ и увидел ошибку
      let data;
      try { data = JSON.parse(p.payload || '{}'); } catch (err) { return json_({ ok: false, error: 'bad_json' }); }
      const r = handle_(data);
      return json_(r || { ok: false, error: 'unknown_action' });
    }
    case 'lessons': return json_(listLessons_(p));
    case 'founder': return json_(founderData_(p));
    case 'list': {
      const a = auth_(p.key);
      if (!a || a.locked) return json_(deny_(a));
      const sh = sheet_();
      const rows = readRows_(sh, HEADERS).filter(function (o) {
        return a.role === 'founder' || !o.teacher || o.teacher === a.name; // преподаватель видит свои заявки и общие
      });
      return json_({ ok: true, leads: rows.slice(-300).reverse() });
    }
  }
  return json_({ ok: true, service: 'vector-leads', version: SCRIPT_VERSION });
}

function notify_(lead) {
  // не больше N уведомлений в час: иначе поток заявок съест дневную квоту почты
  if (bump_(bucket_('nt_h', 3600), 7200) > LIMITS.notifyPerHour) { console.warn('Лимит уведомлений на этот час исчерпан'); return; }
  const text =
    'Новая заявка на VECTOR\n\n' +
    'Имя: ' + lead.name + '\n' +
    (lead.grade ? 'Класс: ' + lead.grade + '\n' : '') +
    (lead.goal ? 'Цель: ' + lead.goal + '\n' : '') +
    (lead.format ? 'Формат: ' + lead.format + '\n' : '') +
    (lead.time ? 'Удобное время: ' + lead.time + '\n' : '') +
    'Контакт: ' + lead.contact + '\n' +
    'Преподаватель: ' + (lead.teacher || 'любой') + '\n' +
    (lead.comment ? 'Комментарий: ' + lead.comment + '\n' : '');

  const all = readTeachers_().filter(function (t) { return t.active === '1'; });
  const targets = lead.teacher ? all.filter(function (t) { return t.name === lead.teacher; }) : all;
  targets.forEach(function (t) {
    if (t.email && t.email.indexOf('@') > 0 && t.email.indexOf('example.com') < 0) {
      MailApp.sendEmail(t.email, 'Новая заявка: ' + lead.name, text);
    }
    const token = tgToken_(), chat = tgChat_(t);
    if (token && chat) {
      const resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
        method: 'post',
        payload: { chat_id: chat, text: text },
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() !== 200) console.error('Telegram error: ' + resp.getContentText());
    } else {
      console.warn('Telegram не настроен: нет токена или chat id');
    }
  });
}

// ---- Вспомогательное: запустите вручную, чтобы узнать chat id для Telegram ----
// 1) Каждый преподаватель пишет вашему боту /start. 2) Запустите эту функцию и откройте «Журнал выполнения».
function showTelegramChats() {
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + tgToken_() + '/getUpdates');
  const res = JSON.parse(r.getContentText()).result || [];
  const seen = {};
  res.forEach(function (u) {
    const c = u.message && u.message.chat;
    if (c && !seen[c.id]) { seen[c.id] = 1; console.log(c.id + ' — ' + (c.first_name || '') + ' ' + (c.username ? '@' + c.username : '')); }
  });
}

// ---- Запустите один раз вручную после вставки нового кода: создаст лист «Преподаватели» ----
function setup() {
  teachersSheet_();
  console.log('Готово. Откройте кабинет основателя и нажмите «Новый код» у каждого преподавателя.');
}

// ===================== РЕЗЕРВНЫЕ КОПИИ =====================
// Раз в сутки (ночью) вся база (заявки, занятия, выплаты, преподаватели) сохраняется строкой в скрытом листе «Резерв».
// Копии по дням недели перезаписываются по кругу, всего их 7, поэтому место не растёт. Файлы на Диске не создаются.
// Дополнительно в Google Таблицах есть «Файл → История версий»: оттуда тоже можно вернуть любое прошлое состояние.
const B_SHEET = 'Резерв';
const B_CHUNK = 40000; // в одной ячейке Google хранит до 50 000 символов

function backupSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet() || createSpreadsheet_();
  let sh = ss.getSheetByName(B_SHEET);
  if (!sh) {
    sh = ss.insertSheet(B_SHEET);
    sh.appendRow(['ключ', 'когда', 'частей', 'данные →']);
    sh.setFrozenRows(1);
    try { sh.hideSheet(); } catch (e) {}
  }
  return sh;
}

function dataSheets_() {
  return [
    { name: SHEET_NAME, cols: HEADERS.length, get: sheet_ },
    { name: L_SHEET, cols: L_HEADERS.length, get: lessonsSheet_ },
    { name: P_SHEET, cols: P_HEADERS.length, get: paymentsSheet_ },
    { name: T_SHEET, cols: T_HEADERS.length, get: teachersSheet_ }
  ];
}

function saveSnapshot_(key) {
  const snap = { v: SCRIPT_VERSION, at: new Date().toISOString(), sheets: {} };
  dataSheets_().forEach(function (d) {
    const sh = d.get();
    snap.sheets[d.name] = sh.getLastRow() ? sh.getRange(1, 1, sh.getLastRow(), d.cols).getDisplayValues() : [];
  });
  const json = JSON.stringify(snap), parts = [];
  for (let i = 0; i < json.length; i += B_CHUNK) parts.push(json.slice(i, i + B_CHUNK));
  const sh = backupSheet_();
  if (sh.getLastRow() > 1) { // убираем прежнюю копию с тем же ключом
    const ks = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
    for (let i = ks.length - 1; i >= 0; i--) if (String(ks[i][0]) === String(key)) sh.deleteRow(i + 2);
  }
  const row = [String(key), snap.at, String(parts.length)].concat(parts);
  if (sh.getMaxColumns() < row.length) sh.insertColumnsAfter(sh.getMaxColumns(), row.length - sh.getMaxColumns());
  const rng = sh.getRange(sh.getLastRow() + 1, 1, 1, row.length);
  rng.setNumberFormat('@');
  rng.setValues([row]);
  return { parts: parts.length, chars: json.length };
}

// Запускается автоматически каждую ночь (триггер создаёт setupBackup)
function dailyBackup() {
  const day = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'u'); // 1 = понедельник … 7 = воскресенье
  const r = saveSnapshot_(day);
  console.log('Резерв сохранён: день ' + day + ', ' + r.chars + ' символов');
}

// Запустите ОДИН РАЗ вручную: создаёт ночной триггер (около 3:00) и сразу делает первую копию
function setupBackup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyBackup') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyBackup').timeBased().everyDays(1).atHour(3).create();
  dailyBackup();
}

// Какие копии есть
function listBackups() {
  const sh = backupSheet_();
  if (sh.getLastRow() < 2) { console.log('Копий пока нет'); return; }
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (r) {
    console.log('день ' + r[0] + ' — ' + r[1] + ' (частей: ' + r[2] + ')');
  });
}

// Вернуть данные из копии. Какую: свойство скрипта RESTORE_DAY (1–7); если не задано, берётся самая свежая.
// Перед возвратом текущее состояние само сохраняется под ключом «pre», так что откатить откат можно (RESTORE_DAY = pre).
function restoreBackup() {
  const want = PropertiesService.getScriptProperties().getProperty('RESTORE_DAY');
  const sh = backupSheet_();
  if (sh.getLastRow() < 2) { console.log('Копий пока нет'); return; }
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getMaxColumns()).getValues();
  let pick = null;
  rows.forEach(function (r) {
    if (want ? String(r[0]) === String(want) : (String(r[0]) !== 'pre' && (!pick || String(r[1]) > String(pick[1])))) pick = r;
  });
  if (!pick) { console.log('Копия не найдена'); return; }
  const n = Number(pick[2]);
  const snap = JSON.parse(pick.slice(3, 3 + n).join(''));
  saveSnapshot_('pre');
  dataSheets_().forEach(function (d) {
    const vals = snap.sheets[d.name];
    if (!vals) return;
    const sh2 = d.get();
    sh2.clearContents();
    if (vals.length) {
      const rng = sh2.getRange(1, 1, vals.length, d.cols);
      rng.setNumberFormat('@');
      rng.setValues(vals);
    }
  });
  dropTeacherCache_();
  console.log('Восстановлено из копии от ' + snap.at);
}

// ---- Проверка: запустите вручную, чтобы создать тестовую заявку и получить уведомление ----
function testLead() {
  const out = submitLead_({ name: 'Тест', grade: '9 класс', goal: 'Подготовиться к экзамену', contact: '@test_user', teacher: '' }, true);
  console.log(JSON.stringify(out));
}
