const seed = JSON.parse(document.getElementById('seedData').textContent);
const STORAGE_KEY = 'personalBudgetSiteOldDesignGoals.v2';
const CLOUD_CONFIG_KEY = 'personalBudgetCloudSupabase.v1';
const THEME_KEY = 'personalBudgetTheme.v1';
const EMBEDDED_CLOUD_CONFIG = window.BUDGET_SUPABASE_CONFIG || {};
let state = migrateState(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || seed);
let currentMonth = state.months[new Date().getMonth()] || 'Январь';
let settingsTab = 'account';
let searchQuery = '';
let searchScope = 'all';
let currentTheme = localStorage.getItem(THEME_KEY) || 'light';
let selected = { expenses: new Set(), incomes: new Set(), purchases: new Set() };
let storedCloudConfig = JSON.parse(localStorage.getItem(CLOUD_CONFIG_KEY) || 'null') || {};
let cloudConfig = {
  url: storedCloudConfig.url || EMBEDDED_CLOUD_CONFIG.url || '',
  key: storedCloudConfig.key || EMBEDDED_CLOUD_CONFIG.key || '',
  enabled: storedCloudConfig.enabled ?? !!(EMBEDDED_CLOUD_CONFIG.url && EMBEDDED_CLOUD_CONFIG.key)
};
let cloudClient = null;
let cloudUser = null;
let cloudStatus = cloudConfig.enabled ? 'Облако не подключено' : 'Оффлайн режим';
let cloudSaveTimer = null;
let cloudSaveInProgress = false;
let pendingCloudSave = false;
let suppressCloudSave = false;
let cloudChecking = false;


function applyTheme(theme){
  currentTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', currentTheme);
  localStorage.setItem(THEME_KEY, currentTheme);
}
function setTheme(theme){
  applyTheme(theme);
  renderSettings();
}
applyTheme(currentTheme);

const rub = n => (Number(n)||0).toLocaleString('ru-RU') + ' ₽';
const pct = n => (Number(n)||0).toLocaleString('ru-RU', {maximumFractionDigits: 1}) + '%';
function num(v){ return Number(String(v ?? '').replace(/\s/g,'').replace(',','.')) || 0; }

function cleanAmountValue(value, finalize=false){
  let raw = String(value ?? '').replace(/\s/g,'').replace(/,/g,'.');
  raw = raw.replace(/[^0-9.]/g,'');
  const parts = raw.split('.');
  let out = parts.shift() || '';
  if(parts.length){ out += '.' + parts.join('').slice(0,2); }
  if(finalize){
    if(out === '.') out = '';
    out = out.replace(/^0+(?=\d)/,'');
    out = out.replace(/\.$/,'');
  }
  return out;
}
function amountInput(el, list, id, key){
  const before = el.value;
  const cleaned = cleanAmountValue(before, false);
  if(before !== cleaned){
    const pos = el.selectionStart || cleaned.length;
    el.value = cleaned;
    const nextPos = Math.max(0, pos - (before.length - cleaned.length));
    try{ el.setSelectionRange(nextPos, nextPos); }catch(e){}
  }
  if(list && id && key) upd(list, id, key, el.value, {silent:true});
}
function amountBlur(el, list, id, key){
  el.value = cleanAmountValue(el.value, true);
  if(list && id && key) upd(list, id, key, el.value, {silent:true});
}
function amountAttrs(){return 'inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" autocomplete="off"';}
function uid(p){ return p + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function save(){
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  scheduleCloudSave();
}

function migrateState(data){
  const s = JSON.parse(JSON.stringify(data || seed));
  s.months ||= seed.months;
  s.expenses ||= [];
  s.incomes ||= [];
  s.purchases ||= [];
  s.expenseCategories ||= s.categories || seed.expenseCategories || seed.categories || [];
  s.categories = s.expenseCategories; // совместимость со старыми экспортами
  s.statuses ||= seed.statuses || ['План','Оплачено','Отложено','Отменено'];
  s.priorities ||= seed.priorities || ['Низкий','Средний','Высокий','Обязательно'];
  s.incomeTypes ||= seed.incomeTypes || ['Зарплата','Доп. доход','Возврат','Подарок','Другое'];
  s.archivedMonths ||= [];
  s.recurringExpenses ||= [];
  s.recurringExpenses = s.recurringExpenses.map(x => normalizeRecurringExpense(x));
  s.expenses = s.expenses.map(x => normalizeExpense(x));
  s.purchases = s.purchases.map(x => ({
    id: x.id || uid('p'),
    name: x.name || x.purchase || 'Цель',
    targetAmount: x.targetAmount ?? x.planAmount ?? '',
    percent: x.percent ?? '',
    initialAmount: x.initialAmount ?? x.factAmount ?? '',
    priority: x.priority || 'Средний',
    status: x.status || 'План',
    comment: x.comment || '',
    targetDate: x.targetDate || '',
    reserve: !!x.reserve
  }));
  return s;
}

function normalizeExpense(x){
  const plan = num(x.planAmount);
  const fact = num(x.factAmount);
  const autoPaid = plan > 0 && fact > 0 && plan === fact;
  const paidManual = Boolean((x.paidManual !== undefined ? x.paidManual : (x.status === 'Оплачено' && !autoPaid)));
  const paid = Boolean(x.paid || x.status === 'Оплачено' || autoPaid);
  return {
    id: x.id || uid('e'),
    month: x.month || seed.months?.[0] || 'Январь',
    category: x.category || 'Другое',
    planAmount: x.planAmount ?? '',
    factAmount: x.factAmount ?? '',
    date: x.date || '',
    status: paid ? 'Оплачено' : (x.status || 'План'),
    paid,
    paidManual,
    comment: x.comment || '',
    priority: x.priority || 'Средний',
    recurringKey: x.recurringKey || ''
  };
}

function normalizeRecurringExpense(x){
  return {
    id: x.id || uid('r'),
    category: x.category || 'Другое',
    planAmount: x.planAmount ?? '',
    day: String(x.day || '').replace(/[^0-9]/g,'').slice(0,2),
    priority: x.priority || 'Средний',
    comment: x.comment || '',
    active: x.active !== false
  };
}
function monthNumber(month){ const idx = monthIndex(month); return idx >= 0 ? idx + 1 : (new Date().getMonth()+1); }
function daysInMonth(month){ return new Date(new Date().getFullYear(), monthNumber(month), 0).getDate(); }
function dateForMonthDay(month, day){
  const d = Math.min(Math.max(Number(day)||1,1), daysInMonth(month));
  const mm = String(monthNumber(month)).padStart(2,'0');
  const dd = String(d).padStart(2,'0');
  return `${new Date().getFullYear()}-${mm}-${dd}`;
}
function recurringKey(r, month){ return `${r.id}:${month}`; }
function applyRecurringForMonth(month=currentMonth, silent=false){
  if(isMonthArchived(month)){ if(!silent) alert('Месяц архивирован. Сначала разархивируй его.'); return; }
  let added = 0;
  state.recurringExpenses ||= [];
  state.recurringExpenses.filter(r=>r.active !== false).forEach(r=>{
    const key = recurringKey(r, month);
    const exists = state.expenses.some(e=>e.recurringKey === key);
    if(!exists){
      state.expenses.push(normalizeExpense({id:uid('e'), month, category:r.category, planAmount:r.planAmount, factAmount:'', date: r.day ? dateForMonthDay(month, r.day) : '', status:'План', paid:false, paidManual:false, comment:r.comment || 'Повторяющийся платеж', priority:r.priority, recurringKey:key}));
      added++;
    }
  });
  if(added){ save(); render(); }
  if(!silent) alert(added ? `Добавлено платежей: ${added}` : 'Новых повторяющихся платежей нет');
}
function applyRecurringAllMonths(){
  if(!confirm('Создать недостающие повторяющиеся платежи во всех неархивных месяцах?')) return;
  let added = 0;
  state.months.forEach(m=>{
    if(isMonthArchived(m)) return;
    state.recurringExpenses.filter(r=>r.active !== false).forEach(r=>{
      const key = recurringKey(r,m);
      if(!state.expenses.some(e=>e.recurringKey === key)){
        state.expenses.push(normalizeExpense({id:uid('e'), month:m, category:r.category, planAmount:r.planAmount, factAmount:'', date: r.day ? dateForMonthDay(m, r.day) : '', status:'План', paid:false, paidManual:false, comment:r.comment || 'Повторяющийся платеж', priority:r.priority, recurringKey:key}));
        added++;
      }
    });
  });
  if(added){ save(); render(); }
  alert(added ? `Добавлено платежей: ${added}` : 'Новых повторяющихся платежей нет');
}
function syncExpensePaid(item){
  if(!item) return;
  const plan = num(item.planAmount);
  const fact = num(item.factAmount);
  if(plan > 0 && fact >= plan){
    item.paid = true;
    item.status = 'Оплачено';
    return;
  }
  if(!item.paidManual){
    item.paid = false;
    if(item.status === 'Оплачено') item.status = 'План';
  }
}
function setExpensePaid(item, paid){
  if(!item) return;
  item.paidManual = !!paid;
  item.paid = !!paid;
  item.status = item.paid ? 'Оплачено' : 'План';
}
function selectedCount(list){
  return selected[list]?.size || 0;
}
function bulkDeleteButton(list, disabled=false){
  const count = selectedCount(list);
  if(!count) return '';
  return `<button class="danger" onclick="bulkDelete('${list}')" ${disabled?'disabled':''}>Удалить выбранные (${count})</button>`;
}
function expenseStatusPill(x){
  const paid = Boolean(x.paid || x.status === 'Оплачено');
  return `<span class="pill ${paid?'ok':''}">${paid?'Оплачено':'Не оплачено'}</span>`;
}

function options(arr, selected=''){return arr.map(x=>`<option ${x===selected?'selected':''}>${escapeHtml(x)}</option>`).join('')}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]))}
function val(id){return document.getElementById(id)?.value || ''}
function isMonthArchived(month){return state.archivedMonths?.includes(month)}
function archivedAttr(month){return isMonthArchived(month) ? 'disabled' : ''}
function archivedNote(month){return isMonthArchived(month) ? '<span class="pill archived">Архив</span>' : ''}
function progressBar(value){const v=Math.max(0,Math.min(Number(value)||0,100)); return `<div class="progress"><div style="width:${v}%"></div></div>`}

function todayLocal(){const d=new Date(); d.setHours(0,0,0,0); return d;}
function dateDiffDays(dateValue){if(!dateValue) return null; const d=new Date(dateValue+'T00:00:00'); if(Number.isNaN(d.getTime())) return null; return Math.round((d-todayLocal())/86400000);}
function notificationItems(month='ALL'){
  const items=[];
  state.expenses.forEach(x=>{
    if(!x.date || (month!=='ALL' && x.month!==month)) return;
    const diff=dateDiffDays(x.date);
    if(diff!==null && diff>=0 && diff<=2 && !x.paid && x.status!=='Оплачено') items.push({kind:'Расход', month:x.month, title:x.category, date:x.date, diff, text:x.comment});
  });
  state.incomes.forEach(x=>{
    if(!x.date || (month!=='ALL' && x.month!==month)) return;
    const diff=dateDiffDays(x.date);
    if(diff!==null && diff>=0 && diff<=2) items.push({kind:'Доход', month:x.month, title:x.type || x.source || 'Доход', date:x.date, diff, text:x.comment});
  });
  return items.sort((a,b)=>a.diff-b.diff || a.date.localeCompare(b.date));
}
function notificationText(diff){return diff===0?'сегодня':diff===1?'завтра':'через 2 дня'}
function notificationPanel(month=currentMonth){
  const items=notificationItems(month);
  if(!items.length) return `<div class="card notifyCard"><h3>Уведомления</h3><p class="mutedText">Ближайших дат на 2 дня нет.</p></div>`;
  return `<div class="card notifyCard"><h3>Уведомления</h3><p class="mutedText">Показываются записи с датой сегодня, завтра или через 2 дня. Если дата пустая — уведомления нет.</p><div class="notifyList">${items.map(x=>`<div class="notifyItem"><strong>${escapeHtml(x.kind)}: ${escapeHtml(x.title)}</strong><span>${escapeHtml(x.month)} · ${escapeHtml(x.date)} · ${notificationText(x.diff)}</span>${x.text?`<small>${escapeHtml(x.text)}</small>`:''}</div>`).join('')}</div></div>`;
}


function upcomingPayments(days=14){
  const items=[];
  state.expenses.forEach(x=>{
    if(!x.date || x.paid || x.status==='Оплачено') return;
    const diff=dateDiffDays(x.date);
    if(diff!==null && diff>=0 && diff<=days){
      items.push({month:x.month, category:x.category, date:x.date, diff, amount:num(x.planAmount)-num(x.factAmount), plan:x.planAmount, fact:x.factAmount, comment:x.comment});
    }
  });
  return items.sort((a,b)=>a.diff-b.diff || a.date.localeCompare(b.date));
}
function upcomingPanel(days=14){
  const items=upcomingPayments(days);
  if(!items.length) return `<div class="card"><h3>Ближайшие платежи</h3><p class="mutedText">Неоплаченных платежей с датой на ближайшие ${days} дней нет.</p></div>`;
  return `<div class="card"><div class="toolbar"><h3>Ближайшие платежи</h3><button onclick="showView('search');searchQuery='';searchScope='expenses';renderSearch()">Открыть поиск</button></div><div class="upcomingList">${items.slice(0,8).map(x=>`<div class="upcomingItem"><div><strong>${escapeHtml(x.category)}</strong><span>${escapeHtml(x.month)} · ${escapeHtml(x.date)} · ${notificationText(Math.min(x.diff,2)).replace('через 2 дня', 'через '+x.diff+' дн.')}</span>${x.comment?`<small>${escapeHtml(x.comment)}</small>`:''}</div><b>${rub(Math.max(x.amount,0))}</b></div>`).join('')}</div></div>`;
}
function monthIndex(month){return state.months.indexOf(month)}
function totals(month){
  const incomes = state.incomes.filter(x=>x.month===month).reduce((s,x)=>s+num(x.amount),0);
  const expensesPlan = state.expenses.filter(x=>x.month===month).reduce((s,x)=>s+num(x.planAmount),0);
  const expensesFact = state.expenses.filter(x=>x.month===month).reduce((s,x)=>s+num(x.factAmount),0);
  const freePlan = incomes - expensesPlan;
  const freeFact = incomes - expensesFact;
  const positiveFreeFact = Math.max(freeFact, 0);
  const goalPercentTotal = state.purchases.reduce((s,x)=>s+num(x.percent),0);
  const goalAllocated = state.purchases.reduce((s,x)=>s+goalMonthAmount(x, month),0);
  const undistributed = Math.max(positiveFreeFact - goalAllocated, 0);
  return {incomes, expensesPlan, expensesFact, freePlan, freeFact, positiveFreeFact, goalPercentTotal, goalAllocated, undistributed};
}
function allTotals(){
  return state.months.reduce((a,m)=>{const t=totals(m); Object.keys(t).forEach(k=>a[k]=(a[k]||0)+t[k]); return a}, {});
}
function goalMonthAmount(goal, month){
  return Math.max(totalsNoGoals(month).freeFact, 0) * num(goal.percent) / 100;
}
function totalsNoGoals(month){
  const incomes = state.incomes.filter(x=>x.month===month).reduce((s,x)=>s+num(x.amount),0);
  const expensesFact = state.expenses.filter(x=>x.month===month).reduce((s,x)=>s+num(x.factAmount),0);
  return {incomes, expensesFact, freeFact: incomes-expensesFact};
}

function allTotalsNoGoals(){
  return state.months.reduce((a,m)=>{
    const t = totalsNoGoals(m);
    Object.keys(t).forEach(k=>a[k]=(a[k]||0)+t[k]);
    return a;
  }, {});
}

function goalAccumulated(goal, upToMonth=currentMonth){
  const idx = monthIndex(upToMonth);
  const months = idx < 0 ? state.months : state.months.slice(0, idx + 1);
  return num(goal.initialAmount) + months.reduce((s,m)=>s+goalMonthAmount(goal,m),0);
}
function goalRemaining(goal, upToMonth=currentMonth){return Math.max(num(goal.targetAmount) - goalAccumulated(goal, upToMonth), 0)}
function goalProgress(goal, upToMonth=currentMonth){const target=num(goal.targetAmount); return target ? Math.min(goalAccumulated(goal, upToMonth)/target*100, 100) : 0}
function monthsUntil(dateValue){
  if(!dateValue) return 0;
  const now = new Date();
  const d = new Date(dateValue+'T00:00:00');
  if(Number.isNaN(d.getTime())) return 0;
  return Math.max(1, (d.getFullYear()-now.getFullYear())*12 + (d.getMonth()-now.getMonth()) + (d.getDate()>=now.getDate()?1:0));
}
function goalMonthlyNeed(goal){
  const months = monthsUntil(goal.targetDate);
  if(!months) return 0;
  return goalRemaining(goal, currentMonth) / months;
}


function hasSupabaseLibrary(){return !!(window.supabase && window.supabase.createClient)}
function cleanSupabaseUrl(url){
  let out = String(url || '').trim();
  out = out.replace(/\/+$/, '');
  out = out.replace(/\/rest\/v1$/i, '');
  out = out.replace(/\/auth\/v1$/i, '');
  return out;
}
function isCloudConfigured(){
  return !!(cloudConfig.enabled && cloudConfig.url && cloudConfig.key);
}
function normalizeCloudConfig(){
  cloudConfig.url = cleanSupabaseUrl(cloudConfig.url || EMBEDDED_CLOUD_CONFIG.url || '');
  cloudConfig.key = (cloudConfig.key || EMBEDDED_CLOUD_CONFIG.key || '').trim();
  cloudConfig.enabled = !!(cloudConfig.enabled && cloudConfig.url && cloudConfig.key);
  localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(cloudConfig));
}
function createCloudClient(){
  normalizeCloudConfig();
  if(!cloudConfig.enabled) { cloudClient=null; cloudUser=null; cloudStatus='Оффлайн режим'; return false; }
  if(!hasSupabaseLibrary()){ cloudStatus='Supabase SDK не загрузился'; return false; }
  try{
    cloudClient = window.supabase.createClient(cloudConfig.url, cloudConfig.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    return true;
  }catch(err){ cloudStatus='Ошибка клиента Supabase'; console.error(err); return false; }
}
async function initCloud(){
  cloudChecking = true;
  updateAuthGate();
  if(!createCloudClient()){ cloudChecking=false; updateAuthGate(); return; }
  const { data, error } = await cloudClient.auth.getSession();
  cloudChecking = false;
  if(error){ cloudStatus='Ошибка сессии Supabase'; updateAuthGate(); return; }
  cloudUser = data?.session?.user || null;
  if(cloudUser){
    cloudStatus='Облако подключено. Загружаю данные...';
    updateAuthGate();
    await cloudLoad(false);
  } else {
    cloudStatus='Нужен вход в аккаунт';
    updateAuthGate();
  }
  cloudClient.auth.onAuthStateChange(async (event, session)=>{
    cloudUser = session?.user || null;
    if(cloudUser){
      cloudStatus = 'Облако подключено';
      updateAuthGate();
      if(event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') await cloudLoad(false);
    } else {
      cloudStatus = 'Нужен вход в аккаунт';
      updateAuthGate();
    }
    render();
  });
}
function authGateHtml(){
  const configured = isCloudConfigured();
  if(cloudChecking){
    return `<div class="authCard"><div class="authLogo">₽</div><h1>Личный бюджет</h1><p>Проверяю вход...</p></div>`;
  }
  if(configured){
    return `<div class="authCard cleanLogin"><div class="authLogo">₽</div><h1>Личный бюджет</h1><p>Войдите в личный бюджет</p><div class="authForm"><input id="authEmail" type="email" autocomplete="email" placeholder="Email"><input id="authPassword" type="password" autocomplete="current-password" placeholder="Пароль" onkeydown="if(event.key==='Enter') cloudLoginFromGate()"><button class="primary" onclick="cloudLoginFromGate()">Войти</button></div><p class="mutedText">После входа приложение запомнит сессию и при следующем открытии загрузит данные автоматически.</p></div>`;
  }
  return `<div class="authCard cleanLogin"><div class="authLogo">₽</div><h1>Личный бюджет</h1><p>Облачное подключение не настроено.</p><p class="mutedText">Заполни <code>cloud-config.js</code>: Supabase Project URL и publishable key. После этого на сайте останется только обычный вход по email и паролю.</p></div>`;
}
function updateAuthGate(){
  const gate = document.getElementById('authGate');
  if(!gate) return;
  const lock = !cloudUser;
  document.body.classList.toggle('auth-locked', lock);
  if(lock){ gate.innerHTML = authGateHtml(); } else { gate.innerHTML = ''; }
  updateCloudStatusView();
}
async function cloudLoginFromGate(){
  const email = document.getElementById('authEmail')?.value || '';
  const password = document.getElementById('authPassword')?.value || '';
  await cloudLogin(email, password);
}
function scheduleCloudSave(){
  if(suppressCloudSave || !cloudConfig.enabled || !cloudClient || !cloudUser) return;
  pendingCloudSave = true;
  cloudStatus = 'Есть несохраненные изменения';
  updateCloudStatusView();
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(()=>cloudSave(false), 650);
}
async function cloudSave(showAlert=true){
  if(!cloudClient || !cloudUser){ if(showAlert) alert('Сначала подключи Supabase и войди в аккаунт'); return; }
  if(cloudSaveInProgress){
    clearTimeout(cloudSaveTimer);
    cloudSaveTimer = setTimeout(()=>cloudSave(showAlert), 700);
    return;
  }
  cloudSaveInProgress = true;
  cloudStatus = 'Сохраняю в облако...';
  updateCloudStatusView();
  const payload = { user_id: cloudUser.id, data: state, updated_at: new Date().toISOString() };
  const { error } = await cloudClient.from('budget_data').upsert(payload, { onConflict: 'user_id' });
  cloudSaveInProgress = false;
  if(error){ cloudStatus='Ошибка сохранения в облако'; console.error(error); if(showAlert) alert('Ошибка сохранения: '+error.message); updateCloudStatusView(); if(showAlert) render(); return; }
  pendingCloudSave = false;
  cloudStatus='Сохранено в облаке: '+new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  updateCloudStatusView();
  if(showAlert){ alert('Сохранено в Supabase'); render(); }
}
function updateCloudStatusView(){
  document.querySelectorAll('[data-cloud-status]').forEach(el=>{ el.textContent = cloudStatus; });
}
window.addEventListener('beforeunload', ()=>{
  if(pendingCloudSave && cloudClient && cloudUser){ cloudSave(false); }
});
window.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'hidden' && pendingCloudSave && cloudClient && cloudUser){ cloudSave(false); }
  if(document.visibilityState === 'visible' && !pendingCloudSave && cloudClient && cloudUser){ cloudLoad(false); }
});
window.addEventListener('focus', ()=>{
  if(!pendingCloudSave && cloudClient && cloudUser) cloudLoad(false);
});
async function cloudLoad(showAlert=true){
  if(!cloudClient || !cloudUser){ if(showAlert) alert('Сначала подключи Supabase и войди в аккаунт'); return; }
  const { data, error } = await cloudClient.from('budget_data').select('data, updated_at').eq('user_id', cloudUser.id).maybeSingle();
  if(error){ cloudStatus='Ошибка загрузки из облака'; console.error(error); if(showAlert) alert('Ошибка загрузки: '+error.message); render(); return; }
  if(data?.data){
    suppressCloudSave = true;
    state = migrateState(data.data);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    suppressCloudSave = false;
    cloudStatus = 'Загружено из облака';
    if(showAlert) alert('Данные загружены из Supabase');
    render();
  } else {
    cloudStatus='В облаке пока пусто';
    if(showAlert) alert('В облаке пока нет данных. Данные появятся после первого изменения.');
    render();
  }
}
async function saveCloudSettings(){
  cloudConfig.url = val('supabaseUrl');
  cloudConfig.key = val('supabaseKey');
  cloudConfig.enabled = !!(cloudConfig.url && cloudConfig.key);
  normalizeCloudConfig();
  const ok=createCloudClient();
  if(ok) await initCloud();
  updateAuthGate();
  render();
  alert(cloudConfig.enabled ? 'Настройки Supabase сохранены' : 'Supabase не настроен');
}
async function cloudLogin(emailArg='', passwordArg=''){
  if(!createCloudClient()){ alert('Приложение не настроено: проверь cloud-config.js'); return; }
  const email=(emailArg || val('cloudEmail')).trim(); const password=passwordArg || val('cloudPassword');
  if(!email || !password){ alert('Укажи email и пароль'); return; }
  const { data, error } = await cloudClient.auth.signInWithPassword({ email, password });
  if(error){ alert('Ошибка входа: '+error.message); return; }
  cloudUser=data?.user || null;
  cloudStatus='Облако подключено';
  updateAuthGate();
  await cloudLoad(false);
  render();
}
async function cloudLogout(){
  if(cloudClient) await cloudClient.auth.signOut();
  cloudUser=null; cloudStatus='Нужен вход в аккаунт'; updateAuthGate(); render();
}
function cloudPanel(){
  const isConfigured = isCloudConfigured();
  if(isConfigured && cloudUser){
    return `<div class="card" style="margin-top:14px"><h3>Аккаунт</h3>
    <div class="cloudStatus"><span class="pill ok" data-cloud-status>Облако Supabase: подключено</span><span class="pill">${escapeHtml(cloudUser.email || '')}</span></div>
    <p class="mutedText">Сессия сохранена в браузере. При следующем открытии приложение автоматически проверит вход и загрузит данные.</p>
    <div class="formrow settingsForm"><button class="danger" onclick="cloudLogout()">Выйти из аккаунта</button></div>
    <details class="advancedBox"><summary>Режим разработчика</summary>
      <p class="mutedText">Технические данные обычно хранятся в <code>cloud-config.js</code>. Менять их нужно только если сменился проект Supabase.</p>
      <div class="formrow settingsForm"><input id="supabaseUrl" placeholder="Supabase Project URL" value="${escapeHtml(cloudConfig.url)}"><input id="supabaseKey" placeholder="Publishable key" value="${escapeHtml(cloudConfig.key)}"><button onclick="saveCloudSettings()">Сохранить</button><button class="danger" onclick="resetCloudSettings()">Сбросить локальные настройки</button></div>
    </details></div>`;
  }
  if(isConfigured && !cloudUser){
    return `<div class="card" style="margin-top:14px"><h3>Аккаунт</h3>
    <div class="cloudStatus"><span class="pill" data-cloud-status>${escapeHtml(cloudStatus)}</span></div>
    <p>Вход выполняется на стартовом экране. После входа здесь будет отображаться статус аккаунта.</p></div>`;
  }
  return `<div class="card" style="margin-top:14px"><h3>Аккаунт</h3><p>Supabase не настроен. Заполни <code>cloud-config.js</code> и обнови сайт.</p>
  <details class="advancedBox"><summary>Режим разработчика</summary>
  <div class="formrow settingsForm"><input id="supabaseUrl" placeholder="Supabase Project URL" value="${escapeHtml(cloudConfig.url)}"><input id="supabaseKey" placeholder="Publishable key" value="${escapeHtml(cloudConfig.key)}"><button class="primary" onclick="saveCloudSettings()">Сохранить локально</button></div>
  </details></div>`;
}
async function resetCloudSettings(){
  if(!confirm('Сбросить подключение Supabase в этом браузере? Данные в облаке не удалятся.')) return;
  if(cloudClient) await cloudClient.auth.signOut();
  localStorage.removeItem(CLOUD_CONFIG_KEY);
  storedCloudConfig = {};
  cloudConfig = { url: EMBEDDED_CLOUD_CONFIG.url || '', key: EMBEDDED_CLOUD_CONFIG.key || '', enabled: !!(EMBEDDED_CLOUD_CONFIG.url && EMBEDDED_CLOUD_CONFIG.key) };
  cloudClient=null; cloudUser=null; cloudStatus=cloudConfig.enabled?'Нужен вход в аккаунт':'Оффлайн режим';
  initCloud().finally(()=>{updateAuthGate();render();});
}


function init(){
  document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>showView(b.dataset.view));
  initCloud().finally(()=>render());
  render();
}
function showView(id){
  document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===id));
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===id));
  const titles={dashboard:'Главная страница',months:'Расходы',income:'Доходы',purchases:'Планы и цели',balance:'Остатки',settings:'Настройки',search:'Поиск'};
  document.getElementById('pageTitle').textContent=titles[id]||'Бюджет';
  render();
}
function render(){
  updateAuthGate();
  pruneSelection();
  renderDashboard(); renderMonths(); renderIncome(); renderPurchases(); renderBalance(); renderSettings(); renderSearch();
}
function kpi(label,value,hint=''){return `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div>${hint?`<div class="hint">${hint}</div>`:''}</div>`}
function renderDashboard(){
  const t=totals(currentMonth);
  const year=allTotals();
  const goalPercentTotal = state.purchases.reduce((s,x)=>s+num(x.percent),0);
  document.getElementById('dashboard').innerHTML = `
    <div class="card dashboardControls"><div><h3>Сводка за месяц</h3><p>Выбери месяц — ниже будут показаны доходы, расходы, остаток и распределение по целям только за этот месяц.</p></div><select onchange="currentMonth=this.value;render()">${options(state.months,currentMonth)}</select></div>
    <div class="two dashboardTop">${upcomingPanel(14)}${notificationPanel(currentMonth)}</div>
    <div class="dashSection"><h3>${currentMonth}: деньги за месяц</h3><div class="grid">${kpi('Доходы',rub(t.incomes),'сколько поступило')}${kpi('Расходы',rub(t.expensesFact),'сколько потрачено по факту')}${kpi('Свободный остаток',rub(t.freeFact),'доходы минус расходы')}${kpi('Уходит в цели',rub(t.goalAllocated),`по правилам целей: ${pct(goalPercentTotal)}`)}</div></div>
    <div class="dashSection"><h3>${currentMonth}: после распределения</h3><div class="grid">${kpi('Не распределено',rub(t.undistributed),'останется свободными деньгами')}${kpi('План расходов',rub(t.expensesPlan),'ожидаемые расходы')}${kpi('Разница план/факт',rub(t.expensesPlan-t.expensesFact),'плюс = потратил меньше плана')}${kpi('Итого за год',rub(year.freeFact),'сумма свободных остатков')}</div></div>
    <div class="two">
      <div class="card"><h3>Цели / план покупок</h3><p class="mutedText">Накопления считаются с начала года до выбранного месяца.</p>${goalsMini()}</div>
      <div class="card"><h3>Остатки по месяцам</h3>${balanceTable()}</div>
    </div>`;
}
function goalsMini(){
  if(!state.purchases.length) return `<div class="empty">Целей пока нет</div>`;
  return `<div class="tableWrap"><table class="goalsMiniTable"><thead><tr><th>Цель</th><th>Накоплено</th><th>Осталось</th><th>Прогресс</th></tr></thead><tbody>${state.purchases.map(g=>`<tr><td>${escapeHtml(g.name)}</td><td>${rub(goalAccumulated(g))}</td><td>${rub(goalRemaining(g))}</td><td>${progressBar(goalProgress(g))}<span class="pill">${pct(goalProgress(g))}</span></td></tr>`).join('')}</tbody></table></div>`;
}
function monthTabs(){
 return `<div class="monthTabs">${state.months.map(m=>`<button class="${m===currentMonth?'active':''} ${isMonthArchived(m)?'archivedTab':''}" onclick="currentMonth='${m}';render()">${m}${isMonthArchived(m)?' · архив':''}</button>`).join('')}</div>`
}
function renderMonths(){
  const rows=state.expenses.filter(x=>x.month===currentMonth);
  const t=totals(currentMonth);
  const archived = isMonthArchived(currentMonth);
  document.getElementById('months').innerHTML = `${monthTabs()}${archived?'<div class="card archiveNotice">Этот месяц архивирован. Редактирование расходов отключено.</div>':''}${notificationPanel(currentMonth)}<div class="grid" style="margin-bottom:14px">${kpi('Доходы',rub(t.incomes))}${kpi('Расходы факт',rub(t.expensesFact))}${kpi('Остаток',rub(t.freeFact))}${kpi('В цели',rub(t.goalAllocated))}</div><div class="card">
    <div class="toolbar"><h3>${currentMonth} — расходы ${archivedNote(currentMonth)}</h3><div class="toolbarActions">${bulkDeleteButton('expenses', archived)}<button class="primary" onclick="addExpense()" ${archived?'disabled':''}>Добавить расход</button></div></div>
    ${expenseForm()}
    <div class="tableWrap">${expenseTable(rows)}</div></div>`;
}
function expenseForm(){
 const disabled = archivedAttr(currentMonth);
 return `<div class="formrow">
   <select id="exCat" ${disabled}>${options(state.expenseCategories)}</select><input id="exPlan" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Плановая сумма" ${disabled}><input id="exFact" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Факт оплачено" ${disabled}><input id="exDate" type="date" ${disabled}>
   <label class="paidLabel"><input id="exPaid" type="checkbox" ${disabled}> Оплачено</label><select id="exPriority" ${disabled}>${options(state.priorities,'Средний')}</select>
   <textarea id="exComment" placeholder="Комментарий" ${disabled}></textarea>
 </div>`;
}
function expenseTable(rows){
 if(!rows.length) return `<div class="empty">Записей нет</div>`;
 const disabled = archivedAttr(currentMonth);
 return `<table class="expenseTable"><thead><tr><th class="checkCol"><input type="checkbox" ${rows.length && rows.every(x=>selected.expenses.has(x.id))?'checked':''} onchange="toggleVisible('expenses', this.checked)"></th><th>Категория</th><th>План</th><th>Факт</th><th>Дата</th><th>Оплачено</th><th>Комментарий</th><th>Приоритет</th><th></th></tr></thead><tbody>
 ${rows.map(x=>`<tr>
 <td class="checkCol"><input type="checkbox" ${selected.expenses.has(x.id)?'checked':''} onchange="toggleOne('expenses','${x.id}',this.checked)" ${disabled}></td>
 <td><select onchange="upd('expenses','${x.id}','category',this.value)" ${disabled}>${options(state.expenseCategories,x.category)}</select></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.planAmount)}" oninput="amountInput(this,'expenses','${x.id}','planAmount')" onblur="amountBlur(this,'expenses','${x.id}','planAmount');render()" placeholder="0" ${disabled}></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.factAmount)}" oninput="amountInput(this,'expenses','${x.id}','factAmount')" onblur="amountBlur(this,'expenses','${x.id}','factAmount');render()" placeholder="0" ${disabled}></td>
 <td><input type="date" value="${escapeHtml(x.date)}" onchange="upd('expenses','${x.id}','date',this.value)" ${disabled}></td>
 <td><label class="paidCell"><input type="checkbox" ${x.paid || x.status==='Оплачено'?'checked':''} onchange="upd('expenses','${x.id}','paid',this.checked)" ${disabled}> ${expenseStatusPill(x)}</label></td>
 <td><textarea class="commentBox" oninput="upd('expenses','${x.id}','comment',this.value)" ${disabled}>${escapeHtml(x.comment)}</textarea></td>
 <td><select onchange="upd('expenses','${x.id}','priority',this.value)" ${disabled}>${options(state.priorities,x.priority)}</select></td>
 <td><button class="danger" onclick="del('expenses','${x.id}')" ${disabled}>Удалить</button></td></tr>`).join('')}</tbody></table>`;
}
function addExpense(){
 if(isMonthArchived(currentMonth)){alert('Месяц архивирован. Сначала разархивируй его в настройках.'); return;}
 const item={id:uid('e'),month:currentMonth,category:val('exCat'),planAmount:cleanAmountValue(val('exPlan'), true),factAmount:cleanAmountValue(val('exFact'), true),date:val('exDate'),status:'План',paid:false,comment:val('exComment'),priority:val('exPriority')};
 if(document.getElementById('exPaid')?.checked){ setExpensePaid(item, true); } else { syncExpensePaid(item); }
 state.expenses.push(item); save(); render();
}
function renderIncome(){
 document.getElementById('income').innerHTML=`<div class="card"><div class="toolbar"><h3>Доходы</h3><div class="toolbarActions">${bulkDeleteButton('incomes')}<button class="primary" onclick="addIncome()">Добавить доход</button></div></div>
 <div class="formrow"><input id="inDate" type="date"><select id="inMonth">${options(state.months,currentMonth)}</select><select id="inType">${options(state.incomeTypes)}</select><input id="inAmount" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Сумма"><input id="inComment" placeholder="Комментарий"></div>
 <div class="tableWrap">${incomeTable()}</div></div>`;
}
function incomeTable(){
 if(!state.incomes.length) return `<div class="empty">Доходов нет</div>`;
 return `<table class="incomeTable"><thead><tr><th class="checkCol"><input type="checkbox" ${state.incomes.length && state.incomes.every(x=>selected.incomes.has(x.id))?'checked':''} onchange="toggleVisible('incomes', this.checked)"></th><th>Дата</th><th>Месяц</th><th>Источник</th><th>Сумма</th><th>Комментарий</th><th></th></tr></thead><tbody>
 ${state.incomes.map(x=>{const disabled=archivedAttr(x.month);return `<tr><td class="checkCol"><input type="checkbox" ${disabled} ${selected.incomes.has(x.id)?'checked':''} onchange="toggleOne('incomes','${x.id}',this.checked)"></td><td><input type="date" value="${x.date}" onchange="upd('incomes','${x.id}','date',this.value)" ${disabled}></td><td><select onchange="upd('incomes','${x.id}','month',this.value)" ${disabled}>${options(state.months,x.month)}</select></td><td><select onchange="upd('incomes','${x.id}','type',this.value);upd('incomes','${x.id}','source',this.value)" ${disabled}>${options(state.incomeTypes,x.type || x.source)}</select></td><td><input ${amountAttrs()} value="${escapeHtml(x.amount)}" oninput="amountInput(this,'incomes','${x.id}','amount')" onblur="amountBlur(this,'incomes','${x.id}','amount');render()" placeholder="0" ${disabled}></td><td><input value="${escapeHtml(x.comment)}" oninput="upd('incomes','${x.id}','comment',this.value)" ${disabled}></td><td><button class="danger" onclick="del('incomes','${x.id}')" ${disabled}>Удалить</button></td></tr>`}).join('')}</tbody></table>`
}
function addIncome(){if(isMonthArchived(val('inMonth'))){alert('Этот месяц архивирован. Сначала разархивируй его в настройках.'); return;} state.incomes.push({id:uid('i'),date:val('inDate'),month:val('inMonth'),source:val('inType'),amount:cleanAmountValue(val('inAmount'), true),type:val('inType'),comment:val('inComment')}); save(); render();}
function renderPurchases(){
 const totalPercent = state.purchases.reduce((s,x)=>s+num(x.percent),0);
 document.getElementById('purchases').innerHTML=`<div class="card"><div class="toolbar"><h3>Планы и цели</h3><div class="toolbarActions"><span class="pill">Проценты: ${pct(totalPercent)}</span>${bulkDeleteButton('purchases')}<button class="primary" onclick="addPurchase()">Добавить цель</button></div></div>
 <p style="color:var(--muted);margin-top:-4px">Каждый месяц свободный остаток автоматически распределяется по целям. Накопления переходят дальше.</p>
 <div class="formrow"><input id="puName" placeholder="Цель / покупка"><input id="puTarget" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Целевая сумма"><input id="puPercent" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="% от остатка"><input id="puInitial" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Уже накоплено"><input id="puDate" type="date" title="Дата цели"><label class="paidLabel"><input id="puReserve" type="checkbox"> Резерв</label><select id="puPr">${options(state.priorities,'Средний')}</select><select id="puSt">${options(state.statuses)}</select><input id="puComment" placeholder="Комментарий"></div>
 <div class="tableWrap">${purchaseTable()}</div></div>`;
}
function purchaseTable(){
 if(!state.purchases.length) return `<div class="empty">Целей пока нет</div>`;
 return `<table class="purchaseTable"><thead><tr><th class="checkCol"><input type="checkbox" ${state.purchases.length && state.purchases.every(x=>selected.purchases.has(x.id))?'checked':''} onchange="toggleVisible('purchases', this.checked)"></th><th>Цель / покупка</th><th>Целевая сумма</th><th>% от остатка</th><th>Уже было</th><th>В этом месяце</th><th>Накоплено</th><th>Осталось</th><th>Прогресс</th><th>Нужно / мес</th><th>Дата</th><th>Тип</th><th>Приоритет</th><th>Статус</th><th></th></tr></thead><tbody>${state.purchases.map(x=>`<tr>
 <td class="checkCol"><input type="checkbox" ${selected.purchases.has(x.id)?'checked':''} onchange="toggleOne('purchases','${x.id}',this.checked)"></td>
 <td><input value="${escapeHtml(x.name)}" oninput="upd('purchases','${x.id}','name',this.value)"></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.targetAmount)}" oninput="amountInput(this,'purchases','${x.id}','targetAmount')" onblur="amountBlur(this,'purchases','${x.id}','targetAmount');render()"></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.percent)}" oninput="amountInput(this,'purchases','${x.id}','percent')" onblur="amountBlur(this,'purchases','${x.id}','percent');render()"></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.initialAmount)}" oninput="amountInput(this,'purchases','${x.id}','initialAmount')" onblur="amountBlur(this,'purchases','${x.id}','initialAmount');render()"></td>
 <td><span class="pill">${rub(goalMonthAmount(x,currentMonth))}</span></td>
 <td><span class="pill">${rub(goalAccumulated(x,currentMonth))}</span></td>
 <td><span class="pill">${rub(goalRemaining(x,currentMonth))}</span></td>
 <td>${progressBar(goalProgress(x,currentMonth))}<span class="pill">${pct(goalProgress(x,currentMonth))}</span></td>
 <td><span class="pill">${rub(goalMonthlyNeed(x))}</span></td>
 <td><input type="date" value="${escapeHtml(x.targetDate)}" onchange="upd('purchases','${x.id}','targetDate',this.value);render()"></td>
 <td><label class="paidCell"><input type="checkbox" ${x.reserve?'checked':''} onchange="upd('purchases','${x.id}','reserve',this.checked);render()"> ${x.reserve?'Резерв':'Цель'}</label></td>
 <td><select onchange="upd('purchases','${x.id}','priority',this.value)">${options(state.priorities,x.priority)}</select></td><td><select onchange="upd('purchases','${x.id}','status',this.value)">${options(state.statuses,x.status)}</select></td><td><button class="danger" onclick="del('purchases','${x.id}')">Удалить</button></td></tr>`).join('')}</tbody></table>`
}
function addPurchase(){state.purchases.push({id:uid('p'),name:val('puName'),targetAmount:cleanAmountValue(val('puTarget'), true),percent:cleanAmountValue(val('puPercent'), true),initialAmount:cleanAmountValue(val('puInitial'), true),targetDate:val('puDate'),reserve:!!document.getElementById('puReserve')?.checked,priority:val('puPr'),status:val('puSt'),comment:val('puComment')}); save(); render();}
function renderBalance(){document.getElementById('balance').innerHTML=`<div class="card"><h3>Остатки</h3>${balanceTable()}</div>`}
function balanceTable(){return `<div class="tableWrap"><table class="balanceTable"><thead><tr><th>Месяц</th><th>Доходы</th><th>План расходов</th><th>Факт расходов</th><th>Свободный остаток</th><th>В цели</th><th>Не распределено</th></tr></thead><tbody>${state.months.map(m=>{const t=totals(m);return `<tr><td>${m}</td><td>${rub(t.incomes)}</td><td>${rub(t.expensesPlan)}</td><td>${rub(t.expensesFact)}</td><td>${rub(t.freeFact)}</td><td>${rub(t.goalAllocated)}</td><td>${rub(t.undistributed)}</td></tr>`}).join('')}</tbody></table></div>`}

function renderSearch(){
  const el = document.getElementById('search');
  if(!el) return;
  const q = searchQuery.trim().toLowerCase();
  const scope = searchScope;
  const rows=[];
  if(q || scope === 'upcoming'){
    if(scope==='all' || scope==='expenses' || scope==='upcoming'){
      state.expenses.forEach(x=>{
        const hay=[x.month,x.category,x.planAmount,x.factAmount,x.date,x.comment,x.priority,x.status].join(' ').toLowerCase();
        const isUpcoming = scope==='upcoming' ? (!x.paid && x.date && dateDiffDays(x.date)!==null && dateDiffDays(x.date)>=0 && dateDiffDays(x.date)<=30) : true;
        if(isUpcoming && (!q || hay.includes(q))) rows.push({type:'Расход', month:x.month, title:x.category, amount:x.factAmount || x.planAmount, date:x.date, comment:x.comment, status:x.paid?'Оплачено':'Не оплачено'});
      });
    }
    if(scope==='all' || scope==='incomes'){
      state.incomes.forEach(x=>{const hay=[x.month,x.type,x.source,x.amount,x.date,x.comment].join(' ').toLowerCase(); if(hay.includes(q)) rows.push({type:'Доход', month:x.month, title:x.type || x.source || 'Доход', amount:x.amount, date:x.date, comment:x.comment, status:'+'});});
    }
    if(scope==='all' || scope==='goals'){
      state.purchases.forEach(x=>{const hay=[x.name,x.targetAmount,x.percent,x.initialAmount,x.priority,x.status,x.comment].join(' ').toLowerCase(); if(hay.includes(q)) rows.push({type:'Цель', month:'-', title:x.name, amount:x.targetAmount, date:x.targetDate || '', comment:x.comment, status:x.status});});
    }
  }
  el.innerHTML = `<div class="card"><h3>Поиск</h3><p class="mutedText">Ищет по расходам, доходам, целям, комментариям, датам и суммам.</p><div class="formrow searchForm"><input id="searchInput" placeholder="Например: патент, телефон, продукты" value="${escapeHtml(searchQuery)}" oninput="searchQuery=this.value;renderSearch()"><select id="searchScope" onchange="searchScope=this.value;renderSearch()"><option value="all" ${scope==='all'?'selected':''}>Все разделы</option><option value="expenses" ${scope==='expenses'?'selected':''}>Расходы</option><option value="incomes" ${scope==='incomes'?'selected':''}>Доходы</option><option value="goals" ${scope==='goals'?'selected':''}>Цели</option><option value="upcoming" ${scope==='upcoming'?'selected':''}>Ближайшие платежи</option></select></div></div><div class="card"><h3>Результаты ${rows.length?`(${rows.length})`:''}</h3>${searchResultsTable(rows)}</div>`;
  const input=document.getElementById('searchInput'); if(input && document.activeElement!==input){ input.focus(); input.setSelectionRange(input.value.length,input.value.length); }
}
function searchResultsTable(rows){
  if(!rows.length) return `<div class="empty">Введите запрос или выберите «Ближайшие платежи».</div>`;
  return `<div class="tableWrap"><table class="searchTable"><thead><tr><th>Тип</th><th>Месяц</th><th>Название</th><th>Сумма</th><th>Дата</th><th>Статус</th><th>Комментарий</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${escapeHtml(r.type)}</td><td>${escapeHtml(r.month)}</td><td>${escapeHtml(r.title)}</td><td>${rub(r.amount)}</td><td>${escapeHtml(r.date)}</td><td>${escapeHtml(r.status)}</td><td>${escapeHtml(r.comment)}</td></tr>`).join('')}</tbody></table></div>`;
}
function renderSettings(){
 const tabs=[['account','Аккаунт'],['appearance','Внешний вид'],['data','Импорт / экспорт'],['maintenance','Обслуживание'],['months','Месяцы и архив'],['recurring','Повторяющиеся'],['categories','Категории расходов']];
 const tabButtons = `<div class="settingsTabs">${tabs.map(([id,title])=>`<button class="${settingsTab===id?'active':''}" onclick="settingsTab='${id}';renderSettings()">${title}</button>`).join('')}</div>`;
 let content='';
 if(settingsTab === 'account'){
  content = `${cloudPanel()}`;
 }
 if(settingsTab === 'appearance'){
  content = `<div class="card"><h3>Тема оформления</h3><p class="mutedText">Светлая тема остается как сейчас. Темная тема сделана в спокойной графитово-коричневой палитре.</p><div class="themeChoices"><button class="themeChoice ${currentTheme==='light'?'active':''}" onclick="setTheme('light')"><span class="themePreview lightPreview"></span><strong>Светлая</strong><small>Текущий теплый стиль</small></button><button class="themeChoice ${currentTheme==='dark'?'active':''}" onclick="setTheme('dark')"><span class="themePreview darkPreview"></span><strong>Темная</strong><small>Графит + теплый акцент</small></button></div></div>`;
 }
 if(settingsTab === 'data'){
  content = `<div class="card"><h3>Импорт / экспорт</h3><p>Экспортируй резервную копию или импортируй данные из JSON. Можно выбрать все месяцы или один месяц.</p><div class="formrow settingsForm"><select id="dataMonthSelect"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select><button onclick="exportJson()">Экспорт</button><label class="fileBtn">Импорт<input type="file" accept="application/json" onchange="importJson(event)"></label></div></div>`;
 }
 if(settingsTab === 'maintenance'){
  content = `<div class="card"><h3>Обслуживание</h3><p class="mutedText">Редкие действия убраны в раскрывающиеся блоки, чтобы случайно ничего не удалить.</p>
  <details class="settingsBlock"><summary>Очистить суммы</summary><p>Оставляет строки, но удаляет суммы. Можно выбрать разделы и месяц.</p><select id="clearMonth"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select>${sectionChecks('clear')}<button onclick="clearAmounts()">Очистить суммы</button></details>
  <details class="settingsBlock"><summary>Пустой шаблон</summary><p>Удаляет записи в выбранных разделах. Архивные месяцы не изменяются.</p><select id="emptyMonth"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select>${sectionChecks('empty')}<button class="danger" onclick="resetData()">Удалить записи</button></details>
  </div>`;
 }
 if(settingsTab === 'months'){
  content = `<div class="card"><h3>Месяцы и архив</h3><p>Здесь можно копировать месяцы, архивировать завершенные периоды и разархивировать их при необходимости.</p>
  <details class="settingsBlock"><summary>Создать месяц на основе другого</summary><p>Копирует строки расходов из выбранного месяца в другой. По умолчанию суммы очищаются, чтобы новый месяц был как шаблон.</p><div class="formrow settingsForm"><select id="copyFromMonth">${options(state.months,currentMonth)}</select><select id="copyToMonth">${options(state.months)}</select><label><input type="checkbox" id="copyAmounts"> Копировать суммы тоже</label></div><button onclick="copyMonthTemplate()">Создать / заменить расходы месяца</button></details>
  <details class="settingsBlock"><summary>Архивирование месяцев</summary><p>Можно архивировать один месяц или все месяцы сразу. Для разархивации выбери нужные месяцы из списка архивов.</p><div class="formrow settingsForm"><select id="archiveMonth"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select><button onclick="archiveSelectedMonth()">Архивировать</button></div><div class="archiveList">${archiveChecks()}</div><button onclick="unarchiveSelectedMonths()">Разархивировать выбранные</button></details>
  </div>`;
 }

 if(settingsTab === 'recurring'){
  content = `<div class="card"><h3>Повторяющиеся платежи</h3><p class="mutedText">Создай правила для платежей, которые повторяются каждый месяц: патент, квартира, коммуналка, телефон, кредит. Правила можно редактировать или удалять ниже.</p>
  <div class="formrow"><select id="recCat">${options(state.expenseCategories)}</select><input id="recPlan" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Плановая сумма"><input id="recDay" inputmode="numeric" maxlength="2" placeholder="День месяца"><select id="recPriority">${options(state.priorities,'Обязательно')}</select><input id="recComment" placeholder="Комментарий"><button class="primary" onclick="addRecurringExpense()">Добавить правило</button></div>
  ${recurringMonthSelector()}
  <div class="tableWrap">${recurringTable()}</div></div>`;
 }
 if(settingsTab === 'categories'){
  content = `<div class="card compactCard categoriesSettings"><h3>Категории расходов</h3><p>Категории используются только в разделе «Расходы».</p><div class="compactAdd"><input id="newExpenseCat" placeholder="Новая категория расходов"><button class="primary" onclick="addCategory('expense')">Добавить</button></div><div class="tagGrid">${state.expenseCategories.map(c=>`<span class="tagItem"><span>${escapeHtml(c)}</span><button class="danger miniBtn" onclick="removeCategory('expense','${escapeHtml(c)}')">×</button></span>`).join('')}</div></div>`;
 }
 document.getElementById('settings').innerHTML=`${tabButtons}<div class="settingsTabContent">${content}</div>`;
}
function sectionChecks(prefix){
 return `<div class="settingsChecks">
  <label><input type="checkbox" id="${prefix}Expenses" checked> Расходы / месяцы</label>
  <label><input type="checkbox" id="${prefix}Incomes" checked> Доходы</label>
  <label><input type="checkbox" id="${prefix}Purchases" checked> Планы и цели</label>
 </div>`;
}
function selectedSections(prefix){
 const map=[['expenses',`${prefix}Expenses`],['incomes',`${prefix}Incomes`],['purchases',`${prefix}Purchases`]];
 return map.filter(([,id])=>document.getElementById(id)?.checked).map(([key])=>key);
}
function addCategory(type){
  const v=val('newExpenseCat').trim();
  if(v && !state.expenseCategories.includes(v)){state.expenseCategories.push(v); state.categories=state.expenseCategories; save(); render();}
}
function removeCategory(type,c){
  if(confirm('Удалить категорию?')){state.expenseCategories=state.expenseCategories.filter(x=>x!==c); state.categories=state.expenseCategories; save(); render();}
}

function recurringTable(){
  state.recurringExpenses ||= [];
  if(!state.recurringExpenses.length) return `<div class="empty">Правил пока нет</div>`;
  return `<table class="recurringTable"><thead><tr><th>Активно</th><th>Категория</th><th>Сумма</th><th>День</th><th>Приоритет</th><th>Комментарий</th><th></th></tr></thead><tbody>${state.recurringExpenses.map(r=>`<tr><td><input type="checkbox" ${r.active!==false?'checked':''} onchange="updRecurring('${r.id}','active',this.checked)"></td><td><select onchange="updRecurring('${r.id}','category',this.value)">${options(state.expenseCategories,r.category)}</select></td><td><input ${amountAttrs()} value="${escapeHtml(r.planAmount)}" oninput="amountInput(this);updRecurring('${r.id}','planAmount',this.value,true)" onblur="amountBlur(this);updRecurring('${r.id}','planAmount',this.value)"></td><td><input inputmode="numeric" maxlength="2" value="${escapeHtml(r.day)}" oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,2);updRecurring('${r.id}','day',this.value,true)" onblur="updRecurring('${r.id}','day',this.value)"></td><td><select onchange="updRecurring('${r.id}','priority',this.value)">${options(state.priorities,r.priority)}</select></td><td><input value="${escapeHtml(r.comment)}" oninput="updRecurring('${r.id}','comment',this.value,true)" onblur="updRecurring('${r.id}','comment',this.value)"></td><td><button class="danger" onclick="deleteRecurring('${r.id}')">Удалить</button></td></tr>`).join('')}</tbody></table>`;
}
function addRecurringExpense(){
  const day=String(val('recDay')).replace(/[^0-9]/g,'').slice(0,2);
  if(day && (Number(day)<1 || Number(day)>31)){alert('День месяца должен быть от 1 до 31'); return;}
  state.recurringExpenses ||= [];
  state.recurringExpenses.push(normalizeRecurringExpense({id:uid('r'),category:val('recCat'),planAmount:cleanAmountValue(val('recPlan'),true),day,priority:val('recPriority'),comment:val('recComment'),active:true}));
  save(); render();
}
function updRecurring(id,key,value,silent=false){
  const r=(state.recurringExpenses||[]).find(x=>x.id===id); if(!r) return;
  if(key==='planAmount') value=cleanAmountValue(value,false);
  if(key==='day') value=String(value).replace(/[^0-9]/g,'').slice(0,2);
  r[key]=value;
  save();
  if(!silent) render();
}
function deleteRecurring(id){
  if(confirm('Удалить правило повторяющегося платежа? Уже созданные расходы не удалятся.')){state.recurringExpenses=(state.recurringExpenses||[]).filter(x=>x.id!==id);save();render();}
}
function clearAmounts(){
  const sections=selectedSections('clear');
  const month=val('clearMonth');
  if(!sections.length){alert('Выбери хотя бы один раздел'); return;}
  if(month !== 'ALL' && isMonthArchived(month)){alert('Этот месяц архивирован. Сначала разархивируй его.'); return;}
  if(confirm('Очистить суммы? Архивные месяцы не изменяются.')){
    if(sections.includes('expenses')) state.expenses.forEach(x=>{if((month==='ALL'||x.month===month) && !isMonthArchived(x.month)){x.planAmount=''; x.factAmount='';}});
    if(sections.includes('incomes')) state.incomes.forEach(x=>{if((month==='ALL'||x.month===month) && !isMonthArchived(x.month)){x.amount='';}});
    if(sections.includes('purchases') && month==='ALL') state.purchases.forEach(x=>{x.targetAmount=''; x.percent=''; x.initialAmount='';});
    save(); render();
  }
}
function resetData(){
  const sections=selectedSections('empty');
  const month=val('emptyMonth');
  if(!sections.length){alert('Выбери хотя бы один раздел'); return;}
  if(month !== 'ALL' && isMonthArchived(month)){alert('Этот месяц архивирован. Сначала разархивируй его.'); return;}
  if(confirm('Удалить записи? Архивные месяцы не изменяются.')){
    if(sections.includes('expenses')) state.expenses=(month==='ALL'?state.expenses.filter(x=>isMonthArchived(x.month)):state.expenses.filter(x=>x.month!==month));
    if(sections.includes('incomes')) state.incomes=(month==='ALL'?state.incomes.filter(x=>isMonthArchived(x.month)):state.incomes.filter(x=>x.month!==month));
    if(sections.includes('purchases') && month==='ALL') state.purchases=[];
    selected.expenses.clear();selected.incomes.clear();selected.purchases.clear();
    save(); render();
  }
}
function copyMonthTemplate(){
  const from=val('copyFromMonth');
  const to=val('copyToMonth');
  const copyAmounts=!!document.getElementById('copyAmounts')?.checked;
  if(!from||!to){alert('Выбери месяц-источник и месяц-получатель'); return;}
  if(from===to){alert('Источник и получатель должны быть разными месяцами'); return;}
  if(isMonthArchived(to)){alert('Месяц-получатель архивирован. Сначала разархивируй его.'); return;}
  const source=state.expenses.filter(x=>x.month===from);
  if(!source.length){alert('В месяце-источнике нет расходов'); return;}
  if(confirm(`Заменить расходы месяца "${to}" строками из "${from}"?`)){
    state.expenses=state.expenses.filter(x=>x.month!==to);
    state.expenses.push(...source.map(x=>({...x,id:uid('e'),month:to,planAmount:copyAmounts?x.planAmount:'',factAmount:copyAmounts?x.factAmount:'',date:''})));
    currentMonth=to;
    save(); render();
  }
}
function archiveChecks(){
  if(!state.archivedMonths?.length) return '<p>Архивные месяцы: нет</p>';
  return `<p>Архивные месяцы:</p><div class="settingsChecks">${state.archivedMonths.map(m=>`<label><input type="checkbox" class="unarchiveMonth" value="${escapeHtml(m)}"> ${escapeHtml(m)}</label>`).join('')}</div>`;
}
function archiveSelectedMonth(){
  const month=val('archiveMonth');
  state.archivedMonths ||= [];
  const targets = month === 'ALL' ? state.months : [month];
  const toAdd = targets.filter(m=>!isMonthArchived(m));
  if(!toAdd.length){alert('Выбранные месяцы уже в архиве'); return;}
  if(confirm(month==='ALL' ? 'Архивировать все месяцы?' : `Архивировать ${month}? Редактирование будет отключено.`)){
    state.archivedMonths = [...new Set([...state.archivedMonths, ...toAdd])];
    save(); render();
  }
}
function unarchiveSelectedMonths(){
  const selectedMonths=[...document.querySelectorAll('.unarchiveMonth:checked')].map(x=>x.value);
  if(!selectedMonths.length){alert('Выбери архивные месяцы для разархивации'); return;}
  if(confirm(`Разархивировать выбранные месяцы: ${selectedMonths.length}?`)){
    state.archivedMonths = state.archivedMonths.filter(m=>!selectedMonths.includes(m));
    save(); render();
  }
}
function upd(list,id,key,value, opts={}){const item=state[list].find(x=>x.id===id); if(item){if(list!=='purchases' && item.month && isMonthArchived(item.month)){alert('Месяц архивирован. Сначала разархивируй его.'); render(); return;} if(key==='month' && isMonthArchived(value)){alert('Нельзя перенести запись в архивный месяц.'); render(); return;} if(['amount','planAmount','factAmount','targetAmount','initialAmount','percent'].includes(key)){value=cleanAmountValue(value, false);} if(list==='purchases' && key==='reserve'){item[key]=value === true || value === 'true';}
    else if(list==='expenses' && key==='paid'){setExpensePaid(item, value === true || value === 'true');} else {item[key]=value; if(list==='expenses' && ['planAmount','factAmount'].includes(key)) syncExpensePaid(item);} save(); if(!opts.silent && ['month','paid'].includes(key)) render();}}
function del(list,id){const item=state[list].find(x=>x.id===id); if(item?.month && isMonthArchived(item.month)){alert('Месяц архивирован. Сначала разархивируй его.'); return;} if(confirm('Удалить запись?')){state[list]=state[list].filter(x=>x.id!==id); selected[list].delete(id); save(); render();}}
function visibleRows(list){
  if(list==='expenses') return state.expenses.filter(x=>x.month===currentMonth);
  return state[list];
}
function toggleOne(list,id,checked){checked ? selected[list].add(id) : selected[list].delete(id); render();}
function toggleVisible(list,checked){visibleRows(list).forEach(x=>checked ? selected[list].add(x.id) : selected[list].delete(x.id)); render();}
function bulkDelete(list){const ids=[...selected[list]]; if(!ids.length){alert('Сначала выбери записи'); return;} const blocked=state[list].filter(x=>selected[list].has(x.id) && x.month && isMonthArchived(x.month)); if(blocked.length){alert('Среди выбранных записей есть архивный месяц. Сначала разархивируй его.'); return;} if(confirm(`Удалить выбранные записи: ${ids.length}?`)){state[list]=state[list].filter(x=>!selected[list].has(x.id)); selected[list].clear(); save(); render();}}
function pruneSelection(){['expenses','incomes','purchases'].forEach(list=>{const ids=new Set(state[list].map(x=>x.id)); selected[list].forEach(id=>{if(!ids.has(id)) selected[list].delete(id);});});}
function exportJson(){
  const month = val('dataMonthSelect') || 'ALL';
  let data = state;
  let filename = 'budget-data-all-months.json';
  if(month !== 'ALL'){
    data = {...state, expenses: state.expenses.filter(x=>x.month===month), incomes: state.incomes.filter(x=>x.month===month), exportScope:{month}};
    filename = `budget-data-${month}.json`;
  }
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=filename; a.click(); URL.revokeObjectURL(a.href)
}
function normalizeImportedBudget(raw){
  // Поддерживаем несколько вариантов резервной копии:
  // 1) обычный экспорт приложения;
  // 2) JSON из Supabase-строки { data: {...} };
  // 3) экспорт месячного файла с exportScope.
  let parsed = raw;
  if(parsed && parsed.data && typeof parsed.data === 'object' && (parsed.data.months || parsed.data.expenses || parsed.data.incomes || parsed.data.purchases)){
    parsed = parsed.data;
  }
  return migrateState({...seed, ...parsed});
}
function importJson(e){
  const input = e.target;
  const f = input.files && input.files[0];
  if(!f) return;
  const selectedMonth = val('dataMonthSelect') || 'ALL';
  const r = new FileReader();
  r.onload = async () => {
    try{
      const raw = JSON.parse(r.result);
      const imported = normalizeImportedBudget(raw);
      if(selectedMonth === 'ALL'){
        if(!confirm('Импортировать резервную копию за все месяцы? Текущие данные будут заменены.')){ input.value=''; return; }
        state = imported;
      } else {
        if(isMonthArchived(selectedMonth)){ alert('Этот месяц архивирован. Сначала разархивируй его.'); input.value=''; return; }
        if(!confirm(`Импортировать данные в месяц: ${selectedMonth}? Текущие доходы и расходы этого месяца будут заменены.`)){ input.value=''; return; }
        state.expenses = state.expenses.filter(x=>x.month!==selectedMonth).concat((imported.expenses||[]).map(x=>({...x,id:x.id||uid('e'),month:selectedMonth})));
        state.incomes = state.incomes.filter(x=>x.month!==selectedMonth).concat((imported.incomes||[]).map(x=>({...x,id:x.id||uid('i'),month:selectedMonth})));
        // Цели, резерв, категории и настройки — глобальные. При месячном импорте обновляем их только если они есть в файле.
        if(Array.isArray(imported.purchases) && imported.purchases.length) state.purchases = imported.purchases;
        if(Array.isArray(imported.reserveHistory)) state.reserveHistory = imported.reserveHistory;
        if(imported.reserve) state.reserve = imported.reserve;
        if(Array.isArray(imported.expenseCategories) && imported.expenseCategories.length){
          state.expenseCategories = imported.expenseCategories;
          state.categories = state.expenseCategories;
        }
      }
      currentMonth = state.months.includes(currentMonth) ? currentMonth : (state.months[0] || 'Январь');
      selected = { expenses: new Set(), incomes: new Set(), purchases: new Set() };
      save();
      render();
      // После импорта сразу отправляем данные в Supabase, чтобы другой телефон/ПК увидел изменения.
      if(cloudClient && cloudUser) await cloudSave(false);
      alert('Импортировано успешно');
    }catch(err){
      console.error('Import error:', err);
      alert('Ошибка импорта: файл не похож на резервную копию бюджета или поврежден.');
    }finally{
      input.value = '';
    }
  };
  r.onerror = () => { alert('Ошибка чтения файла'); input.value=''; };
  r.readAsText(f);
}


/* --- Release 2.2 fixes: dashboard order, scroll upcoming, global goals, recurring months --- */
function moneySearchToken(v){
  const n = num(v);
  if(!n) return String(v ?? '').toLowerCase();
  return [String(v ?? ''), n.toFixed(2), String(n), n.toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2})].join(' ').toLowerCase();
}
function haystack(parts){return parts.map(x=>moneySearchToken(x)).join(' ').toLowerCase();}

function purchasePaidAmount(p){
  if(!(p.paid || p.status === 'Оплачено')) return 0;
  return Math.min(num(p.factAmount) || num(p.targetAmount), num(p.targetAmount) || (num(p.factAmount)||0));
}
function purchaseProgress(p){
  const target = num(p.targetAmount);
  const value = isGoalPaid(p) ? purchasePaidAmount(p) : goalAllocatedAmount(p);
  return target ? Math.min(value / target * 100, 100) : 0;
}
function syncPurchasePaid(item){
  if(!item) return;
  const target = num(item.targetAmount);
  const fact = num(item.factAmount);
  if(target > 0 && fact >= target){ item.paid = true; item.status = 'Оплачено'; return; }
  if(!item.paidManual){ item.paid = false; if(item.status === 'Оплачено') item.status='План'; }
}
function setPurchasePaid(item, paid){
  if(!item) return;
  item.paidManual = !!paid;
  item.paid = !!paid;
  item.status = item.paid ? 'Оплачено' : 'План';
  if(item.paid && !num(item.factAmount)){
    const allocated = Math.min(goalAllocatedAmount(item), num(item.targetAmount) || goalAllocatedAmount(item));
    item.factAmount = cleanAmountValue(String(Math.max(allocated, 0)), true);
  }
}
function normalizePurchasesGlobal(){
  state.purchases = (state.purchases || []).map(x => ({
    id: x.id || uid('p'),
    name: x.name || x.purchase || 'Цель',
    targetAmount: cleanAmountValue(x.targetAmount ?? x.planAmount ?? '', true),
    factAmount: cleanAmountValue(x.factAmount ?? '', true),
    percent: cleanAmountValue(x.percent ?? '', true),
    paid: Boolean(x.paid || x.status === 'Оплачено'),
    paidManual: Boolean(x.paidManual || x.status === 'Оплачено'),
    priority: x.priority || 'Средний',
    status: x.status || (x.paid ? 'Оплачено' : 'План'),
    comment: x.comment || ''
  }));
}
normalizePurchasesGlobal();

function allGoalsPaid(){ return state.purchases.reduce((s,x)=>s+purchasePaidAmount(x),0); }
function allGoalsTarget(){ return state.purchases.reduce((s,x)=>s+num(x.targetAmount),0); }
function allGoalsRemaining(){ return Math.max(allGoalsTarget()-allGoalsPaid(),0); }
function allGoalsPercent(){ return state.purchases.reduce((s,x)=>s+num(x.percent),0); }

function notificationText(diff){
  if(diff < 0) return `просрочено на ${Math.abs(diff)} дн.`;
  if(diff === 0) return 'сегодня';
  if(diff === 1) return 'завтра';
  return `через ${diff} дн.`;
}
function upcomingPayments(days=14){
  const items=[];
  state.expenses.forEach(x=>{
    if(!x.date || x.paid || x.status==='Оплачено') return;
    const diff=dateDiffDays(x.date);
    if(diff!==null && diff<=days){
      const amount = Math.max(num(x.planAmount)-num(x.factAmount), 0) || num(x.planAmount) || num(x.factAmount);
      items.push({month:x.month, category:x.category, date:x.date, diff, amount, comment:x.comment});
    }
  });
  return items.sort((a,b)=>a.diff-b.diff || a.date.localeCompare(b.date));
}
function upcomingClass(diff){return diff < 0 ? 'overdue' : (diff <= 1 ? 'dueSoon' : '');}
function upcomingPanel(days=14){
  const items=upcomingPayments(days);
  if(!items.length) return `<div class="card"><h3>Ближайшие платежи и просрочки</h3><p class="mutedText">Нет неоплаченных платежей с датой на ближайшие ${days} дней и просрочек.</p></div>`;
  return `<div class="card"><div class="toolbar"><h3>Ближайшие платежи и просрочки</h3><span class="pill">${items.length}</span></div><div class="upcomingList scrollList">${items.map(x=>`<div class="upcomingItem ${upcomingClass(x.diff)}"><div><strong>${escapeHtml(x.category)}</strong><span>${escapeHtml(x.month)} · ${escapeHtml(x.date)} · ${notificationText(x.diff)}</span>${x.comment?`<small>${escapeHtml(x.comment)}</small>`:''}</div><b>${rub(x.amount)}</b></div>`).join('')}</div></div>`;
}

function totals(month){
  const incomes = state.incomes.filter(x=>x.month===month).reduce((s,x)=>s+num(x.amount),0);
  const expensesPlan = state.expenses.filter(x=>x.month===month).reduce((s,x)=>s+num(x.planAmount),0);
  const expensesFact = state.expenses.filter(x=>x.month===month).reduce((s,x)=>s+num(x.factAmount),0);
  const freePlan = incomes - expensesPlan;
  const freeFact = incomes - expensesFact;
  return {incomes, expensesPlan, expensesFact, purchasesPlan:0, purchasesFact:0, totalPlan:expensesPlan, totalFact:expensesFact, freePlan, freeFact, positiveFreeFact:Math.max(freeFact,0), goalAllocated:0, undistributed:freeFact};
}
function allTotals(){
  const base = state.months.reduce((a,m)=>{const t=totals(m); Object.keys(t).forEach(k=>a[k]=(a[k]||0)+t[k]); return a}, {});
  base.goalsPaid = allGoalsPaid();
  base.goalsTarget = allGoalsTarget();
  base.freeAfterGoals = (base.freeFact || 0) - base.goalsPaid;
  return base;
}
function goalsMini(){
  if(!state.purchases.length) return `<div class="empty">Целей пока нет</div>`;
  return `<div class="tableWrap"><table class="goalsMiniTable"><thead><tr><th>Цель</th><th>Приоритет</th><th>% от остатка</th><th>Оплачено</th><th>Осталось</th><th>Прогресс</th></tr></thead><tbody>${state.purchases.slice(0,8).map(g=>{const paid=purchasePaidAmount(g); const rem=Math.max(num(g.targetAmount)-paid,0); return `<tr><td>${escapeHtml(g.name)}</td><td>${escapeHtml(g.priority||'-')}</td><td>${pct(num(g.percent))}</td><td>${rub(paid)}</td><td>${rub(rem)}</td><td>${progressBar(purchaseProgress(g))}<span class="pill">${pct(purchaseProgress(g))}</span></td></tr>`}).join('')}</tbody></table></div>`;
}
function renderDashboard(){
  const t=totals(currentMonth);
  const year=allTotals();
  document.getElementById('dashboard').innerHTML = `
    <div class="card dashboardControls"><div><h3>Сводка за месяц</h3><p>Показывает доходы, расходы и свободный остаток за выбранный месяц. Цели считаются отдельно, без привязки к месяцу.</p></div><select onchange="currentMonth=this.value;render()">${options(state.months,currentMonth)}</select></div>
    <div class="dashSection"><h3>${currentMonth}: деньги за месяц</h3><div class="grid">${kpi('Доходы',rub(t.incomes),'сколько поступило')}${kpi('Расходы',rub(t.expensesFact),'факт по разделу «Расходы»')}${kpi('Свободный остаток',rub(t.freeFact),'доходы минус расходы')}${kpi('План расходов',rub(t.expensesPlan),'ожидаемые расходы')}</div></div>
    <div class="dashSection"><h3>Общая картина</h3><div class="grid">${kpi('Свободно за год',rub(year.freeFact),'сумма свободных остатков по месяцам')}${kpi('Оплаченные цели',rub(year.goalsPaid),'влияют на общий остаток')}${kpi('Свободно после целей',rub(year.freeAfterGoals),'годовой остаток минус оплаченные цели')}${kpi('Цели всего',rub(year.goalsTarget),'общая сумма целей')}</div></div>
    <div class="two">
      <div class="card"><h3>Планы и цели</h3><p class="mutedText">Цели не привязаны к месяцу. Процент показывает, какую долю свободного остатка ты планируешь направлять на цель.</p>${goalsMini()}</div>
      <div class="card"><h3>Остатки по месяцам</h3>${balanceTable()}</div>
    </div>
    <div class="dashboardBottom">${upcomingPanel(14)}</div>`;
}

function renderMonths(){
  const rows=state.expenses.filter(x=>x.month===currentMonth);
  const t=totals(currentMonth);
  const archived = isMonthArchived(currentMonth);
  document.getElementById('months').innerHTML = `${monthTabs()}${archived?'<div class="card archiveNotice">Этот месяц архивирован. Редактирование расходов отключено.</div>':''}<div class="grid" style="margin-bottom:14px">${kpi('Доходы',rub(t.incomes))}${kpi('Расходы факт',rub(t.expensesFact))}${kpi('Остаток',rub(t.freeFact))}${kpi('План расходов',rub(t.expensesPlan))}</div><div class="card">
    <div class="toolbar"><h3>${currentMonth} — расходы ${archivedNote(currentMonth)}</h3><div class="toolbarActions">${bulkDeleteButton('expenses', archived)}<button class="primary" onclick="addExpense()" ${archived?'disabled':''}>Добавить расход</button></div></div>
    ${expenseForm()}
    <div class="tableWrap">${expenseTable(rows)}</div></div>`;
}

function renderPurchases(){
  const goalsPaid = allGoalsPaid();
  const goalsTarget = allGoalsTarget();
  document.getElementById('purchases').innerHTML=`<div class="grid" style="margin-bottom:14px">${kpi('Цели всего',rub(goalsTarget))}${kpi('Оплачено',rub(goalsPaid))}${kpi('Осталось',rub(Math.max(goalsTarget-goalsPaid,0)))}${kpi('Процент распределения',pct(allGoalsPercent()))}</div><div class="card"><div class="toolbar"><h3>Планы и цели</h3><div class="toolbarActions">${bulkDeleteButton('purchases')}<button class="primary" onclick="addPurchase()">Добавить цель</button></div></div>
  <p class="mutedText">Цели не привязаны к месяцам. Оплаченные цели уменьшают общий свободный остаток, а не остаток конкретного месяца.</p>
  <div class="formrow"><input id="puName" placeholder="Цель / покупка"><input id="puTarget" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Целевая сумма"><input id="puFact" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Факт оплачено"><input id="puPercent" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="% от остатка"><select id="puPr">${options(state.priorities,'Средний')}</select><label class="paidLabel"><input id="puPaid" type="checkbox"> Оплачено</label><input id="puComment" placeholder="Комментарий"></div>
  <div class="tableWrap">${purchaseTable(state.purchases)}</div></div>`;
}
function purchaseTable(rows){
 if(!rows.length) return `<div class="empty">Целей пока нет</div>`;
 return `<table class="purchaseTable"><thead><tr><th class="checkCol"><input type="checkbox" ${rows.length && rows.every(x=>selected.purchases.has(x.id))?'checked':''} onchange="toggleVisible('purchases', this.checked)"></th><th>Цель / покупка</th><th>Цель</th><th>Факт</th><th>% от остатка</th><th>Осталось</th><th>Оплачено</th><th>Прогресс</th><th>Приоритет</th><th>Комментарий</th><th></th></tr></thead><tbody>${rows.map(x=>{const paidAmount=purchasePaidAmount(x); const remaining=Math.max(num(x.targetAmount)-paidAmount,0); return `<tr>
 <td class="checkCol"><input type="checkbox" ${selected.purchases.has(x.id)?'checked':''} onchange="toggleOne('purchases','${x.id}',this.checked)"></td>
 <td><input value="${escapeHtml(x.name)}" oninput="upd('purchases','${x.id}','name',this.value)"></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.targetAmount)}" oninput="amountInput(this,'purchases','${x.id}','targetAmount')" onblur="amountBlur(this,'purchases','${x.id}','targetAmount');render()"></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.percent)}" oninput="amountInput(this,'purchases','${x.id}','percent')" onblur="amountBlur(this,'purchases','${x.id}','percent');render()"></td>
 <td><span class="pill">${rub(remaining)}</span></td>
 <td><label class="paidCell"><input type="checkbox" ${x.paid || x.status==='Оплачено'?'checked':''} onchange="upd('purchases','${x.id}','paid',this.checked);render()"> ${x.paid || x.status==='Оплачено'?'Оплачено':'Не оплачено'}</label></td>
 <td>${progressBar(purchaseProgress(x))}<span class="pill">${pct(purchaseProgress(x))}</span></td>
 <td><select onchange="upd('purchases','${x.id}','priority',this.value)">${options(state.priorities,x.priority)}</select></td>
 <td><input value="${escapeHtml(x.comment)}" oninput="upd('purchases','${x.id}','comment',this.value)"></td>
 <td><button class="danger" onclick="del('purchases','${x.id}')">Удалить</button></td></tr>`}).join('')}</tbody></table>`;
}
function addPurchase(){
  const item={id:uid('p'),name:val('puName'),targetAmount:cleanAmountValue(val('puTarget'), true),factAmount:cleanAmountValue(val('puFact'), true),percent:cleanAmountValue(val('puPercent'), true),paid:!!document.getElementById('puPaid')?.checked,paidManual:!!document.getElementById('puPaid')?.checked,priority:val('puPr'),status:'План',comment:val('puComment')};
  syncPurchasePaid(item);
  if(item.paid) item.status='Оплачено';
  state.purchases.push(item); save(); render();
}
function balanceTable(){return `<div class="tableWrap"><table class="balanceTable"><thead><tr><th>Месяц</th><th>Доходы</th><th>План расходов</th><th>Факт расходов</th><th>Свободный остаток</th></tr></thead><tbody>${state.months.map(m=>{const t=totals(m);return `<tr><td>${m}</td><td>${rub(t.incomes)}</td><td>${rub(t.expensesPlan)}</td><td>${rub(t.expensesFact)}</td><td>${rub(t.freeFact)}</td></tr>`}).join('')}</tbody></table></div>`}


function normalizeSearchText(value){
  return String(value ?? '').toLowerCase().trim().replace(/ё/g,'е');
}
function normalizeSearchAmount(value){
  const raw = String(value ?? '').trim();
  if(!raw) return '';
  const onlyAmount = raw.replace(/\s/g,'').replace(',', '.');
  if(!/^\d+(\.\d{1,2})?$/.test(onlyAmount)) return '';
  return String(Number(onlyAmount).toFixed(2));
}
function searchMatch(parts, query){
  const q = normalizeSearchText(query);
  if(!q) return false;
  const amountQuery = normalizeSearchAmount(q);
  const text = parts.map(x => normalizeSearchText(x)).join(' ');
  if(text.includes(q)) return true;
  if(amountQuery){
    return parts.some(x => {
      const token = normalizeSearchAmount(x);
      return token && token === amountQuery;
    });
  }
  return false;
}
function renderSearch(){
  const el = document.getElementById('search'); if(!el) return;
  const q = searchQuery.trim();
  const scope = searchScope;
  const rows=[];
  const hasQuery = !!q;
  if(hasQuery || scope === 'upcoming'){
    if(scope==='all' || scope==='expenses' || scope==='upcoming'){
      state.expenses.forEach(x=>{
        const diff=dateDiffDays(x.date);
        const isUpcoming = scope==='upcoming' ? (!x.paid && x.date && diff!==null && diff<=30) : true;
        const parts=[x.month,x.category,x.planAmount,x.factAmount,x.date,x.comment,x.priority,x.status, x.paid?'оплачено':'не оплачено'];
        if(isUpcoming && (scope==='upcoming' ? (!hasQuery || searchMatch(parts,q)) : searchMatch(parts,q))){
          rows.push({type:'Расход', month:x.month, title:x.category, amount:x.factAmount || x.planAmount, date:x.date, comment:x.comment, status:x.paid?'Оплачено':'Не оплачено'});
        }
      });
    }
    if(scope==='all' || scope==='incomes'){
      state.incomes.forEach(x=>{
        const st=incomeStatus(x);
        const parts=[x.month,x.type,x.source,x.amount,x.date,x.comment,st.text];
        if(searchMatch(parts,q)) rows.push({type:'Доход', month:x.month, title:x.type || x.source || 'Доход', amount:x.amount, date:x.date, comment:x.comment, status:st.text});
      });
    }
    if(scope==='all' || scope==='goals'){
      state.purchases.forEach(x=>{
        const parts=[x.name,x.targetAmount,x.factAmount,x.percent,x.priority,x.status,x.comment,x.paid?'оплачено':'не оплачено'];
        if(searchMatch(parts,q)) rows.push({type:'Цель', month:'-', title:x.name, amount:(x.paid?purchasePaidAmount(x):goalAllocatedAmount(x)) || x.targetAmount, date:'', comment:x.comment, status:x.paid?'Оплачено':'План'});
      });
    }
  }
  const hint = scope==='upcoming'
    ? 'Показывает ближайшие платежи. Можно дополнительно отфильтровать их по тексту или сумме.'
    : 'Ищет только совпадения по расходам, доходам, целям, комментариям, датам и суммам. Суммы ищутся одинаково в формате 4400, 4400.00 или 4 400,00.';
  el.innerHTML = `<div class="card"><h3>Поиск</h3><p class="mutedText">${hint}</p><div class="formrow searchForm"><input id="searchInput" placeholder="Например: патент, 4400.00, телефон" value="${escapeHtml(searchQuery)}" oninput="searchQuery=this.value;renderSearch()"><select id="searchScope" onchange="searchScope=this.value;renderSearch()"><option value="all" ${scope==='all'?'selected':''}>Все разделы</option><option value="expenses" ${scope==='expenses'?'selected':''}>Расходы</option><option value="incomes" ${scope==='incomes'?'selected':''}>Доходы</option><option value="goals" ${scope==='goals'?'selected':''}>Цели</option><option value="upcoming" ${scope==='upcoming'?'selected':''}>Ближайшие платежи</option></select></div></div><div class="card"><h3>Результаты ${rows.length?`(${rows.length})`:''}</h3>${searchResultsTable(rows)}</div>`;
  const input=document.getElementById('searchInput'); if(input && document.activeElement!==input){ input.focus(); input.setSelectionRange(input.value.length,input.value.length); }
}

function recurringMonthSelector(){
  return `<details class="settingsBlock"><summary>Применить правила</summary><p>Выбери один или несколько месяцев, куда нужно добавить повторяющиеся платежи. По умолчанию месяц не выбран, чтобы правило случайно не создавало записи.</p><div class="recurringControls"><select id="recurringPreset" onchange="setRecurringPreset(this.value);this.value=''"><option value="">Быстрый выбор...</option><option value="current">Текущий месяц</option><option value="future">С текущего до декабря</option><option value="all">Все месяцы</option><option value="clear">Снять выбор</option></select></div><div class="settingsChecks monthChecks">${state.months.map(m=>`<label><input type="checkbox" class="recurringMonth" value="${escapeHtml(m)}"> ${escapeHtml(m)}</label>`).join('')}</div><div class="toolbarActions"><button onclick="applyRecurringSelectedMonths()">Создать платежи</button><button class="danger" onclick="deleteRecurringGeneratedSelectedMonths()">Удалить созданные по правилам</button></div></details>`;
}
function setRecurringPreset(mode){
  const checks=[...document.querySelectorAll('.recurringMonth')];
  checks.forEach(ch=>ch.checked=false);
  if(mode==='current') checks.forEach(ch=>{ch.checked = ch.value===currentMonth;});
  if(mode==='future') checks.forEach(ch=>{ch.checked = monthIndex(ch.value) >= monthIndex(currentMonth);});
  if(mode==='all') checks.forEach(ch=>ch.checked=true);
}
function recurringSelectedMonths(){return [...document.querySelectorAll('.recurringMonth:checked')].map(x=>x.value);}
function applyRecurringSelectedMonths(){
  const months=recurringSelectedMonths();
  if(!months.length){alert('Выбери хотя бы один месяц'); return;}
  let added=0;
  months.forEach(month=>{
    if(isMonthArchived(month)) return;
    (state.recurringExpenses||[]).filter(r=>r.active!==false).forEach(r=>{
      const key=recurringKey(r,month);
      if(!state.expenses.some(e=>e.recurringKey===key)){
        state.expenses.push(normalizeExpense({id:uid('e'),month,category:r.category,planAmount:r.planAmount,factAmount:'',date:r.day?dateForMonthDay(month,r.day):'',status:'План',paid:false,paidManual:false,comment:r.comment||'Повторяющийся платеж',priority:r.priority,recurringKey:key}));
        added++;
      }
    });
  });
  if(added){save();render();}
  alert(added ? `Добавлено платежей: ${added}` : 'Новых повторяющихся платежей нет');
}
function deleteRecurringGeneratedSelectedMonths(){
  const months=recurringSelectedMonths();
  if(!months.length){alert('Выбери хотя бы один месяц'); return;}
  const count=state.expenses.filter(x=>months.includes(x.month) && x.recurringKey).length;
  if(!count){alert('В выбранных месяцах нет платежей, созданных по правилам'); return;}
  if(confirm(`Удалить платежи, созданные по правилам: ${count}? Ручные расходы не будут удалены.`)){
    state.expenses=state.expenses.filter(x=>!(months.includes(x.month) && x.recurringKey));
    save(); render();
  }
}

function upd(list,id,key,value, opts={}){
  const item=state[list].find(x=>x.id===id);
  if(!item) return;
  if(list!=='purchases' && item.month && isMonthArchived(item.month)){alert('Месяц архивирован. Сначала разархивируй его.'); render(); return;}
  if(key==='month' && isMonthArchived(value)){alert('Нельзя перенести запись в архивный месяц.'); render(); return;}
  if(['amount','planAmount','factAmount','targetAmount','initialAmount','percent'].includes(key)){value=cleanAmountValue(value, false);}
  if(list==='expenses' && key==='paid') setExpensePaid(item, value === true || value === 'true');
  else if(list==='purchases' && key==='paid') setPurchasePaid(item, value === true || value === 'true');
  else { item[key]=value; if(list==='expenses' && ['planAmount','factAmount'].includes(key)) syncExpensePaid(item); if(list==='purchases' && ['targetAmount','factAmount'].includes(key)) syncPurchasePaid(item); }
  save();
  if(!opts.silent && ['month','paid'].includes(key)) render();
}
function visibleRows(list){
  if(list==='expenses') return state.expenses.filter(x=>x.month===currentMonth);
  if(list==='purchases') return state.purchases;
  return state[list];
}

init();

/* --- Release 2.3 fixes: priority goals, recurring selection persistence, dashboard cleanup --- */
let recurringMonthsSelection = new Set();
const goalPriorityWeights = {'Обязательно':4,'Высокий':3,'Средний':2,'Низкий':1};
function unpaidGoals(){ return (state.purchases || []).filter(g=>!(g.paid || g.status === 'Оплачено')); }
function allGoalsTarget(){ return unpaidGoals().reduce((s,x)=>s+num(x.targetAmount),0); }
function goalAllocationBase(){ return Math.max((allTotalsNoGoals().freeFact || 0) - allGoalsPaid(), 0); }
function goalAllocatedAmount(g){ return goalAllocationBase() * num(g.percent) / 100; }
function allGoalsAllocatedByPercent(){ return unpaidGoals().reduce((s,g)=>s+goalAllocatedAmount(g),0); }
function autoDistributeGoalPercents(){
  const goals = unpaidGoals();
  if(!goals.length){ alert('Нет неоплаченных целей для распределения'); return; }
  const totalWeight = goals.reduce((s,g)=>s+(goalPriorityWeights[g.priority] || 2),0);
  let used = 0;
  goals.forEach((g,idx)=>{
    let pctVal = totalWeight ? ((goalPriorityWeights[g.priority] || 2) / totalWeight * 100) : 0;
    if(idx < goals.length - 1){ pctVal = Math.round(pctVal * 100) / 100; used += pctVal; }
    else { pctVal = Math.max(0, Math.round((100 - used) * 100) / 100); }
    g.percent = String(pctVal.toFixed(2));
  });
  save(); render();
}
function renderDashboard(){
  const t=totals(currentMonth);
  const year=allTotals();
  document.getElementById('dashboard').innerHTML = `
    <div class="dashboardTopFull">${upcomingPanel(14)}</div>
    <div class="card dashboardControls"><div><h3>Сводка за месяц</h3><p>Показывает доходы, расходы и свободный остаток за выбранный месяц. Цели считаются отдельно, без привязки к месяцу.</p></div><select onchange="currentMonth=this.value;render()">${options(state.months,currentMonth)}</select></div>
    <div class="dashSection"><h3>${currentMonth}: деньги за месяц</h3><div class="grid">${kpi('Доходы',rub(t.incomes),'сколько поступило')}${kpi('Расходы',rub(t.expensesFact),'факт по разделу «Расходы»')}${kpi('Свободный остаток',rub(t.freeFact),'доходы минус расходы')}${kpi('План расходов',rub(t.expensesPlan),'ожидаемые расходы')}</div></div>
    <div class="dashSection"><h3>Общая картина</h3><div class="grid">${kpi('Оплаченные цели',rub(year.goalsPaid),'уже закрытые цели')}${kpi('Свободно после целей',rub(year.freeAfterGoals),'годовой остаток минус оплаченные цели')}${kpi('Цели всего',rub(year.goalsTarget),'только неоплаченные цели')}${kpi('По % распределения',rub(allGoalsAllocatedByPercent()),'сколько уйдет в неоплаченные цели по процентам')}</div></div>
    <div class="two">
      <div class="card"><h3>Планы и цели</h3><p class="mutedText">Процент показывает, какую долю свободного остатка направлять на каждую неоплаченную цель.</p>${goalsMini()}</div>
      <div class="card"><h3>Остатки по месяцам</h3>${balanceTable()}</div>
    </div>`;
}
function goalsMini(){
  if(!state.purchases.length) return `<div class="empty">Целей пока нет</div>`;
  return `<div class="tableWrap"><table class="goalsMiniTable"><thead><tr><th>Цель</th><th>Приоритет</th><th>%</th><th>Выделено</th><th>Осталось</th><th>Прогресс</th></tr></thead><tbody>${state.purchases.slice(0,8).map(g=>{const isPaid=g.paid||g.status==='Оплачено'; const shown=isPaid?purchasePaidAmount(g):goalAllocatedAmount(g); const rem=Math.max(num(g.targetAmount)-shown,0); return `<tr><td>${escapeHtml(g.name)}</td><td>${escapeHtml(g.priority||'-')}</td><td>${isPaid?'-':pct(num(g.percent))}</td><td>${rub(shown)}</td><td>${rub(rem)}</td><td>${progressBar(purchaseProgress(g))}<span class="pill">${pct(purchaseProgress(g))}</span></td></tr>`}).join('')}</tbody></table></div>`;
}
function renderPurchases(){
  const goalsPaid = allGoalsPaid();
  const goalsTarget = allGoalsTarget();
  document.getElementById('purchases').innerHTML=`<div class="grid" style="margin-bottom:14px">${kpi('Цели всего',rub(goalsTarget),'только неоплаченные')}${kpi('Оплачено',rub(goalsPaid),'закрытые цели')}${kpi('Осталось',rub(allGoalsRemaining()))}${kpi('По % распределения',rub(allGoalsAllocatedByPercent()))}</div><div class="card"><div class="toolbar"><div><h3>Планы и цели</h3><p class="mutedText">Цели не привязаны к месяцам. Процент распределяет общий свободный остаток после уже оплаченных целей.</p></div><div class="toolbarActions">${bulkDeleteButton('purchases')}<button onclick="autoDistributeGoalPercents()">Распределить % по приоритетам</button><button class="primary" onclick="addPurchase()">Добавить цель</button></div></div>
  <div class="formrow"><input id="puName" placeholder="Цель / покупка"><input id="puTarget" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Целевая сумма"><input id="puFact" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Факт оплачено"><input id="puPercent" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="% от остатка"><select id="puPr">${options(state.priorities,'Средний')}</select><label class="paidLabel"><input id="puPaid" type="checkbox"> Оплачено</label><input id="puComment" placeholder="Комментарий"></div>
  <div class="tableWrap">${purchaseTable(state.purchases)}</div></div>`;
}
function purchaseTable(rows){
 if(!rows.length) return `<div class="empty">Целей пока нет</div>`;
 return `<table class="purchaseTable"><thead><tr><th class="checkCol"><input type="checkbox" ${rows.length && rows.every(x=>selected.purchases.has(x.id))?'checked':''} onchange="toggleVisible('purchases', this.checked)"></th><th>Цель / покупка</th><th>Цель</th><th>Факт</th><th>% от остатка</th><th>Сумма по %</th><th>Осталось</th><th>Оплачено</th><th>Прогресс</th><th>Приоритет</th><th>Комментарий</th><th></th></tr></thead><tbody>${rows.map(x=>{const paidAmount=purchasePaidAmount(x); const remaining=Math.max(num(x.targetAmount)-paidAmount,0); const isPaid=x.paid || x.status==='Оплачено'; return `<tr>
 <td class="checkCol"><input type="checkbox" ${selected.purchases.has(x.id)?'checked':''} onchange="toggleOne('purchases','${x.id}',this.checked)"></td>
 <td><input value="${escapeHtml(x.name)}" oninput="upd('purchases','${x.id}','name',this.value)"></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.targetAmount)}" oninput="amountInput(this,'purchases','${x.id}','targetAmount')" onblur="amountBlur(this,'purchases','${x.id}','targetAmount');render()"></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.percent)}" oninput="amountInput(this,'purchases','${x.id}','percent')" onblur="amountBlur(this,'purchases','${x.id}','percent');render()" ${isPaid?'disabled':''}></td>
 <td><span class="pill">${rub(shownAmount)}</span></td>
 <td><span class="pill">${rub(remaining)}</span></td>
 <td><label class="paidCell"><input type="checkbox" ${isPaid?'checked':''} onchange="upd('purchases','${x.id}','paid',this.checked);render()"> ${isPaid?'Оплачено':'Не оплачено'}</label></td>
 <td>${progressBar(purchaseProgress(x))}<span class="pill">${pct(purchaseProgress(x))}</span></td>
 <td><select onchange="upd('purchases','${x.id}','priority',this.value)">${options(state.priorities,x.priority)}</select></td>
 <td><input value="${escapeHtml(x.comment)}" oninput="upd('purchases','${x.id}','comment',this.value)"></td>
 <td><button class="danger" onclick="del('purchases','${x.id}')">Удалить</button></td></tr>`}).join('')}</tbody></table>`;
}
function recurringMonthSelector(){
  return `<details class="settingsBlock"><summary>Применить правила</summary><p>Выбери один или несколько месяцев, куда нужно добавить повторяющиеся платежи.</p><div class="recurringControls"><select id="recurringPreset" onchange="setRecurringPreset(this.value);this.value=''"><option value="">Быстрый выбор...</option><option value="current">Текущий месяц</option><option value="future">С текущего до декабря</option><option value="all">Все месяцы</option><option value="clear">Снять выбор</option></select></div><div class="settingsChecks monthChecks">${state.months.map(m=>`<label><input type="checkbox" class="recurringMonth" value="${escapeHtml(m)}" ${recurringMonthsSelection.has(m)?'checked':''} onchange="toggleRecurringMonth('${escapeHtml(m)}',this.checked)"> ${escapeHtml(m)}</label>`).join('')}</div><div class="toolbarActions"><button onclick="applyRecurringSelectedMonths()">Создать платежи</button><button class="danger" onclick="deleteRecurringGeneratedSelectedMonths()">Удалить созданные по правилам</button></div></details>`;
}
function toggleRecurringMonth(month, checked){ checked ? recurringMonthsSelection.add(month) : recurringMonthsSelection.delete(month); }
function setRecurringPreset(mode){
  recurringMonthsSelection.clear();
  if(mode==='current') recurringMonthsSelection.add(currentMonth);
  if(mode==='future') state.months.forEach(m=>{ if(monthIndex(m) >= monthIndex(currentMonth)) recurringMonthsSelection.add(m); });
  if(mode==='all') state.months.forEach(m=>recurringMonthsSelection.add(m));
  renderSettings();
}
function recurringSelectedMonths(){return [...recurringMonthsSelection];}
function updRecurring(id,key,value,silent=false){
  const r=(state.recurringExpenses||[]).find(x=>x.id===id); if(!r) return;
  if(key==='planAmount') value=cleanAmountValue(value,false);
  if(key==='day') value=String(value).replace(/[^0-9]/g,'').slice(0,2);
  r[key]=value;
  save();
  if(!silent && key!=='active') renderSettings();
}

/* --- Release 2.4 fixes: goal percent cap --- */
function isGoalPaid(goal){ return !!(goal && (goal.paid || goal.status === 'Оплачено')); }
function goalPercentSum(excludeId=''){
  return (state.purchases || []).reduce((s,g)=>{
    if(isGoalPaid(g)) return s;
    if(excludeId && g.id === excludeId) return s;
    return s + num(g.percent);
  },0);
}
function goalPercentAvailable(goalId=''){
  return Math.max(0, 100 - goalPercentSum(goalId));
}
function clampGoalPercentValue(goalId, value){
  const clean = cleanAmountValue(value, true);
  const raw = Math.max(0, num(clean));
  const max = goalPercentAvailable(goalId);
  const capped = Math.min(raw, max);
  return String(Math.round(capped * 100) / 100);
}
function normalizeGoalPercentsLimit(){
  let used = 0;
  (state.purchases || []).forEach(g=>{
    if(isGoalPaid(g)) return;
    const val = Math.max(0, num(g.percent));
    const capped = Math.min(val, Math.max(0, 100 - used));
    if(String(g.percent ?? '') !== String(capped)) g.percent = capped ? String(Math.round(capped * 100) / 100) : '';
    used += capped;
  });
}
function goalPercentWarning(){
  const total = goalPercentSum();
  const left = Math.max(0, 100 - total);
  const cls = total >= 100 ? 'dangerText' : 'mutedText';
  return `<p class="${cls}">Распределено: <strong>${pct(total)}</strong>. Доступно: <strong>${pct(left)}</strong>. Общий процент по неоплаченным целям не может быть больше 100%.</p>`;
}
function addPurchase(){
  const percent = clampGoalPercentValue('', val('puPercent'));
  const item={id:uid('p'),name:val('puName'),targetAmount:cleanAmountValue(val('puTarget'), true),factAmount:'',percent,paid:false,paidManual:false,priority:val('puPr'),status:'План',comment:val('puComment')};
  if(!!document.getElementById('puPaid')?.checked) setPurchasePaid(item, true);
  state.purchases.push(item); normalizeGoalPercentsLimit(); save(); render();
}
function upd(list,id,key,value, opts={}){
  const item=state[list].find(x=>x.id===id);
  if(!item) return;
  if(list!=='purchases' && item.month && isMonthArchived(item.month)){alert('Месяц архивирован. Сначала разархивируй его.'); render(); return;}
  if(key==='month' && isMonthArchived(value)){alert('Нельзя перенести запись в архивный месяц.'); render(); return;}
  if(['amount','planAmount','factAmount','targetAmount','initialAmount','percent'].includes(key)){value=cleanAmountValue(value, false);}
  if(list==='purchases' && key==='percent'){
    value = clampGoalPercentValue(id, value);
  }
  if(list==='expenses' && key==='paid') setExpensePaid(item, value === true || value === 'true');
  else if(list==='purchases' && key==='paid'){
    setPurchasePaid(item, value === true || value === 'true');
  }
  else {
    item[key]=value;
    if(list==='expenses' && ['planAmount','factAmount'].includes(key)) syncExpensePaid(item);
    if(list==='purchases' && ['targetAmount','factAmount'].includes(key)) syncPurchasePaid(item);
  }
  if(list==='purchases') normalizeGoalPercentsLimit();
  save();
  if(!opts.silent && ['month','paid'].includes(key)) render();
}
function renderPurchases(){
  normalizeGoalPercentsLimit();
  const goalsPaid = allGoalsPaid();
  const goalsTarget = allGoalsTarget();
  document.getElementById('purchases').innerHTML=`<div class="grid" style="margin-bottom:14px">${kpi('Цели всего',rub(goalsTarget),'только неоплаченные')}${kpi('Оплачено',rub(goalsPaid),'закрытые цели')}${kpi('Осталось',rub(allGoalsRemaining()))}${kpi('По % распределения',rub(allGoalsAllocatedByPercent()))}</div><div class="card"><div class="toolbar"><div><h3>Планы и цели</h3><p class="mutedText">Цели не привязаны к месяцам. Процент распределяет общий свободный остаток после уже оплаченных целей.</p>${goalPercentWarning()}</div><div class="toolbarActions">${bulkDeleteButton('purchases')}<button onclick="autoDistributeGoalPercents()">Распределить % по приоритетам</button><button class="primary" onclick="addPurchase()">Добавить цель</button></div></div>
  <div class="formrow"><input id="puName" placeholder="Цель / покупка"><input id="puTarget" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Целевая сумма"><input id="puPercent" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this);this.value=clampGoalPercentValue('',this.value);" placeholder="% от остатка"><select id="puPr">${options(state.priorities,'Средний')}</select><label class="paidLabel"><input id="puPaid" type="checkbox"> Оплачено</label><input id="puComment" placeholder="Комментарий"></div>
  <div class="tableWrap">${purchaseTable(state.purchases)}</div></div>`;
}
function purchaseTable(rows){
 if(!rows.length) return `<div class="empty">Целей пока нет</div>`;
 return `<table class="purchaseTable"><thead><tr><th class="checkCol"><input type="checkbox" ${rows.length && rows.every(x=>selected.purchases.has(x.id))?'checked':''} onchange="toggleVisible('purchases', this.checked)"></th><th>Цель / покупка</th><th>Целевая сумма</th><th>% от остатка</th><th>Выделено</th><th>Осталось</th><th>Оплачено</th><th>Прогресс</th><th>Приоритет</th><th>Комментарий</th><th></th></tr></thead><tbody>${rows.map(x=>{const isPaid=x.paid || x.status==='Оплачено'; const allocated=goalAllocatedAmount(x); const paidAmount=purchasePaidAmount(x); const shownAmount=isPaid?paidAmount:allocated; const remaining=Math.max(num(x.targetAmount)-shownAmount,0); const available=goalPercentAvailable(x.id); return `<tr>
 <td class="checkCol"><input type="checkbox" ${selected.purchases.has(x.id)?'checked':''} onchange="toggleOne('purchases','${x.id}',this.checked)"></td>
 <td><input value="${escapeHtml(x.name)}" oninput="upd('purchases','${x.id}','name',this.value)"></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.targetAmount)}" oninput="amountInput(this,'purchases','${x.id}','targetAmount')" onblur="amountBlur(this,'purchases','${x.id}','targetAmount');render()"></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.percent)}" title="Доступно для этой цели: ${pct(available)}" oninput="amountInput(this,'purchases','${x.id}','percent')" onblur="amountBlur(this,'purchases','${x.id}','percent');this.value=clampGoalPercentValue('${x.id}',this.value);upd('purchases','${x.id}','percent',this.value);render()" ${isPaid?'disabled':''}></td>
 <td><span class="pill">${rub(shownAmount)}</span></td>
 <td><span class="pill">${rub(remaining)}</span></td>
 <td><label class="paidCell"><input type="checkbox" ${isPaid?'checked':''} onchange="upd('purchases','${x.id}','paid',this.checked);render()"> ${isPaid?'Оплачено':'Не оплачено'}</label></td>
 <td>${progressBar(purchaseProgress(x))}<span class="pill">${pct(purchaseProgress(x))}</span></td>
 <td><select onchange="upd('purchases','${x.id}','priority',this.value)">${options(state.priorities,x.priority)}</select></td>
 <td><input value="${escapeHtml(x.comment)}" oninput="upd('purchases','${x.id}','comment',this.value)"></td>
 <td><button class="danger" onclick="del('purchases','${x.id}')">Удалить</button></td></tr>`}).join('')}</tbody></table>`;
}

setTimeout(()=>{ try { normalizeGoalPercentsLimit(); save(); render(); } catch(e) { console.error(e); } }, 0);

/* --- Release 3: financial planning, reserve fund, stronger goals --- */
function ensureRelease3State(){
  state.reserveFund ||= {currentAmount:'', targetMonths:'3', note:''};
  state.purchases = (state.purchases || []).map(g => ({
    allocatedLocked: g.allocatedLocked || '',
    ...g
  }));
}
function averageMonthlyExpense(){
  const monthsWithData = state.months.filter(m => state.expenses.some(e => e.month === m && num(e.factAmount) > 0));
  const divisor = monthsWithData.length || 1;
  const total = state.months.reduce((s,m)=>s+totalsNoGoals(m).expensesFact,0);
  return total / divisor;
}
function reserveTargetAmount(){ return averageMonthlyExpense() * num(state.reserveFund?.targetMonths || 3); }
function reserveCurrentAmount(){ return num(state.reserveFund?.currentAmount); }
function reserveProgress(){ const target = reserveTargetAmount(); return target ? Math.min(100, reserveCurrentAmount()/target*100) : 0; }
function activeGoals(){ return (state.purchases || []).filter(g=>!isGoalPaid(g)); }
function goalMonthlyAmount(g){ return goalAllocatedAmount(g); }
function goalRemainingStrong(g){ return Math.max(num(g.targetAmount) - goalMonthlyAmount(g), 0); }
function goalMonthsEstimate(g){
  const monthly = goalMonthlyAmount(g);
  const remaining = Math.max(num(g.targetAmount) - monthly, 0);
  if(!remaining) return '0 мес.';
  if(!monthly) return 'нет %';
  return Math.ceil(remaining / monthly) + ' мес.';
}
function reserveCard(){
  ensureRelease3State();
  const target = reserveTargetAmount();
  const current = reserveCurrentAmount();
  return `<div class="card reserveCard"><div class="toolbar"><div><h3>Резервный фонд</h3><p class="mutedText">Отдельно от покупок. Цель считается от средних месячных расходов.</p></div></div>
    <div class="grid compactGrid">${kpi('Накоплено',rub(current))}${kpi('Цель резерва',rub(target),`${num(state.reserveFund.targetMonths)||3} мес. расходов`)}${kpi('Средние расходы',rub(averageMonthlyExpense()))}${kpi('Готовность',pct(reserveProgress()))}</div>
    ${progressBar(reserveProgress())}
    <div class="formrow reserveForm"><input id="reserveCurrent" ${amountAttrs()} value="${escapeHtml(state.reserveFund.currentAmount)}" oninput="amountInput(this)" onblur="amountBlur(this);state.reserveFund.currentAmount=this.value;save();render()" placeholder="Сколько уже есть в резерве"><select id="reserveMonths" onchange="state.reserveFund.targetMonths=this.value;save();render()"><option ${state.reserveFund.targetMonths==='3'?'selected':''}>3</option><option ${state.reserveFund.targetMonths==='6'?'selected':''}>6</option><option ${state.reserveFund.targetMonths==='9'?'selected':''}>9</option><option ${state.reserveFund.targetMonths==='12'?'selected':''}>12</option></select><input id="reserveNote" value="${escapeHtml(state.reserveFund.note||'')}" oninput="state.reserveFund.note=this.value;save()" placeholder="Комментарий"></div>
  </div>`;
}
function planningGoalsTable(){
  const goals = activeGoals();
  if(!goals.length) return `<div class="empty">Активных целей пока нет</div>`;
  return `<div class="tableWrap"><table><thead><tr><th>Цель</th><th>Приоритет</th><th>%</th><th>Выделено сейчас</th><th>Осталось после выделения</th><th>Оценка срока</th><th>Прогресс</th></tr></thead><tbody>${goals.map(g=>`<tr><td>${escapeHtml(g.name)}</td><td>${escapeHtml(g.priority||'-')}</td><td>${pct(num(g.percent))}</td><td>${rub(goalMonthlyAmount(g))}</td><td>${rub(goalRemainingStrong(g))}</td><td><span class="pill">${goalMonthsEstimate(g)}</span></td><td>${progressBar(purchaseProgress(g))}<span class="pill">${pct(purchaseProgress(g))}</span></td></tr>`).join('')}</tbody></table></div>`;
}
function renderDashboard(){
  ensureRelease3State();
  const t=totals(currentMonth);
  const year=allTotals();
  document.getElementById('dashboard').innerHTML = `
    <div class="dashboardTopFull">${upcomingPanel(14)}</div>
    <div class="card dashboardControls"><div><h3>Сводка за месяц</h3><p>Главные цифры по выбранному месяцу.</p></div><select onchange="currentMonth=this.value;render()">${options(state.months,currentMonth)}</select></div>
    <div class="dashSection"><h3>${currentMonth}: деньги за месяц</h3><div class="grid">${kpi('Доходы',rub(t.incomes))}${kpi('Расходы',rub(t.expensesFact))}${kpi('Свободный остаток',rub(t.freeFact))}${kpi('План расходов',rub(t.expensesPlan))}</div></div>
    <div class="dashSection"><h3>Планирование</h3><div class="grid">${kpi('Активные цели',rub(allGoalsTarget()))}${kpi('Выделено по %',rub(allGoalsAllocatedByPercent()))}${kpi('Свободно после целей',rub(year.freeAfterGoals))}${kpi('Резерв готов',pct(reserveProgress()))}</div></div>
    <div class="two">${reserveCard()}<div class="card"><h3>Цели: прогноз</h3><p class="mutedText">Оценка строится от текущего свободного остатка и процентов распределения.</p>${planningGoalsTable()}</div></div>
    <div class="card" style="margin-top:14px"><h3>Остатки по месяцам</h3>${balanceTable()}</div>`;
}
function renderPurchases(){
  ensureRelease3State();
  normalizeGoalPercentsLimit();
  const goalsPaid = allGoalsPaid();
  const goalsTarget = allGoalsTarget();
  document.getElementById('purchases').innerHTML=`${reserveCard()}<div class="grid" style="margin:14px 0">${kpi('Активные цели',rub(goalsTarget),'только неоплаченные')}${kpi('Закрыто целей',rub(goalsPaid))}${kpi('Осталось по целям',rub(allGoalsRemaining()))}${kpi('Выделено по %',rub(allGoalsAllocatedByPercent()))}</div><div class="card"><div class="toolbar"><div><h3>Планы и цели</h3><p class="mutedText">Цели не привязаны к месяцам. Процент распределяет общий свободный остаток. Резервный фонд ведется отдельно выше.</p>${goalPercentWarning()}</div><div class="toolbarActions">${bulkDeleteButton('purchases')}<button onclick="autoDistributeGoalPercents()">Распределить % по приоритетам</button><button class="primary" onclick="addPurchase()">Добавить цель</button></div></div>
  <div class="formrow"><input id="puName" placeholder="Цель / покупка"><input id="puTarget" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Целевая сумма"><input id="puPercent" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this);this.value=clampGoalPercentValue('',this.value);" placeholder="% от остатка"><select id="puPr">${options(state.priorities,'Средний')}</select><label class="paidLabel"><input id="puPaid" type="checkbox"> Оплачено</label><input id="puComment" placeholder="Комментарий"></div>
  <div class="tableWrap">${purchaseTable(state.purchases)}</div></div><div class="card" style="margin-top:14px"><h3>Прогноз по активным целям</h3>${planningGoalsTable()}</div>`;
}

/* --- Patch: Release 3 layout and goals remaining consistency --- */
function allGoalsRemaining(){
  return (state.purchases || [])
    .filter(g => !isGoalPaid(g))
    .reduce((sum, g) => sum + Math.max(num(g.targetAmount) - goalAllocatedAmount(g), 0), 0);
}
function renderDashboard(){
  ensureRelease3State();
  const t = totals(currentMonth);
  const year = allTotals();
  document.getElementById('dashboard').innerHTML = `
    <div class="dashboardTopFull">${upcomingPanel(14)}</div>
    <div class="card dashboardControls"><div><h3>Сводка за месяц</h3><p>Главные цифры по выбранному месяцу.</p></div><select onchange="currentMonth=this.value;render()">${options(state.months,currentMonth)}</select></div>
    <div class="dashSection"><h3>${currentMonth}: деньги за месяц</h3><div class="grid">${kpi('Доходы',rub(t.incomes))}${kpi('Расходы',rub(t.expensesFact))}${kpi('Свободный остаток',rub(t.freeFact))}${kpi('План расходов',rub(t.expensesPlan))}</div></div>
    <div class="dashSection"><h3>Планирование</h3><div class="grid">${kpi('Активные цели',rub(allGoalsTarget()))}${kpi('Осталось по целям',rub(allGoalsRemaining()))}${kpi('Свободно после целей',rub(year.freeAfterGoals))}${kpi('Резерв готов',pct(reserveProgress()))}</div></div>
    <div style="margin-top:14px">${reserveCard()}</div>
    <div class="card" style="margin-top:14px"><h3>Цели: прогноз</h3><p class="mutedText">Оценка строится от текущего свободного остатка и процентов распределения.</p>${planningGoalsTable()}</div>
    <div class="card" style="margin-top:14px"><h3>Остатки по месяцам</h3>${balanceTable()}</div>`;
}
function renderPurchases(){
  ensureRelease3State();
  normalizeGoalPercentsLimit();
  const goalsPaid = allGoalsPaid();
  const goalsTarget = allGoalsTarget();
  document.getElementById('purchases').innerHTML=`${reserveCard()}<div class="grid" style="margin:14px 0">${kpi('Активные цели',rub(goalsTarget),'только неоплаченные')}${kpi('Закрыто целей',rub(goalsPaid))}${kpi('Осталось по целям',rub(allGoalsRemaining()),'по активным целям')}${kpi('Выделено по %',rub(allGoalsAllocatedByPercent()))}</div><div class="card"><div class="toolbar"><div><h3>Планы и цели</h3><p class="mutedText">Цели не привязаны к месяцам. Процент распределяет общий свободный остаток. Резервный фонд ведется отдельно выше.</p>${goalPercentWarning()}</div><div class="toolbarActions">${bulkDeleteButton('purchases')}<button onclick="autoDistributeGoalPercents()">Распределить % по приоритетам</button><button class="primary" onclick="addPurchase()">Добавить цель</button></div></div>
  <div class="formrow"><input id="puName" placeholder="Цель / покупка"><input id="puTarget" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Целевая сумма"><input id="puPercent" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this);this.value=clampGoalPercentValue('',this.value);" placeholder="% от остатка"><select id="puPr">${options(state.priorities,'Средний')}</select><label class="paidLabel"><input id="puPaid" type="checkbox"> Оплачено</label><input id="puComment" placeholder="Комментарий"></div>
  <div class="tableWrap">${purchaseTable(state.purchases)}</div></div><div class="card" style="margin-top:14px"><h3>Прогноз по активным целям</h3>${planningGoalsTable()}</div>`;
}

/* --- Release 3.1: linked reserve fund and goals --- */
let reserveHistoryModalOpen = false;

function ensureReserveState(){
  state.reserveFund ||= {};
  state.reserveFund.currentAmount = cleanAmountValue(state.reserveFund.currentAmount ?? '', true);
  state.reserveFund.targetMonths = String(state.reserveFund.targetMonths || '3');
  state.reserveFund.percent = cleanAmountValue(state.reserveFund.percent ?? '30', true);
  state.reserveFund.note = state.reserveFund.note || '';
  state.reserveFund.transactions = Array.isArray(state.reserveFund.transactions) ? state.reserveFund.transactions : [];
}
function ensureRelease3State(){
  ensureReserveState();
  state.purchases = (state.purchases || []).map(g => ({ allocatedLocked: g.allocatedLocked || '', ...g }));
}
function reserveAvailableBase(){
  return Math.max((allTotalsNoGoals().freeFact || 0) - allGoalsPaid(), 0);
}
function reserveNeedAmount(){
  return Math.max(reserveTargetAmount() - reserveCurrentAmount(), 0);
}
function reserveIsFull(){
  return reserveNeedAmount() <= 0;
}
function reserveAutoAllocation(){
  ensureReserveState();
  if(reserveIsFull()) return 0;
  const base = reserveAvailableBase();
  const byPercent = base * Math.min(Math.max(num(state.reserveFund.percent),0),100) / 100;
  return Math.min(byPercent, reserveNeedAmount());
}
function goalAllocationBase(){
  return Math.max(reserveAvailableBase() - reserveAutoAllocation(), 0);
}
function allGoalsAllocatedByPercent(){
  return unpaidGoals().reduce((s,g)=>s+goalAllocatedAmount(g),0);
}
function allTotals(){
  const base = state.months.reduce((a,m)=>{const t=totals(m); Object.keys(t).forEach(k=>a[k]=(a[k]||0)+t[k]); return a}, {});
  base.goalsPaid = allGoalsPaid();
  base.goalsTarget = allGoalsTarget();
  base.reserveAllocation = reserveAutoAllocation();
  base.goalsAllocated = allGoalsAllocatedByPercent();
  base.freeAfterGoals = (base.freeFact || 0) - base.goalsPaid - base.reserveAllocation - base.goalsAllocated;
  return base;
}
function reserveTxRows(){
  ensureReserveState();
  const tx = [...state.reserveFund.transactions].sort((a,b)=>(b.date||'').localeCompare(a.date||'') || (b.id||'').localeCompare(a.id||''));
  if(!tx.length) return `<div class="empty">История резерва пока пустая</div>`;
  return `<div class="tableWrap reserveHistoryTable"><table><thead><tr><th>Дата</th><th>Операция</th><th>Сумма</th><th>Комментарий</th><th></th></tr></thead><tbody>${tx.map(t=>`<tr><td>${escapeHtml(t.date || '')}</td><td><span class="pill ${t.type==='spend'?'dangerPill':'okPill'}">${t.type==='spend'?'Списание':'Пополнение'}</span></td><td>${t.type==='spend'?'-':'+'}${rub(t.amount)}</td><td>${escapeHtml(t.comment || '')}</td><td><button class="danger" onclick="deleteReserveTransaction('${t.id}')">Удалить</button></td></tr>`).join('')}</tbody></table></div>`;
}
function showReserveHistory(){
  closeReserveHistory();
  const wrap=document.createElement('div');
  wrap.className='modalOverlay';
  wrap.id='reserveHistoryModal';
  wrap.innerHTML=`<div class="modalCard"><div class="toolbar"><div><h3>История резервного фонда</h3><p class="mutedText">Пополнения и списания резерва. История не засоряет основной экран.</p></div><button onclick="closeReserveHistory()">Закрыть</button></div>${reserveTxRows()}</div>`;
  document.body.appendChild(wrap);
}
function closeReserveHistory(){
  const el=document.getElementById('reserveHistoryModal');
  if(el) el.remove();
}
function addReserveTransaction(type){
  ensureReserveState();
  const amount = num(val('reserveTxAmount'));
  if(amount <= 0){ alert('Укажи сумму операции'); return; }
  const comment = val('reserveTxComment');
  const date = val('reserveTxDate') || new Date().toISOString().slice(0,10);
  const sign = type === 'spend' ? -1 : 1;
  const current = Math.max(0, reserveCurrentAmount() + sign * amount);
  state.reserveFund.currentAmount = cleanAmountValue(String(current), true);
  state.reserveFund.transactions.push({id:uid('rt'), type, amount, date, comment});
  save(); render();
}
function deleteReserveTransaction(id){
  ensureReserveState();
  const tx = state.reserveFund.transactions.find(x=>x.id===id);
  if(!tx) return;
  if(!confirm('Удалить операцию из истории резерва? Сумма резерва будет пересчитана обратно.')) return;
  const sign = tx.type === 'spend' ? 1 : -1;
  state.reserveFund.currentAmount = cleanAmountValue(String(Math.max(0, reserveCurrentAmount() + sign * num(tx.amount))), true);
  state.reserveFund.transactions = state.reserveFund.transactions.filter(x=>x.id!==id);
  save(); render();
  showReserveHistory();
}
function reserveCard(){
  ensureReserveState();
  const target = reserveTargetAmount();
  const current = reserveCurrentAmount();
  const need = reserveNeedAmount();
  const statusText = reserveIsFull() ? 'Резерв заполнен. Автосбор остановлен.' : `Нужно восстановить: ${rub(need)}`;
  return `<div class="card reserveCard"><div class="toolbar"><div><h3>Резервный фонд</h3><p class="mutedText">Резерв получает процент от свободного остатка первым. Когда цель достигнута, сбор автоматически останавливается. Если потратить резерв, восстановление включится снова.</p></div><button onclick="showReserveHistory()">История</button></div>
    <div class="grid compactGrid">${kpi('Уже есть',rub(current))}${kpi('Цель резерва',rub(target),`${num(state.reserveFund.targetMonths)||3} мес. расходов`)}${kpi('Осталось восстановить',rub(need))}${kpi('Оценка срока',reserveMonthsEstimate(),`готовность ${pct(reserveProgress())}`)}</div>
    ${progressBar(reserveProgress())}
    <p class="${reserveIsFull()?'okText':'mutedText'}"><strong>${statusText}</strong></p>
    <div class="formrow reserveForm"><input id="reserveCurrent" ${amountAttrs()} value="${escapeHtml(state.reserveFund.currentAmount)}" oninput="amountInput(this)" onblur="amountBlur(this);state.reserveFund.currentAmount=this.value;save();render()" placeholder="Сколько уже есть"><select id="reserveMonths" onchange="state.reserveFund.targetMonths=this.value;save();render()"><option ${state.reserveFund.targetMonths==='3'?'selected':''}>3</option><option ${state.reserveFund.targetMonths==='6'?'selected':''}>6</option><option ${state.reserveFund.targetMonths==='9'?'selected':''}>9</option><option ${state.reserveFund.targetMonths==='12'?'selected':''}>12</option></select><input id="reservePercent" ${amountAttrs()} value="${escapeHtml(state.reserveFund.percent)}" oninput="amountInput(this)" onblur="amountBlur(this);state.reserveFund.percent=String(Math.min(num(this.value),100));this.value=state.reserveFund.percent;save();render()" placeholder="% резерва от остатка"><input id="reserveNote" value="${escapeHtml(state.reserveFund.note||'')}" oninput="state.reserveFund.note=this.value;save()" placeholder="Комментарий"></div>
    <div class="reserveOps"><div class="formrow"><input id="reserveTxDate" type="date" value="${new Date().toISOString().slice(0,10)}"><input id="reserveTxAmount" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Сумма операции"><input id="reserveTxComment" placeholder="Комментарий к операции"><button class="primary" onclick="addReserveTransaction('add')">Пополнить</button><button class="danger" onclick="addReserveTransaction('spend')">Потратить</button></div></div>
  </div>`;
}
function goalPercentWarning(){
  const total = goalPercentSum();
  const left = Math.max(0, 100 - total);
  const cls = total >= 100 ? 'dangerText' : 'mutedText';
  return `<p class="${cls}">Резерв забирает <strong>${pct(num(state.reserveFund?.percent || 0))}</strong> от свободного остатка до заполнения. Цели распределяют оставшуюся часть. По целям распределено: <strong>${pct(total)}</strong>, доступно: <strong>${pct(left)}</strong>.</p>`;
}
function planningGoalsTable(){
  const goals = activeGoals();
  if(!goals.length) return `<div class="empty">Активных целей пока нет</div>`;
  return `<div class="tableWrap"><table><thead><tr><th>Цель</th><th>Приоритет</th><th>%</th><th>Выделено после резерва</th><th>Осталось после выделения</th><th>Оценка срока</th><th>Прогресс</th></tr></thead><tbody>${goals.map(g=>`<tr><td>${escapeHtml(g.name)}</td><td>${escapeHtml(g.priority||'-')}</td><td>${pct(num(g.percent))}</td><td>${rub(goalMonthlyAmount(g))}</td><td>${rub(goalRemainingStrong(g))}</td><td><span class="pill">${goalMonthsEstimate(g)}</span></td><td>${progressBar(purchaseProgress(g))}<span class="pill">${pct(purchaseProgress(g))}</span></td></tr>`).join('')}</tbody></table></div>`;
}
function renderDashboard(){
  ensureRelease3State();
  const t = totals(currentMonth);
  const year = allTotals();
  document.getElementById('dashboard').innerHTML = `
    <div class="dashboardTopFull">${upcomingPanel(14)}</div>
    <div class="card dashboardControls"><div><h3>Сводка за месяц</h3><p>Главные цифры по выбранному месяцу.</p></div><select onchange="currentMonth=this.value;render()">${options(state.months,currentMonth)}</select></div>
    <div class="dashSection"><h3>${currentMonth}: деньги за месяц</h3><div class="grid">${kpi('Доходы',rub(t.incomes))}${kpi('Расходы',rub(t.expensesFact))}${kpi('Свободный остаток',rub(t.freeFact))}${kpi('План расходов',rub(t.expensesPlan))}</div></div>
    <div class="dashSection"><h3>Планирование</h3><div class="grid">${kpi('Выделено на цели',rub(year.goalsAllocated))}${kpi('Свободно после целей',rub(year.freeAfterGoals))}${kpi('Резерв уже есть',rub(reserveCurrentAmount()))}${kpi('Резерв готов',pct(reserveProgress()))}</div></div>
    <div style="margin-top:14px">${reserveCard()}</div>
    <div class="card" style="margin-top:14px"><h3>Цели: прогноз</h3><p class="mutedText">Цели считаются от остатка после резерва. Если резерв заполнен, его процент больше не забирает деньги.</p>${planningGoalsTable()}</div>
    <div class="card" style="margin-top:14px"><h3>Остатки по месяцам</h3>${balanceTable()}</div>`;
}
function renderPurchases(){
  ensureRelease3State();
  normalizeGoalPercentsLimit();
  const goalsPaid = allGoalsPaid();
  const goalsTarget = allGoalsTarget();
  const year = allTotals();
  document.getElementById('purchases').innerHTML=`${reserveCard()}<div class="grid" style="margin:14px 0">${kpi('Активные цели',rub(goalsTarget),'только неоплаченные')}${kpi('Закрыто целей',rub(goalsPaid))}${kpi('Осталось по целям',rub(allGoalsRemaining()),'по активным целям')}${kpi('Доступно целям после резерва',rub(goalAllocationBase()))}</div><div class="card"><div class="toolbar"><div><h3>Планы и цели</h3><p class="mutedText">Цели не привязаны к месяцам. Проценты целей распределяются от суммы, которая остается после резерва.</p>${goalPercentWarning()}</div><div class="toolbarActions">${bulkDeleteButton('purchases')}<button onclick="autoDistributeGoalPercents()">Распределить % по приоритетам</button><button class="primary" onclick="addPurchase()">Добавить цель</button></div></div>
  <div class="formrow"><input id="puName" placeholder="Цель / покупка"><input id="puTarget" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Целевая сумма"><input id="puPercent" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this);this.value=clampGoalPercentValue('',this.value);" placeholder="% от остатка после резерва"><select id="puPr">${options(state.priorities,'Средний')}</select><label class="paidLabel"><input id="puPaid" type="checkbox"> Оплачено</label><input id="puComment" placeholder="Комментарий"></div>
  <div class="tableWrap">${purchaseTable(state.purchases)}</div></div><div class="card" style="margin-top:14px"><h3>Прогноз по активным целям</h3>${planningGoalsTable()}</div>`;
}
try { ensureRelease3State(); save(); } catch(e) { console.error(e); }

/* --- Release 3.1.1: reserve UX cleanup --- */
function reserveSummaryCard(){
  ensureReserveState();
  const target = reserveTargetAmount();
  const current = reserveCurrentAmount();
  const need = reserveNeedAmount();
  const statusText = reserveIsFull() ? 'Резерв заполнен. Автосбор остановлен.' : `Нужно восстановить: ${rub(need)}`;
  return `<div class="card reserveCard"><div class="toolbar"><div><h3>Резервный фонд</h3><p class="mutedText">Краткая сводка по подушке безопасности. Без технических расчетов пополнения.</p></div><button onclick="showView('purchases')">Открыть резерв</button></div>
    <div class="grid compactGrid">${kpi('Уже есть',rub(current))}${kpi('Цель резерва',rub(target),`${num(state.reserveFund.targetMonths)||3} мес. расходов`)}${kpi('Осталось восстановить',rub(need))}${kpi('Оценка срока',reserveMonthsEstimate(),`готовность ${pct(reserveProgress())}`)}</div>
    ${progressBar(reserveProgress())}
    <p class="${reserveIsFull()?'okText':'mutedText'}"><strong>${statusText}</strong></p>
  </div>`;
}
function reserveCard(){
  ensureReserveState();
  const target = reserveTargetAmount();
  const current = reserveCurrentAmount();
  const need = reserveNeedAmount();
  const statusText = reserveIsFull() ? 'Резерв заполнен. Автосбор остановлен.' : `Нужно восстановить: ${rub(need)}`;
  return `<div class="card reserveCard"><div class="toolbar"><div><h3>Резервный фонд</h3><p class="mutedText">Резерв учитывается первым при распределении свободного остатка. На экране показано только сколько уже есть, сколько осталось и оценка срока.</p></div><button onclick="showReserveHistory()">История</button></div>
    <div class="grid compactGrid">${kpi('Уже есть',rub(current))}${kpi('Цель резерва',rub(target),`${num(state.reserveFund.targetMonths)||3} мес. расходов`)}${kpi('Осталось восстановить',rub(need))}${kpi('Оценка срока',reserveMonthsEstimate(),`готовность ${pct(reserveProgress())}`)}</div>
    ${progressBar(reserveProgress())}
    <p class="${reserveIsFull()?'okText':'mutedText'}"><strong>${statusText}</strong></p>
    <div class="formrow reserveForm"><input id="reserveCurrent" ${amountAttrs()} value="${escapeHtml(state.reserveFund.currentAmount)}" oninput="amountInput(this)" onblur="amountBlur(this);state.reserveFund.currentAmount=this.value;save();render()" placeholder="Сколько уже есть"><select id="reserveMonths" onchange="state.reserveFund.targetMonths=this.value;save();render()"><option ${state.reserveFund.targetMonths==='3'?'selected':''}>3</option><option ${state.reserveFund.targetMonths==='6'?'selected':''}>6</option><option ${state.reserveFund.targetMonths==='9'?'selected':''}>9</option><option ${state.reserveFund.targetMonths==='12'?'selected':''}>12</option></select><input id="reservePercent" ${amountAttrs()} value="${escapeHtml(state.reserveFund.percent)}" oninput="amountInput(this)" onblur="amountBlur(this);state.reserveFund.percent=String(Math.min(num(this.value),100));this.value=state.reserveFund.percent;save();render()" placeholder="% резерва от остатка"><input id="reserveNote" value="${escapeHtml(state.reserveFund.note||'')}" oninput="state.reserveFund.note=this.value;save()" placeholder="Комментарий"></div>
    <div class="reserveOps"><div class="formrow"><input id="reserveTxDate" type="date" value="${new Date().toISOString().slice(0,10)}"><input id="reserveTxAmount" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Сумма списания"><input id="reserveTxComment" placeholder="Комментарий к списанию"><button class="danger" onclick="addReserveTransaction('spend')">Потратить</button></div></div>
  </div>`;
}
function addReserveTransaction(type){
  ensureReserveState();
  if(type !== 'spend') return;
  const amount = num(val('reserveTxAmount'));
  if(amount <= 0){ alert('Укажи сумму списания'); return; }
  if(amount > reserveCurrentAmount()){
    alert('Сумма списания больше текущего резерва');
    return;
  }
  const comment = val('reserveTxComment');
  const date = val('reserveTxDate') || new Date().toISOString().slice(0,10);
  state.reserveFund.currentAmount = cleanAmountValue(String(Math.max(0, reserveCurrentAmount() - amount)), true);
  state.reserveFund.transactions.push({id:uid('rt'), type:'spend', amount, date, comment});
  save(); render();
}
function renderDashboard(){
  ensureRelease3State();
  const t = totals(currentMonth);
  const year = allTotals();
  document.getElementById('dashboard').innerHTML = `
    <div class="dashboardTopFull">${upcomingPanel(14)}</div>
    <div class="card dashboardControls"><div><h3>Сводка за месяц</h3><p>Главные цифры по выбранному месяцу.</p></div><select onchange="currentMonth=this.value;render()">${options(state.months,currentMonth)}</select></div>
    <div class="dashSection"><h3>${currentMonth}: деньги за месяц</h3><div class="grid">${kpi('Доходы',rub(t.incomes))}${kpi('Расходы',rub(t.expensesFact))}${kpi('Свободный остаток',rub(t.freeFact))}${kpi('План расходов',rub(t.expensesPlan))}</div></div>
    <div class="dashSection"><h3>Планирование</h3><div class="grid">${kpi('Выделено на цели',rub(year.goalsAllocated))}${kpi('Свободно после целей',rub(year.freeAfterGoals))}${kpi('Резерв уже есть',rub(reserveCurrentAmount()))}${kpi('Резерв готов',pct(reserveProgress()))}</div></div>
    <div style="margin-top:14px">${reserveSummaryCard()}</div>
    <div class="card" style="margin-top:14px"><h3>Цели: прогноз</h3><p class="mutedText">Цели считаются от остатка после резерва. Если резерв заполнен, его процент больше не забирает деньги.</p>${planningGoalsTable()}</div>
    <div class="card" style="margin-top:14px"><h3>Остатки по месяцам</h3>${balanceTable()}</div>`;
}

/* --- Hotfix 3.1.1: reserve estimate function --- */
function reserveMonthsEstimate(){
  try{
    const monthly = reserveAutoAllocation ? reserveAutoAllocation() : 0;
    const need = reserveNeedAmount ? reserveNeedAmount() : Math.max(reserveTargetAmount() - reserveCurrentAmount(), 0);
    if(!need) return '0 мес.';
    if(!monthly) return 'нет %';
    return Math.ceil(need / monthly) + ' мес.';
  }catch(e){
    return 'нет данных';
  }
}

/* --- Hotfix 3.1.4: reserve visible amount includes current allocation --- */
function reserveUiAmount(){
  const target = reserveTargetAmount();
  const current = reserveCurrentAmount();
  const allocation = reserveAutoAllocation();
  return Math.min(target || (current + allocation), current + allocation);
}
function reserveUiNeedAmount(){
  return Math.max(reserveTargetAmount() - reserveUiAmount(), 0);
}
function reserveUiProgress(){
  const target = reserveTargetAmount();
  return target ? Math.min(100, reserveUiAmount()/target*100) : 0;
}
function reserveMonthsEstimate(){
  try{
    const monthly = reserveAutoAllocation ? reserveAutoAllocation() : 0;
    const need = reserveUiNeedAmount();
    if(!need) return '0 мес.';
    if(!monthly) return 'нет %';
    return Math.ceil(need / monthly) + ' мес.';
  }catch(e){
    return 'нет данных';
  }
}
function reserveSummaryCard(){
  ensureReserveState();
  const target = reserveTargetAmount();
  const shown = reserveUiAmount();
  const need = reserveUiNeedAmount();
  const full = need <= 0;
  const statusText = full ? 'Резерв заполнен. Автосбор остановлен.' : `Нужно восстановить: ${rub(need)}`;
  return `<div class="card reserveCard"><div class="toolbar"><div><h3>Резервный фонд</h3><p class="mutedText">Краткая сводка по подушке безопасности.</p></div><button onclick="showView('purchases')">Открыть резерв</button></div>
    <div class="grid compactGrid">${kpi('Уже есть',rub(shown),'с учетом распределения')}${kpi('Цель резерва',rub(target),`${num(state.reserveFund.targetMonths)||3} мес. расходов`)}${kpi('Осталось восстановить',rub(need))}${kpi('Оценка срока',reserveMonthsEstimate(),`готовность ${pct(reserveUiProgress())}`)}</div>
    ${progressBar(reserveUiProgress())}
    <p class="${full?'okText':'mutedText'}"><strong>${statusText}</strong></p>
  </div>`;
}
function reserveCard(){
  ensureReserveState();
  const target = reserveTargetAmount();
  const shown = reserveUiAmount();
  const need = reserveUiNeedAmount();
  const full = need <= 0;
  const statusText = full ? 'Резерв заполнен. Автосбор остановлен.' : `Нужно восстановить: ${rub(need)}`;
  return `<div class="card reserveCard"><div class="toolbar"><div><h3>Резервный фонд</h3><p class="mutedText">Резерв учитывается первым при распределении свободного остатка. «Уже есть» показывает сумму с учетом текущего распределения.</p></div><button onclick="showReserveHistory()">История</button></div>
    <div class="grid compactGrid">${kpi('Уже есть',rub(shown),'с учетом распределения')}${kpi('Цель резерва',rub(target),`${num(state.reserveFund.targetMonths)||3} мес. расходов`)}${kpi('Осталось восстановить',rub(need))}${kpi('Оценка срока',reserveMonthsEstimate(),`готовность ${pct(reserveUiProgress())}`)}</div>
    ${progressBar(reserveUiProgress())}
    <p class="${full?'okText':'mutedText'}"><strong>${statusText}</strong></p>
    <div class="formrow reserveForm"><input id="reserveCurrent" ${amountAttrs()} value="${escapeHtml(state.reserveFund.currentAmount)}" oninput="amountInput(this)" onblur="amountBlur(this);state.reserveFund.currentAmount=this.value;save();render()" placeholder="Фактически уже есть"><select id="reserveMonths" onchange="state.reserveFund.targetMonths=this.value;save();render()"><option ${state.reserveFund.targetMonths==='3'?'selected':''}>3</option><option ${state.reserveFund.targetMonths==='6'?'selected':''}>6</option><option ${state.reserveFund.targetMonths==='9'?'selected':''}>9</option><option ${state.reserveFund.targetMonths==='12'?'selected':''}>12</option></select><input id="reservePercent" ${amountAttrs()} value="${escapeHtml(state.reserveFund.percent)}" oninput="amountInput(this)" onblur="amountBlur(this);state.reserveFund.percent=String(Math.min(num(this.value),100));this.value=state.reserveFund.percent;save();render()" placeholder="% резерва от остатка"><input id="reserveNote" value="${escapeHtml(state.reserveFund.note||'')}" oninput="state.reserveFund.note=this.value;save()" placeholder="Комментарий"></div>
    <div class="reserveOps"><div class="formrow"><input id="reserveTxDate" type="date" value="${new Date().toISOString().slice(0,10)}"><input id="reserveTxAmount" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Сумма списания"><input id="reserveTxComment" placeholder="Комментарий к списанию"><button class="danger" onclick="addReserveTransaction('spend')">Потратить</button></div></div>
  </div>`;
}
function renderDashboard(){
  ensureRelease3State();
  const t = totals(currentMonth);
  const year = allTotals();
  document.getElementById('dashboard').innerHTML = `
    <div class="dashboardTopFull">${upcomingPanel(14)}</div>
    <div class="card dashboardControls"><div><h3>Сводка за месяц</h3><p>Главные цифры по выбранному месяцу.</p></div><select onchange="currentMonth=this.value;render()">${options(state.months,currentMonth)}</select></div>
    <div class="dashSection"><h3>${currentMonth}: деньги за месяц</h3><div class="grid">${kpi('Доходы',rub(t.incomes))}${kpi('Расходы',rub(t.expensesFact))}${kpi('Свободный остаток',rub(t.freeFact))}${kpi('План расходов',rub(t.expensesPlan))}</div></div>
    <div class="dashSection"><h3>Планирование</h3><div class="grid">${kpi('Выделено на цели',rub(year.goalsAllocated))}${kpi('Свободно после целей',rub(year.freeAfterGoals))}${kpi('Резерв уже есть',rub(reserveUiAmount()))}${kpi('Резерв готов',pct(reserveUiProgress()))}</div></div>
    <div style="margin-top:14px">${reserveSummaryCard()}</div>
    <div class="card" style="margin-top:14px"><h3>Цели: прогноз</h3><p class="mutedText">Цели считаются от остатка после резерва. Если резерв заполнен, его процент больше не забирает деньги.</p>${planningGoalsTable()}</div>
    <div class="card" style="margin-top:14px"><h3>Остатки по месяцам</h3>${balanceTable()}</div>`;
}

/* --- Hotfix 3.1.5: reserve spending uses the same amount shown in UI --- */
function reserveProjectedSpent(){
  ensureReserveState();
  state.reserveFund.projectedSpent = cleanAmountValue(state.reserveFund.projectedSpent ?? '', true);
  return num(state.reserveFund.projectedSpent);
}
function reserveUiAmount(){
  ensureReserveState();
  const target = reserveTargetAmount();
  const current = reserveCurrentAmount();
  const allocation = reserveAutoAllocation();
  const spent = reserveProjectedSpent();
  return Math.max(0, Math.min(target || (current + allocation), current + allocation) - spent);
}
function reserveUiNeedAmount(){
  return Math.max(reserveTargetAmount() - reserveUiAmount(), 0);
}
function reserveUiProgress(){
  const target = reserveTargetAmount();
  return target ? Math.min(100, reserveUiAmount()/target*100) : 0;
}
function addReserveTransaction(type){
  ensureReserveState();
  if(type !== 'spend') return;
  const amount = num(val('reserveTxAmount'));
  if(amount <= 0){ alert('Укажи сумму списания'); return; }
  const available = reserveUiAmount();
  if(amount > available){
    alert('Сумма списания больше текущего резерва');
    return;
  }
  const comment = val('reserveTxComment');
  const date = val('reserveTxDate') || new Date().toISOString().slice(0,10);
  const actual = reserveCurrentAmount();
  const fromActual = Math.min(actual, amount);
  const fromProjected = amount - fromActual;
  state.reserveFund.currentAmount = cleanAmountValue(String(Math.max(0, actual - fromActual)), true);
  if(fromProjected > 0){
    state.reserveFund.projectedSpent = cleanAmountValue(String(reserveProjectedSpent() + fromProjected), true);
  }
  state.reserveFund.transactions.push({id:uid('rt'), type:'spend', amount, date, comment, fromActual, fromProjected});
  save(); render();
}
function deleteReserveTransaction(id){
  ensureReserveState();
  const tx = state.reserveFund.transactions.find(x=>x.id===id);
  if(!tx) return;
  if(tx.type === 'spend'){
    const fromActual = num(tx.fromActual ?? tx.amount);
    const fromProjected = num(tx.fromProjected ?? 0);
    state.reserveFund.currentAmount = cleanAmountValue(String(reserveCurrentAmount() + fromActual), true);
    if(fromProjected > 0){
      state.reserveFund.projectedSpent = cleanAmountValue(String(Math.max(0, reserveProjectedSpent() - fromProjected)), true);
    }
  }
  state.reserveFund.transactions = state.reserveFund.transactions.filter(x=>x.id!==id);
  save(); render();
}

/* --- Release 3.2: reserve status and clean reserve planning model --- */
function reserveIsActuallyOrVirtuallyFull(){
  const target = reserveTargetAmount();
  return target > 0 && reserveUiAmount() >= target;
}
function syncReserveFullFlag(){
  ensureReserveState();
  if(typeof state.reserveFund.wasFull === 'undefined') state.reserveFund.wasFull = false;
  if(reserveIsActuallyOrVirtuallyFull()) state.reserveFund.wasFull = true;
}
function reserveStatusInfo(){
  syncReserveFullFlag();
  const target = reserveTargetAmount();
  const shown = reserveUiAmount();
  if(target <= 0){
    return {text:'Не настроен', cls:'mutedText', pill:'pill', description:'Укажи цель резерва через количество месяцев расходов.'};
  }
  if(shown >= target){
    return {text:'Заполнен', cls:'okText', pill:'pill okPill', description:'Резерв достиг цели. Автоматическое распределение в резерв остановлено.'};
  }
  if(state.reserveFund.wasFull){
    return {text:'Требует восстановления', cls:'dangerText', pill:'pill dangerPill', description:`Резерв был заполнен, но часть суммы потрачена. Нужно восстановить: ${rub(reserveUiNeedAmount())}.`};
  }
  return {text:'Формируется', cls:'mutedText', pill:'pill warnPill', description:`Резерв еще формируется. Осталось накопить: ${rub(reserveUiNeedAmount())}.`};
}
function reserveSummaryCard(){
  ensureReserveState();
  const target = reserveTargetAmount();
  const shown = reserveUiAmount();
  const need = reserveUiNeedAmount();
  const st = reserveStatusInfo();
  return `<div class="card reserveCard"><div class="toolbar"><div><h3>Резервный фонд</h3><p class="mutedText">Краткая сводка по подушке безопасности.</p></div><button onclick="showView('purchases')">Открыть резерв</button></div>
    <div class="reserveStatusLine"><span class="${st.pill}">${escapeHtml(st.text)}</span><span class="${st.cls}">${escapeHtml(st.description)}</span></div>
    <div class="grid compactGrid">${kpi('Уже есть',rub(shown),'с учетом распределения')}${kpi('Цель резерва',rub(target),`${num(state.reserveFund.targetMonths)||3} мес. расходов`)}${kpi('Осталось восстановить',rub(need))}${kpi('Оценка срока',reserveMonthsEstimate(),`готовность ${pct(reserveUiProgress())}`)}</div>
    ${progressBar(reserveUiProgress())}
  </div>`;
}
function reserveCard(){
  ensureReserveState();
  const target = reserveTargetAmount();
  const shown = reserveUiAmount();
  const need = reserveUiNeedAmount();
  const st = reserveStatusInfo();
  return `<div class="card reserveCard"><div class="toolbar"><div><h3>Резервный фонд</h3><p class="mutedText">Резерв получает процент от свободного остатка первым. Когда цель достигнута, сбор останавливается. Если потратить резерв, восстановление включится снова.</p></div><button onclick="showReserveHistory()">История</button></div>
    <div class="reserveStatusLine"><span class="${st.pill}">${escapeHtml(st.text)}</span><span class="${st.cls}">${escapeHtml(st.description)}</span></div>
    <div class="grid compactGrid">${kpi('Уже есть',rub(shown),'с учетом распределения')}${kpi('Цель резерва',rub(target),`${num(state.reserveFund.targetMonths)||3} мес. расходов`)}${kpi('Осталось восстановить',rub(need))}${kpi('Оценка срока',reserveMonthsEstimate(),`готовность ${pct(reserveUiProgress())}`)}</div>
    ${progressBar(reserveUiProgress())}
    <div class="formrow reserveForm"><input id="reserveCurrent" ${amountAttrs()} value="${escapeHtml(state.reserveFund.currentAmount)}" oninput="amountInput(this)" onblur="amountBlur(this);state.reserveFund.currentAmount=this.value;save();render()" placeholder="Фактически уже есть"><select id="reserveMonths" onchange="state.reserveFund.targetMonths=this.value;save();render()"><option ${state.reserveFund.targetMonths==='3'?'selected':''}>3</option><option ${state.reserveFund.targetMonths==='6'?'selected':''}>6</option><option ${state.reserveFund.targetMonths==='9'?'selected':''}>9</option><option ${state.reserveFund.targetMonths==='12'?'selected':''}>12</option></select><input id="reservePercent" ${amountAttrs()} value="${escapeHtml(state.reserveFund.percent)}" oninput="amountInput(this)" onblur="amountBlur(this);state.reserveFund.percent=String(Math.min(num(this.value),100));this.value=state.reserveFund.percent;save();render()" placeholder="% резерва от остатка"><input id="reserveNote" value="${escapeHtml(state.reserveFund.note||'')}" oninput="state.reserveFund.note=this.value;save()" placeholder="Комментарий"></div>
    <div class="reserveOps"><div class="formrow"><input id="reserveTxDate" type="date" value="${new Date().toISOString().slice(0,10)}"><input id="reserveTxAmount" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Сумма списания"><input id="reserveTxComment" placeholder="Комментарий к списанию"><button class="danger" onclick="addReserveTransaction('spend')">Потратить</button></div></div>
  </div>`;
}
function addReserveTransaction(type){
  ensureReserveState();
  if(type !== 'spend') return;
  const amount = num(val('reserveTxAmount'));
  if(amount <= 0){ alert('Укажи сумму списания'); return; }
  const available = reserveUiAmount();
  if(amount > available){
    alert('Сумма списания больше текущего резерва');
    return;
  }
  if(reserveIsActuallyOrVirtuallyFull()) state.reserveFund.wasFull = true;
  const comment = val('reserveTxComment');
  const date = val('reserveTxDate') || new Date().toISOString().slice(0,10);
  const actual = reserveCurrentAmount();
  const fromActual = Math.min(actual, amount);
  const fromProjected = amount - fromActual;
  state.reserveFund.currentAmount = cleanAmountValue(String(Math.max(0, actual - fromActual)), true);
  if(fromProjected > 0){
    state.reserveFund.projectedSpent = cleanAmountValue(String(reserveProjectedSpent() + fromProjected), true);
  }
  state.reserveFund.transactions.push({id:uid('rt'), type:'spend', amount, date, comment, fromActual, fromProjected});
  save(); render();
}
function deleteReserveTransaction(id){
  ensureReserveState();
  const tx = state.reserveFund.transactions.find(x=>x.id===id);
  if(!tx) return;
  if(tx.type === 'spend'){
    const fromActual = num(tx.fromActual ?? tx.amount);
    const fromProjected = num(tx.fromProjected ?? 0);
    state.reserveFund.currentAmount = cleanAmountValue(String(reserveCurrentAmount() + fromActual), true);
    if(fromProjected > 0){
      state.reserveFund.projectedSpent = cleanAmountValue(String(Math.max(0, reserveProjectedSpent() - fromProjected)), true);
    }
  }
  state.reserveFund.transactions = state.reserveFund.transactions.filter(x=>x.id!==id);
  syncReserveFullFlag();
  save(); render();
}

/* --- Future income release: expected incomes are not counted until their date --- */
function todayDateString(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
function incomeIsAvailable(income){
  // Empty date is treated as already available for backward compatibility with old imported data.
  if(!income || !income.date) return true;
  return String(income.date) <= todayDateString();
}
function incomeStatus(income){
  return incomeIsAvailable(income)
    ? {text:'Получен', cls:'okPill'}
    : {text:'Ожидается', cls:'warnPill'};
}
function incomeTotals(month){
  const rows = state.incomes.filter(x=>x.month===month);
  const available = rows.filter(incomeIsAvailable).reduce((s,x)=>s+num(x.amount),0);
  const expected = rows.filter(x=>!incomeIsAvailable(x)).reduce((s,x)=>s+num(x.amount),0);
  return {available, expected, forecast: available + expected};
}
function upcomingIncomes(days=15){
  const now = new Date(todayDateString()+'T00:00:00');
  return state.incomes
    .filter(x=>x.date && !incomeIsAvailable(x))
    .map(x=>({
      ...x,
      diff: Math.ceil((new Date(x.date+'T00:00:00') - now) / 86400000),
      amountValue: num(x.amount)
    }))
    .filter(x=>x.diff>=0 && x.diff<=days)
    .sort((a,b)=>a.diff-b.diff || String(a.date).localeCompare(String(b.date)));
}
function upcomingIncomePanel(days=15){
  const items = upcomingIncomes(days);
  if(!items.length) return `<div class="card"><h3>Ближайшие поступления</h3><p class="mutedText">Ожидаемых доходов на ближайшие ${days} дней нет.</p></div>`;
  return `<div class="card"><div class="toolbar"><h3>Ближайшие поступления</h3><span class="pill">${items.length}</span></div><div class="upcomingList scrollList">${items.map(x=>`<div class="upcomingItem incomeUpcoming"><div><strong>${escapeHtml(x.type || x.source || 'Доход')}</strong><span>${escapeHtml(x.month)} · ${escapeHtml(x.date)} · ${x.diff===0?'сегодня':('через '+x.diff+' дн.')}</span>${x.comment?`<small>${escapeHtml(x.comment)}</small>`:''}</div><b>+${rub(x.amountValue)}</b></div>`).join('')}</div></div>`;
}
function totals(month){
  const inc = incomeTotals(month);
  const incomes = inc.available;
  const expectedIncomes = inc.expected;
  const forecastIncomes = inc.forecast;
  const expensesPlan = state.expenses.filter(x=>x.month===month).reduce((s,x)=>s+num(x.planAmount),0);
  const expensesFact = state.expenses.filter(x=>x.month===month).reduce((s,x)=>s+num(x.factAmount),0);
  const freePlan = incomes - expensesPlan;
  const freeFact = incomes - expensesFact;
  const forecastFreeFact = forecastIncomes - expensesFact;
  const positiveFreeFact = Math.max(freeFact, 0);
  const goalPercentTotal = unpaidGoals ? unpaidGoals().reduce((s,x)=>s+num(x.percent),0) : state.purchases.reduce((s,x)=>s+num(x.percent),0);
  const goalAllocated = state.purchases.reduce((s,x)=>s+(goalMonthAmount ? goalMonthAmount(x, month) : 0),0);
  const undistributed = Math.max(positiveFreeFact - goalAllocated, 0);
  return {incomes, expectedIncomes, forecastIncomes, expensesPlan, expensesFact, freePlan, freeFact, forecastFreeFact, positiveFreeFact, goalPercentTotal, goalAllocated, undistributed};
}
function totalsNoGoals(month){
  const incomes = incomeTotals(month).available;
  const expensesFact = state.expenses.filter(x=>x.month===month).reduce((s,x)=>s+num(x.factAmount),0);
  return {incomes, expensesFact, freeFact: incomes-expensesFact};
}
function renderIncome(){
 document.getElementById('income').innerHTML=`<div class="card"><div class="toolbar"><div><h3>Доходы</h3><p class="mutedText">Доход с будущей датой отображается как «Ожидается» и не участвует в остатках до наступления даты.</p></div><div class="toolbarActions">${bulkDeleteButton('incomes')}<button class="primary" onclick="addIncome()">Добавить доход</button></div></div>
 <div class="formrow"><input id="inDate" type="date"><select id="inMonth">${options(state.months,currentMonth)}</select><select id="inType">${options(state.incomeTypes)}</select><input id="inAmount" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Сумма"><input id="inComment" placeholder="Комментарий"></div>
 <div class="tableWrap">${incomeTable()}</div></div>`;
}
function incomeTable(){
 if(!state.incomes.length) return `<div class="empty">Доходов нет</div>`;
 return `<table class="incomeTable"><thead><tr><th class="checkCol"><input type="checkbox" ${state.incomes.length && state.incomes.every(x=>selected.incomes.has(x.id))?'checked':''} onchange="toggleVisible('incomes', this.checked)"></th><th>Дата</th><th>Месяц</th><th>Источник</th><th>Сумма</th><th>Статус</th><th>Комментарий</th><th></th></tr></thead><tbody>
 ${state.incomes.map(x=>{const disabled=archivedAttr(x.month); const st=incomeStatus(x);return `<tr><td class="checkCol"><input type="checkbox" ${disabled} ${selected.incomes.has(x.id)?'checked':''} onchange="toggleOne('incomes','${x.id}',this.checked)"></td><td><input type="date" value="${x.date}" onchange="upd('incomes','${x.id}','date',this.value);render()" ${disabled}></td><td><select onchange="upd('incomes','${x.id}','month',this.value);render()" ${disabled}>${options(state.months,x.month)}</select></td><td><select onchange="upd('incomes','${x.id}','type',this.value);upd('incomes','${x.id}','source',this.value)" ${disabled}>${options(state.incomeTypes,x.type || x.source)}</select></td><td><input ${amountAttrs()} value="${escapeHtml(x.amount)}" oninput="amountInput(this,'incomes','${x.id}','amount')" onblur="amountBlur(this,'incomes','${x.id}','amount');render()" placeholder="0" ${disabled}></td><td><span class="pill ${st.cls}">${st.text}</span></td><td><input value="${escapeHtml(x.comment)}" oninput="upd('incomes','${x.id}','comment',this.value)" ${disabled}></td><td><button class="danger" onclick="del('incomes','${x.id}')" ${disabled}>Удалить</button></td></tr>`}).join('')}</tbody></table>`;
}
function renderDashboard(){
  ensureRelease3State();
  const t = totals(currentMonth);
  const year = allTotals();
  document.getElementById('dashboard').innerHTML = `
    <div class="dashboardTopFull">${upcomingPanel(14)}</div>
    <div style="margin-top:14px">${upcomingIncomePanel(15)}</div>
    <div class="card dashboardControls"><div><h3>Сводка за месяц</h3><p>Главные цифры по выбранному месяцу. Будущие доходы показаны отдельно и пока не участвуют в остатке.</p></div><select onchange="currentMonth=this.value;render()">${options(state.months,currentMonth)}</select></div>
    <div class="dashSection"><h3>${currentMonth}: деньги за месяц</h3><div class="grid">${kpi('Доходы получены',rub(t.incomes))}${kpi('Ожидается доходов',rub(t.expectedIncomes),'не учитывается до даты')}${kpi('Расходы',rub(t.expensesFact))}${kpi('Свободный остаток',rub(t.freeFact))}${kpi('Прогноз с будущими доходами',rub(t.forecastFreeFact))}${kpi('План расходов',rub(t.expensesPlan))}</div></div>
    <div class="dashSection"><h3>Планирование</h3><div class="grid">${kpi('Выделено на цели',rub(year.goalsAllocated))}${kpi('Свободно после целей',rub(year.freeAfterGoals))}${kpi('Резерв уже есть',rub(reserveUiAmount()))}${kpi('Резерв готов',pct(reserveUiProgress()))}</div></div>
    <div style="margin-top:14px">${reserveSummaryCard()}</div>
    <div class="card" style="margin-top:14px"><h3>Цели: прогноз</h3><p class="mutedText">Цели считаются от остатка после резерва. Будущие доходы попадут в расчет после наступления даты.</p>${planningGoalsTable()}</div>
    <div class="card" style="margin-top:14px"><h3>Остатки по месяцам</h3>${balanceTable()}</div>`;
}
function balanceTable(){return `<div class="tableWrap"><table class="balanceTable"><thead><tr><th>Месяц</th><th>Доходы получены</th><th>Ожидается</th><th>План расходов</th><th>Факт расходов</th><th>Свободный остаток</th></tr></thead><tbody>${state.months.map(m=>{const t=totals(m);return `<tr><td>${m}</td><td>${rub(t.incomes)}</td><td>${rub(t.expectedIncomes)}</td><td>${rub(t.expensesPlan)}</td><td>${rub(t.expensesFact)}</td><td>${rub(t.freeFact)}</td></tr>`}).join('')}</tbody></table></div>`}

/* --- Release 3.3: row ordering, data model, income categories, searchable category fields --- */
function ensureDataModelRelease(){
  state.expenseCategories ||= state.categories || seed.expenseCategories || seed.categories || [];
  state.incomeCategories ||= state.incomeTypes || seed.incomeTypes || ['Зарплата','Доп. доход','Возврат','Подарок','Другое'];
  state.categories = state.expenseCategories;
  state.incomeTypes = state.incomeCategories; // совместимость со старой логикой
  state.expenses ||= [];
  state.incomes ||= [];
}
function dataList(id, arr){
  return `<datalist id="${id}">${(arr||[]).map(x=>`<option value="${escapeHtml(x)}"></option>`).join('')}</datalist>`;
}
function searchableField(id, arr, value='', attrs=''){
  const listId = `${id}List`;
  return `<input id="${id}" list="${listId}" value="${escapeHtml(value)}" ${attrs}>${dataList(listId, arr)}`;
}
function orderButtons(list,id,disabled=false){
  return `<div class="orderBtns"><button type="button" title="Выше" onclick="moveRow('${list}','${id}',-1)" ${disabled?'disabled':''}>↑</button><button type="button" title="Ниже" onclick="moveRow('${list}','${id}',1)" ${disabled?'disabled':''}>↓</button></div>`;
}
function moveRow(list,id,dir){
  ensureDataModelRelease();
  const arr = state[list] || [];
  const item = arr.find(x=>x.id===id);
  if(!item) return;
  if(item.month && isMonthArchived(item.month)){ alert('Месяц архивирован. Сначала разархивируй его.'); return; }
  let visible;
  if(list === 'expenses') visible = arr.filter(x=>x.month===currentMonth);
  else visible = arr.slice();
  const vIdx = visible.findIndex(x=>x.id===id);
  const target = visible[vIdx + dir];
  if(!target) return;
  const a = arr.findIndex(x=>x.id===item.id);
  const b = arr.findIndex(x=>x.id===target.id);
  if(a < 0 || b < 0) return;
  [arr[a], arr[b]] = [arr[b], arr[a]];
  save(); render();
}
function moveCategory(kind, value, dir){
  ensureDataModelRelease();
  const arr = kind === 'income' ? state.incomeCategories : state.expenseCategories;
  const idx = arr.indexOf(value);
  const next = idx + dir;
  if(idx < 0 || next < 0 || next >= arr.length) return;
  [arr[idx], arr[next]] = [arr[next], arr[idx]];
  state.categories = state.expenseCategories;
  state.incomeTypes = state.incomeCategories;
  save(); renderSettings();
}
function renderMonths(){
  ensureDataModelRelease();
  const disabled=isMonthArchived(currentMonth);
  const rows=state.expenses.filter(x=>x.month===currentMonth);
  document.getElementById('months').innerHTML = `${monthTabs()}<div class="card">
    <div class="toolbar"><div><h3>${currentMonth} — расходы ${archivedNote(currentMonth)}</h3><p class="mutedText">Строки можно перемещать стрелками. Порядок сохраняется в данных и синхронизируется.</p></div><div class="toolbarActions">${bulkDeleteButton('expenses',disabled)}<button class="primary" onclick="addExpense()" ${disabled?'disabled':''}>Добавить расход</button></div></div>
    ${expenseForm()}
    <div class="tableWrap">${expenseTable(rows)}</div></div>`;
}
function expenseForm(){
 const disabled=archivedAttr(currentMonth);
 return `<div class="formrow">
   ${searchableField('exCat', state.expenseCategories, '', `placeholder="Категория" ${disabled}`)}<input id="exPlan" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Плановая сумма" ${disabled}><input id="exFact" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Факт оплачено" ${disabled}><input id="exDate" type="date" ${disabled}>
   <label class="paidLabel"><input id="exPaid" type="checkbox" ${disabled}> Оплачено</label><select id="exPriority" ${disabled}>${options(state.priorities,'Средний')}</select>
   <textarea id="exComment" placeholder="Комментарий" ${disabled}></textarea>
 </div>`;
}
function expenseTable(rows){
 if(!rows.length) return `<div class="empty">Записей нет</div>`;
 return `<table class="expenseTable"><thead><tr><th class="checkCol"><input type="checkbox" ${rows.length && rows.every(x=>selected.expenses.has(x.id))?'checked':''} onchange="toggleVisible('expenses', this.checked)"></th><th class="orderCol">Порядок</th><th>Категория</th><th>План</th><th>Факт</th><th>Дата</th><th>Оплачено</th><th>Комментарий</th><th>Приоритет</th><th></th></tr></thead><tbody>
 ${rows.map(x=>{const disabled=archivedAttr(x.month); const listId=`cat_${x.id}`; return `<tr>
 <td class="checkCol"><input type="checkbox" ${selected.expenses.has(x.id)?'checked':''} onchange="toggleOne('expenses','${x.id}',this.checked)" ${disabled}></td>
 <td class="orderCol">${orderButtons('expenses',x.id,!!disabled)}</td>
 <td><input list="${listId}" value="${escapeHtml(x.category)}" oninput="upd('expenses','${x.id}','category',this.value,{silent:true})" onblur="render()" ${disabled}>${dataList(listId,state.expenseCategories)}</td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.planAmount)}" oninput="amountInput(this,'expenses','${x.id}','planAmount')" onblur="amountBlur(this,'expenses','${x.id}','planAmount');render()" placeholder="0" ${disabled}></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.factAmount)}" oninput="amountInput(this,'expenses','${x.id}','factAmount')" onblur="amountBlur(this,'expenses','${x.id}','factAmount');render()" placeholder="0" ${disabled}></td>
 <td><input type="date" value="${escapeHtml(x.date)}" onchange="upd('expenses','${x.id}','date',this.value)" ${disabled}></td>
 <td><label class="paidLabel"><input type="checkbox" ${x.paid?'checked':''} onchange="upd('expenses','${x.id}','paid',this.checked)" ${disabled}> ${expenseStatusPill(x)}</label></td>
 <td><textarea class="commentArea" oninput="upd('expenses','${x.id}','comment',this.value,{silent:true})" onblur="render()" ${disabled}>${escapeHtml(x.comment)}</textarea></td>
 <td><select onchange="upd('expenses','${x.id}','priority',this.value)" ${disabled}>${options(state.priorities,x.priority)}</select></td>
 <td><button class="danger" onclick="del('expenses','${x.id}')" ${disabled}>Удалить</button></td></tr>`}).join('')}</tbody></table>`;
}
function addExpense(){
 if(isMonthArchived(currentMonth)){alert('Этот месяц архивирован. Сначала разархивируй его в настройках.'); return;}
 state.expenses.push(normalizeExpense({id:uid('e'),month:currentMonth,category:val('exCat') || 'Другое',planAmount:cleanAmountValue(val('exPlan'), true),factAmount:cleanAmountValue(val('exFact'), true),date:val('exDate'),paid:document.getElementById('exPaid')?.checked || false,paidManual:document.getElementById('exPaid')?.checked || false,comment:val('exComment'),priority:val('exPriority')}));
 save(); render();
}
function renderIncome(){
 ensureDataModelRelease();
 document.getElementById('income').innerHTML=`<div class="card"><div class="toolbar"><div><h3>Доходы</h3><p class="mutedText">Будущие доходы не участвуют в остатках до наступления даты. Строки можно перемещать стрелками.</p></div><div class="toolbarActions">${bulkDeleteButton('incomes')}<button class="primary" onclick="addIncome()">Добавить доход</button></div></div>
 <div class="formrow"><input id="inDate" type="date"><select id="inMonth">${options(state.months,currentMonth)}</select>${searchableField('inType', state.incomeCategories, '', 'placeholder="Категория дохода"')}<input id="inAmount" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Сумма"><input id="inComment" placeholder="Комментарий"></div>
 <div class="tableWrap">${incomeTable()}</div></div>`;
}
function incomeTable(){
 ensureDataModelRelease();
 if(!state.incomes.length) return `<div class="empty">Доходов нет</div>`;
 return `<table class="incomeTable"><thead><tr><th class="checkCol"><input type="checkbox" ${state.incomes.length && state.incomes.every(x=>selected.incomes.has(x.id))?'checked':''} onchange="toggleVisible('incomes', this.checked)"></th><th class="orderCol">Порядок</th><th>Дата</th><th>Месяц</th><th>Категория дохода</th><th>Сумма</th><th>Статус</th><th>Комментарий</th><th></th></tr></thead><tbody>
 ${state.incomes.map(x=>{const disabled=archivedAttr(x.month); const st=incomeStatus(x); const listId=`incomeCat_${x.id}`; return `<tr><td class="checkCol"><input type="checkbox" ${disabled} ${selected.incomes.has(x.id)?'checked':''} onchange="toggleOne('incomes','${x.id}',this.checked)"></td><td class="orderCol">${orderButtons('incomes',x.id,!!disabled)}</td><td><input type="date" value="${escapeHtml(x.date)}" onchange="upd('incomes','${x.id}','date',this.value);render()" ${disabled}></td><td><select onchange="upd('incomes','${x.id}','month',this.value);render()" ${disabled}>${options(state.months,x.month)}</select></td><td><input list="${listId}" value="${escapeHtml(x.type || x.source)}" oninput="upd('incomes','${x.id}','type',this.value,{silent:true});upd('incomes','${x.id}','source',this.value,{silent:true})" onblur="render()" ${disabled}>${dataList(listId,state.incomeCategories)}</td><td><input ${amountAttrs()} value="${escapeHtml(x.amount)}" oninput="amountInput(this,'incomes','${x.id}','amount')" onblur="amountBlur(this,'incomes','${x.id}','amount');render()" placeholder="0" ${disabled}></td><td><span class="pill ${st.cls}">${st.text}</span></td><td><input value="${escapeHtml(x.comment)}" oninput="upd('incomes','${x.id}','comment',this.value,{silent:true})" onblur="render()" ${disabled}></td><td><button class="danger" onclick="del('incomes','${x.id}')" ${disabled}>Удалить</button></td></tr>`}).join('')}</tbody></table>`;
}
function addIncome(){
  if(isMonthArchived(val('inMonth'))){alert('Этот месяц архивирован. Сначала разархивируй его в настройках.'); return;}
  const type = val('inType') || 'Другое';
  state.incomes.push({id:uid('i'),date:val('inDate'),month:val('inMonth'),source:type,amount:cleanAmountValue(val('inAmount'), true),type,comment:val('inComment')});
  save(); render();
}
function addCategory(type){
  ensureDataModelRelease();
  const inputId = type === 'income' ? 'newIncomeCat' : 'newExpenseCat';
  const arr = type === 'income' ? state.incomeCategories : state.expenseCategories;
  const v=val(inputId).trim();
  if(v && !arr.includes(v)){ arr.push(v); state.categories=state.expenseCategories; state.incomeTypes=state.incomeCategories; save(); renderSettings(); }
}
function removeCategory(type,c){
  ensureDataModelRelease();
  const arrName = type === 'income' ? 'incomeCategories' : 'expenseCategories';
  if(confirm('Удалить категорию? Записи с этой категорией останутся как текст.')){ state[arrName]=state[arrName].filter(x=>x!==c); state.categories=state.expenseCategories; state.incomeTypes=state.incomeCategories; save(); renderSettings(); }
}
function categoryManager(kind,title,description,inputId,arr){
  return `<div class="card compactCard categoriesSettings"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p><div class="compactAdd"><input id="${inputId}" placeholder="Новая категория"><button class="primary" onclick="addCategory('${kind}')">Добавить</button></div><div class="tagListOrdered">${(arr||[]).map(c=>`<div class="tagItem orderedTag"><span>${escapeHtml(c)}</span><div class="tagActions"><button class="miniBtn" onclick="moveCategory('${kind}','${escapeHtml(c)}',-1)">↑</button><button class="miniBtn" onclick="moveCategory('${kind}','${escapeHtml(c)}',1)">↓</button><button class="danger miniBtn" onclick="removeCategory('${kind}','${escapeHtml(c)}')">×</button></div></div>`).join('')}</div></div>`;
}
function renderSettings(){
 ensureDataModelRelease();
 const tabs=[['account','Аккаунт'],['appearance','Внешний вид'],['data','Импорт / экспорт'],['maintenance','Обслуживание'],['months','Месяцы и архив'],['recurring','Повторяющиеся'],['categories','Модель данных']];
 const tabButtons = `<div class="settingsTabs">${tabs.map(([id,title])=>`<button class="${settingsTab===id?'active':''}" onclick="settingsTab='${id}';renderSettings()">${title}</button>`).join('')}</div>`;
 let content='';
 if(settingsTab === 'account') content = `${cloudPanel()}`;
 if(settingsTab === 'appearance') content = `<div class="card"><h3>Тема оформления</h3><p class="mutedText">Светлая тема остается как сейчас. Темная тема сделана в спокойной графитово-коричневой палитре.</p><div class="themeChoices"><button class="themeChoice ${currentTheme==='light'?'active':''}" onclick="setTheme('light')"><span class="themePreview lightPreview"></span><strong>Светлая</strong><small>Текущий теплый стиль</small></button><button class="themeChoice ${currentTheme==='dark'?'active':''}" onclick="setTheme('dark')"><span class="themePreview darkPreview"></span><strong>Темная</strong><small>Графит + теплый акцент</small></button></div></div>`;
 if(settingsTab === 'data') content = `<div class="card"><h3>Импорт / экспорт</h3><p>Экспортируй резервную копию или импортируй данные из JSON. Можно выбрать все месяцы или один месяц.</p><div class="formrow settingsForm"><select id="dataMonthSelect"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select><button onclick="exportJson()">Экспорт</button><label class="fileBtn">Импорт<input type="file" accept="application/json" onchange="importJson(event)"></label></div></div>`;
 if(settingsTab === 'maintenance') content = `<div class="card"><h3>Обслуживание</h3><p class="mutedText">Редкие действия убраны в раскрывающиеся блоки, чтобы случайно ничего не удалить.</p><details class="settingsBlock"><summary>Очистить суммы</summary><p>Оставляет строки, но удаляет суммы. Можно выбрать разделы и месяц.</p><select id="clearMonth"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select>${sectionChecks('clear')}<button onclick="clearAmounts()">Очистить суммы</button></details><details class="settingsBlock"><summary>Пустой шаблон</summary><p>Удаляет записи в выбранных разделах. Архивные месяцы не изменяются.</p><select id="emptyMonth"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select>${sectionChecks('empty')}<button class="danger" onclick="resetData()">Удалить записи</button></details></div>`;
 if(settingsTab === 'months') content = `<div class="card"><h3>Месяцы и архив</h3><p>Здесь можно копировать месяцы, архивировать завершенные периоды и разархивировать их при необходимости.</p><details class="settingsBlock"><summary>Создать месяц на основе другого</summary><p>Копирует строки расходов из выбранного месяца в другой. По умолчанию суммы очищаются, чтобы новый месяц был как шаблон.</p><div class="formrow settingsForm"><select id="copyFromMonth">${options(state.months,currentMonth)}</select><select id="copyToMonth">${options(state.months)}</select><label><input type="checkbox" id="copyAmounts"> Копировать суммы тоже</label></div><button onclick="copyMonthTemplate()">Создать / заменить расходы месяца</button></details><details class="settingsBlock"><summary>Архивирование месяцев</summary><p>Можно архивировать один месяц или все месяцы сразу. Для разархивации выбери нужные месяцы из списка архивов.</p><div class="formrow settingsForm"><select id="archiveMonth"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select><button onclick="archiveSelectedMonth()">Архивировать</button></div><div class="archiveList">${archiveChecks()}</div><button onclick="unarchiveSelectedMonths()">Разархивировать выбранные</button></details></div>`;
 if(settingsTab === 'recurring') content = `<div class="card"><h3>Повторяющиеся платежи</h3><p class="mutedText">Создай правила для платежей, которые повторяются каждый месяц: патент, квартира, коммуналка, телефон, кредит. Категорию можно выбрать из списка или найти через ввод.</p><div class="formrow">${searchableField('recCat', state.expenseCategories, '', 'placeholder="Категория"')}<input id="recPlan" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Плановая сумма"><input id="recDay" inputmode="numeric" maxlength="2" placeholder="День месяца"><select id="recPriority">${options(state.priorities,'Обязательно')}</select><input id="recComment" placeholder="Комментарий"><button class="primary" onclick="addRecurringExpense()">Добавить правило</button></div>${recurringMonthSelector()}<div class="tableWrap">${recurringTable()}</div></div>`;
 if(settingsTab === 'categories') content = `<div class="two modelDataGrid">${categoryManager('expense','Категории расходов','Используются в разделе «Расходы» и в повторяющихся платежах. Порядок можно менять стрелками.','newExpenseCat',state.expenseCategories)}${categoryManager('income','Категории доходов','Используются в разделе «Доходы». Порядок можно менять стрелками.','newIncomeCat',state.incomeCategories)}</div>`;
 document.getElementById('settings').innerHTML=`${tabButtons}<div class="settingsTabContent">${content}</div>`;
}
function recurringTable(){
  ensureDataModelRelease();
  state.recurringExpenses ||= [];
  if(!state.recurringExpenses.length) return `<div class="empty">Правил пока нет</div>`;
  return `<table class="recurringTable"><thead><tr><th>Активно</th><th>Категория</th><th>Сумма</th><th>День</th><th>Приоритет</th><th>Комментарий</th><th></th></tr></thead><tbody>${state.recurringExpenses.map(r=>{const listId=`recCat_${r.id}`; return `<tr><td><input type="checkbox" ${r.active!==false?'checked':''} onchange="updRecurring('${r.id}','active',this.checked)"></td><td><input list="${listId}" value="${escapeHtml(r.category)}" oninput="updRecurring('${r.id}','category',this.value,true)" onblur="updRecurring('${r.id}','category',this.value)">${dataList(listId,state.expenseCategories)}</td><td><input ${amountAttrs()} value="${escapeHtml(r.planAmount)}" oninput="amountInput(this);updRecurring('${r.id}','planAmount',this.value,true)" onblur="amountBlur(this);updRecurring('${r.id}','planAmount',this.value)"></td><td><input inputmode="numeric" maxlength="2" value="${escapeHtml(r.day)}" oninput="this.value=this.value.replace(/[^0-9]/g,'').slice(0,2);updRecurring('${r.id}','day',this.value,true)" onblur="updRecurring('${r.id}','day',this.value)"></td><td><select onchange="updRecurring('${r.id}','priority',this.value)">${options(state.priorities,r.priority)}</select></td><td><input value="${escapeHtml(r.comment)}" oninput="updRecurring('${r.id}','comment',this.value,true)" onblur="updRecurring('${r.id}','comment',this.value)"></td><td><button class="danger" onclick="deleteRecurring('${r.id}')">Удалить</button></td></tr>`}).join('')}</tbody></table>`;
}
ensureDataModelRelease();
try{ render(); }catch(e){ console.error('Release 3.3 render failed', e); }

/* --- Release 3.3.1: drag-and-drop ordering + cleaner searchable fields --- */
let dragState = { kind: null, id: null };

function searchableField(id, arr, value='', attrs=''){
  const listId = `${id}_list`;
  return `<div class="searchSelectWrap"><input class="searchSelectInput" id="${id}" list="${listId}" value="${escapeHtml(value)}" autocomplete="off" ${attrs}>${dataList(listId,arr)}<span class="searchSelectIcon">⌕</span></div>`;
}

function normalizeOrderFor(list){
  const arr = state[list] || [];
  arr.forEach((x,i)=>{ if(typeof x.sortOrder !== 'number') x.sortOrder = i; });
  arr.sort((a,b)=>(a.sortOrder??0)-(b.sortOrder??0));
}
function orderedExpensesForMonth(month){
  normalizeOrderFor('expenses');
  return state.expenses.filter(x=>x.month===month).sort((a,b)=>(a.sortOrder??0)-(b.sortOrder??0));
}
function orderedIncomes(){
  normalizeOrderFor('incomes');
  return state.incomes.sort((a,b)=>(a.sortOrder??0)-(b.sortOrder??0));
}
function startRowDrag(ev,list,id){
  dragState = {kind:list,id};
  ev.dataTransfer.effectAllowed='move';
  ev.dataTransfer.setData('text/plain', `${list}:${id}`);
  ev.currentTarget.classList.add('dragging');
}
function endRowDrag(ev){
  ev.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.dragOver').forEach(x=>x.classList.remove('dragOver'));
}
function allowRowDrop(ev){ ev.preventDefault(); ev.currentTarget.classList.add('dragOver'); }
function leaveRowDrop(ev){ ev.currentTarget.classList.remove('dragOver'); }
function dropRow(ev,list,targetId){
  ev.preventDefault();
  ev.currentTarget.classList.remove('dragOver');
  const sourceId = dragState.id || (ev.dataTransfer.getData('text/plain').split(':')[1]);
  if(!sourceId || sourceId===targetId) return;
  if(list==='expenses') reorderVisibleList('expenses', sourceId, targetId, x=>x.month===currentMonth);
  if(list==='incomes') reorderVisibleList('incomes', sourceId, targetId, ()=>true);
}
function reorderVisibleList(list, sourceId, targetId, predicate){
  const visible = state[list].filter(predicate).sort((a,b)=>(a.sortOrder??0)-(b.sortOrder??0));
  const from = visible.findIndex(x=>x.id===sourceId);
  const to = visible.findIndex(x=>x.id===targetId);
  if(from<0 || to<0) return;
  const [item] = visible.splice(from,1);
  visible.splice(to,0,item);
  visible.forEach((x,i)=>x.sortOrder=i);
  save(); render();
}
function dragHandle(){ return `<span class="dragHandle" title="Удерживай и перетащи">☰</span>`; }

function expenseMonthDashboard(){
  const t = totals(currentMonth);
  return `<div class="grid expenseDashboards" style="margin-bottom:14px">${kpi('Доходы',rub(t.incomes))}${kpi('Расходы факт',rub(t.expensesFact))}${kpi('Остаток',rub(t.freeFact))}${kpi('План расходов',rub(t.expensesPlan))}</div>`;
}

function renderMonths(){
  ensureDataModelRelease();
  const archived=isMonthArchived(currentMonth);
  const rows=orderedExpensesForMonth(currentMonth);
  document.getElementById('months').innerHTML = `${monthTabs()}${expenseMonthDashboard()}<div class="card ${archived?'archivedCard':''}">
    <div class="toolbar"><div><h3>${currentMonth} — расходы</h3>${archived?'<p class="mutedText">Месяц архивирован. Редактирование отключено.</p>':'<p class="mutedText">Строки можно менять местами: удерживай значок ☰ и перетаскивай.</p>'}</div><div class="toolbarActions">${bulkDeleteButton('expenses')}<button class="primary" onclick="addExpense()" ${archived?'disabled':''}>Добавить расход</button></div></div>
    ${expenseForm()}
    <div class="tableWrap">${expenseTable(rows)}</div></div>`;
}
function expenseTable(rows){
 if(!rows.length) return `<div class="empty">Записей нет</div>`;
 return `<table class="expenseTable"><thead><tr><th class="checkCol"><input type="checkbox" ${rows.length && rows.every(x=>selected.expenses.has(x.id))?'checked':''} onchange="toggleVisible('expenses', this.checked)"></th><th class="dragCol"></th><th>Категория</th><th>План</th><th>Факт</th><th>Дата</th><th>Оплачено</th><th>Комментарий</th><th>Приоритет</th><th></th></tr></thead><tbody>
 ${rows.map(x=>{const disabled=archivedAttr(x.month); const listId=`cat_${x.id}`; return `<tr draggable="${disabled?'false':'true'}" ondragstart="startRowDrag(event,'expenses','${x.id}')" ondragend="endRowDrag(event)" ondragover="allowRowDrop(event)" ondragleave="leaveRowDrop(event)" ondrop="dropRow(event,'expenses','${x.id}')">
 <td class="checkCol"><input type="checkbox" ${selected.expenses.has(x.id)?'checked':''} onchange="toggleOne('expenses','${x.id}',this.checked)" ${disabled}></td>
 <td class="dragCol">${disabled?'':dragHandle()}</td>
 <td><div class="searchSelectWrap tableSearch"><input class="searchSelectInput" list="${listId}" value="${escapeHtml(x.category)}" oninput="upd('expenses','${x.id}','category',this.value,{silent:true})" onblur="render()" ${disabled}>${dataList(listId,state.expenseCategories)}<span class="searchSelectIcon">⌕</span></div></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.planAmount)}" oninput="amountInput(this,'expenses','${x.id}','planAmount')" onblur="amountBlur(this,'expenses','${x.id}','planAmount');render()" placeholder="0" ${disabled}></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.factAmount)}" oninput="amountInput(this,'expenses','${x.id}','factAmount')" onblur="amountBlur(this,'expenses','${x.id}','factAmount');render()" placeholder="0" ${disabled}></td>
 <td><input type="date" value="${escapeHtml(x.date)}" onchange="upd('expenses','${x.id}','date',this.value)" ${disabled}></td>
 <td><label class="paidLabel"><input type="checkbox" ${x.paid?'checked':''} onchange="upd('expenses','${x.id}','paid',this.checked)" ${disabled}> ${expenseStatusPill(x)}</label></td>
 <td><textarea class="commentArea" oninput="upd('expenses','${x.id}','comment',this.value,{silent:true})" onblur="render()" ${disabled}>${escapeHtml(x.comment)}</textarea></td>
 <td><select onchange="upd('expenses','${x.id}','priority',this.value)" ${disabled}>${options(state.priorities,x.priority)}</select></td>
 <td><button class="danger subtleDanger" onclick="del('expenses','${x.id}')" ${disabled}>Удалить</button></td></tr>`}).join('')}</tbody></table>`;
}
function addExpense(){
 if(isMonthArchived(currentMonth)){alert('Этот месяц архивирован. Сначала разархивируй его в настройках.'); return;}
 const maxOrder = Math.max(-1,...state.expenses.filter(x=>x.month===currentMonth).map(x=>Number(x.sortOrder)||0));
 state.expenses.push(normalizeExpense({id:uid('e'),month:currentMonth,category:val('exCat') || 'Другое',planAmount:cleanAmountValue(val('exPlan'), true),factAmount:cleanAmountValue(val('exFact'), true),date:val('exDate'),paid:document.getElementById('exPaid')?.checked || false,paidManual:document.getElementById('exPaid')?.checked || false,comment:val('exComment'),priority:val('exPriority'),sortOrder:maxOrder+1}));
 save(); render();
}
function renderIncome(){
 ensureDataModelRelease();
 document.getElementById('income').innerHTML=`<div class="card"><div class="toolbar"><div><h3>Доходы</h3><p class="mutedText">Будущие доходы не участвуют в остатках до наступления даты. Строки можно менять местами перетаскиванием.</p></div><div class="toolbarActions">${bulkDeleteButton('incomes')}<button class="primary" onclick="addIncome()">Добавить доход</button></div></div>
 <div class="formrow"><input id="inDate" type="date"><select id="inMonth">${options(state.months,currentMonth)}</select>${searchableField('inType', state.incomeCategories, '', 'placeholder="Категория дохода"')}<input id="inAmount" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Сумма"><input id="inComment" placeholder="Комментарий"></div>
 <div class="tableWrap">${incomeTable()}</div></div>`;
}
function incomeTable(){
 ensureDataModelRelease();
 const rows = orderedIncomes();
 if(!rows.length) return `<div class="empty">Доходов нет</div>`;
 return `<table class="incomeTable"><thead><tr><th class="checkCol"><input type="checkbox" ${rows.length && rows.every(x=>selected.incomes.has(x.id))?'checked':''} onchange="toggleVisible('incomes', this.checked)"></th><th class="dragCol"></th><th>Дата</th><th>Месяц</th><th>Категория дохода</th><th>Сумма</th><th>Статус</th><th>Комментарий</th><th></th></tr></thead><tbody>
 ${rows.map(x=>{const disabled=archivedAttr(x.month); const st=incomeStatus(x); const listId=`incomeCat_${x.id}`; return `<tr draggable="${disabled?'false':'true'}" ondragstart="startRowDrag(event,'incomes','${x.id}')" ondragend="endRowDrag(event)" ondragover="allowRowDrop(event)" ondragleave="leaveRowDrop(event)" ondrop="dropRow(event,'incomes','${x.id}')"><td class="checkCol"><input type="checkbox" ${disabled} ${selected.incomes.has(x.id)?'checked':''} onchange="toggleOne('incomes','${x.id}',this.checked)"></td><td class="dragCol">${disabled?'':dragHandle()}</td><td><input type="date" value="${escapeHtml(x.date)}" onchange="upd('incomes','${x.id}','date',this.value);render()" ${disabled}></td><td><select onchange="upd('incomes','${x.id}','month',this.value);render()" ${disabled}>${options(state.months,x.month)}</select></td><td><div class="searchSelectWrap tableSearch"><input class="searchSelectInput" list="${listId}" value="${escapeHtml(x.type || x.source)}" oninput="upd('incomes','${x.id}','type',this.value,{silent:true});upd('incomes','${x.id}','source',this.value,{silent:true})" onblur="render()" ${disabled}>${dataList(listId,state.incomeCategories)}<span class="searchSelectIcon">⌕</span></div></td><td><input ${amountAttrs()} value="${escapeHtml(x.amount)}" oninput="amountInput(this,'incomes','${x.id}','amount')" onblur="amountBlur(this,'incomes','${x.id}','amount');render()" placeholder="0" ${disabled}></td><td><span class="pill ${st.cls}">${st.text}</span></td><td><input value="${escapeHtml(x.comment)}" oninput="upd('incomes','${x.id}','comment',this.value,{silent:true})" onblur="render()" ${disabled}></td><td><button class="danger subtleDanger" onclick="del('incomes','${x.id}')" ${disabled}>Удалить</button></td></tr>`}).join('')}</tbody></table>`;
}
function addIncome(){
  if(isMonthArchived(val('inMonth'))){alert('Этот месяц архивирован. Сначала разархивируй его в настройках.'); return;}
  const type = val('inType') || 'Другое';
  const maxOrder = Math.max(-1,...state.incomes.map(x=>Number(x.sortOrder)||0));
  state.incomes.push({id:uid('i'),date:val('inDate'),month:val('inMonth'),source:type,amount:cleanAmountValue(val('inAmount'), true),type,comment:val('inComment'),sortOrder:maxOrder+1});
  save(); render();
}

function startCategoryDrag(ev,kind,value){
  dragState = {kind:`cat:${kind}`, id:value};
  ev.dataTransfer.effectAllowed='move';
  ev.dataTransfer.setData('text/plain', `${kind}:${value}`);
  ev.currentTarget.classList.add('dragging');
}
function dropCategory(ev,kind,targetValue){
  ev.preventDefault();
  ev.currentTarget.classList.remove('dragOver');
  const sourceValue = dragState.id || ev.dataTransfer.getData('text/plain').split(':').slice(1).join(':');
  if(!sourceValue || sourceValue===targetValue) return;
  const arrName = kind === 'income' ? 'incomeCategories' : 'expenseCategories';
  const arr = state[arrName] || [];
  const from = arr.indexOf(sourceValue);
  const to = arr.indexOf(targetValue);
  if(from<0 || to<0) return;
  const [item] = arr.splice(from,1);
  arr.splice(to,0,item);
  state.categories=state.expenseCategories;
  state.incomeTypes=state.incomeCategories;
  save(); renderSettings();
}
function categoryManager(kind,title,description,inputId,arr){
  return `<div class="card compactCard categoriesSettings"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description.replace('Порядок можно менять стрелками.','Порядок можно менять перетаскиванием.'))}</p><div class="compactAdd"><input id="${inputId}" placeholder="Новая категория"><button class="primary" onclick="addCategory('${kind}')">Добавить</button></div><div class="categoryColumn">${(arr||[]).map(c=>`<div class="categoryRow" draggable="true" ondragstart="startCategoryDrag(event,'${kind}','${escapeHtml(c)}')" ondragend="endRowDrag(event)" ondragover="allowRowDrop(event)" ondragleave="leaveRowDrop(event)" ondrop="dropCategory(event,'${kind}','${escapeHtml(c)}')"><span class="dragHandle" title="Удерживай и перетащи">☰</span><span class="categoryName">${escapeHtml(c)}</span><button class="danger miniBtn subtleDanger" onclick="removeCategory('${kind}','${escapeHtml(c)}')">Удалить</button></div>`).join('')}</div></div>`;
}
function renderSettings(){
 ensureDataModelRelease();
 const tabs=[['account','Аккаунт'],['appearance','Внешний вид'],['data','Импорт / экспорт'],['maintenance','Обслуживание'],['months','Месяцы и архив'],['recurring','Повторяющиеся'],['categories','Модель данных']];
 const tabButtons = `<div class="settingsTabs">${tabs.map(([id,title])=>`<button class="${settingsTab===id?'active':''}" onclick="settingsTab='${id}';renderSettings()">${title}</button>`).join('')}</div>`;
 let content='';
 if(settingsTab === 'account') content = `${cloudPanel()}`;
 if(settingsTab === 'appearance') content = `<div class="card"><h3>Тема оформления</h3><p class="mutedText">Светлая тема остается как сейчас. Темная тема сделана в спокойной графитово-коричневой палитре.</p><div class="themeChoices"><button class="themeChoice ${currentTheme==='light'?'active':''}" onclick="setTheme('light')"><span class="themePreview lightPreview"></span><strong>Светлая</strong><small>Текущий теплый стиль</small></button><button class="themeChoice ${currentTheme==='dark'?'active':''}" onclick="setTheme('dark')"><span class="themePreview darkPreview"></span><strong>Темная</strong><small>Графит + теплый акцент</small></button></div></div>`;
 if(settingsTab === 'data') content = `<div class="card"><h3>Импорт / экспорт</h3><p>Экспортируй резервную копию или импортируй данные из JSON. Можно выбрать все месяцы или один месяц.</p><div class="formrow settingsForm"><select id="dataMonthSelect"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select><button onclick="exportJson()">Экспорт</button><label class="fileBtn">Импорт<input type="file" accept="application/json" onchange="importJson(event)"></label></div></div>`;
 if(settingsTab === 'maintenance') content = `<div class="card"><h3>Обслуживание</h3><p class="mutedText">Редкие действия убраны в раскрывающиеся блоки, чтобы случайно ничего не удалить.</p><details class="settingsBlock"><summary>Очистить суммы</summary><p>Оставляет строки, но удаляет суммы. Можно выбрать разделы и месяц.</p><select id="clearMonth"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select>${sectionChecks('clear')}<button onclick="clearAmounts()">Очистить суммы</button></details><details class="settingsBlock"><summary>Пустой шаблон</summary><p>Удаляет записи в выбранных разделах. Архивные месяцы не изменяются.</p><select id="emptyMonth"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select>${sectionChecks('empty')}<button class="danger" onclick="resetData()">Удалить записи</button></details></div>`;
 if(settingsTab === 'months') content = `<div class="card"><h3>Месяцы и архив</h3><p>Здесь можно копировать месяцы, архивировать завершенные периоды и разархивировать их при необходимости.</p><details class="settingsBlock"><summary>Создать месяц на основе другого</summary><p>Копирует строки расходов из выбранного месяца в другой. По умолчанию суммы очищаются, чтобы новый месяц был как шаблон.</p><div class="formrow settingsForm"><select id="copyFromMonth">${options(state.months,currentMonth)}</select><select id="copyToMonth">${options(state.months)}</select><label><input type="checkbox" id="copyAmounts"> Копировать суммы тоже</label></div><button onclick="copyMonthTemplate()">Создать / заменить расходы месяца</button></details><details class="settingsBlock"><summary>Архивирование месяцев</summary><p>Можно архивировать один месяц или все месяцы сразу. Для разархивации выбери нужные месяцы из списка архивов.</p><div class="formrow settingsForm"><select id="archiveMonth"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select><button onclick="archiveSelectedMonth()">Архивировать</button></div><div class="archiveList">${archiveChecks()}</div><button onclick="unarchiveSelectedMonths()">Разархивировать выбранные</button></details></div>`;
 if(settingsTab === 'recurring') content = `<div class="card"><h3>Повторяющиеся платежи</h3><p class="mutedText">Создай правила для платежей, которые повторяются каждый месяц: патент, квартира, коммуналка, телефон, кредит. Категорию можно выбрать из списка или найти через ввод.</p><div class="formrow">${searchableField('recCat', state.expenseCategories, '', 'placeholder="Категория"')}<input id="recPlan" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Плановая сумма"><input id="recDay" inputmode="numeric" maxlength="2" placeholder="День месяца"><select id="recPriority">${options(state.priorities,'Обязательно')}</select><input id="recComment" placeholder="Комментарий"><button class="primary" onclick="addRecurringExpense()">Добавить правило</button></div>${recurringMonthSelector()}<div class="tableWrap">${recurringTable()}</div></div>`;
 if(settingsTab === 'categories') content = `<div class="two modelDataGrid">${categoryManager('expense','Категории расходов','Используются в разделе «Расходы» и в повторяющихся платежах. Порядок можно менять перетаскиванием.','newExpenseCat',state.expenseCategories)}${categoryManager('income','Категории доходов','Используются в разделе «Доходы». Порядок можно менять перетаскиванием.','newIncomeCat',state.incomeCategories)}</div>`;
 document.getElementById('settings').innerHTML=`${tabButtons}<div class="settingsTabContent">${content}</div>`;
}

try{ render(); }catch(e){ console.error('Release 3.3.1 render failed', e); }

/* --- Release 3.3.2: native-looking searchable selects + cleaner drag UI --- */
function jsArg(v){ return JSON.stringify(String(v ?? '')); }
function smartSelectMarkup(id, arr, value='', placeholder='Выбрать', mode='form', list='', itemId='', key='', secondaryKey='', disabled=''){
  const safeId = String(id).replace(/[^a-zA-Z0-9_:-]/g,'_');
  const selected = String(value || '');
  const label = selected || placeholder;
  const opts = (arr || []).map(v=>`<button type="button" class="smartOption" data-search="${escapeHtml(String(v).toLowerCase())}" onclick='smartSelectChoose(${jsArg(safeId)}, ${jsArg(v)}, ${jsArg(mode)}, ${jsArg(list)}, ${jsArg(itemId)}, ${jsArg(key)}, ${jsArg(secondaryKey)})'>${escapeHtml(v)}</button>`).join('');
  return `<div class="smartSelect ${disabled?'disabled':''}" id="${safeId}_wrap">
    <input type="hidden" id="${safeId}" value="${escapeHtml(selected)}">
    <button type="button" class="smartSelectBtn" onclick="openSmartSelect(event,'${safeId}')" ${disabled?'disabled':''}><span id="${safeId}_label">${escapeHtml(label)}</span><span class="smartCaret">▾</span></button>
    <div class="smartMenu" id="${safeId}_menu">
      <input class="smartSearch" placeholder="Поиск..." oninput="filterSmartOptions('${safeId}', this.value)" onclick="event.stopPropagation()">
      <div class="smartOptions" id="${safeId}_options">${opts || '<div class="smartEmpty">Нет категорий</div>'}</div>
    </div>
  </div>`;
}
function searchableField(id, arr, value='', attrs=''){
  const ph = (attrs.match(/placeholder="([^"]+)"/)||[])[1] || 'Выбрать';
  const disabled = /disabled/.test(attrs) ? 'disabled' : '';
  return smartSelectMarkup(id, arr, value, ph, 'form', '', '', '', '', disabled);
}
function openSmartSelect(ev,id){
  ev.stopPropagation();
  document.querySelectorAll('.smartSelect.open').forEach(el=>{ if(el.id !== id+'_wrap') el.classList.remove('open'); });
  const wrap=document.getElementById(id+'_wrap');
  if(!wrap) return;
  wrap.classList.toggle('open');
  if(wrap.classList.contains('open')){
    const search=document.querySelector(`#${CSS.escape(id+'_menu')} .smartSearch`);
    if(search){ search.value=''; filterSmartOptions(id,''); setTimeout(()=>search.focus(),30); }
  }
}
function filterSmartOptions(id,q){
  const query=String(q||'').trim().toLowerCase();
  document.querySelectorAll(`#${CSS.escape(id+'_options')} .smartOption`).forEach(btn=>{
    btn.style.display = !query || btn.dataset.search.includes(query) ? '' : 'none';
  });
}
function smartSelectChoose(id,value,mode,list,itemId,key,secondaryKey){
  const hidden=document.getElementById(id); if(hidden) hidden.value=value;
  const label=document.getElementById(id+'_label'); if(label) label.textContent=value || 'Выбрать';
  document.getElementById(id+'_wrap')?.classList.remove('open');
  if(mode==='row'){
    upd(list,itemId,key,value,{silent:true});
    if(secondaryKey) upd(list,itemId,secondaryKey,value,{silent:true});
    render();
  }
}
if(!window.__smartSelectCloseBound){
  document.addEventListener('click',()=>document.querySelectorAll('.smartSelect.open').forEach(el=>el.classList.remove('open')));
  window.__smartSelectCloseBound=true;
}
function dragHandleFor(list,id){ return `<span class="dragHandle" draggable="true" ondragstart="startRowDrag(event,'${list}','${id}')" ondragend="endRowDrag(event)" title="Удерживай и перетащи">☰</span>`; }

function expenseTable(rows){
 if(!rows.length) return `<div class="empty">Записей нет</div>`;
 return `<table class="expenseTable"><thead><tr><th class="checkCol"><input type="checkbox" ${rows.length && rows.every(x=>selected.expenses.has(x.id))?'checked':''} onchange="toggleVisible('expenses', this.checked)"></th><th class="dragCol"></th><th>Категория</th><th>План</th><th>Факт</th><th>Дата</th><th>Оплачено</th><th>Комментарий</th><th>Приоритет</th><th></th></tr></thead><tbody>
 ${rows.map(x=>{const disabled=archivedAttr(x.month); return `<tr ondragover="allowRowDrop(event)" ondragleave="leaveRowDrop(event)" ondrop="dropRow(event,'expenses','${x.id}')">
 <td class="checkCol"><input type="checkbox" ${selected.expenses.has(x.id)?'checked':''} onchange="toggleOne('expenses','${x.id}',this.checked)" ${disabled}></td>
 <td class="dragCol">${disabled?'':dragHandleFor('expenses',x.id)}</td>
 <td>${smartSelectMarkup(`cat_${x.id}`, state.expenseCategories, x.category, 'Категория', 'row', 'expenses', x.id, 'category', '', disabled)}</td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.planAmount)}" oninput="amountInput(this,'expenses','${x.id}','planAmount')" onblur="amountBlur(this,'expenses','${x.id}','planAmount');render()" placeholder="0" ${disabled}></td>
 <td><input ${amountAttrs()} value="${escapeHtml(x.factAmount)}" oninput="amountInput(this,'expenses','${x.id}','factAmount')" onblur="amountBlur(this,'expenses','${x.id}','factAmount');render()" placeholder="0" ${disabled}></td>
 <td><input type="date" value="${escapeHtml(x.date)}" onchange="upd('expenses','${x.id}','date',this.value)" ${disabled}></td>
 <td><label class="paidLabel"><input type="checkbox" ${x.paid?'checked':''} onchange="upd('expenses','${x.id}','paid',this.checked)" ${disabled}> ${expenseStatusPill(x)}</label></td>
 <td><textarea class="commentArea" oninput="upd('expenses','${x.id}','comment',this.value,{silent:true})" onblur="render()" ${disabled}>${escapeHtml(x.comment)}</textarea></td>
 <td><select onchange="upd('expenses','${x.id}','priority',this.value)" ${disabled}>${options(state.priorities,x.priority)}</select></td>
 <td><button class="danger subtleDanger" onclick="del('expenses','${x.id}')" ${disabled}>Удалить</button></td></tr>`}).join('')}</tbody></table>`;
}
function renderIncome(){
 ensureDataModelRelease();
 document.getElementById('income').innerHTML=`<div class="card"><div class="toolbar"><div><h3>Доходы</h3><p class="mutedText">Будущие доходы не участвуют в остатках до наступления даты. Строки можно менять местами перетаскиванием.</p></div><div class="toolbarActions">${bulkDeleteButton('incomes')}<button class="primary" onclick="addIncome()">Добавить доход</button></div></div>
 <div class="formrow"><input id="inDate" type="date"><select id="inMonth">${options(state.months,currentMonth)}</select>${searchableField('inType', state.incomeCategories, '', 'placeholder="Категория дохода"')}<input id="inAmount" ${amountAttrs()} oninput="amountInput(this)" onblur="amountBlur(this)" placeholder="Сумма"><input id="inComment" placeholder="Комментарий"></div>
 <div class="tableWrap">${incomeTable()}</div></div>`;
}
function incomeTable(){
 ensureDataModelRelease();
 const rows = orderedIncomes();
 if(!rows.length) return `<div class="empty">Доходов нет</div>`;
 return `<table class="incomeTable"><thead><tr><th class="checkCol"><input type="checkbox" ${rows.length && rows.every(x=>selected.incomes.has(x.id))?'checked':''} onchange="toggleVisible('incomes', this.checked)"></th><th class="dragCol"></th><th>Дата</th><th>Месяц</th><th>Категория дохода</th><th>Сумма</th><th>Статус</th><th>Комментарий</th><th></th></tr></thead><tbody>
 ${rows.map(x=>{const disabled=archivedAttr(x.month); const st=incomeStatus(x); return `<tr ondragover="allowRowDrop(event)" ondragleave="leaveRowDrop(event)" ondrop="dropRow(event,'incomes','${x.id}')"><td class="checkCol"><input type="checkbox" ${disabled} ${selected.incomes.has(x.id)?'checked':''} onchange="toggleOne('incomes','${x.id}',this.checked)"></td><td class="dragCol">${disabled?'':dragHandleFor('incomes',x.id)}</td><td><input type="date" value="${escapeHtml(x.date)}" onchange="upd('incomes','${x.id}','date',this.value);render()" ${disabled}></td><td><select onchange="upd('incomes','${x.id}','month',this.value);render()" ${disabled}>${options(state.months,x.month)}</select></td><td>${smartSelectMarkup(`incomeCat_${x.id}`, state.incomeCategories, x.type || x.source, 'Категория дохода', 'row', 'incomes', x.id, 'type', 'source', disabled)}</td><td><input ${amountAttrs()} value="${escapeHtml(x.amount)}" oninput="amountInput(this,'incomes','${x.id}','amount')" onblur="amountBlur(this,'incomes','${x.id}','amount');render()" placeholder="0" ${disabled}></td><td><span class="pill ${st.cls}">${st.text}</span></td><td><input value="${escapeHtml(x.comment)}" oninput="upd('incomes','${x.id}','comment',this.value,{silent:true})" onblur="render()" ${disabled}></td><td><button class="danger subtleDanger" onclick="del('incomes','${x.id}')" ${disabled}>Удалить</button></td></tr>`}).join('')}</tbody></table>`;
}
function categoryManager(kind,title,description,inputId,arr){
  return `<div class="card compactCard categoriesSettings"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description.replace('Порядок можно менять стрелками.','Порядок можно менять перетаскиванием.'))}</p><div class="compactAdd"><input id="${inputId}" placeholder="Новая категория"><button class="primary" onclick="addCategory('${kind}')">Добавить</button></div><div class="categoryColumn">${(arr||[]).map(c=>`<div class="categoryRow" ondragover="allowRowDrop(event)" ondragleave="leaveRowDrop(event)" ondrop="dropCategory(event,'${kind}','${escapeHtml(c)}')"><span class="dragHandle" draggable="true" ondragstart="startCategoryDrag(event,'${kind}','${escapeHtml(c)}')" ondragend="endRowDrag(event)" title="Удерживай и перетащи">☰</span><span class="categoryName">${escapeHtml(c)}</span><button class="danger miniBtn subtleDanger" onclick="removeCategory('${kind}','${escapeHtml(c)}')">Удалить</button></div>`).join('')}</div></div>`;
}
