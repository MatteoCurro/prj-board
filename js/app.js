(() => {
'use strict';
const API='api/index.php';
const state={user:null,workspaces:[],workspace:null,site:null,search:'',quickFilter:'all',completedView:false,cardSortables:[],columnSortable:null,status:null,memberTimer:null,calendarFeeds:null,cardChecklistDraft:[],myTasks:[]};
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const boardEl=$('#board'), emptyState=$('#emptyState'), toastRegion=$('#toastRegion');

function icons(){if(window.lucide)window.lucide.createIcons({attrs:{'stroke-width':1.8}})}
function toast(message,type='info'){const e=document.createElement('div');e.className='toast'+(type==='error'?' error':'');e.textContent=message;toastRegion.append(e);setTimeout(()=>e.remove(),3200)}
function setBusy(v){document.body.classList.toggle('busy',v)}
async function api(action,options={}){
 const init={method:options.method||'GET',credentials:'same-origin',headers:{Accept:'application/json'}};
 if(options.body!==undefined){init.method=init.method==='GET'?'POST':init.method;init.headers['Content-Type']='application/json';init.body=JSON.stringify(options.body)}
 const url=API+'?action='+encodeURIComponent(action)+(options.query?'&'+new URLSearchParams(options.query):'');
 let res;try{res=await fetch(url,init)}catch{throw new Error('Server non raggiungibile.')}
 let data;try{data=await res.json()}catch{throw new Error('Risposta server non valida.')}
 if(res.status===401&&!['login','register','password:recover-admin'].includes(action)){await showAuth();throw new Error('Sessione scaduta.')}
 if(!res.ok||data.ok===false)throw new Error(data.error||'Operazione non riuscita.');
 return data;
}
function applySite(site){
 state.site=site||{name:'PRJ',description:'Project workspace',logo_url:null};
 const name=state.site.name||'PRJ',desc=state.site.description||'Project workspace';
 $('#siteBrandName').textContent=name;$('#siteBrandDescription').textContent=desc;$('#authBrandName').textContent=name;$('#authBrandDescription').textContent=desc;
 document.title=name+' · Project Board';document.querySelector('meta[name="description"]').content=desc;
 setLogo($('#siteBrandMark'),name,state.site.logo_url);setLogo($('#authBrandMark'),name,state.site.logo_url);
}
function setLogo(el,name,url){
 el.innerHTML='';
 if(url){const img=document.createElement('img');img.src=url;img.alt='';img.onerror=()=>{el.textContent=(name||'?')[0].toUpperCase()};el.append(img)}
 else el.textContent=(name||'?')[0].toUpperCase();
}
async function boot(){
 icons();bindGlobalEvents();
 try{
  const status=await api('status');state.status=status;applySite(status.site);
  if(status.setup_required){$('#setupDialog').showModal();return}
  if(!status.authenticated){showAuth(status);return}
  await enterApp(status);
 }catch(e){toast(e.message,'error')}
}
async function enterApp(status=null){
 if(!status)status=await api('status');
 state.status=status;state.user=status.user;state.workspaces=status.workspaces||[];applySite(status.site);
 $('#authDialog').open&&$('#authDialog').close();
 $('#logoutBtn').hidden=false;$('#workspaceSwitch').hidden=false;$('#userChip').hidden=false;$('#myTasksBtn').hidden=false;
 $('#userChip').textContent=userDisplayName(state.user);$('#userChip').title='@'+state.user.username;$('#newWorkspaceBtn').hidden=!state.user.is_admin;
 renderWorkspaceSelect();
 const saved=Number(localStorage.getItem('prj_workspace')||0),chosen=state.workspaces.find(w=>w.id===saved)||state.workspaces[0];
 if(!chosen){showNoWorkspace();return}
 await selectWorkspace(chosen.id);
 refreshMyTasksBadge();
 if(state.user.is_admin)loadPendingBadge();
}

function showNoWorkspace(){state.workspace=null;$('#workspaceContent').hidden=true;$('#workspaceNoAccess').hidden=false;$('#adminBtn').hidden=!state.user?.is_admin;$('#workspaceSelect').innerHTML=''}
function renderWorkspaceSelect(){const select=$('#workspaceSelect');select.innerHTML='';state.workspaces.forEach(w=>{const o=document.createElement('option');o.value=w.id;o.textContent=w.name;select.append(o)})}
async function selectWorkspace(id){const ws=state.workspaces.find(w=>Number(w.id)===Number(id));if(!ws)return;localStorage.setItem('prj_workspace',String(id));$('#workspaceSelect').value=String(id);setWorkspaceAvatar($('#workspaceMiniAvatar'),ws);$('#workspaceNoAccess').hidden=true;$('#workspaceContent').hidden=false;await loadWorkspace(id)}
async function loadWorkspace(id=state.workspace?.id){if(!id)return;setBusy(true);try{const d=await api('workspace:get',{query:{workspace_id:id}});state.workspace=d.workspace;renderWorkspace()}finally{setBusy(false)}}
function canEdit(){return ['editor','admin'].includes(state.workspace?.role)}
function canAdminWorkspace(){return state.workspace?.role==='admin'}
function setWorkspaceAvatar(el,ws){setLogo(el,ws?.name||'?',ws?.logo_url)}
function roleLabel(r){return({viewer:'sola lettura',editor:'editor',admin:'admin'})[r]||r}
function userDisplayName(u){const name=(u?.display_name||'').trim();return name||('@'+(u?.username||'?'))}
function userInitial(u){return (u?.display_name||u?.username||'?').trim()[0]?.toUpperCase()||'?'}
function daysUntil(value){if(!value)return null;const today=new Date();today.setHours(0,0,0,0);const due=new Date(value+'T00:00:00');return Math.round((due-today)/86400000)}
function priorityInfo(value){
 return({
  low:{label:'Bassa',className:'low'},
  normal:{label:'Normale',className:'normal'},
  high:{label:'Alta',className:'high'},
  urgent:{label:'Urgente',className:'urgent'}
 })[value]||{label:'Normale',className:'normal'};
}
function checklistStats(items=[]){const total=items.length,done=items.filter(i=>i.done).length;return{total,done}}
function taskDueLabel(value){
 const days=daysUntil(value);if(days===null)return'Senza scadenza';if(days<0)return'Scaduta da '+Math.abs(days)+(Math.abs(days)===1?' giorno':' giorni');if(days===0)return'Scade oggi';if(days===1)return'Scade domani';return'Scade tra '+days+' giorni';
}
function cardMatchesQuickFilter(card){
 if(state.quickFilter==='mine')return (card.assignees||[]).some(u=>Number(u.id)===Number(state.user?.id));
 if(state.quickFilter==='due'){const days=daysUntil(card.due_date);return days!==null&&days<=7}
 return true;
}
function hexRgb(hex){const v=(hex||'#5b6255').replace('#','');return [parseInt(v.slice(0,2),16),parseInt(v.slice(2,4),16),parseInt(v.slice(4,6),16)]}
function tagMix(tags=[]){
 if(!tags.length)return{solid:'#5b6255',column:'rgba(0,0,0,0)',card:'rgba(0,0,0,0)'};
 const rgb=tags.map(t=>hexRgb(t.color));const n=rgb.length;
 const avg=rgb.reduce((a,c)=>[a[0]+c[0],a[1]+c[1],a[2]+c[2]],[0,0,0]).map(v=>Math.round(v/n));
 const alpha=Math.min(.26,.10+(n-1)*.045),cardAlpha=Math.min(.18,.07+(n-1)*.03);
 return{solid:`rgb(${avg.join(',')})`,column:`rgba(${avg.join(',')},${alpha})`,card:`rgba(${avg.join(',')},${cardAlpha})`};
}
function renderWorkspace(){
 destroySortables();boardEl.innerHTML='';const ws=state.workspace;if(!ws)return;
 $('#boardTitle').textContent=ws.name;setWorkspaceAvatar($('#workspaceAvatar'),ws);setWorkspaceAvatar($('#workspaceMiniAvatar'),ws);
 const activeTotal=ws.columns.reduce((n,c)=>n+c.cards.filter(card=>!card.completed).length,0);
 const completedTotal=ws.columns.reduce((n,c)=>n+c.cards.filter(card=>card.completed).length,0);
 $('#boardMeta').textContent=ws.columns.length+(ws.columns.length===1?' colonna':' colonne')+' · '+activeTotal+' attive · '+completedTotal+' completate · '+roleLabel(ws.role);
 $('#completedViewToggle').checked=state.completedView;
 $$('.quick-filter').forEach(b=>b.classList.toggle('active',b.dataset.quickFilter===state.quickFilter));
 emptyState.hidden=ws.columns.length>0;boardEl.hidden=ws.columns.length===0;
 $('#addColumnBtn').hidden=!canEdit()||state.completedView;$('#emptyAddColumnBtn').hidden=!canEdit();$('#editWorkspaceBtn').hidden=!canAdminWorkspace();$('#adminBtn').hidden=!(state.user?.is_admin||canAdminWorkspace());$('#calendarBtn').hidden=false;
 ws.columns.forEach(col=>{
  const f=$('#columnTemplate').content.cloneNode(true),el=$('.column',f),mix=tagMix(col.tags),visibleCards=col.cards.filter(card=>Boolean(card.completed)===state.completedView&&cardMatchesQuickFilter(card));
  el.dataset.columnId=col.id;el.style.setProperty('--tag-bg',mix.column);el.style.setProperty('--tag-solid',mix.solid);
  $('.column-title',f).textContent=col.name;$('.column-count',f).textContent=visibleCards.length;
  const tagBox=$('.column-tags',f);(col.tags||[]).forEach(t=>tagBox.append(tagPill(t)));
  const list=$('.card-list',f);visibleCards.forEach(card=>list.append(renderCard(card,col.tags||[])));
  $('.add-card-btn',f).hidden=!canEdit()||state.completedView||state.quickFilter!=='all';
  if(!canEdit()||state.completedView||state.quickFilter!=='all'){$('.column-grip',f).hidden=true}
  if(!canEdit())$('.column-menu-btn',f).hidden=true;
  boardEl.append(f);
 });
 applySearch();bindBoardEvents();if(canEdit()&&!state.completedView&&state.quickFilter==='all')initSortables();icons();
}

function tagPill(tag){const e=document.createElement('span');e.className='tag-pill';const d=document.createElement('span');d.className='tag-dot';d.style.setProperty('--tag-color',tag.color);const n=document.createElement('span');n.textContent=tag.name;e.append(d,n);return e}
function localDateValue(offset=0){
 const d=new Date();d.setHours(12,0,0,0);d.setDate(d.getDate()+Number(offset||0));
 const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');
 return y+'-'+m+'-'+day;
}
function updateDueQuickState(){
 const input=$('#cardDueDate'),value=input.value;
 $$('.due-quick-list [data-due-offset]').forEach(btn=>btn.classList.toggle('active',value===localDateValue(btn.dataset.dueOffset)));
 $('#clearDueDateBtn').disabled=!value;
}
function setDueDate(value){$('#cardDueDate').value=value||'';updateDueQuickState()}
function openDueDatePicker(){
 const input=$('#cardDueDate');
 if(typeof input.showPicker==='function'){try{input.showPicker();return}catch{}}
 input.focus();input.click();
}

function dueState(value){
 if(!value)return null;const today=new Date();today.setHours(0,0,0,0);const due=new Date(value+'T00:00:00');const days=Math.round((due-today)/86400000);
 if(days<0)return{className:'overdue',icon:'circle-alert',label:'Scaduta'};
 if(days<=2)return{className:'due-soon',icon:'alarm-clock',label:days===0?'Oggi':days===1?'Domani':'Tra 2 giorni'};
 return{className:'',icon:'calendar-days',label:null};
}
function renderCard(card,columnTags=[]){
 const f=$('#cardTemplate').content.cloneNode(true),el=$('.task-card',f),mix=tagMix(columnTags);el.dataset.cardId=card.id;el.dataset.label=card.label||'';el.style.setProperty('--card-tag-bg',mix.card);$('.task-title',f).textContent=card.title;
 if(card.completed)el.classList.add('completed-card');
 const desc=$('.task-description',f);if(card.description){desc.textContent=card.description;desc.hidden=false}
 const lab=$('.task-label',f);if(card.label){lab.textContent=({magenta:'Focus',amber:'Attesa',teal:'Pronto',blue:'Info',violet:'Idea'})[card.label]||card.label;lab.hidden=false}
 const priority=$('.task-priority',f),pInfo=priorityInfo(card.priority);if(card.priority&&card.priority!=='normal'){priority.textContent=pInfo.label;priority.classList.add(pInfo.className);priority.hidden=false}
 const people=$('.task-assignees',f);if(card.assignees?.length){card.assignees.forEach(u=>{const pill=document.createElement('span');pill.className='assignee-pill';pill.textContent=userDisplayName(u);pill.title=u.display_name?userDisplayName(u)+' · @'+u.username:'@'+u.username;people.append(pill)});people.hidden=false}
 const due=$('.task-due',f);if(card.due_date){const st=card.completed?null:dueState(card.due_date);$('span',due).textContent=(st?.label?st.label+' · ':'')+new Intl.DateTimeFormat('it-IT',{day:'numeric',month:'short'}).format(new Date(card.due_date+'T12:00:00'));due.hidden=false;const ic=$('.task-due-icon',due);ic.setAttribute('data-lucide',st?.icon||'calendar-days');if(st?.className)el.classList.add(st.className)}
 const cs=checklistStats(card.checklist||[]),cc=$('.checklist-count',f);if(cs.total){$('span',cc).textContent=cs.done+'/'+cs.total;cc.hidden=false;if(cs.done===cs.total)cc.classList.add('complete')}
 const ac=$('.attachment-count',f);if(card.attachments?.length){$('span',ac).textContent=card.attachments.length;ac.hidden=false}
 const quick=$('.card-complete',f);quick.title=card.completed?'Riapri card':'Segna come fatto';quick.setAttribute('aria-label',quick.title);$('i',quick).setAttribute('data-lucide',card.completed?'rotate-ccw':'circle-check-big');
 if(!canEdit()){$('.card-edit',f).hidden=true;quick.hidden=true;$('.card-drag-handle',f).hidden=true}
 return f;
}


function bindGlobalEvents(){
 $('#workspaceSelect').addEventListener('change',e=>selectWorkspace(Number(e.target.value)));$('#newWorkspaceBtn').addEventListener('click',()=>openWorkspaceDialog());$('#editWorkspaceBtn').addEventListener('click',()=>openWorkspaceDialog(state.workspace));$('#refreshBtn').addEventListener('click',()=>loadWorkspace());$('#addColumnBtn').addEventListener('click',()=>openColumnDialog());$('#emptyAddColumnBtn').addEventListener('click',()=>openColumnDialog());
 $('#adminBtn').addEventListener('click',openAdmin);$('#calendarBtn').addEventListener('click',openCalendarDialog);$('#myTasksBtn').addEventListener('click',openMyTasks);$('#refreshMyTasksBtn').addEventListener('click',()=>loadMyTasks(false));$('#userChip').addEventListener('click',openProfile);$('#logoutBtn').addEventListener('click',async()=>{try{await api('logout',{body:{}})}catch{}location.reload()});
 $('#searchInput').addEventListener('input',e=>{state.search=e.target.value.trim().toLowerCase();applySearch()});$('#completedViewToggle').addEventListener('change',e=>{state.completedView=e.target.checked;renderWorkspace()});
 $$('.quick-filter').forEach(b=>b.addEventListener('click',()=>{state.quickFilter=b.dataset.quickFilter||'all';renderWorkspace()}));
 $('#showLoginBtn').addEventListener('click',()=>toggleAuth('login'));$('#showRegisterBtn').addEventListener('click',()=>toggleAuth('register'));$('#showRecoverBtn').addEventListener('click',()=>toggleAuth('recover'));$('#backToLoginBtn').addEventListener('click',()=>toggleAuth('login'));
 $('#loginForm').addEventListener('submit',login);$('#registerForm').addEventListener('submit',register);$('#recoverForm').addEventListener('submit',recoverAdmin);
 $('#workspaceForm').addEventListener('submit',saveWorkspace);$('#columnForm').addEventListener('submit',saveColumn);$('#manageTagsBtn').addEventListener('click',openTagManager);$('#tagForm').addEventListener('submit',saveTag);$('#cancelTagEditBtn').addEventListener('click',resetTagForm);
 $('#cardForm').addEventListener('submit',saveCard);$('#completeCardBtn').addEventListener('click',completeCurrentCard);$('#archiveCardBtn').addEventListener('click',archiveCurrentCard);$('#cardFiles').addEventListener('change',renderSelectedFiles);$('#addChecklistItemBtn').addEventListener('click',addChecklistItem);$('#checklistNewItem').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();addChecklistItem()}});
 $('#dueDatePickerBtn').addEventListener('click',openDueDatePicker);$('#clearDueDateBtn').addEventListener('click',()=>setDueDate(''));$('#cardDueDate').addEventListener('change',updateDueQuickState);$$('.due-quick-list [data-due-offset]').forEach(b=>b.addEventListener('click',()=>setDueDate(localDateValue(b.dataset.dueOffset))));
 $('#profileForm').addEventListener('submit',saveProfile);$('#emailTestBtn').addEventListener('click',sendTestEmail);$('#profilePasswordForm').addEventListener('submit',changeOwnPassword);$('#resetPasswordForm').addEventListener('submit',resetUserPassword);$('#siteSettingsForm').addEventListener('submit',saveSiteSettings);
 $('#profileNotificationEmail').addEventListener('input',e=>{$('#emailTestBtn').disabled=!e.target.value.trim()});
 $('#generatePersonalCalendarBtn').addEventListener('click',()=>generateCalendarFeed('personal'));$('#rotatePersonalCalendarBtn').addEventListener('click',()=>generateCalendarFeed('personal',true));$('#revokePersonalCalendarBtn').addEventListener('click',()=>revokeCalendarFeed('personal'));$('#copyPersonalCalendarBtn').addEventListener('click',()=>copyCalendarUrl('personal'));$('#openPersonalCalendarBtn').addEventListener('click',()=>openCalendarUrl('personal'));
 $('#generateWorkspaceCalendarBtn').addEventListener('click',()=>generateCalendarFeed('workspace'));$('#rotateWorkspaceCalendarBtn').addEventListener('click',()=>generateCalendarFeed('workspace',true));$('#revokeWorkspaceCalendarBtn').addEventListener('click',()=>revokeCalendarFeed('workspace'));$('#copyWorkspaceCalendarBtn').addEventListener('click',()=>copyCalendarUrl('workspace'));$('#openWorkspaceCalendarBtn').addEventListener('click',()=>openCalendarUrl('workspace'));
 $('#memberSearch').addEventListener('input',()=>{clearTimeout(state.memberTimer);state.memberTimer=setTimeout(loadMembers,220)});
 $$('.dialog-close,.dialog-cancel').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));document.addEventListener('click',e=>{if(!e.target.closest('.column-menu-wrap'))closePopovers()});document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){e.preventDefault();$('#searchInput').focus()}if(e.key==='Escape')closePopovers()});
}

async function showAuth(status=null){if(!status)status=await api('status');state.status=status;applySite(status.site);$('#logoutBtn').hidden=true;$('#workspaceSwitch').hidden=true;$('#userChip').hidden=true;$('#adminBtn').hidden=true;$('#challengeLabel').textContent='Verifica antispam: quanto fa '+(status.challenge?.question||'?')+'?';$('#bootstrapField').hidden=!!status.has_admin;toggleAuth('login');const d=$('#authDialog');if(!d.open)d.showModal();icons()}
function toggleAuth(mode){const login=mode==='login',reg=mode==='register',recover=mode==='recover';$('#loginForm').hidden=!login;$('#registerForm').hidden=!reg;$('#recoverForm').hidden=!recover;$('#authTabs').hidden=recover;$('#showLoginBtn').classList.toggle('active',login);$('#showRegisterBtn').classList.toggle('active',reg)}
async function login(e){e.preventDefault();const err=$('#loginError');err.hidden=true;try{await api('login',{body:{username:$('#loginUsername').value.trim(),password:$('#loginPassword').value}});$('#loginPassword').value='';await enterApp()}catch(x){err.textContent=x.message;err.hidden=false}}
async function register(e){e.preventDefault();const err=$('#registerError'),ok=$('#registerSuccess');err.hidden=true;ok.hidden=true;if($('#registerPassword').value!==$('#registerPassword2').value){err.textContent='Le password non coincidono.';err.hidden=false;return}try{const d=await api('register',{body:{username:$('#registerUsername').value.trim(),password:$('#registerPassword').value,bootstrap_password:$('#bootstrapPassword').value,challenge_answer:$('#challengeAnswer').value,website:$('#websiteField').value}});if(d.admin){await enterApp();return}ok.textContent='Registrazione inviata. Il tuo account deve essere approvato dall’amministratore.';ok.hidden=false;$('#registerForm').querySelector('button[type="submit"]').disabled=true}catch(x){err.textContent=x.message;err.hidden=false}}
async function recoverAdmin(e){e.preventDefault();const err=$('#recoverError'),ok=$('#recoverSuccess');err.hidden=true;ok.hidden=true;if($('#recoverPassword').value!==$('#recoverPassword2').value){err.textContent='Le password non coincidono.';err.hidden=false;return}try{await api('password:recover-admin',{body:{username:$('#recoverUsername').value.trim(),new_password:$('#recoverPassword').value,app_password:$('#recoverAppPassword').value}});ok.textContent='Password reimpostata. Ora puoi accedere.';ok.hidden=false;$('#recoverPassword').value=$('#recoverPassword2').value=$('#recoverAppPassword').value=''}catch(x){err.textContent=x.message;err.hidden=false}}

function bindBoardEvents(){
 $$('.add-card-btn',boardEl).forEach(b=>b.addEventListener('click',()=>openCardDialog(null,b.closest('.column').dataset.columnId)));
 $$('.column-menu-btn',boardEl).forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const p=$('.column-popover',b.closest('.column-menu-wrap')),open=p.hidden;closePopovers();p.hidden=!open}));
 $$('[data-action="rename-column"]',boardEl).forEach(b=>b.addEventListener('click',()=>{const c=findColumn(b.closest('.column').dataset.columnId);closePopovers();openColumnDialog(c)}));
 $$('[data-action="delete-column"]',boardEl).forEach(b=>b.addEventListener('click',async()=>{const id=b.closest('.column').dataset.columnId,c=findColumn(id);closePopovers();if(!confirm('Eliminare la colonna "'+c.name+'" e tutte le sue card?'))return;try{await api('column:delete',{body:{workspace_id:state.workspace.id,id}});await loadWorkspace();toast('Colonna eliminata.')}catch(e){toast(e.message,'error')}}));
 $$('.task-quick-actions button',boardEl).forEach(b=>b.addEventListener('pointerdown',e=>e.stopPropagation()));
 $$('.card-complete',boardEl).forEach(b=>b.addEventListener('click',async e=>{e.stopPropagation();const card=findCard(b.closest('.task-card').dataset.cardId);if(card)await setCardCompleted(card.id,!card.completed)}));
 $$('.card-edit',boardEl).forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const card=findCard(b.closest('.task-card').dataset.cardId);if(card)openCardDialog(card,card.column_id)}));
 $$('.task-card',boardEl).forEach(el=>{const open=e=>{if(e?.target?.closest('.task-quick-actions'))return;const card=findCard(el.dataset.cardId);openCardDialog(card,card.column_id)};el.addEventListener('click',open);el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open(e)}})});
}
function initSortables(){
 if(!window.Sortable)return;
 state.columnSortable=new Sortable(boardEl,{animation:160,handle:'.column-grip',draggable:'.column',ghostClass:'sortable-ghost',onEnd:async()=>{const ids=$$('.column',boardEl).map(e=>Number(e.dataset.columnId));try{await api('column:reorder',{body:{workspace_id:state.workspace.id,ids}});await loadWorkspace()}catch(e){toast(e.message,'error');await loadWorkspace()}}});
 const coarse=!!window.matchMedia?.('(pointer:coarse)').matches;
 $$('.card-list',boardEl).forEach(list=>{
  const options={group:'cards',animation:150,draggable:'.task-card',filter:'.card-complete,.card-edit,button,a,input,select,textarea,label',preventOnFilter:false,ghostClass:'sortable-ghost',emptyInsertThreshold:28,onEnd:async ev=>{try{await api('card:move',{body:{workspace_id:state.workspace.id,id:Number(ev.item.dataset.cardId),from_column_id:Number(ev.from.closest('.column').dataset.columnId),to_column_id:Number(ev.to.closest('.column').dataset.columnId),new_index:ev.newIndex}});await loadWorkspace()}catch(e){toast(e.message,'error');await loadWorkspace()}}};
  if(coarse)options.handle='.card-drag-handle';
  state.cardSortables.push(new Sortable(list,options));
 });
}

function destroySortables(){state.cardSortables.forEach(s=>s.destroy());state.cardSortables=[];if(state.columnSortable){state.columnSortable.destroy();state.columnSortable=null}}
function closePopovers(){$$('.popover').forEach(e=>e.hidden=true)}
function applySearch(){
 const q=state.search;
 $$('.task-card',boardEl).forEach(el=>{
  const c=findCard(el.dataset.cardId);if(!c)return;
  const people=(c.assignees||[]).flatMap(u=>[u.username,u.display_name||'']).join(' ');
  el.classList.toggle('filtered-out',!!q&&![c.title,c.description,c.label,people].join(' ').toLowerCase().includes(q));
 });
}

function findColumn(id){return state.workspace?.columns.find(c=>Number(c.id)===Number(id))}
function findCard(id){for(const col of state.workspace?.columns||[]){const c=col.cards.find(x=>Number(x.id)===Number(id));if(c)return c}return null}

async function refreshMyTasksBadge(){
 try{
  const d=await api('my:tasks');state.myTasks=d.tasks||[];
  const count=state.myTasks.length,badge=$('#myTasksBadge');badge.hidden=!count;badge.textContent=count>99?'99+':String(count);
 }catch{}
}
async function openMyTasks(){
 $('#myTasksDialog').showModal();await loadMyTasks(false);icons();
}
async function loadMyTasks(silent=false){
 const list=$('#myTasksList'),summary=$('#myTasksSummary');
 if(!silent){list.innerHTML='<div class="empty-list">Caricamento attività…</div>';summary.textContent='Caricamento…'}
 try{
  const d=await api('my:tasks');state.myTasks=d.tasks||[];renderMyTasks();
  const badge=$('#myTasksBadge'),count=state.myTasks.length;badge.hidden=!count;badge.textContent=count>99?'99+':String(count);
 }catch(e){if(!silent){list.innerHTML='<div class="empty-list"></div>';$('.empty-list',list).textContent=e.message;summary.textContent='Impossibile caricare le attività'}}
}
function renderMyTasks(){
 const list=$('#myTasksList'),tasks=state.myTasks||[];list.innerHTML='';
 const overdue=tasks.filter(t=>daysUntil(t.due_date)!==null&&daysUntil(t.due_date)<0).length;
 const dueSoon=tasks.filter(t=>{const d=daysUntil(t.due_date);return d!==null&&d>=0&&d<=7}).length;
 $('#myTasksSummary').textContent=tasks.length+' attività · '+overdue+' scadute · '+dueSoon+' entro 7 giorni';
 if(!tasks.length){list.innerHTML='<div class="empty-list">Nessuna attività attiva assegnata a te.</div>';return}
 tasks.forEach(task=>{
  const row=document.createElement('button');row.type='button';row.className='my-task-row';row.dataset.cardId=task.id;row.dataset.workspaceId=task.workspace_id;
  const main=document.createElement('div');main.className='my-task-main';
  const head=document.createElement('div');head.className='my-task-head';
  const title=document.createElement('strong');title.textContent=task.title;
  const p=priorityInfo(task.priority),priority=document.createElement('span');priority.className='my-task-priority '+p.className;priority.textContent=p.label;
  head.append(title,priority);
  const context=document.createElement('span');context.className='my-task-context';context.textContent=task.workspace_name+' · '+task.column_name;
  const meta=document.createElement('div');meta.className='my-task-meta';
  const due=document.createElement('span');due.className='my-task-due';due.textContent=taskDueLabel(task.due_date);const days=daysUntil(task.due_date);if(days!==null&&days<0)due.classList.add('overdue');else if(days!==null&&days<=2)due.classList.add('soon');
  meta.append(due);
  if(task.checklist_total){const check=document.createElement('span');check.innerHTML='<i data-lucide="list-checks"></i><span></span>';$('span',check).textContent=task.checklist_done+'/'+task.checklist_total;meta.append(check)}
  main.append(head,context,meta);
  const arrow=document.createElement('i');arrow.setAttribute('data-lucide','chevron-right');row.append(main,arrow);
  row.addEventListener('click',()=>openMyTaskCard(task));list.append(row);
 });
 icons();
}
async function openMyTaskCard(task){
 $('#myTasksDialog').close();
 try{
  await selectWorkspace(Number(task.workspace_id));
  const card=findCard(Number(task.id));if(!card){toast('La card non è più disponibile.','error');return}
  openCardDialog(card,card.column_id);
 }catch(e){toast(e.message,'error')}
}

async function openCalendarDialog(){
 if(!state.workspace)return;
 $('#calendarDialogTitle').textContent=state.workspace.name+' · Calendario';
 state.calendarFeeds=null;
 $('#calendarDialog').showModal();
 renderCalendarFeeds({personal:null,workspace:null,can_manage_workspace_feed:false},true);
 icons();
 try{
  const d=await api('calendar:feeds',{query:{workspace_id:state.workspace.id}});
  state.calendarFeeds=d;renderCalendarFeeds(d,false);icons();
 }catch(e){toast(e.message,'error')}
}
function renderCalendarFeeds(data,loading=false){
 const personal=data?.personal||null,workspace=data?.workspace||null,canWorkspace=!!data?.can_manage_workspace_feed;
 $('#personalCalendarEmpty').hidden=!!personal||loading;$('#personalCalendarActive').hidden=!personal;
 $('#personalCalendarUrl').value=personal?.url||'';
 $('#workspaceCalendarSection').hidden=!canWorkspace;
 $('#workspaceCalendarEmpty').hidden=!!workspace||loading;$('#workspaceCalendarActive').hidden=!workspace;
 $('#workspaceCalendarUrl').value=workspace?.url||'';
 const pg=$('#generatePersonalCalendarBtn'),wg=$('#generateWorkspaceCalendarBtn');if(pg)pg.disabled=loading;if(wg)wg.disabled=loading;
}
async function generateCalendarFeed(scope,rotate=false){
 if(!state.workspace)return;
 if(rotate&&!confirm('Rigenerare l’URL? Il vecchio calendario smetterà di aggiornarsi.'))return;
 try{
  const d=await api('calendar:token',{body:{workspace_id:state.workspace.id,scope}});
  const feeds=await api('calendar:feeds',{query:{workspace_id:state.workspace.id}});
  state.calendarFeeds=feeds;renderCalendarFeeds(feeds,false);icons();
  toast(rotate?'URL calendario rigenerato.':'Calendario generato.');
  return d;
 }catch(e){toast(e.message,'error')}
}
async function revokeCalendarFeed(scope){
 if(!state.workspace||!confirm('Revocare questo calendario? Chi usa il vecchio URL non riceverà più aggiornamenti.'))return;
 try{
  await api('calendar:revoke',{body:{workspace_id:state.workspace.id,scope}});
  const feeds=await api('calendar:feeds',{query:{workspace_id:state.workspace.id}});
  state.calendarFeeds=feeds;renderCalendarFeeds(feeds,false);icons();toast('Calendario revocato.');
 }catch(e){toast(e.message,'error')}
}
function currentCalendarUrl(scope){return scope==='workspace'?state.calendarFeeds?.workspace?.url:state.calendarFeeds?.personal?.url}
async function copyCalendarUrl(scope){
 const url=currentCalendarUrl(scope);if(!url)return;
 try{await navigator.clipboard.writeText(url);toast('URL calendario copiato.')}catch{const input=scope==='workspace'?$('#workspaceCalendarUrl'):$('#personalCalendarUrl');input.select();document.execCommand('copy');toast('URL calendario copiato.')}
}
function openCalendarUrl(scope){
 const url=currentCalendarUrl(scope);if(!url)return;
 location.href=url.replace(/^https?:\/\//i,'webcal://');
}

function openWorkspaceDialog(ws=null){$('#workspaceId').value=ws?.id||'';$('#workspaceName').value=ws?.name||'';$('#workspaceLogo').value=ws?.logo_url||'';$('#workspaceDialogTitle').textContent=ws?'Modifica workspace':'Nuovo workspace';$('#workspaceDialog').showModal();setTimeout(()=>$('#workspaceName').focus(),30)}
async function saveWorkspace(e){e.preventDefault();const id=$('#workspaceId').value,body={name:$('#workspaceName').value.trim(),logo_url:$('#workspaceLogo').value.trim()};if(id)body.workspace_id=id;try{const d=await api(id?'workspace:update':'workspace:create',{body});$('#workspaceDialog').close();const st=await api('status');state.workspaces=st.workspaces||[];renderWorkspaceSelect();await selectWorkspace(id?Number(id):Number(d.id))}catch(x){toast(x.message,'error')}}

function renderColumnTagChoices(selected=[]){const box=$('#columnTagChoices');box.innerHTML='';const set=new Set(selected.map(Number));if(!(state.workspace?.tags||[]).length){box.innerHTML='<span class="empty-list">Nessun tag disponibile.</span>';return}(state.workspace.tags||[]).forEach(t=>{const lab=document.createElement('label');lab.className='tag-choice';lab.style.setProperty('--tag-color',t.color);const input=document.createElement('input');input.type='checkbox';input.value=t.id;input.checked=set.has(Number(t.id));const dot=document.createElement('span');dot.className='tag-dot';dot.style.setProperty('--tag-color',t.color);const name=document.createElement('span');name.textContent=t.name;lab.append(input,dot,name);box.append(lab)})}
function openColumnDialog(c=null){$('#columnId').value=c?.id||'';$('#columnName').value=c?.name||'';$('#columnDialogTitle').textContent=c?'Modifica colonna':'Nuova colonna';$('#manageTagsBtn').hidden=!canEdit();renderColumnTagChoices((c?.tags||[]).map(t=>t.id));$('#columnDialog').showModal();setTimeout(()=>$('#columnName').focus(),30)}
async function saveColumn(e){e.preventDefault();const id=$('#columnId').value,body={workspace_id:state.workspace.id,name:$('#columnName').value.trim(),tag_ids:$$('#columnTagChoices input:checked').map(i=>Number(i.value))};if(id)body.id=id;try{await api(id?'column:update':'column:create',{body});$('#columnDialog').close();await loadWorkspace()}catch(x){toast(x.message,'error')}}
function openTagManager(){$('#columnDialog').close();resetTagForm();renderTagManager();$('#tagDialog').showModal()}
function renderTagManager(){const box=$('#tagList');box.innerHTML='';if(!(state.workspace?.tags||[]).length){box.innerHTML='<div class="empty-list">Nessun tag creato.</div>';return}(state.workspace.tags||[]).forEach(t=>{const row=document.createElement('div');row.className='tag-manager-row';const main=document.createElement('div');main.className='tag-manager-name';const dot=document.createElement('span');dot.className='tag-dot';dot.style.setProperty('--tag-color',t.color);const name=document.createElement('span');name.textContent=t.name;main.append(dot,name);const acts=document.createElement('div');acts.className='user-actions';const edit=document.createElement('button');edit.className='tiny-btn';edit.textContent='Modifica';edit.onclick=()=>{ $('#tagId').value=t.id;$('#tagName').value=t.name;$('#tagColor').value=t.color;$('#cancelTagEditBtn').hidden=false;$('#tagName').focus()};const del=document.createElement('button');del.className='tiny-btn danger';del.textContent='Elimina';del.onclick=()=>deleteTag(t.id,t.name);acts.append(edit,del);row.append(main,acts);box.append(row)})}
function resetTagForm(){$('#tagId').value='';$('#tagName').value='';$('#tagColor').value='#b6174b';$('#cancelTagEditBtn').hidden=true}
async function saveTag(e){e.preventDefault();const id=$('#tagId').value,body={workspace_id:state.workspace.id,name:$('#tagName').value.trim(),color:$('#tagColor').value};if(id)body.id=id;try{await api(id?'tag:update':'tag:create',{body});await loadWorkspace();resetTagForm();renderTagManager()}catch(x){toast(x.message,'error')}}
async function deleteTag(id,name){if(!confirm('Eliminare il tag "'+name+'"? Verrà rimosso anche dalle colonne.'))return;try{await api('tag:delete',{body:{workspace_id:state.workspace.id,id}});await loadWorkspace();renderTagManager()}catch(x){toast(x.message,'error')}}

function renderAssigneeChoices(selected=[]){
 const box=$('#cardAssigneeChoices');box.innerHTML='';
 const users=state.workspace?.assignable_users||[],chosen=new Set((selected||[]).map(u=>Number(typeof u==='object'?u.id:u)));
 if(!users.length){box.innerHTML='<span class="empty-list">Nessun utente disponibile nel workspace.</span>';return}
 users.forEach(u=>{const lab=document.createElement('label');lab.className='assignee-choice';lab.title=u.display_name?userDisplayName(u)+' · @'+u.username:'@'+u.username;const input=document.createElement('input');input.type='checkbox';input.value=u.id;input.checked=chosen.has(Number(u.id));const avatar=document.createElement('span');avatar.className='assignee-avatar';avatar.textContent=userInitial(u);const name=document.createElement('span');name.textContent=userDisplayName(u);lab.append(input,avatar,name);box.append(lab)});
}

function renderChecklistDraft(){
 const box=$('#checklistList');box.innerHTML='';const items=state.cardChecklistDraft||[],stats=checklistStats(items);$('#checklistProgressLabel').textContent=stats.done+'/'+stats.total+' completati';
 if(!items.length){box.innerHTML='<div class="checklist-empty">Nessun sotto-task.</div>';return}
 items.forEach((item,index)=>{
  const row=document.createElement('div');row.className='checklist-item';
  const check=document.createElement('input');check.type='checkbox';check.checked=!!item.done;check.disabled=!canEdit();check.setAttribute('aria-label','Completa sotto-task');check.addEventListener('change',()=>{state.cardChecklistDraft[index].done=check.checked;renderChecklistDraft()});
  const text=document.createElement('input');text.type='text';text.maxLength=240;text.value=item.text;text.disabled=!canEdit();text.addEventListener('input',()=>{state.cardChecklistDraft[index].text=text.value});
  const remove=document.createElement('button');remove.type='button';remove.className='ghost-icon checklist-remove';remove.title='Rimuovi';remove.setAttribute('aria-label','Rimuovi sotto-task');remove.innerHTML='<i data-lucide="x"></i>';remove.hidden=!canEdit();remove.addEventListener('click',()=>{state.cardChecklistDraft.splice(index,1);renderChecklistDraft();icons()});
  if(item.done)row.classList.add('done');row.append(check,text,remove);box.append(row);
 });
 icons();
}
function addChecklistItem(){
 if(!canEdit())return;const input=$('#checklistNewItem'),text=input.value.trim();if(!text)return;
 state.cardChecklistDraft.push({text,done:false});input.value='';renderChecklistDraft();input.focus();
}

function openCardDialog(card=null,columnId){
 const col=findColumn(columnId||card?.column_id);
 $('#cardId').value=card?.id||'';$('#cardColumnId').value=col?.id||'';$('#cardTitle').value=card?.title||'';$('#cardDescription').value=card?.description||'';$('#cardLabel').value=card?.label||'';$('#cardPriority').value=card?.priority||'normal';$('#cardDueDate').value=card?.due_date||'';updateDueQuickState();
 state.cardChecklistDraft=(card?.checklist||[]).map(item=>({text:item.text,done:!!item.done}));$('#checklistNewItem').value='';renderChecklistDraft();$('#checklistComposer').hidden=!canEdit();
 $('#cardColumnLabel').textContent=col?.name||'Card';$('#cardDialogTitle').textContent=card?'Dettaglio attività':'Nuova attività';$('#archiveCardBtn').hidden=!card||!canEdit();$('#completeCardBtn').hidden=!card||!canEdit();
 if(card){const completeBtn=$('#completeCardBtn');$('span',completeBtn).textContent=card.completed?'Riapri':'Segna fatto';const oldIcon=$('svg,i',completeBtn);const newIcon=document.createElement('i');newIcon.setAttribute('data-lucide',card.completed?'rotate-ccw':'circle-check-big');if(oldIcon)oldIcon.replaceWith(newIcon);else completeBtn.prepend(newIcon)}
 $('#saveCardBtn').hidden=!canEdit();$('#attachmentUploadField').hidden=!canEdit();$('#cardFiles').value='';$('#selectedFiles').innerHTML='';renderAttachments(card?.attachments||[]);renderAssigneeChoices(card?.assignees||[]);
 $$('#cardForm input,#cardForm textarea,#cardForm select').forEach(i=>{if(!['cardId','cardColumnId','cardFiles','checklistNewItem'].includes(i.id))i.disabled=!canEdit()});
 $('#cardDialog').showModal();icons();if(canEdit())setTimeout(()=>$('#cardTitle').focus(),30)
}

function humanSize(bytes){if(bytes<1024)return bytes+' B';if(bytes<1024*1024)return(Math.round(bytes/102.4)/10)+' KB';return(Math.round(bytes/1024/102.4)/10)+' MB'}
function renderAttachments(items){const box=$('#attachmentList');box.innerHTML='';if(!items.length){box.innerHTML='<div class="empty-list">Nessun allegato.</div>';return}items.forEach(a=>{const row=document.createElement('div');row.className='attachment-row';const main=document.createElement('div');main.className='attachment-main';const icon=document.createElement('i');icon.setAttribute('data-lucide','file');const name=document.createElement('a');name.className='attachment-name';name.textContent=a.name;name.href=API+'?action=attachment:download&id='+encodeURIComponent(a.id);name.target='_blank';name.rel='noopener';const size=document.createElement('span');size.className='attachment-size';size.textContent=humanSize(a.size);main.append(icon,name,size);const acts=document.createElement('div');acts.className='attachment-actions';if(canEdit()){const del=document.createElement('button');del.className='tiny-btn danger';del.type='button';del.textContent='Rimuovi';del.onclick=()=>deleteAttachment(a.id);acts.append(del)}row.append(main,acts);box.append(row)});icons()}
function renderSelectedFiles(){const box=$('#selectedFiles');box.innerHTML='';[...$('#cardFiles').files].forEach(f=>{const row=document.createElement('div');row.className='selected-file';row.textContent=f.name+' · '+humanSize(f.size);box.append(row)})}
async function uploadAttachments(cardId,files){if(!files.length)return;const fd=new FormData();fd.append('workspace_id',state.workspace.id);fd.append('card_id',cardId);files.forEach(f=>fd.append('files[]',f));const res=await fetch(API+'?action=attachment:upload',{method:'POST',credentials:'same-origin',body:fd,headers:{Accept:'application/json'}});let data;try{data=await res.json()}catch{throw new Error('Risposta upload non valida.')}if(!res.ok||!data.ok)throw new Error(data.error||'Upload non riuscito.')}
async function deleteAttachment(id){if(!confirm('Rimuovere questo allegato?'))return;try{await api('attachment:delete',{body:{id}});await loadWorkspace();const c=findCard($('#cardId').value);renderAttachments(c?.attachments||[])}catch(e){toast(e.message,'error')}}
async function saveCard(e){e.preventDefault();if(!canEdit())return;const id=$('#cardId').value,files=[...$('#cardFiles').files],body={workspace_id:state.workspace.id,column_id:$('#cardColumnId').value,title:$('#cardTitle').value.trim(),description:$('#cardDescription').value.trim(),label:$('#cardLabel').value,priority:$('#cardPriority').value,due_date:$('#cardDueDate').value||null,assignee_ids:$$('#cardAssigneeChoices input:checked').map(i=>Number(i.value)),checklist:(state.cardChecklistDraft||[]).map(i=>({text:(i.text||'').trim(),done:!!i.done})).filter(i=>i.text)};if(id)body.id=id;try{setBusy(true);const d=await api(id?'card:update':'card:create',{body});const cardId=id?Number(id):Number(d.id);if(files.length)await uploadAttachments(cardId,files);$('#cardDialog').close();await loadWorkspace();refreshMyTasksBadge();toast(files.length?'Card e allegati salvati.':'Card salvata.')}catch(x){toast(x.message,'error')}finally{setBusy(false)}}
async function setCardCompleted(id,completed){try{await api('card:complete',{body:{workspace_id:state.workspace.id,id,completed}});await loadWorkspace();refreshMyTasksBadge();toast(completed?'Card completata.':'Card riaperta.')}catch(x){toast(x.message,'error')}}
async function completeCurrentCard(){const id=Number($('#cardId').value);if(!id)return;const card=findCard(id);if(!card)return;$('#cardDialog').close();await setCardCompleted(id,!card.completed)}
async function archiveCurrentCard(){const id=$('#cardId').value;if(!id||!confirm('Archiviare questa card?'))return;try{await api('card:archive',{body:{workspace_id:state.workspace.id,id}});$('#cardDialog').close();await loadWorkspace();refreshMyTasksBadge()}catch(x){toast(x.message,'error')}}

function openProfile(){
 $('#profileTitle').textContent=userDisplayName(state.user);
 $('#profileDisplayName').value=state.user.display_name||'';
 $('#profileNotificationEmail').value=state.user.notification_email||'';
 $('#profileDigestFrequency').value=state.user.digest_frequency||'off';
 $('#profileDigestDueDays').value=String(state.user.digest_due_days||3);
 $('#profileCurrentPassword').value=$('#profileNewPassword').value=$('#profileNewPassword2').value='';
 $('#profileSettingsError').hidden=true;$('#profilePasswordError').hidden=true;$('#emailTestStatus').hidden=true;$('#emailTestBtn').disabled=!(state.user.notification_email||'').trim();$('#profileDialog').showModal()
}
async function persistProfileFromForm(){
 const d=await api('profile:update',{body:{display_name:$('#profileDisplayName').value.trim(),notification_email:$('#profileNotificationEmail').value.trim(),digest_frequency:$('#profileDigestFrequency').value,digest_due_days:Number($('#profileDigestDueDays').value)}});
 state.user=d.user;$('#userChip').textContent=userDisplayName(state.user);$('#userChip').title='@'+state.user.username;$('#profileTitle').textContent=userDisplayName(state.user);$('#emailTestBtn').disabled=!(state.user.notification_email||'').trim();
 return d.user;
}
async function saveProfile(e){
 e.preventDefault();const err=$('#profileSettingsError');err.hidden=true;$('#emailTestStatus').hidden=true;
 try{await persistProfileFromForm();await loadWorkspace();toast('Profilo aggiornato.')}catch(x){err.textContent=x.message;err.hidden=false}
}
async function sendTestEmail(){
 const err=$('#profileSettingsError'),status=$('#emailTestStatus'),btn=$('#emailTestBtn');err.hidden=true;status.hidden=true;
 try{
  btn.disabled=true;btn.classList.add('loading');
  await persistProfileFromForm();
  const d=await api('email:test',{body:{}});
  const via=d.transport==='php-mail'?'Gandi Web Hosting':(d.transport==='smtp'?'SMTP Gandi':d.transport||'trasporto email');
  status.textContent='Notifica accettata da '+via+' per '+d.recipient+'. Il server di destinazione può impiegare qualche istante a recapitarla.';
  status.hidden=false;
  toast('Notifica inviata.');
 }catch(x){err.textContent=x.message;err.hidden=false}finally{btn.classList.remove('loading');btn.disabled=!(state.user?.notification_email||'').trim()}
}
async function changeOwnPassword(e){
 e.preventDefault();const err=$('#profilePasswordError');err.hidden=true;
 if($('#profileNewPassword').value!==$('#profileNewPassword2').value){err.textContent='Le password non coincidono.';err.hidden=false;return}
 try{await api('password:change',{body:{current_password:$('#profileCurrentPassword').value,new_password:$('#profileNewPassword').value}});$('#profileCurrentPassword').value=$('#profileNewPassword').value=$('#profileNewPassword2').value='';toast('Password aggiornata.')}catch(x){err.textContent=x.message;err.hidden=false}
}

function openResetPassword(u){$('#resetPasswordUserId').value=u.id;$('#resetPasswordTitle').textContent='Password di @'+u.username;$('#adminNewPassword').value=$('#adminNewPassword2').value='';$('#resetPasswordError').hidden=true;$('#resetPasswordDialog').showModal()}
async function resetUserPassword(e){e.preventDefault();const err=$('#resetPasswordError');err.hidden=true;if($('#adminNewPassword').value!==$('#adminNewPassword2').value){err.textContent='Le password non coincidono.';err.hidden=false;return}try{await api('admin:user-password',{body:{user_id:$('#resetPasswordUserId').value,new_password:$('#adminNewPassword').value}});$('#resetPasswordDialog').close();toast('Password reimpostata.')}catch(x){err.textContent=x.message;err.hidden=false}}

async function openAdmin(){$('#adminDialog').showModal();$('#membersWorkspaceLabel').textContent=state.workspace?'Workspace: '+state.workspace.name:'';$('#pendingSection').hidden=!state.user.is_admin;$('#globalUsersSection').hidden=!state.user.is_admin;$('#siteSettingsSection').hidden=!state.user.is_admin;$('#membersSection').hidden=!canAdminWorkspace()&&!state.user.is_admin;if(state.user.is_admin){populateSiteSettings();await loadAdminUsers()}if(canAdminWorkspace()||state.user.is_admin)await loadMembers();icons()}
function populateSiteSettings(){$('#siteNameInput').value=state.site?.name||'PRJ';$('#siteLogoInput').value=state.site?.logo_url||'';$('#siteDescriptionInput').value=state.site?.description||''}
async function saveSiteSettings(e){e.preventDefault();try{const d=await api('site:update',{body:{name:$('#siteNameInput').value.trim(),logo_url:$('#siteLogoInput').value.trim(),description:$('#siteDescriptionInput').value.trim()}});applySite(d.site);toast('Identità del sito aggiornata.')}catch(x){toast(x.message,'error')}}
async function loadPendingBadge(){try{const d=await api('admin:users'),n=d.users.filter(u=>u.status==='pending').length;$('#pendingBadge').hidden=!n;$('#pendingBadge').textContent=n||''}catch{}}
async function loadAdminUsers(){try{const d=await api('admin:users'),pending=d.users.filter(u=>u.status==='pending'),active=d.users.filter(u=>u.status==='active');$('#pendingBadge').hidden=!pending.length;$('#pendingBadge').textContent=pending.length||'';renderPending(pending);renderGlobalUsers(active)}catch(e){toast(e.message,'error')}}
function userRow(u,sub=''){
 const row=document.createElement('div');row.className='user-row';const main=document.createElement('div');main.className='user-main';const av=document.createElement('span');av.className='user-avatar';av.textContent=userInitial(u);const txt=document.createElement('div');txt.innerHTML='<div class="user-name"></div><div class="user-sub"></div>';
 $('.user-name',txt).textContent=userDisplayName(u);
 $('.user-sub',txt).textContent=(u.display_name?'@'+u.username+(sub?' · ':''):'')+sub;
 main.append(av,txt);const actions=document.createElement('div');actions.className='user-actions';row.append(main,actions);return{row,actions}
}

function renderPending(users){const box=$('#pendingUsers');box.innerHTML='';if(!users.length){box.innerHTML='<div class="empty-list">Nessuna richiesta in attesa.</div>';return}users.forEach(u=>{const {row,actions}=userRow(u,'registrato '+new Date(u.created_at).toLocaleDateString('it-IT'));const yes=document.createElement('button');yes.className='tiny-btn primary';yes.textContent='Approva';yes.onclick=()=>setUserStatus(u.id,'active');const no=document.createElement('button');no.className='tiny-btn danger';no.textContent='Rifiuta';no.onclick=()=>setUserStatus(u.id,'rejected');actions.append(yes,no);box.append(row)})}
function renderGlobalUsers(users){const box=$('#globalUsers');box.innerHTML='';users.forEach(u=>{const {row,actions}=userRow(u,u.is_admin?'admin globale':'utente attivo');const reset=document.createElement('button');reset.className='tiny-btn';reset.textContent='Reset password';reset.onclick=()=>openResetPassword(u);actions.append(reset);if(Number(u.id)!==Number(state.user.id)){const b=document.createElement('button');b.className='tiny-btn';b.textContent=u.is_admin?'Revoca admin':'Rendi admin';b.onclick=()=>setGlobalAdmin(u.id,!u.is_admin);actions.append(b)}box.append(row)})}
async function setUserStatus(id,status){try{await api('admin:user-status',{body:{user_id:id,status}});await loadAdminUsers();await loadMembers()}catch(e){toast(e.message,'error')}}
async function setGlobalAdmin(id,isAdmin){try{await api('admin:user-admin',{body:{user_id:id,is_admin:isAdmin}});await loadAdminUsers()}catch(e){toast(e.message,'error')}}
async function loadMembers(){if(!state.workspace)return;try{const d=await api('members:list',{query:{workspace_id:state.workspace.id,q:$('#memberSearch').value.trim()}});renderMembers(d.users)}catch(e){toast(e.message,'error')}}
function renderMembers(users){const box=$('#workspaceMembers');box.innerHTML='';if(!users.length){box.innerHTML='<div class="empty-list">Nessun utente trovato.</div>';return}users.forEach(u=>{const {row,actions}=userRow(u,u.role?'ruolo: '+roleLabel(u.role):(u.is_admin?'admin globale · accesso implicito':'non assegnato'));const sel=document.createElement('select');[['','Non assegnato'],['viewer','Lettura'],['editor','Editor'],['admin','Admin workspace']].forEach(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;if((u.role||'')===v)o.selected=true;sel.append(o)});if(u.is_admin){sel.disabled=true;sel.title='Gli admin globali hanno accesso a tutti i workspace'}else sel.onchange=()=>setMember(u.id,sel.value);actions.append(sel);box.append(row)})}
async function setMember(userId,role){try{await api('member:set',{body:{workspace_id:state.workspace.id,user_id:userId,role}});await loadMembers();toast('Accesso aggiornato.')}catch(e){toast(e.message,'error')}}

boot();
})();