(() => {
'use strict';
const API='api/index.php';
const state={user:null,workspaces:[],workspace:null,site:null,search:'',completedView:false,cardSortables:[],columnSortable:null,status:null,memberTimer:null};
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
 $('#logoutBtn').hidden=false;$('#workspaceSwitch').hidden=false;$('#userChip').hidden=false;
 $('#userChip').textContent='@'+state.user.username;$('#newWorkspaceBtn').hidden=!state.user.is_admin;
 renderWorkspaceSelect();
 const saved=Number(localStorage.getItem('prj_workspace')||0),chosen=state.workspaces.find(w=>w.id===saved)||state.workspaces[0];
 if(!chosen){showNoWorkspace();return}
 await selectWorkspace(chosen.id);
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
 emptyState.hidden=ws.columns.length>0;boardEl.hidden=ws.columns.length===0;
 $('#addColumnBtn').hidden=!canEdit()||state.completedView;$('#emptyAddColumnBtn').hidden=!canEdit();$('#editWorkspaceBtn').hidden=!canAdminWorkspace();$('#adminBtn').hidden=!(state.user?.is_admin||canAdminWorkspace());
 ws.columns.forEach(col=>{
  const f=$('#columnTemplate').content.cloneNode(true),el=$('.column',f),mix=tagMix(col.tags),visibleCards=col.cards.filter(card=>Boolean(card.completed)===state.completedView);
  el.dataset.columnId=col.id;el.style.setProperty('--tag-bg',mix.column);el.style.setProperty('--tag-solid',mix.solid);
  $('.column-title',f).textContent=col.name;$('.column-count',f).textContent=visibleCards.length;
  const tagBox=$('.column-tags',f);(col.tags||[]).forEach(t=>tagBox.append(tagPill(t)));
  const list=$('.card-list',f);visibleCards.forEach(card=>list.append(renderCard(card,col.tags||[])));
  $('.add-card-btn',f).hidden=!canEdit()||state.completedView;
  if(!canEdit()||state.completedView){$('.column-grip',f).hidden=true}
  if(!canEdit())$('.column-menu-btn',f).hidden=true;
  boardEl.append(f);
 });
 applySearch();bindBoardEvents();if(canEdit()&&!state.completedView)initSortables();icons();
}
function tagPill(tag){const e=document.createElement('span');e.className='tag-pill';const d=document.createElement('span');d.className='tag-dot';d.style.setProperty('--tag-color',tag.color);const n=document.createElement('span');n.textContent=tag.name;e.append(d,n);return e}
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
 const people=$('.task-assignees',f);if(card.assignees?.length){card.assignees.forEach(u=>{const pill=document.createElement('span');pill.className='assignee-pill';pill.textContent='@'+u.username;pill.title='Assegnato a @'+u.username;people.append(pill)});people.hidden=false}
 const due=$('.task-due',f);if(card.due_date){const st=card.completed?null:dueState(card.due_date);$('span',due).textContent=(st?.label?st.label+' · ':'')+new Intl.DateTimeFormat('it-IT',{day:'numeric',month:'short'}).format(new Date(card.due_date+'T12:00:00'));due.hidden=false;const ic=$('.task-due-icon',due);ic.setAttribute('data-lucide',st?.icon||'calendar-days');if(st?.className)el.classList.add(st.className)}
 const ac=$('.attachment-count',f);if(card.attachments?.length){$('span',ac).textContent=card.attachments.length;ac.hidden=false}
 const quick=$('.card-complete',f);quick.title=card.completed?'Riapri card':'Segna come fatto';quick.setAttribute('aria-label',quick.title);$('i',quick).setAttribute('data-lucide',card.completed?'rotate-ccw':'circle-check-big');
 if(!canEdit()){$('.card-edit',f).hidden=true;quick.hidden=true}
 return f;
}

function bindGlobalEvents(){
 $('#workspaceSelect').addEventListener('change',e=>selectWorkspace(Number(e.target.value)));$('#newWorkspaceBtn').addEventListener('click',()=>openWorkspaceDialog());$('#editWorkspaceBtn').addEventListener('click',()=>openWorkspaceDialog(state.workspace));$('#refreshBtn').addEventListener('click',()=>loadWorkspace());$('#addColumnBtn').addEventListener('click',()=>openColumnDialog());$('#emptyAddColumnBtn').addEventListener('click',()=>openColumnDialog());
 $('#adminBtn').addEventListener('click',openAdmin);$('#userChip').addEventListener('click',openProfile);$('#logoutBtn').addEventListener('click',async()=>{try{await api('logout',{body:{}})}catch{}location.reload()});
 $('#searchInput').addEventListener('input',e=>{state.search=e.target.value.trim().toLowerCase();applySearch()});$('#completedViewToggle').addEventListener('change',e=>{state.completedView=e.target.checked;renderWorkspace()});
 $('#showLoginBtn').addEventListener('click',()=>toggleAuth('login'));$('#showRegisterBtn').addEventListener('click',()=>toggleAuth('register'));$('#showRecoverBtn').addEventListener('click',()=>toggleAuth('recover'));$('#backToLoginBtn').addEventListener('click',()=>toggleAuth('login'));
 $('#loginForm').addEventListener('submit',login);$('#registerForm').addEventListener('submit',register);$('#recoverForm').addEventListener('submit',recoverAdmin);
 $('#workspaceForm').addEventListener('submit',saveWorkspace);$('#columnForm').addEventListener('submit',saveColumn);$('#manageTagsBtn').addEventListener('click',openTagManager);$('#tagForm').addEventListener('submit',saveTag);$('#cancelTagEditBtn').addEventListener('click',resetTagForm);
 $('#cardForm').addEventListener('submit',saveCard);$('#completeCardBtn').addEventListener('click',completeCurrentCard);$('#archiveCardBtn').addEventListener('click',archiveCurrentCard);$('#cardFiles').addEventListener('change',renderSelectedFiles);
 $('#profileForm').addEventListener('submit',changeOwnPassword);$('#resetPasswordForm').addEventListener('submit',resetUserPassword);$('#siteSettingsForm').addEventListener('submit',saveSiteSettings);
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
 $('.card-complete',boardEl).forEach(b=>b.addEventListener('click',async e=>{e.stopPropagation();const card=findCard(b.closest('.task-card').dataset.cardId);if(card)await setCardCompleted(card.id,!card.completed)}));
 $('.card-edit',boardEl).forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const card=findCard(b.closest('.task-card').dataset.cardId);if(card)openCardDialog(card,card.column_id)}));
 $('.task-card',boardEl).forEach(el=>{const open=e=>{if(e?.target?.closest('.task-quick-actions'))return;const card=findCard(el.dataset.cardId);openCardDialog(card,card.column_id)};el.addEventListener('click',open);el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open(e)}})});
}
function initSortables(){if(!window.Sortable)return;state.columnSortable=new Sortable(boardEl,{animation:160,handle:'.column-grip',draggable:'.column',ghostClass:'sortable-ghost',onEnd:async()=>{const ids=$$('.column',boardEl).map(e=>Number(e.dataset.columnId));try{await api('column:reorder',{body:{workspace_id:state.workspace.id,ids}});await loadWorkspace()}catch(e){toast(e.message,'error');await loadWorkspace()}}});$$('.card-list',boardEl).forEach(list=>state.cardSortables.push(new Sortable(list,{group:'cards',animation:150,draggable:'.task-card',ghostClass:'sortable-ghost',emptyInsertThreshold:28,onEnd:async ev=>{try{await api('card:move',{body:{workspace_id:state.workspace.id,id:Number(ev.item.dataset.cardId),from_column_id:Number(ev.from.closest('.column').dataset.columnId),to_column_id:Number(ev.to.closest('.column').dataset.columnId),new_index:ev.newIndex}});await loadWorkspace()}catch(e){toast(e.message,'error');await loadWorkspace()}}})))}
function destroySortables(){state.cardSortables.forEach(s=>s.destroy());state.cardSortables=[];if(state.columnSortable){state.columnSortable.destroy();state.columnSortable=null}}
function closePopovers(){$$('.popover').forEach(e=>e.hidden=true)}
function applySearch(){const q=state.search;$$('.task-card',boardEl).forEach(el=>{const c=findCard(el.dataset.cardId);if(c)el.classList.toggle('filtered-out',!!q&&![c.title,c.description,c.label].join(' ').toLowerCase().includes(q))})}
function findColumn(id){return state.workspace?.columns.find(c=>Number(c.id)===Number(id))}
function findCard(id){for(const col of state.workspace?.columns||[]){const c=col.cards.find(x=>Number(x.id)===Number(id));if(c)return c}return null}

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
 users.forEach(u=>{const lab=document.createElement('label');lab.className='assignee-choice';const input=document.createElement('input');input.type='checkbox';input.value=u.id;input.checked=chosen.has(Number(u.id));const avatar=document.createElement('span');avatar.className='assignee-avatar';avatar.textContent=(u.username||'?')[0].toUpperCase();const name=document.createElement('span');name.textContent='@'+u.username;lab.append(input,avatar,name);box.append(lab)});
}
function openCardDialog(card=null,columnId){const col=findColumn(columnId||card?.column_id);$('#cardId').value=card?.id||'';$('#cardColumnId').value=col?.id||'';$('#cardTitle').value=card?.title||'';$('#cardDescription').value=card?.description||'';$('#cardLabel').value=card?.label||'';$('#cardDueDate').value=card?.due_date||'';$('#cardColumnLabel').textContent=col?.name||'Card';$('#cardDialogTitle').textContent=card?'Dettaglio attività':'Nuova attività';$('#archiveCardBtn').hidden=!card||!canEdit();$('#completeCardBtn').hidden=!card||!canEdit();if(card){$('#completeCardBtn span').textContent=card.completed?'Riapri':'Segna fatto';$('#completeCardBtn i').setAttribute('data-lucide',card.completed?'rotate-ccw':'circle-check-big')}$('#saveCardBtn').hidden=!canEdit();$('#attachmentUploadField').hidden=!canEdit();$('#cardFiles').value='';$('#selectedFiles').innerHTML='';renderAttachments(card?.attachments||[]);renderAssigneeChoices(card?.assignees||[]);$$('#cardForm input,#cardForm textarea,#cardForm select').forEach(i=>{if(!['cardId','cardColumnId','cardFiles'].includes(i.id))i.disabled=!canEdit()});$('#cardDialog').showModal();icons();if(canEdit())setTimeout(()=>$('#cardTitle').focus(),30)}
function humanSize(bytes){if(bytes<1024)return bytes+' B';if(bytes<1024*1024)return(Math.round(bytes/102.4)/10)+' KB';return(Math.round(bytes/1024/102.4)/10)+' MB'}
function renderAttachments(items){const box=$('#attachmentList');box.innerHTML='';if(!items.length){box.innerHTML='<div class="empty-list">Nessun allegato.</div>';return}items.forEach(a=>{const row=document.createElement('div');row.className='attachment-row';const main=document.createElement('div');main.className='attachment-main';const icon=document.createElement('i');icon.setAttribute('data-lucide','file');const name=document.createElement('a');name.className='attachment-name';name.textContent=a.name;name.href=API+'?action=attachment:download&id='+encodeURIComponent(a.id);name.target='_blank';name.rel='noopener';const size=document.createElement('span');size.className='attachment-size';size.textContent=humanSize(a.size);main.append(icon,name,size);const acts=document.createElement('div');acts.className='attachment-actions';if(canEdit()){const del=document.createElement('button');del.className='tiny-btn danger';del.type='button';del.textContent='Rimuovi';del.onclick=()=>deleteAttachment(a.id);acts.append(del)}row.append(main,acts);box.append(row)});icons()}
function renderSelectedFiles(){const box=$('#selectedFiles');box.innerHTML='';[...$('#cardFiles').files].forEach(f=>{const row=document.createElement('div');row.className='selected-file';row.textContent=f.name+' · '+humanSize(f.size);box.append(row)})}
async function uploadAttachments(cardId,files){if(!files.length)return;const fd=new FormData();fd.append('workspace_id',state.workspace.id);fd.append('card_id',cardId);files.forEach(f=>fd.append('files[]',f));const res=await fetch(API+'?action=attachment:upload',{method:'POST',credentials:'same-origin',body:fd,headers:{Accept:'application/json'}});let data;try{data=await res.json()}catch{throw new Error('Risposta upload non valida.')}if(!res.ok||!data.ok)throw new Error(data.error||'Upload non riuscito.')}
async function deleteAttachment(id){if(!confirm('Rimuovere questo allegato?'))return;try{await api('attachment:delete',{body:{id}});await loadWorkspace();const c=findCard($('#cardId').value);renderAttachments(c?.attachments||[])}catch(e){toast(e.message,'error')}}
async function saveCard(e){e.preventDefault();if(!canEdit())return;const id=$('#cardId').value,files=[...$('#cardFiles').files],body={workspace_id:state.workspace.id,column_id:$('#cardColumnId').value,title:$('#cardTitle').value.trim(),description:$('#cardDescription').value.trim(),label:$('#cardLabel').value,due_date:$('#cardDueDate').value||null,assignee_ids:$$('#cardAssigneeChoices input:checked').map(i=>Number(i.value))};if(id)body.id=id;try{setBusy(true);const d=await api(id?'card:update':'card:create',{body});const cardId=id?Number(id):Number(d.id);if(files.length)await uploadAttachments(cardId,files);$('#cardDialog').close();await loadWorkspace();toast(files.length?'Card e allegati salvati.':'Card salvata.')}catch(x){toast(x.message,'error')}finally{setBusy(false)}}
async function setCardCompleted(id,completed){try{await api('card:complete',{body:{workspace_id:state.workspace.id,id,completed}});await loadWorkspace();toast(completed?'Card completata.':'Card riaperta.')}catch(x){toast(x.message,'error')}}
async function completeCurrentCard(){const id=Number($('#cardId').value);if(!id)return;const card=findCard(id);if(!card)return;$('#cardDialog').close();await setCardCompleted(id,!card.completed)}
async function archiveCurrentCard(){const id=$('#cardId').value;if(!id||!confirm('Archiviare questa card?'))return;try{await api('card:archive',{body:{workspace_id:state.workspace.id,id}});$('#cardDialog').close();await loadWorkspace()}catch(x){toast(x.message,'error')}}

function openProfile(){$('#profileTitle').textContent='@'+state.user.username;$('#profileCurrentPassword').value=$('#profileNewPassword').value=$('#profileNewPassword2').value='';$('#profileError').hidden=true;$('#profileDialog').showModal()}
async function changeOwnPassword(e){e.preventDefault();const err=$('#profileError');err.hidden=true;if($('#profileNewPassword').value!==$('#profileNewPassword2').value){err.textContent='Le password non coincidono.';err.hidden=false;return}try{await api('password:change',{body:{current_password:$('#profileCurrentPassword').value,new_password:$('#profileNewPassword').value}});$('#profileDialog').close();toast('Password aggiornata.')}catch(x){err.textContent=x.message;err.hidden=false}}
function openResetPassword(u){$('#resetPasswordUserId').value=u.id;$('#resetPasswordTitle').textContent='Password di @'+u.username;$('#adminNewPassword').value=$('#adminNewPassword2').value='';$('#resetPasswordError').hidden=true;$('#resetPasswordDialog').showModal()}
async function resetUserPassword(e){e.preventDefault();const err=$('#resetPasswordError');err.hidden=true;if($('#adminNewPassword').value!==$('#adminNewPassword2').value){err.textContent='Le password non coincidono.';err.hidden=false;return}try{await api('admin:user-password',{body:{user_id:$('#resetPasswordUserId').value,new_password:$('#adminNewPassword').value}});$('#resetPasswordDialog').close();toast('Password reimpostata.')}catch(x){err.textContent=x.message;err.hidden=false}}

async function openAdmin(){$('#adminDialog').showModal();$('#membersWorkspaceLabel').textContent=state.workspace?'Workspace: '+state.workspace.name:'';$('#pendingSection').hidden=!state.user.is_admin;$('#globalUsersSection').hidden=!state.user.is_admin;$('#siteSettingsSection').hidden=!state.user.is_admin;$('#membersSection').hidden=!canAdminWorkspace()&&!state.user.is_admin;if(state.user.is_admin){populateSiteSettings();await loadAdminUsers()}if(canAdminWorkspace()||state.user.is_admin)await loadMembers();icons()}
function populateSiteSettings(){$('#siteNameInput').value=state.site?.name||'PRJ';$('#siteLogoInput').value=state.site?.logo_url||'';$('#siteDescriptionInput').value=state.site?.description||''}
async function saveSiteSettings(e){e.preventDefault();try{const d=await api('site:update',{body:{name:$('#siteNameInput').value.trim(),logo_url:$('#siteLogoInput').value.trim(),description:$('#siteDescriptionInput').value.trim()}});applySite(d.site);toast('Identità del sito aggiornata.')}catch(x){toast(x.message,'error')}}
async function loadPendingBadge(){try{const d=await api('admin:users'),n=d.users.filter(u=>u.status==='pending').length;$('#pendingBadge').hidden=!n;$('#pendingBadge').textContent=n||''}catch{}}
async function loadAdminUsers(){try{const d=await api('admin:users'),pending=d.users.filter(u=>u.status==='pending'),active=d.users.filter(u=>u.status==='active');$('#pendingBadge').hidden=!pending.length;$('#pendingBadge').textContent=pending.length||'';renderPending(pending);renderGlobalUsers(active)}catch(e){toast(e.message,'error')}}
function userRow(u,sub=''){const row=document.createElement('div');row.className='user-row';const main=document.createElement('div');main.className='user-main';const av=document.createElement('span');av.className='user-avatar';av.textContent=(u.username||'?')[0].toUpperCase();const txt=document.createElement('div');txt.innerHTML='<div class="user-name"></div><div class="user-sub"></div>';$('.user-name',txt).textContent='@'+u.username;$('.user-sub',txt).textContent=sub;main.append(av,txt);const actions=document.createElement('div');actions.className='user-actions';row.append(main,actions);return{row,actions}}
function renderPending(users){const box=$('#pendingUsers');box.innerHTML='';if(!users.length){box.innerHTML='<div class="empty-list">Nessuna richiesta in attesa.</div>';return}users.forEach(u=>{const {row,actions}=userRow(u,'registrato '+new Date(u.created_at).toLocaleDateString('it-IT'));const yes=document.createElement('button');yes.className='tiny-btn primary';yes.textContent='Approva';yes.onclick=()=>setUserStatus(u.id,'active');const no=document.createElement('button');no.className='tiny-btn danger';no.textContent='Rifiuta';no.onclick=()=>setUserStatus(u.id,'rejected');actions.append(yes,no);box.append(row)})}
function renderGlobalUsers(users){const box=$('#globalUsers');box.innerHTML='';users.forEach(u=>{const {row,actions}=userRow(u,u.is_admin?'admin globale':'utente attivo');const reset=document.createElement('button');reset.className='tiny-btn';reset.textContent='Reset password';reset.onclick=()=>openResetPassword(u);actions.append(reset);if(Number(u.id)!==Number(state.user.id)){const b=document.createElement('button');b.className='tiny-btn';b.textContent=u.is_admin?'Revoca admin':'Rendi admin';b.onclick=()=>setGlobalAdmin(u.id,!u.is_admin);actions.append(b)}box.append(row)})}
async function setUserStatus(id,status){try{await api('admin:user-status',{body:{user_id:id,status}});await loadAdminUsers();await loadMembers()}catch(e){toast(e.message,'error')}}
async function setGlobalAdmin(id,isAdmin){try{await api('admin:user-admin',{body:{user_id:id,is_admin:isAdmin}});await loadAdminUsers()}catch(e){toast(e.message,'error')}}
async function loadMembers(){if(!state.workspace)return;try{const d=await api('members:list',{query:{workspace_id:state.workspace.id,q:$('#memberSearch').value.trim()}});renderMembers(d.users)}catch(e){toast(e.message,'error')}}
function renderMembers(users){const box=$('#workspaceMembers');box.innerHTML='';if(!users.length){box.innerHTML='<div class="empty-list">Nessun utente trovato.</div>';return}users.forEach(u=>{const {row,actions}=userRow(u,u.role?'ruolo: '+roleLabel(u.role):(u.is_admin?'admin globale · accesso implicito':'non assegnato'));const sel=document.createElement('select');[['','Non assegnato'],['viewer','Lettura'],['editor','Editor'],['admin','Admin workspace']].forEach(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;if((u.role||'')===v)o.selected=true;sel.append(o)});if(u.is_admin){sel.disabled=true;sel.title='Gli admin globali hanno accesso a tutti i workspace'}else sel.onchange=()=>setMember(u.id,sel.value);actions.append(sel);box.append(row)})}
async function setMember(userId,role){try{await api('member:set',{body:{workspace_id:state.workspace.id,user_id:userId,role}});await loadMembers();toast('Accesso aggiornato.')}catch(e){toast(e.message,'error')}}

boot();
})();