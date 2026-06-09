const seed = JSON.parse(document.getElementById('seedData').textContent);
const STORAGE_KEY = 'personalBudgetSiteOldDesignGoals.v2';
const CLOUD_CONFIG_KEY = 'personalBudgetCloudSupabase.v1';
const EMBEDDED_CLOUD_CONFIG = window.BUDGET_SUPABASE_CONFIG || {};
let state = migrateState(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') || seed);
let currentMonth = state.months[new Date().getMonth()] || 'Январь';
let settingsTab = 'database';
let selected = { expenses: new Set(), incomes: new Set(), purchases: new Set() };
let storedCloudConfig = JSON.parse(localStorage.getItem(CLOUD_CONFIG_KEY) || 'null') || {};
let cloudConfig = {
  url: storedCloudConfig.url || EMBEDDED_CLOUD_CONFIG.url || '',
  key: storedCloudConfig.key || EMBEDDED_CLOUD_CONFIG.key || '',
  enabled: storedCloudConfig.enabled ?? !!(EMBEDDED_CLOUD_CONFIG.url && EMBEDDED_CLOUD_CONFIG.key)
};
let cloudClient = null;
let cloudUser = null;
let cloudStatus = cloudConfig.enabled ? 'Облако не подключено' : 'Локальный режим';
let cloudSaveTimer = null;
let cloudSaveInProgress = false;
let pendingCloudSave = false;
let suppressCloudSave = false;

const rub = n => (Number(n)||0).toLocaleString('ru-RU') + ' ₽';
const pct = n => (Number(n)||0).toLocaleString('ru-RU', {maximumFractionDigits: 1}) + '%';
const num = v => Number(String(v ?? '').replace(/\s/g,'').replace(',','.')) || 0;
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
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
  s.purchases = s.purchases.map(x => ({
    id: x.id || uid('p'),
    name: x.name || x.purchase || 'Цель',
    targetAmount: x.targetAmount ?? x.planAmount ?? '',
    percent: x.percent ?? '',
    initialAmount: x.initialAmount ?? x.factAmount ?? '',
    priority: x.priority || 'Средний',
    status: x.status || 'План',
    comment: x.comment || ''
  }));
  return s;
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
    if(diff!==null && diff>=0 && diff<=2 && x.status!=='Оплачено') items.push({kind:'Расход', month:x.month, title:x.category, date:x.date, diff, text:x.comment});
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
function goalAccumulated(goal, upToMonth=currentMonth){
  const idx = monthIndex(upToMonth);
  const months = idx < 0 ? state.months : state.months.slice(0, idx + 1);
  return num(goal.initialAmount) + months.reduce((s,m)=>s+goalMonthAmount(goal,m),0);
}
function goalRemaining(goal, upToMonth=currentMonth){return Math.max(num(goal.targetAmount) - goalAccumulated(goal, upToMonth), 0)}
function goalProgress(goal, upToMonth=currentMonth){const target=num(goal.targetAmount); return target ? Math.min(goalAccumulated(goal, upToMonth)/target*100, 100) : 0}


function hasSupabaseLibrary(){return !!(window.supabase && window.supabase.createClient)}
function normalizeCloudConfig(){
  cloudConfig.url = (cloudConfig.url || EMBEDDED_CLOUD_CONFIG.url || '').trim();
  cloudConfig.key = (cloudConfig.key || EMBEDDED_CLOUD_CONFIG.key || '').trim();
  cloudConfig.enabled = !!(cloudConfig.enabled && cloudConfig.url && cloudConfig.key);
  localStorage.setItem(CLOUD_CONFIG_KEY, JSON.stringify(cloudConfig));
}
function createCloudClient(){
  normalizeCloudConfig();
  if(!cloudConfig.enabled) { cloudClient=null; cloudUser=null; cloudStatus='Локальный режим'; return false; }
  if(!hasSupabaseLibrary()){ cloudStatus='Supabase SDK не загрузился'; return false; }
  try{
    cloudClient = window.supabase.createClient(cloudConfig.url, cloudConfig.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    return true;
  }catch(err){ cloudStatus='Ошибка клиента Supabase'; console.error(err); return false; }
}
async function initCloud(){
  if(!createCloudClient()) return;
  const { data, error } = await cloudClient.auth.getSession();
  if(error){ cloudStatus='Ошибка сессии Supabase'; return; }
  cloudUser = data?.session?.user || null;
  if(cloudUser){
    cloudStatus='Облако подключено. Загружаю данные...';
    await cloudLoad(false);
  } else {
    cloudStatus='Supabase настроен, нужен вход';
  }
  cloudClient.auth.onAuthStateChange(async (event, session)=>{
    cloudUser = session?.user || null;
    if(cloudUser){
      cloudStatus = 'Облако подключено';
      if(event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') await cloudLoad(false);
    } else {
      cloudStatus = 'Supabase настроен, нужен вход';
    }
    render();
  });
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
    if(showAlert) alert('В облаке пока нет данных. Нажми «Сохранить в облако»');
    render();
  }
}
async function saveCloudSettings(){
  cloudConfig.url = val('supabaseUrl');
  cloudConfig.key = val('supabaseKey');
  cloudConfig.enabled = !!document.getElementById('supabaseEnabled')?.checked;
  normalizeCloudConfig();
  const ok=createCloudClient();
  if(ok) await initCloud();
  render();
  alert(cloudConfig.enabled ? 'Настройки Supabase сохранены' : 'Облачный режим выключен');
}
async function cloudSignUp(){
  if(!createCloudClient()){ alert('Сначала укажи Supabase URL и publishable/anon key'); return; }
  const email=val('cloudEmail').trim(); const password=val('cloudPassword');
  if(!email || !password){ alert('Укажи email и пароль'); return; }
  const { error } = await cloudClient.auth.signUp({ email, password });
  if(error){ alert('Ошибка регистрации: '+error.message); return; }
  alert('Регистрация создана. Если Supabase попросит подтверждение email — подтверди письмо, потом нажми «Войти».');
}
async function cloudLogin(){
  if(!createCloudClient()){ alert('Сначала укажи Supabase URL и publishable/anon key'); return; }
  const email=val('cloudEmail').trim(); const password=val('cloudPassword');
  if(!email || !password){ alert('Укажи email и пароль'); return; }
  const { data, error } = await cloudClient.auth.signInWithPassword({ email, password });
  if(error){ alert('Ошибка входа: '+error.message); return; }
  cloudUser=data?.user || null;
  cloudStatus='Облако подключено';
  await cloudLoad(false);
  render();
}
async function cloudLogout(){
  if(cloudClient) await cloudClient.auth.signOut();
  cloudUser=null; cloudStatus='Supabase настроен, нужен вход'; render();
}
function cloudPanel(){
  const isConfigured = !!(cloudConfig.enabled && cloudConfig.url && cloudConfig.key);
  const isEmbedded = !!(EMBEDDED_CLOUD_CONFIG.url && EMBEDDED_CLOUD_CONFIG.key);
  if(isConfigured && cloudUser){
    return `<div class="card" style="margin-top:14px"><h3>Облако Supabase</h3>
    <div class="cloudStatus"><span class="pill ok" data-cloud-status>${escapeHtml(cloudStatus)}</span><span class="pill">${escapeHtml(cloudUser.email || '')}</span></div>
    <p class="mutedText">Автоматический режим включен: при открытии сайта данные загружаются из облака, изменения сохраняются автоматически через несколько секунд. На другом устройстве достаточно обновить страницу.</p>
    <div class="formrow settingsForm"><button class="danger" onclick="cloudLogout()">Выйти</button><button onclick="cloudLoad(true)">Обновить из облака</button></div>
    <details class="advancedBox"><summary>Технические настройки</summary>
      <div class="formrow settingsForm"><label><input type="checkbox" id="supabaseEnabled" ${cloudConfig.enabled?'checked':''}> Включить облачный режим</label><input id="supabaseUrl" placeholder="Supabase Project URL" value="${escapeHtml(cloudConfig.url)}"><input id="supabaseKey" placeholder="Publishable / anon key" value="${escapeHtml(cloudConfig.key)}"><button onclick="saveCloudSettings()">Сохранить настройки</button><button class="danger" onclick="resetCloudSettings()">Сбросить подключение</button></div>
    </details></div>`;
  }
  if(isConfigured && !cloudUser){
    return `<div class="card" style="margin-top:14px"><h3>Облако Supabase</h3>
    <div class="cloudStatus"><span class="pill" data-cloud-status>${escapeHtml(cloudStatus)}</span></div>
    <p>Подключение к базе уже настроено. Осталось войти один раз на этом устройстве. После входа сессия сохранится в браузере.</p>
    <div class="formrow settingsForm"><input id="cloudEmail" type="email" placeholder="Email"><input id="cloudPassword" type="password" placeholder="Пароль"><button onclick="cloudSignUp()">Регистрация</button><button class="primary" onclick="cloudLogin()">Войти</button></div>
    <details class="advancedBox"><summary>Технические настройки</summary>
      <div class="formrow settingsForm"><label><input type="checkbox" id="supabaseEnabled" ${cloudConfig.enabled?'checked':''}> Включить облачный режим</label><input id="supabaseUrl" placeholder="Supabase Project URL" value="${escapeHtml(cloudConfig.url)}"><input id="supabaseKey" placeholder="Publishable / anon key" value="${escapeHtml(cloudConfig.key)}"><button onclick="saveCloudSettings()">Сохранить настройки</button></div>
    </details></div>`;
  }
  return `<div class="card" style="margin-top:14px"><h3>Облако Supabase</h3><p>Первичная настройка. Вставь Project URL и Publishable key один раз. Чтобы не вводить их на каждом устройстве, заполни файл <strong>cloud-config.js</strong> перед загрузкой на GitHub.</p>
  <div class="cloudStatus"><span class="pill" data-cloud-status>${escapeHtml(cloudStatus)}</span></div>
  <div class="formrow settingsForm"><label><input type="checkbox" id="supabaseEnabled" checked> Включить облачный режим</label><input id="supabaseUrl" placeholder="Supabase Project URL" value="${escapeHtml(cloudConfig.url)}"><input id="supabaseKey" placeholder="Publishable / anon key" value="${escapeHtml(cloudConfig.key)}"><button class="primary" onclick="saveCloudSettings()">Сохранить подключение</button></div>
  <p class="mutedText">Secret/service_role key сюда вставлять нельзя.</p></div>`;
}
async function resetCloudSettings(){
  if(!confirm('Сбросить подключение Supabase в этом браузере? Данные в облаке не удалятся.')) return;
  if(cloudClient) await cloudClient.auth.signOut();
  localStorage.removeItem(CLOUD_CONFIG_KEY);
  storedCloudConfig = {};
  cloudConfig = { url: EMBEDDED_CLOUD_CONFIG.url || '', key: EMBEDDED_CLOUD_CONFIG.key || '', enabled: !!(EMBEDDED_CLOUD_CONFIG.url && EMBEDDED_CLOUD_CONFIG.key) };
  cloudClient=null; cloudUser=null; cloudStatus=cloudConfig.enabled?'Supabase настроен, нужен вход':'Локальный режим';
  initCloud().finally(()=>render());
}


function init(){
  document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>showView(b.dataset.view));
  initCloud().finally(()=>render());
  render();
}
function showView(id){
  document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===id));
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===id));
  const titles={dashboard:'Сводка',months:'Месяцы',income:'Доходы',purchases:'План покупок',balance:'Остатки',settings:'Настройки'};
  document.getElementById('pageTitle').textContent=titles[id]||'Бюджет';
  render();
}
function render(){
  pruneSelection();
  renderDashboard(); renderMonths(); renderIncome(); renderPurchases(); renderBalance(); renderSettings();
}
function kpi(label,value,hint=''){return `<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div>${hint?`<div class="hint">${hint}</div>`:''}</div>`}
function renderDashboard(){
  const t=totals(currentMonth);
  const year=allTotals();
  const goalPercentTotal = state.purchases.reduce((s,x)=>s+num(x.percent),0);
  document.getElementById('dashboard').innerHTML = `
    <div class="card dashboardControls"><div><h3>Сводка за месяц</h3><p>Выбери месяц — ниже будут показаны доходы, расходы, остаток и распределение по целям только за этот месяц.</p></div><select onchange="currentMonth=this.value;render()">${options(state.months,currentMonth)}</select></div>
    ${notificationPanel(currentMonth)}
    <div class="dashSection"><h3>${currentMonth}: деньги за месяц</h3><div class="grid">${kpi('Доходы',rub(t.incomes),'сколько поступило')}${kpi('Расходы',rub(t.expensesFact),'сколько потрачено по факту')}${kpi('Свободный остаток',rub(t.freeFact),'доходы минус расходы')}${kpi('Уходит в цели',rub(t.goalAllocated),`по правилам целей: ${pct(goalPercentTotal)}`)}</div></div>
    <div class="dashSection"><h3>${currentMonth}: после распределения</h3><div class="grid">${kpi('Не распределено',rub(t.undistributed),'останется свободными деньгами')}${kpi('План расходов',rub(t.expensesPlan),'ожидаемые расходы')}${kpi('Разница план/факт',rub(t.expensesPlan-t.expensesFact),'плюс = потратил меньше плана')}${kpi('Итого за год',rub(year.freeFact),'сумма свободных остатков')}</div></div>
    <div class="two">
      <div class="card"><h3>Цели / план покупок</h3><p class="mutedText">Накопления считаются с начала года до выбранного месяца.</p>${goalsMini()}</div>
      <div class="card"><h3>Остатки по месяцам</h3>${balanceTable()}</div>
    </div>`;
}
function goalsMini(){
  if(!state.purchases.length) return `<div class="empty">Целей пока нет</div>`;
  return `<div class="tableWrap"><table><thead><tr><th>Цель</th><th>Накоплено</th><th>Осталось</th><th>Прогресс</th></tr></thead><tbody>${state.purchases.map(g=>`<tr><td>${escapeHtml(g.name)}</td><td>${rub(goalAccumulated(g))}</td><td>${rub(goalRemaining(g))}</td><td>${progressBar(goalProgress(g))}<span class="pill">${pct(goalProgress(g))}</span></td></tr>`).join('')}</tbody></table></div>`;
}
function monthTabs(){
 return `<div class="monthTabs">${state.months.map(m=>`<button class="${m===currentMonth?'active':''} ${isMonthArchived(m)?'archivedTab':''}" onclick="currentMonth='${m}';render()">${m}${isMonthArchived(m)?' · архив':''}</button>`).join('')}</div>`
}
function renderMonths(){
  const rows=state.expenses.filter(x=>x.month===currentMonth);
  const t=totals(currentMonth);
  const archived = isMonthArchived(currentMonth);
  document.getElementById('months').innerHTML = `${monthTabs()}${archived?'<div class="card archiveNotice">Этот месяц архивирован. Редактирование расходов отключено.</div>':''}${notificationPanel(currentMonth)}<div class="grid" style="margin-bottom:14px">${kpi('Доходы',rub(t.incomes))}${kpi('Расходы факт',rub(t.expensesFact))}${kpi('Остаток',rub(t.freeFact))}${kpi('В цели',rub(t.goalAllocated))}</div><div class="card">
    <div class="toolbar"><h3>${currentMonth} — расходы ${archivedNote(currentMonth)}</h3><div class="toolbarActions"><button class="danger" onclick="bulkDelete('expenses')" ${archived?'disabled':''}>Удалить выбранные</button><button class="primary" onclick="addExpense()" ${archived?'disabled':''}>Добавить расход</button></div></div>
    ${expenseForm()}
    <div class="tableWrap">${expenseTable(rows)}</div></div>`;
}
function expenseForm(){
 const disabled = archivedAttr(currentMonth);
 return `<div class="formrow">
   <select id="exCat" ${disabled}>${options(state.expenseCategories)}</select><input id="exPlan" placeholder="Плановая сумма" ${disabled}><input id="exFact" placeholder="Факт оплачено" ${disabled}><input id="exDate" type="date" ${disabled}>
   <select id="exStatus" ${disabled}>${options(state.statuses)}</select><select id="exPriority" ${disabled}>${options(state.priorities,'Средний')}</select>
   <textarea id="exComment" placeholder="Комментарий" ${disabled}></textarea>
 </div>`;
}
function expenseTable(rows){
 if(!rows.length) return `<div class="empty">Записей нет</div>`;
 const disabled = archivedAttr(currentMonth);
 return `<table><thead><tr><th class="checkCol"><input type="checkbox" ${rows.length && rows.every(x=>selected.expenses.has(x.id))?'checked':''} onchange="toggleVisible('expenses', this.checked)"></th><th>Категория</th><th>План</th><th>Факт</th><th>Дата</th><th>Статус</th><th>Комментарий</th><th>Приоритет</th><th></th></tr></thead><tbody>
 ${rows.map(x=>`<tr>
 <td class="checkCol"><input type="checkbox" ${selected.expenses.has(x.id)?'checked':''} onchange="toggleOne('expenses','${x.id}',this.checked)" ${disabled}></td>
 <td><select onchange="upd('expenses','${x.id}','category',this.value)" ${disabled}>${options(state.expenseCategories,x.category)}</select></td>
 <td><input value="${escapeHtml(x.planAmount)}" oninput="upd('expenses','${x.id}','planAmount',this.value)" onblur="render()" placeholder="0" ${disabled}></td>
 <td><input value="${escapeHtml(x.factAmount)}" oninput="upd('expenses','${x.id}','factAmount',this.value)" onblur="render()" placeholder="0" ${disabled}></td>
 <td><input type="date" value="${escapeHtml(x.date)}" onchange="upd('expenses','${x.id}','date',this.value)" ${disabled}></td>
 <td><select onchange="upd('expenses','${x.id}','status',this.value)" ${disabled}>${options(state.statuses,x.status)}</select></td>
 <td><textarea class="commentBox" oninput="upd('expenses','${x.id}','comment',this.value)" ${disabled}>${escapeHtml(x.comment)}</textarea></td>
 <td><select onchange="upd('expenses','${x.id}','priority',this.value)" ${disabled}>${options(state.priorities,x.priority)}</select></td>
 <td><button class="danger" onclick="del('expenses','${x.id}')" ${disabled}>Удалить</button></td></tr>`).join('')}</tbody></table>`;
}
function addExpense(){
 if(isMonthArchived(currentMonth)){alert('Месяц архивирован. Сначала разархивируй его в настройках.'); return;}
 state.expenses.push({id:uid('e'),month:currentMonth,category:val('exCat'),planAmount:val('exPlan'),factAmount:val('exFact'),date:val('exDate'),status:val('exStatus'),comment:val('exComment'),priority:val('exPriority')}); save(); render();
}
function renderIncome(){
 document.getElementById('income').innerHTML=`<div class="card"><div class="toolbar"><h3>Доходы</h3><div class="toolbarActions"><button class="danger" onclick="bulkDelete('incomes')">Удалить выбранные</button><button class="primary" onclick="addIncome()">Добавить доход</button></div></div>
 <div class="formrow"><input id="inDate" type="date"><select id="inMonth">${options(state.months,currentMonth)}</select><select id="inType">${options(state.incomeTypes)}</select><input id="inAmount" placeholder="Сумма"><input id="inComment" placeholder="Комментарий"></div>
 <div class="tableWrap">${incomeTable()}</div></div>`;
}
function incomeTable(){
 if(!state.incomes.length) return `<div class="empty">Доходов нет</div>`;
 return `<table><thead><tr><th class="checkCol"><input type="checkbox" ${state.incomes.length && state.incomes.every(x=>selected.incomes.has(x.id))?'checked':''} onchange="toggleVisible('incomes', this.checked)"></th><th>Дата</th><th>Месяц</th><th>Источник</th><th>Сумма</th><th>Комментарий</th><th></th></tr></thead><tbody>
 ${state.incomes.map(x=>{const disabled=archivedAttr(x.month);return `<tr><td class="checkCol"><input type="checkbox" ${disabled} ${selected.incomes.has(x.id)?'checked':''} onchange="toggleOne('incomes','${x.id}',this.checked)"></td><td><input type="date" value="${x.date}" onchange="upd('incomes','${x.id}','date',this.value)" ${disabled}></td><td><select onchange="upd('incomes','${x.id}','month',this.value)" ${disabled}>${options(state.months,x.month)}</select></td><td><select onchange="upd('incomes','${x.id}','type',this.value);upd('incomes','${x.id}','source',this.value)" ${disabled}>${options(state.incomeTypes,x.type || x.source)}</select></td><td><input value="${escapeHtml(x.amount)}" oninput="upd('incomes','${x.id}','amount',this.value)" onblur="render()" placeholder="0" ${disabled}></td><td><input value="${escapeHtml(x.comment)}" oninput="upd('incomes','${x.id}','comment',this.value)" ${disabled}></td><td><button class="danger" onclick="del('incomes','${x.id}')" ${disabled}>Удалить</button></td></tr>`}).join('')}</tbody></table>`
}
function addIncome(){if(isMonthArchived(val('inMonth'))){alert('Этот месяц архивирован. Сначала разархивируй его в настройках.'); return;} state.incomes.push({id:uid('i'),date:val('inDate'),month:val('inMonth'),source:val('inType'),amount:val('inAmount'),type:val('inType'),comment:val('inComment')}); save(); render();}
function renderPurchases(){
 const totalPercent = state.purchases.reduce((s,x)=>s+num(x.percent),0);
 document.getElementById('purchases').innerHTML=`<div class="card"><div class="toolbar"><h3>План покупок / цели</h3><div class="toolbarActions"><span class="pill">Проценты: ${pct(totalPercent)}</span><button class="danger" onclick="bulkDelete('purchases')">Удалить выбранные</button><button class="primary" onclick="addPurchase()">Добавить цель</button></div></div>
 <p style="color:var(--muted);margin-top:-4px">Каждый месяц свободный остаток автоматически распределяется по целям. Накопления переходят дальше.</p>
 <div class="formrow"><input id="puName" placeholder="Цель / покупка"><input id="puTarget" placeholder="Целевая сумма"><input id="puPercent" placeholder="% от остатка"><input id="puInitial" placeholder="Уже накоплено"><select id="puPr">${options(state.priorities,'Средний')}</select><select id="puSt">${options(state.statuses)}</select></div>
 <div class="tableWrap">${purchaseTable()}</div></div>`;
}
function purchaseTable(){
 if(!state.purchases.length) return `<div class="empty">Целей пока нет</div>`;
 return `<table><thead><tr><th class="checkCol"><input type="checkbox" ${state.purchases.length && state.purchases.every(x=>selected.purchases.has(x.id))?'checked':''} onchange="toggleVisible('purchases', this.checked)"></th><th>Цель / покупка</th><th>Целевая сумма</th><th>% от остатка</th><th>Уже было</th><th>В этом месяце</th><th>Накоплено</th><th>Осталось</th><th>Прогресс</th><th>Приоритет</th><th>Статус</th><th></th></tr></thead><tbody>${state.purchases.map(x=>`<tr>
 <td class="checkCol"><input type="checkbox" ${selected.purchases.has(x.id)?'checked':''} onchange="toggleOne('purchases','${x.id}',this.checked)"></td>
 <td><input value="${escapeHtml(x.name)}" oninput="upd('purchases','${x.id}','name',this.value)"></td>
 <td><input value="${escapeHtml(x.targetAmount)}" oninput="upd('purchases','${x.id}','targetAmount',this.value)" onblur="render()"></td>
 <td><input value="${escapeHtml(x.percent)}" oninput="upd('purchases','${x.id}','percent',this.value)" onblur="render()"></td>
 <td><input value="${escapeHtml(x.initialAmount)}" oninput="upd('purchases','${x.id}','initialAmount',this.value)" onblur="render()"></td>
 <td><span class="pill">${rub(goalMonthAmount(x,currentMonth))}</span></td>
 <td><span class="pill">${rub(goalAccumulated(x,currentMonth))}</span></td>
 <td><span class="pill">${rub(goalRemaining(x,currentMonth))}</span></td>
 <td>${progressBar(goalProgress(x,currentMonth))}<span class="pill">${pct(goalProgress(x,currentMonth))}</span></td>
 <td><select onchange="upd('purchases','${x.id}','priority',this.value)">${options(state.priorities,x.priority)}</select></td><td><select onchange="upd('purchases','${x.id}','status',this.value)">${options(state.statuses,x.status)}</select></td><td><button class="danger" onclick="del('purchases','${x.id}')">Удалить</button></td></tr>`).join('')}</tbody></table>`
}
function addPurchase(){state.purchases.push({id:uid('p'),name:val('puName'),targetAmount:val('puTarget'),percent:val('puPercent'),initialAmount:val('puInitial'),priority:val('puPr'),status:val('puSt'),comment:''}); save(); render();}
function renderBalance(){document.getElementById('balance').innerHTML=`<div class="card"><h3>Остатки</h3>${balanceTable()}</div>`}
function balanceTable(){return `<div class="tableWrap"><table><thead><tr><th>Месяц</th><th>Статус</th><th>Доходы</th><th>План расходов</th><th>Факт расходов</th><th>Свободный остаток</th><th>В цели</th><th>Не распределено</th></tr></thead><tbody>${state.months.map(m=>{const t=totals(m);return `<tr><td>${m}</td><td>${isMonthArchived(m)?'<span class="pill archived">Архив</span>':'-'}</td><td>${rub(t.incomes)}</td><td>${rub(t.expensesPlan)}</td><td>${rub(t.expensesFact)}</td><td>${rub(t.freeFact)}</td><td>${rub(t.goalAllocated)}</td><td>${rub(t.undistributed)}</td></tr>`}).join('')}</tbody></table></div>`}
function renderSettings(){
 const tabs = [
  ['database','База данных'],
  ['service','Обслуживание'],
  ['months','Месяцы и архив'],
  ['categories','Категории расходов']
 ];
 const tabButtons = `<div class="settingsTabs">${tabs.map(([id,title])=>`<button class="${settingsTab===id?'active':''}" onclick="settingsTab='${id}';renderSettings()">${title}</button>`).join('')}</div>`;
 let content = '';
 if(settingsTab === 'database'){
  content = `<div class="card"><h3>База данных</h3><p>Здесь находятся импорт, экспорт и облачное подключение Supabase. Выбери: работать со всеми месяцами или только с одним месяцем.</p><div class="formrow settingsForm"><select id="dataMonthSelect"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select><button onclick="exportJson()">Экспорт</button><label class="fileBtn">Импорт<input type="file" accept="application/json" onchange="importJson(event)"></label><button onclick="currentMonth=val('dataMonthSelect')==='ALL'?currentMonth:val('dataMonthSelect');render()">Перейти к месяцу</button></div></div>${cloudPanel()}`;
 }
 if(settingsTab === 'service'){
  content = `<div class="card"><h3>Обслуживание</h3><p>Здесь можно очистить суммы или удалить записи по выбранным разделам и месяцам.</p>
  <div class="settingsBlock"><strong>Очистить суммы</strong><p>Оставляет строки, названия, даты, статусы и комментарии. Удаляет только денежные значения.</p>${sectionChecks('clear')}<div><select id='clearMonth'><option value='ALL'>Все месяцы</option>${options(state.months)}</select></div><button onclick="clearAmounts()">Очистить выбранные суммы</button></div>
  <div class="settingsBlock"><strong>Пустой шаблон</strong><p>Удаляет записи в выбранных разделах. Месяцы, категории и настройки остаются.</p>${sectionChecks('empty')}<div><select id='emptyMonth'><option value='ALL'>Все месяцы</option>${options(state.months)}</select></div><button class="danger" onclick="resetData()">Очистить выбранные разделы</button></div>
  </div>`;
 }
 if(settingsTab === 'months'){
  content = `<div class="card"><h3>Месяцы и архив</h3><p>Здесь можно копировать месяцы, архивировать завершенные периоды и разархивировать их при необходимости.</p>
  <div class="settingsBlock"><strong>Создать месяц на основе другого</strong><p>Копирует строки расходов из выбранного месяца в другой. По умолчанию суммы очищаются, чтобы новый месяц был как шаблон.</p><div class="formrow settingsForm"><select id="copyFromMonth">${options(state.months,currentMonth)}</select><select id="copyToMonth">${options(state.months)}</select><label><input type="checkbox" id="copyAmounts"> Копировать суммы тоже</label></div><button onclick="copyMonthTemplate()">Создать / заменить расходы месяца</button></div>
  <div class="settingsBlock"><strong>Архивирование месяцев</strong><p>Можно архивировать один месяц или все месяцы сразу. Для разархивации выбери нужные месяцы из списка архивов.</p><div class="formrow settingsForm"><select id="archiveMonth"><option value="ALL">Все месяцы</option>${options(state.months,currentMonth)}</select><button onclick="archiveSelectedMonth()">Архивировать</button></div><div class="archiveList">${archiveChecks()}</div><button onclick="unarchiveSelectedMonths()">Разархивировать выбранные</button></div>
  </div>`;
 }
 if(settingsTab === 'categories'){
  content = `<div class="card compactCard categoriesSettings"><h3>Категории расходов</h3><p>Категории используются только в разделе «Месяцы / расходы».</p><div class="compactAdd"><input id="newExpenseCat" placeholder="Новая категория расходов"><button class="primary" onclick="addCategory('expense')">Добавить</button></div><div class="tagGrid">${state.expenseCategories.map(c=>`<span class="tagItem"><span>${escapeHtml(c)}</span><button class="danger miniBtn" onclick="removeCategory('expense','${escapeHtml(c)}')">×</button></span>`).join('')}</div></div>`;
 }
 document.getElementById('settings').innerHTML=`${tabButtons}<div class="settingsTabContent">${content}</div>`;
}
function sectionChecks(prefix){
 return `<div class="settingsChecks">
  <label><input type="checkbox" id="${prefix}Expenses" checked> Расходы / месяцы</label>
  <label><input type="checkbox" id="${prefix}Incomes" checked> Доходы</label>
  <label><input type="checkbox" id="${prefix}Purchases" checked> План покупок / цели</label>
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
function upd(list,id,key,value){const item=state[list].find(x=>x.id===id); if(item){if(list!=='purchases' && item.month && isMonthArchived(item.month)){alert('Месяц архивирован. Сначала разархивируй его.'); render(); return;} if(key==='month' && isMonthArchived(value)){alert('Нельзя перенести запись в архивный месяц.'); render(); return;} item[key]=value; save(); if(['month'].includes(key)) render();}}
function del(list,id){const item=state[list].find(x=>x.id===id); if(item?.month && isMonthArchived(item.month)){alert('Месяц архивирован. Сначала разархивируй его.'); return;} if(confirm('Удалить запись?')){state[list]=state[list].filter(x=>x.id!==id); selected[list].delete(id); save(); render();}}
function visibleRows(list){
  if(list==='expenses') return state.expenses.filter(x=>x.month===currentMonth);
  return state[list];
}
function toggleOne(list,id,checked){checked ? selected[list].add(id) : selected[list].delete(id);}
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
function importJson(e){
  const f=e.target.files[0]; if(!f)return;
  const selectedMonth = val('dataMonthSelect') || 'ALL';
  const r=new FileReader();
  r.onload=()=>{try{
    const imported=migrateState({...seed,...JSON.parse(r.result)});
    if(selectedMonth === 'ALL'){
      state = imported;
    } else {
      if(isMonthArchived(selectedMonth)){alert('Этот месяц архивирован. Сначала разархивируй его.'); return;}
      state.expenses = state.expenses.filter(x=>x.month!==selectedMonth).concat(imported.expenses.map(x=>({...x,id:x.id||uid('e'),month:selectedMonth})));
      state.incomes = state.incomes.filter(x=>x.month!==selectedMonth).concat(imported.incomes.map(x=>({...x,id:x.id||uid('i'),month:selectedMonth})));
      state.purchases = imported.purchases?.length ? imported.purchases : state.purchases;
      state.expenseCategories = imported.expenseCategories || state.expenseCategories;
      state.categories = state.expenseCategories;
    }
    save(); render(); alert('Импортировано')
  }catch(err){alert('Ошибка импорта')}}; r.readAsText(f)
}
init();
