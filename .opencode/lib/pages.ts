// Отдельные страницы «Аналитика» и «Генераторы». Вынесены из seo-ui.ts, чтобы
// не раздувать и без того большой файл панели. Данные тянутся с /api/insights/*.

const CSS = `
:root{--bg:#0f1218;--panel:#171c25;--border:#2a3342;--text:#e6edf7;--muted:#8b9bb4;--accent:#4c9aff;--high:#ff5c6c;--medium:#ffb020;--low:#7a8aa3;--ok:#3ecf8e}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{display:flex;align-items:center;gap:16px;padding:18px 28px;border-bottom:1px solid var(--border);flex-wrap:wrap}
header h1{font-size:18px;margin:0}
header .sp{flex:1}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
main{padding:22px 28px;max-width:1280px}
.tabs{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap}
.tabs button{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 14px;cursor:pointer}
.tabs button.active{border-color:var(--accent);color:var(--accent)}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:18px}
.card h2{font-size:15px;margin:0 0 10px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:500}
tr:last-child td{border-bottom:0}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid}
.badge.pass{color:var(--ok);border-color:var(--ok)}
.badge.warn{color:var(--medium);border-color:var(--medium)}
.badge.fail{color:var(--high);border-color:var(--high)}
.badge.unknown{color:var(--muted);border-color:var(--muted)}
.sev-high{color:var(--high)}.sev-medium{color:var(--medium)}.sev-low{color:var(--low)}
input,select,textarea{background:#0d1117;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 10px;font:inherit;width:100%}
textarea{min-height:110px;font-family:ui-monospace,Consolas,monospace;font-size:12px}
button.act{background:var(--accent);color:#06101f;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 10px;cursor:pointer}
button.danger{background:transparent;color:var(--high);border:1px solid var(--high);border-radius:8px;padding:6px 10px;cursor:pointer}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px}
.row>label{flex:1;min-width:180px;display:block;color:var(--muted);font-size:12px}
.row>label input,.row>label select,.row>label textarea{margin-top:4px}
.muted{color:var(--muted)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:900px){.grid2{grid-template-columns:1fr}}
pre{white-space:pre-wrap;word-break:break-word;background:#0d1117;border:1px solid var(--border);border-radius:8px;padding:12px;font-size:12px;max-height:420px;overflow:auto}
.err{color:var(--high);white-space:pre-wrap}
.ok{color:var(--ok)}
.hidden{display:none!important}
`

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)
const layout = (title: string, body: string, script: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}<script>${script}</script></body></html>`

const CLIENT_HELPERS = `
const $=function(s){return document.querySelector(s)};
const $$=function(s){return Array.from(document.querySelectorAll(s))};
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
async function api(url,body){const r=await fetch(url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return r.json()}
function badge(gate){const t={pass:'пройден',warn:'замечания',fail:'не пройден',unknown:'нет данных'}[gate]||gate;return '<span class="badge '+esc(gate)+'">'+esc(t)+'</span>'}
function fmtDate(v){if(!v)return '—';const d=new Date(v);return isNaN(d)?esc(v):d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})}
`

export function renderInsightsPage(): string {
  const body = `
<header><h1>Аналитика SEO-центра</h1><span class="sp"></span><a href="/">← К панели</a><a href="/generators">Генераторы</a></header>
<main>
<div class="tabs">
  <button data-tab="overview" class="active">Сводка</button>
  <button data-tab="history">История</button>
  <button data-tab="issues">Проблемы</button>
  <button data-tab="schedule">Расписание</button>
  <button data-tab="settings">Интеграции</button>
</div>

<section id="tab-overview">
  <div class="card"><h2>Все сайты</h2><div id="overview"><p class="muted">Загрузка…</p></div></div>
</section>

<section id="tab-history" class="hidden">
  <div class="card"><h2>История прогонов</h2>
    <div class="row"><label>Сайт<select id="history-host"><option value="">Все сайты</option></select></label></div>
    <div id="history"><p class="muted">Загрузка…</p></div>
  </div>
  <div class="card" id="report-card"><h2>Отчёт и дельта</h2><div id="report"><p class="muted">Выберите прогон в истории.</p></div></div>
</section>

<section id="tab-issues" class="hidden">
  <div class="card"><h2>Проблемы и статусы</h2>
    <div class="row">
      <label>Сайт<select id="issues-host"><option value="">Все сайты</option></select></label>
      <label>Статус<select id="issues-status"><option value="">Все</option><option value="open">Открыта</option><option value="in_progress">В работе</option><option value="fixed">Исправлена</option><option value="ignored">Игнор</option></select></label>
    </div>
    <div id="issues"><p class="muted">Загрузка…</p></div>
  </div>
</section>

<section id="tab-schedule" class="hidden">
  <div class="card"><h2>Регулярные аудиты</h2>
    <div class="row">
      <label>URL сайта<input id="sch-site" placeholder="https://example.com/"></label>
      <label>Каждые N дней<input id="sch-days" type="number" min="1" max="90" value="7"></label>
      <label>Час запуска<input id="sch-hour" type="number" min="0" max="23" value="9"></label>
      <label>Глубина контента (2.1)<input id="sch-depth-content" type="number" min="1" value="50"></label>
      <label>Глубина скорости (4.1)<input id="sch-depth-speed" type="number" min="1" value="10"></label>
      <label>Пункты<select id="sch-preset"><option value="">Как в последнем аудите</option></select></label>
      <button class="act" id="sch-add">Добавить</button>
    </div>
    <div class="muted" id="sch-msg"></div>
    <div id="schedules"><p class="muted">Загрузка…</p></div>
  </div>
  <div class="card"><h2>Уведомления в Telegram</h2>
    <div class="row">
      <label>Токен бота<input id="tg-token" placeholder="123456:ABC…"></label>
      <label>Chat ID<input id="tg-chat" placeholder="-1001234567890"></label>
      <button class="act" id="tg-save">Сохранить</button>
    </div>
    <div class="muted">Приходит сообщение после каждого аудита: гейт, скор, новые и закрытые проблемы.</div>
  </div>
</section>

<section id="tab-settings" class="hidden">
  <div class="card"><h2>Внешние API</h2>
    <p class="muted">Токены хранятся в файле состояния результатов (права 600). OAuth-флоу нет: вставьте готовый токен.</p>
    <div class="grid2">
      <div><h2>PageSpeed Insights</h2><label class="muted">API-ключ<input id="int-psi" placeholder="AIza…"></label><div class="row" style="margin-top:8px"><label>URL для проверки<input id="int-psi-url" placeholder="https://example.com/"></label><button class="ghost" data-test="psi">Проверить</button></div></div>
      <div><h2>Яндекс.Вебмастер</h2><label class="muted">OAuth-токен<input id="int-wm" placeholder="y0_Ag…"></label><div class="row" style="margin-top:8px"><button class="ghost" data-test="webmaster">Проверить</button></div></div>
      <div><h2>Google Search Console</h2><label class="muted">OAuth-токен<input id="int-gsc" placeholder="ya29…"></label><div class="row" style="margin-top:8px"><button class="ghost" data-test="gsc">Проверить</button></div></div>
      <div><h2>Яндекс.Метрика</h2><label class="muted">OAuth-токен<input id="int-metrika" placeholder="y0_Ag…"></label><label class="muted">Номер счётчика<input id="int-counter" placeholder="12345678"></label><div class="row" style="margin-top:8px"><button class="ghost" data-test="metrika">Проверить</button></div></div>
      <div><h2>Яндекс.Вордстат</h2><label class="muted">API-ключ<input id="int-wordstat-key" placeholder="AQVN…"></label><label class="muted">Folder ID<input id="int-wordstat-folder" placeholder="b1g…"></label><div class="row" style="margin-top:8px"><button class="ghost" data-test="wordstat">Проверить</button></div></div>
    </div>
    <div class="row" style="margin-top:12px"><button class="act" id="int-save">Сохранить токены</button><button class="ghost" id="preset-save">Сохранить пресет пунктов…</button></div>
    <div id="int-result" style="margin-top:12px"></div>
  </div>
</section>
</main>`

  const script = CLIENT_HELPERS + `
let state={tab:'overview',host:'',presets:[],settings:null};
function show(tab){state.tab=tab;$$('.tabs button').forEach(function(b){b.classList.toggle('active',b.dataset.tab===tab)});['overview','history','issues','schedule','settings'].forEach(function(t){$('#tab-'+t).classList.toggle('hidden',t!==tab)});
  if(tab==='history')loadHistory();if(tab==='issues')loadIssues();if(tab==='schedule'||tab==='settings')loadSettings()}
$$('.tabs button').forEach(function(b){b.onclick=function(){show(b.dataset.tab)}});

async function loadOverview(){
  const r=await api('/api/insights/overview');
  if(!r.ok){$('#overview').innerHTML='<p class="err">'+esc(r.error||'Ошибка')+'</p>';return}
  if(!r.hosts.length){$('#overview').innerHTML='<p class="muted">Пока нет ни одного аудита. Запустите аудит на вкладке «SEO-аудит».</p>';return}
  let h='<table><tr><th>Сайт</th><th>Прогонов</th><th>Последний</th><th>Скор</th><th>Гейт</th><th>Открытых проблем</th><th></th></tr>';
  r.hosts.forEach(function(x){
    h+='<tr><td><b>'+esc(x.host)+'</b></td><td>'+x.runs+'</td><td>'+fmtDate(x.lastAt)+'</td><td>'+(x.score==null?'—':x.score+'/100')+(x.delta==null?'':' <span class="muted">('+(x.delta>0?'+':'')+x.delta+')</span>')+'</td><td>'+badge(x.gate)+'</td><td>'+x.open+'</td><td><button class="ghost" data-host="'+esc(x.host)+'">История</button> <button class="ghost" data-issues="'+esc(x.host)+'">Проблемы</button></td></tr>';
  });
  $('#overview').innerHTML=h+'</table>';
  $$('#overview [data-host]').forEach(function(b){b.onclick=function(){state.host=b.dataset.host;show('history')}});
  $$('#overview [data-issues]').forEach(function(b){b.onclick=function(){state.host=b.dataset.issues;show('issues')}});
}

async function loadHistory(){
  const r=await api('/api/insights/history?host='+encodeURIComponent(state.host));
  if(!r.ok){$('#history').innerHTML='<p class="err">'+esc(r.error||'Ошибка')+'</p>';return}
  if(!r.runs.length){$('#history').innerHTML='<p class="muted">Нет прогонов.</p>';return}
  let h='<table><tr><th>Дата</th><th>Сайт</th><th>Пункты</th><th>Скор</th><th>Гейт</th><th>Проблемы</th><th></th></tr>';
  r.runs.slice().reverse().forEach(function(x){
    h+='<tr><td>'+fmtDate(x.at)+'</td><td>'+esc(x.host)+'</td><td>'+esc((x.points||[]).join(', '))+'</td><td>'+(x.score==null?'—':x.score)+'</td><td>'+badge(x.gate)+'</td><td>'+(x.counts?('<span class="sev-high">'+x.counts.high+'</span> / <span class="sev-medium">'+x.counts.medium+'</span> / <span class="sev-low">'+x.counts.low+'</span>'):'—')+'</td><td><button class="ghost" data-run="'+esc(x.id)+'">Открыть</button> <button class="ghost" data-repeat="'+esc(x.id)+'">Повторить</button></td></tr>';
  });
  $('#history').innerHTML=h+'</table>';
  $$('#history [data-run]').forEach(function(b){b.onclick=function(){openReport(b.dataset.run)}});
  $$('#history [data-repeat]').forEach(function(b){b.onclick=async function(){b.disabled=true;const rr=await api('/api/insights/repeat',{runId:b.dataset.repeat});b.disabled=false;if(!rr.ok){alert(rr.error||'Не удалось повторить');return}alert(rr.queued?('В очереди, позиция '+rr.position+', '+rr.eta):'Аудит запущен')}});
}

async function openReport(id){
  const r=await api('/api/insights/report?run='+encodeURIComponent(id));
  if(!r.ok){$('#report').innerHTML='<p class="err">'+esc(r.error||'Ошибка')+'</p>';return}
  let h='<p>'+fmtDate(r.run.at)+' · скор '+(r.run.score==null?'—':r.run.score)+' · '+badge(r.run.gate)+'</p>';
  if(r.delta){h+='<p>Новых: <b>'+r.delta.added.length+'</b> · закрыто: <b>'+r.delta.fixed.length+'</b> · осталось: <b>'+r.delta.persisting+'</b>'+(r.delta.scoreFrom==null?'':' · скор '+r.delta.scoreFrom+' → '+r.delta.scoreTo)+'</p>'}
  if(!r.report){h+='<p class="muted">В папке прогона нет audit.json — отчёт есть только в docx.</p>'}
  else{
    h+='<table><tr><th>Пункт</th><th>Проверено</th><th>Проблемы</th></tr>';
    r.report.points.forEach(function(p){
      h+='<tr><td><b>'+esc(p.point)+'. '+esc(p.title)+'</b></td><td>'+(p.checkedPages||'—')+'</td><td>';
      if(!p.issues.length)h+='<span class="ok">нет</span>';
      p.issues.forEach(function(i){h+='<div class="sev-'+esc(i.severity)+'">['+esc(i.severity)+'] '+esc(i.title)+(i.fix?' — '+esc(i.fix):'')+'</div>'});
      h+='</td></tr>';
    });
    h+='</table>';
  }
  $('#report').innerHTML=h;
}

async function loadIssues(){
  const r=await api('/api/insights/issues?host='+encodeURIComponent(state.host)+'&status='+encodeURIComponent($('#issues-status').value));
  if(!r.ok){$('#issues').innerHTML='<p class="err">'+esc(r.error||'Ошибка')+'</p>';return}
  if(!r.issues.length){$('#issues').innerHTML='<p class="muted">Проблем нет.</p>';return}
  let h='<table><tr><th>Сайт</th><th>Пункт</th><th>Проблема</th><th>Важность</th><th>Статус</th><th>Последний раз</th><th></th></tr>';
  r.issues.forEach(function(i){
    h+='<tr><td>'+esc(i.host)+'</td><td>'+esc(i.point)+'</td><td>'+esc(i.title)+(i.urls&&i.urls.length?'<div class="muted">'+esc(i.urls.slice(0,3).join(', '))+(i.urls.length>3?' …':'')+'</div>':'')+'</td><td class="sev-'+esc(i.severity)+'">'+esc(i.severity)+'</td><td>'+esc(i.status)+(i.vanishedAt?' <span class="muted">(не найдена)</span>':'')+'</td><td>'+fmtDate(i.lastSeen)+'</td><td><select data-id="'+esc(i.id)+'" data-host="'+esc(i.host)+'"><option value="open">открыта</option><option value="in_progress">в работе</option><option value="fixed">исправлена</option><option value="ignored">игнор</option></select></td></tr>';
  });
  $('#issues').innerHTML=h+'</table>';
  $$('#issues select[data-id]').forEach(function(s){s.value=r.issues.find(function(i){return i.id===s.dataset.id&&i.host===s.dataset.host}).status;
    s.onchange=async function(){const rr=await api('/api/insights/issues/status',{host:s.dataset.host,id:s.dataset.id,status:s.value});if(!rr.ok)alert(rr.error||'Ошибка')}});
}

async function loadSettings(){
  const r=await api('/api/insights/settings');
  if(!r.ok){return}
  state.settings=r.settings;state.presets=r.settings.presets||[];
  const sel=$('#sch-preset');sel.innerHTML='<option value="">Как в последнем аудите</option>'+state.presets.map(function(p){return '<option value="'+esc(p.name)+'">'+esc(p.name)+'</option>'}).join('');
  const t=r.settings.telegram||{};$('#tg-token').value=t.token||'';$('#tg-chat').value=t.chatId||'';
  const i=r.settings.integrations||{};$('#int-psi').value=i.psiKey||'';$('#int-wm').value=i.webmasterToken||'';$('#int-gsc').value=i.gscToken||'';$('#int-metrika').value=i.metrikaToken||'';$('#int-counter').value=i.metrikaCounter||'';$('#int-wordstat-key').value=i.wordstatKey||'';$('#int-wordstat-folder').value=i.wordstatFolderId||'';
  renderSchedules(r.settings.schedules||[]);
}

function renderSchedules(list){
  if(!list.length){$('#schedules').innerHTML='<p class="muted">Расписаний нет.</p>';return}
  function nextRunText(s){
    if(!s.enabled)return "выкл.";
    const now = new Date();
    const base = s.lastRunAt ? new Date(s.lastRunAt) : new Date(now.getFullYear(), now.getMonth(), now.getDate(), s.hour, 0, 0);
    const next = new Date(base.getTime() + Math.max(1, s.everyDays) * 86400000);
    if(!s.lastRunAt){
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), s.hour, 0, 0);
      if(now > today) next.setDate(today.getDate() + 1);
      else next.setTime(today.getTime());
    }
    return next.toLocaleString(undefined, {day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
  }
  let h='<table><tr><th>Сайт</th><th>Пункты</th><th>Раз в N дней</th><th>Час</th><th>Следующий запуск</th><th>Последний запуск</th><th>Вкл.</th><th></th></tr>';
  list.forEach(function(s){
    h+='<tr><td>'+esc(s.site)+'</td><td>'+esc((s.points||[]).map(function(p){return p.point}).join(', ')||'—')+'</td><td>'+s.everyDays+'</td><td>'+s.hour+':00</td><td>'+nextRunText(s)+'</td><td>'+fmtDate(s.lastRunAt)+'</td><td>'+(s.enabled?'да':'нет')+'</td><td><button class="ghost" data-toggle="'+esc(s.site)+'">'+(s.enabled?'Выключить':'Включить')+'</button> <button class="danger" data-del="'+esc(s.site)+'">Удалить</button></td></tr>';
  });
  $('#schedules').innerHTML=h+'</table>';
  $$('#schedules [data-toggle]').forEach(function(b){b.onclick=async function(){const rr=await api('/api/insights/schedules/toggle',{site:b.dataset.toggle});if(rr.ok)renderSchedules(rr.schedules)}});
  $$('#schedules [data-del]').forEach(function(b){b.onclick=async function(){if(!confirm('Удалить расписание?'))return;const rr=await api('/api/insights/schedules/delete',{site:b.dataset.del});if(rr.ok)renderSchedules(rr.schedules)}});
}

$('#sch-add').onclick=async function(){
  const preset=state.presets.find(function(p){return p.name===$('#sch-preset').value});
  const body={site:$('#sch-site').value.trim(),everyDays:Number($('#sch-days').value)||7,hour:Number($('#sch-hour').value)||9,preset:preset?preset.name:'',
    depthContent:Number($('#sch-depth-content').value)||50,depthSpeed:Number($('#sch-depth-speed').value)||10};
  const r=await api('/api/insights/schedules',body);
  $('#sch-msg').textContent=r.ok?'Добавлено.':'Ошибка: '+(r.error||'');
  if(r.ok)renderSchedules(r.schedules);
};
$('#tg-save').onclick=async function(){const r=await api('/api/insights/telegram',{token:$('#tg-token').value.trim(),chatId:$('#tg-chat').value.trim()});$('#tg-save').textContent=r.ok?'Сохранено':'Ошибка';setTimeout(function(){$('#tg-save').textContent='Сохранить'},1500)};
$('#int-save').onclick=async function(){const r=await api('/api/insights/integrations',{psiKey:$('#int-psi').value.trim(),gscToken:$('#int-gsc').value.trim(),webmasterToken:$('#int-wm').value.trim(),metrikaToken:$('#int-metrika').value.trim(),metrikaCounter:$('#int-counter').value.trim(),wordstatKey:$('#int-wordstat-key').value.trim(),wordstatFolderId:$('#int-wordstat-folder').value.trim()});$('#int-save').textContent=r.ok?'Сохранено':'Ошибка';setTimeout(function(){$('#int-save').textContent='Сохранить токены'},1500)};
$('#preset-save').onclick=function(){alert('Пресеты пунктов сохраняются на вкладке «SEO-аудит» кнопкой «Сохранить пресет».')};
$$('[data-test]').forEach(function(b){b.onclick=async function(){
  b.disabled=true;$('#int-result').innerHTML='<p class="muted">Проверяю…</p>';
  const r=await api('/api/insights/integrations/test',{kind:b.dataset.test,url:$('#int-psi-url').value.trim()});
  b.disabled=false;
  $('#int-result').innerHTML=(r.ok&&r.result&&r.result.ok)?('<p class="ok">'+esc(r.result.summary)+'</p><pre>'+esc(JSON.stringify(r.result.data,null,2))+'</pre>'):('<p class="err">'+esc(r.result?(r.result.error||r.result.summary):r.error||'Ошибка')+'</p>');
}}) ;
$('#issues-status').onchange=loadIssues;
$('#issues-host').onchange=function(){state.host=this.value;loadIssues()};
$('#history-host').onchange=function(){state.host=this.value;loadHistory()};

async function fillHostSelects(){
  const r=await api('/api/insights/overview');
  if(!r.ok)return;
  ['#history-host','#issues-host'].forEach(function(s){const el=$(s);r.hosts.forEach(function(x){const o=document.createElement('option');o.value=x.host;o.textContent=x.host;el.appendChild(o)})});
}
loadOverview();fillHostSelects();
`
  return layout("Аналитика — SEO-центр", body, script)
}

export function renderGeneratorsPage(): string {
  const body = `
<header><h1>Генераторы SEO-файлов</h1><span class="sp"></span><a href="/">← К панели</a><a href="/insights">Аналитика</a></header>
<main>
<div class="grid2">
  <div class="card"><h2>robots.txt</h2>
    <div class="row"><label>Sitemap URL<input id="r-sitemap" placeholder="https://example.com/sitemap.xml"></label></div>
    <div class="row"><label>Закрыть (по одному в строке)<textarea id="r-disallow" placeholder="/admin/&#10;/search/"></textarea></label></div>
    <div class="row"><label>Открыть (по одному в строке)<textarea id="r-allow" placeholder="/admin/login"></textarea></label></div>
    <label class="muted"><input type="checkbox" id="r-clean" checked style="width:auto"> Добавлять Disallow: /*? (обязательно по методике)</label>
    <div class="row" style="margin-top:10px"><button class="act" id="r-run">Сгенерировать</button><button class="ghost" id="r-down">Скачать</button></div>
  </div>
  <div class="card"><h2>sitemap.xml</h2>
    <div class="row"><label>URL (по одному в строке)<textarea id="s-urls" placeholder="https://example.com/&#10;https://example.com/about/"></textarea></label></div>
    <div class="row"><label>lastmod<input id="s-lastmod" placeholder="2026-11-12"></label><label>changefreq<select id="s-freq"><option value=""></option><option>daily</option><option>weekly</option><option>monthly</option></select></label></div>
    <div class="row"><label>Или CSV из «Выгрузки метатегов»<input type="file" id="s-file" accept=".csv,.txt"></label></div>
    <div class="row"><button class="act" id="s-run">Сгенерировать</button><button class="ghost" id="s-down">Скачать</button></div>
  </div>
</div>
<div class="card"><h2>JSON-LD</h2>
  <div class="row"><label>Тип<select id="j-type"><option>Article</option><option>NewsArticle</option><option>BlogPosting</option><option>TechArticle</option><option>BreadcrumbList</option><option>FAQPage</option><option>QAPage</option><option>Product</option><option>Service</option><option>HowTo</option><option>VideoObject</option><option>Recipe</option><option>Review</option><option>Organization</option><option>LocalBusiness</option><option>Store</option><option>MedicalOrganization</option></select></label></div>
  <div class="row"><label>Данные (JSON)<textarea id="j-data" style="min-height:220px"></textarea></label></div>
  <div class="row"><button class="act" id="j-run">Проверить и собрать</button><button class="ghost" id="j-copy">Копировать</button></div>
  <div id="j-errors"></div>
  <pre id="j-out" class="hidden"></pre>
</div>
<div class="card"><h2>Результат</h2><pre id="out">Сгенерируйте файл — здесь появится содержимое.</pre></div>
</main>`

  const script = CLIENT_HELPERS + `
let last={content:'',filename:''};
function showOut(content,filename){last={content:content,filename:filename};$('#out').textContent=content}
function download(){if(!last.content){alert('Сначала сгенерируйте файл');return}const b=new Blob([last.content],{type:'text/plain;charset=utf-8'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=last.filename;a.click();setTimeout(function(){URL.revokeObjectURL(a.href)},1000)}

$('#r-run').onclick=async function(){
  const r=await api('/api/generate',{kind:'robots',sitemaps:$('#r-sitemap').value.split(/\\s+/).filter(Boolean),disallow:$('#r-disallow').value.split(/\\n+/),allow:$('#r-allow').value.split(/\\n+/),cleanParams:$('#r-clean').checked});
  if(r.ok)showOut(r.content,r.filename);else alert(r.error||'Ошибка');
};
$('#s-run').onclick=async function(){
  const urls=$('#s-urls').value.split(/\\s+/).filter(Boolean);
  const r=await api('/api/generate',{kind:'sitemap',urls:urls,lastmod:$('#s-lastmod').value.trim(),changefreq:$('#s-freq').value});
  if(r.ok)showOut(r.content,r.filename);else alert(r.error||'Ошибка');
};
$('#s-file').onchange=function(){const f=this.files[0];if(!f)return;const rd=new FileReader();rd.onload=async function(){const r=await api('/api/generate',{kind:'sitemap-from-csv',csv:String(rd.result)});if(r.ok){$('#s-urls').value=r.urls.join('\\n')}else alert(r.error||'Ошибка')};rd.readAsText(f)};

let templates={};
async function loadTemplate(){const r=await api('/api/generate',{kind:'jsonld-template',type:$('#j-type').value});if(r.ok)$('#j-data').value=JSON.stringify(r.template,null,2)}
$('#j-type').onchange=loadTemplate;
$('#j-run').onclick=async function(){
  let data;try{data=JSON.parse($('#j-data').value)}catch(e){$('#j-errors').innerHTML='<p class="err">JSON не парсится: '+esc(e.message)+'</p>';return}
  const r=await api('/api/generate',{kind:'jsonld',type:$('#j-type').value,data:data});
  $('#j-errors').innerHTML=(r.errors&&r.errors.length)?'<p class="err">'+r.errors.map(esc).join('<br>')+'</p>':'<p class="ok">Разметка валидна.</p>';
  if(r.script){$('#j-out').classList.remove('hidden');$('#j-out').textContent=r.script;last={content:r.script,filename:'jsonld.html'}}
};
$('#j-copy').onclick=function(){const t=$('#j-out').textContent;if(t)navigator.clipboard.writeText(t)};
$('#r-down').onclick=download;$('#s-down').onclick=download;
loadTemplate();
`
  return layout("Генераторы — SEO-центр", body, script)
}
