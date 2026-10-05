(() => {
'use strict';
const API='api/index.php';
const state={user:null,workspaces:[],workspace:null,search:'',cardSortables:[],columnSortable:null,status:null,memberTimer:null};
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const boardEl=$('#board'), emptyState=$('#emptyState'), toastRegion=$('#toastRegion');

function icons(){if(window.lucide)window.lucide.createIcons({attrs:{'stroke-width':1.8}})}
function toast(message,type='info'){const e=document.createElement('div');e.className='toast'+(type==='error'?' error':'');e.textContent=message;toastRegion.append(e);setTimeout(()=>e.remove(),3000)}
function setBusy(v){document.body.classList.toggle('busy',v)}
async function api(action,options={}){
 const init={method:options.method||'GET',credentials:'same-origin',headers:{Accept:'application/json'}};
 if(options.body!==undefined){init.method=init.method==='GET'?'POST':init.method;init.headers['Content-Type']='application/json';init.body=JSON.stringify(options.body)}
 const url=API+'?action='+encodeURIComponent(action)+(options.query?'&'+new URLSearchParams(options.query):'');
 let res;try{res=await fetch(url,init)}catch{throw new Error('Server non raggiungibile.')}
 let data;try{data=await res.json()}catch{throw new Error('Risposta server non valida.')}
 if(res.status===401&&!['login','register'].includes(action)){await showAuth();throw new Error('Sessione scaduta.')}
 if(!res.ok||data.ok===false)throw new Error(data.error||'Operazione non riuscita.');
 return data;
}

async function boot(){
 icons();bindGlobalEvents();
 try{
  const status=await api('status');state.status=status;
  if(status.setup_required){$('#setupDialog').showModal();return}
  if(!status.authenticated){showAuth(status);return}
  await enterApp(status);
 }catch(e){toast(e.message,'error')}
}
async function enterApp(status=null){
 if(!status)status=await api('status');
 state.status=status;state.user=status.user;state.workspaces=status.workspaces||[];
 $('#authDialog').open&&$('#authDialog').close();
 $('#logoutBtn').hidden=false;$('#workspaceSwitch').hidden=false;$('#userChip').hidden=false;
 $('#userChip').textContent='@'+state.user.username;
 $('#newWorkspaceBtn').hidden=!state.user.is_admin;
 renderWorkspaceSelect();
 const saved=Number(localStorage.getItem('prj_workspace')||0);
 const chosen=state.workspaces.find(w=>w.id===saved)||state.workspaces[0];
 if(!chosen){showNoWorkspace();return}
 await selectWorkspace(chosen.id);
}
function showNoWorkspace(){
 state.workspace=null;$('#workspaceContent').hidden=true;$('#workspaceNoAccess').hidden=false;$('#adminBtn').hidden=!state.user?.is_admin;$('#workspaceSelect').innerHTML='';
}
function renderWorkspaceSelect(){
 const select=$('#workspaceSelect');select.innerHTML='';
 state.workspaces.forEach(w=>{const o=document.createElement('option');o.value=w.id;o.textContent=w.name;select.append(o)});
}
async function selectWorkspace(id){
 const wsMeta=state.workspaces.find(w=>Number(w.id)===Number(id));if(!wsMeta)return;
 localStorage.setItem('prj_workspace',String(id));$('#workspaceSelect').value=String(id);setMiniAvatar(wsMeta);
 $('#workspaceNoAccess').hidden=true;$('#workspaceContent').hidden=false;
 await loadWorkspace(id);
}
async function loadWorkspace(id=state.workspace?.id){
 if(!id)return;setBusy(true);
 try{const d=await api('workspace:get',{query:{workspace_id:id}});state.workspace=d.workspace;renderWorkspace()}
 finally{setBusy(false)}
}
function canEdit(){return ['editor','admin'].includes(state.workspace?.role)}
function canAdminWorkspace(){return state.workspace?.role==='admin'}
function setAvatar(el,ws){
 el.innerHTML='';if(ws?.logo_url){const img=document.createElement('img');img.src=ws.logo_url;img.alt='';img.onerror=()=>{el.textContent=(ws.name||'?').charAt(0).toUpperCase()};el.append(img)}
 else el.textContent=(ws?.name||'?').charAt(0).toUpperCase();
}
function setMiniAvatar(ws){setAvatar($('#workspaceMiniAvatar'),ws)}
function renderWorkspace(){
 destroySortables();boardEl.innerHTML='';const ws=state.workspace;if(!ws)return;
 $('#boardTitle').textContent=ws.name;setAvatar($('#workspaceAvatar'),ws);setMiniAvatar(ws);
 const total=ws.columns.reduce((n,c)=>n+c.cards.length,0);
 $('#boardMeta').textContent=ws.columns.length+(ws.columns.length===1?' colonna':' colonne')+' · '+total+(total===1?' card':' card')+' · '+roleLabel(ws.role);
 emptyState.hidden=ws.columns.length>0;boardEl.hidden=ws.columns.length===0;
 $('#addColumnBtn').hidden=!canEdit();$('#emptyAddColumnBtn').hidden=!canEdit();$('#editWorkspaceBtn').hidden=!canAdminWorkspace();$('#adminBtn').hidden=!(state.user?.is_admin||canAdminWorkspace());
 ws.columns.forEach(col=>{
  const f=$('#columnTemplate').content.cloneNode(true),el=$('.column',f);el.dataset.columnId=col.id;el.style.setProperty('--column-color',col.color||'#5b6255');
  $('.column-title',f).textContent=col.name;$('.column-count',f).textContent=col.cards.length;
  const list=$('.card-list',f);col.cards.forEach(card=>list.append(renderCard(card)));
  if(!canEdit()){$('.column-grip',f).hidden=true;$('.column-menu-btn',f).hidden=true;$('.add-card-btn',f).hidden=true}
  boardEl.append(f);
 });
 applySearch();bindBoardEvents();if(canEdit())initSortables();icons();
}
function roleLabel(r){return({viewer:'sola lettura',editor:'editor',admin:'admin'})[r]||r}
function renderCard(card){
 const f=$('#cardTemplate').content.cloneNode(true),el=$('.task-card',f);el.dataset.cardId=card.id;el.dataset.label=card.label||'';
 $('.task-title',f).textContent=card.title;
 const desc=$('.task-description',f);if(card.description){desc.textContent=card.description;desc.hidden=false}
 const lab=$('.task-label',f);if(card.label){lab.textContent=({magenta:'Focus',amber:'Attesa',teal:'Pronto',blue:'Info',violet:'Idea'})[card.label]||card.label;lab.hidden=false}
 const due=$('.task-due',f);if(card.due_date){$('span',due).textContent=new Intl.DateTimeFormat('it-IT',{day:'numeric',month:'short'}).format(new Date(card.due_date+'T12:00:00'));due.hidden=false;if(new Date(card.due_date+'T23:59:59')<new Date())due.classList.add('overdue')}
 if(!canEdit())$('.card-edit',f).hidden=true;return f;
}

function bindGlobalEvents(){
 $('#workspaceSelect').addEventListener('change',e=>selectWorkspace(Number(e.target.value)));
 $('#newWorkspaceBtn').addEventListener('click',()=>openWorkspaceDialog());
 $('#editWorkspaceBtn').addEventListener('click',()=>openWorkspaceDialog(state.workspace));
 $('#refreshBtn').addEventListener('click',()=>loadWorkspace());
 $('#addColumnBtn').addEventListener('click',()=>openColumnDialog());$('#emptyAddColumnBtn').addEventListener('click',()=>openColumnDialog());
 $('#adminBtn').addEventListener('click',openAdmin);
 $('#logoutBtn').addEventListener('click',async()=>{try{await api('logout',{body:{}})}catch{}location.reload()});
 $('#searchInput').addEventListener('input',e=>{state.search=e.target.value.trim().toLowerCase();applySearch()});
 $('#showLoginBtn').addEventListener('click',()=>toggleAuth('login'));$('#showRegisterBtn').addEventListener('click',()=>toggleAuth('register'));
 $('#loginForm').addEventListener('submit',login);$('#registerForm').addEventListener('submit',register);
 $('#workspaceForm').addEventListener('submit',saveWorkspace);$('#columnForm').addEventListener('submit',saveColumn);$('#cardForm').addEventListener('submit',saveCard);$('#archiveCardBtn').addEventListener('click',archiveCurrentCard);
 $('#memberSearch').addEventListener('input',()=>{clearTimeout(state.memberTimer);state.memberTimer=setTimeout(loadMembers,220)});
 $$('.dialog-close,.dialog-cancel').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
 document.addEventListener('click',e=>{if(!e.target.closest('.column-menu-wrap'))closePopovers()});
 document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){e.preventDefault();$('#searchInput').focus()}if(e.key==='Escape')closePopovers()});
}
async function showAuth(status=null){
 if(!status)status=await api('status');state.status=status;$('#logoutBtn').hidden=true;$('#workspaceSwitch').hidden=true;$('#userChip').hidden=true;$('#adminBtn').hidden=true;
 $('#challengeLabel').textContent='Verifica antispam: quanto fa '+(status.challenge?.question||'?')+'?';$('#bootstrapField').hidden=!!status.has_admin;
 toggleAuth('login');const d=$('#authDialog');if(!d.open)d.showModal();icons();
}
function toggleAuth(mode){
 const login=mode==='login';$('#loginForm').hidden=!login;$('#registerForm').hidden=login;$('#showLoginBtn').classList.toggle('active',login);$('#showRegisterBtn').classList.toggle('active',!login);
}
async function login(e){
 e.preventDefault();const err=$('#loginError');err.hidden=true;
 try{await api('login',{body:{username:$('#loginUsername').value.trim(),password:$('#loginPassword').value}});$('#loginPassword').value='';await enterApp()}
 catch(x){err.textContent=x.message;err.hidden=false}
}
async function register(e){
 e.preventDefault();const err=$('#registerError'),ok=$('#registerSuccess');err.hidden=true;ok.hidden=true;
 if($('#registerPassword').value!==$('#registerPassword2').value){err.textContent='Le password non coincidono.';err.hidden=false;return}
 try{
  const d=await api('register',{body:{username:$('#registerUsername').value.trim(),password:$('#registerPassword').value,bootstrap_password:$('#bootstrapPassword').value,challenge_answer:$('#challengeAnswer').value,website:$('#websiteField').value}});
  if(d.admin){await enterApp();return}
  ok.textContent='Registrazione inviata. Il tuo account deve essere approvato dall’amministratore.';ok.hidden=false;$('#registerForm').querySelector('button[type="submit"]').disabled=true;
 }catch(x){err.textContent=x.message;err.hidden=false}
}
function bindBoardEvents(){
 $$('.add-card-btn',boardEl).forEach(b=>b.addEventListener('click',()=>openCardDialog(null,b.closest('.column').dataset.columnId)));
 $$('.column-menu-btn',boardEl).forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();const p=$('.column-popover',b.closest('.column-menu-wrap')),open=p.hidden;closePopovers();p.hidden=!open}));
 $$('[data-action="rename-column"]',boardEl).forEach(b=>b.addEventListener('click',()=>{const c=findColumn(b.closest('.column').dataset.columnId);closePopovers();openColumnDialog(c)}));
 $$('[data-action="delete-column"]',boardEl).forEach(b=>b.addEventListener('click',async()=>{const id=b.closest('.column').dataset.columnId,c=findColumn(id);closePopovers();if(!confirm('Eliminare la colonna "'+c.name+'" e tutte le sue card?'))return;try{await api('column:delete',{body:{workspace_id:state.workspace.id,id}});await loadWorkspace();toast('Colonna eliminata.')}catch(e){toast(e.message,'error')}}));
 $$('.task-card',boardEl).forEach(el=>{const open=()=>{const c=findCard(el.dataset.cardId);openCardDialog(c,c.column_id)};el.addEventListener('click',open);el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}})});
}
function initSortables(){
 if(!window.Sortable)return;
 state.columnSortable=new Sortable(boardEl,{animation:160,handle:'.column-grip',draggable:'.column',ghostClass:'sortable-ghost',onEnd:async()=>{const ids=$$('.column',boardEl).map(e=>Number(e.dataset.columnId));try{await api('column:reorder',{body:{workspace_id:state.workspace.id,ids}});await loadWorkspace()}catch(e){toast(e.message,'error');await loadWorkspace()}}});
 $$('.card-list',boardEl).forEach(list=>state.cardSortables.push(new Sortable(list,{group:'cards',animation:150,draggable:'.task-card',ghostClass:'sortable-ghost',emptyInsertThreshold:28,onEnd:async ev=>{try{await api('card:move',{body:{workspace_id:state.workspace.id,id:Number(ev.item.dataset.cardId),from_column_id:Number(ev.from.closest('.column').dataset.columnId),to_column_id:Number(ev.to.closest('.column').dataset.columnId),new_index:ev.newIndex}});await loadWorkspace()}catch(e){toast(e.message,'error');await loadWorkspace()}}})));
}
function destroySortables(){state.cardSortables.forEach(s=>s.destroy());state.cardSortables=[];if(state.columnSortable){state.columnSortable.destroy();state.columnSortable=null}}
function closePopovers(){$$('.popover').forEach(e=>e.hidden=true)}
function applySearch(){const q=state.search;$$('.task-card',boardEl).forEach(el=>{const c=findCard(el.dataset.cardId);if(c)el.classList.toggle('filtered-out',!!q&&![c.title,c.description,c.label].join(' ').toLowerCase().includes(q))})}
function findColumn(id){return state.workspace?.columns.find(c=>Number(c.id)===Number(id))}
function findCard(id){for(const col of state.workspace?.columns||[]){const c=col.cards.find(x=>Number(x.id)===Number(id));if(c)return c}return null}

function openWorkspaceDialog(ws=null){$('#workspaceId').value=ws?.id||'';$('#workspaceName').value=ws?.name||'';$('#workspaceLogo').value=ws?.logo_url||'';$('#workspaceDialogTitle').textContent=ws?'Modifica workspace':'Nuovo workspace';$('#workspaceDialog').showModal();setTimeout(()=>$('#workspaceName').focus(),30)}
async function saveWorkspace(e){e.preventDefault();const id=$('#workspaceId').value,body={name:$('#workspaceName').value.trim(),logo_url:$('#workspaceLogo').value.trim()};if(id)body.workspace_id=id;try{const d=await api(id?'workspace:update':'workspace:create',{body});$('#workspaceDialog').close();const st=await api('status');state.workspaces=st.workspaces||[];renderWorkspaceSelect();await selectWorkspace(id?Number(id):Number(d.id))}catch(x){toast(x.message,'error')}}
function openColumnDialog(c=null){$('#columnId').value=c?.id||'';$('#columnName').value=c?.name||'';$('#columnColor').value=c?.color||'#5b6255';$('#columnDialogTitle').textContent=c?'Modifica colonna':'Nuova colonna';$('#columnDialog').showModal();setTimeout(()=>$('#columnName').focus(),30)}
async function saveColumn(e){e.preventDefault();const id=$('#columnId').value,body={workspace_id:state.workspace.id,name:$('#columnName').value.trim(),color:$('#columnColor').value};if(id)body.id=id;try{await api(id?'column:update':'column:create',{body});$('#columnDialog').close();await loadWorkspace()}catch(x){toast(x.message,'error')}}
function openCardDialog(card=null,columnId){const col=findColumn(columnId||card?.column_id);$('#cardId').value=card?.id||'';$('#cardColumnId').value=col?.id||'';$('#cardTitle').value=card?.title||'';$('#cardDescription').value=card?.description||'';$('#cardLabel').value=card?.label||'';$('#cardDueDate').value=card?.due_date||'';$('#cardColumnLabel').textContent=col?.name||'Card';$('#cardDialogTitle').textContent=card?'Dettaglio attività':'Nuova attività';$('#archiveCardBtn').hidden=!card||!canEdit();$('#saveCardBtn').hidden=!canEdit();$$('#cardForm input,#cardForm textarea,#cardForm select').forEach(i=>{if(!['cardId','cardColumnId'].includes(i.id))i.disabled=!canEdit()});$('#cardDialog').showModal();if(canEdit())setTimeout(()=>$('#cardTitle').focus(),30)}
async function saveCard(e){e.preventDefault();if(!canEdit())return;const id=$('#cardId').value,body={workspace_id:state.workspace.id,column_id:$('#cardColumnId').value,title:$('#cardTitle').value.trim(),description:$('#cardDescription').value.trim(),label:$('#cardLabel').value,due_date:$('#cardDueDate').value||null};if(id)body.id=id;try{await api(id?'card:update':'card:create',{body});$('#cardDialog').close();await loadWorkspace()}catch(x){toast(x.message,'error')}}
async function archiveCurrentCard(){const id=$('#cardId').value;if(!id||!confirm('Archiviare questa card?'))return;try{await api('card:archive',{body:{workspace_id:state.workspace.id,id}});$('#cardDialog').close();await loadWorkspace()}catch(x){toast(x.message,'error')}}

async function openAdmin(){
 $('#adminDialog').showModal();$('#membersWorkspaceLabel').textContent=state.workspace?'Workspace: '+state.workspace.name:'';
 $('#pendingSection').hidden=!state.user.is_admin;$('#globalUsersSection').hidden=!state.user.is_admin;$('#membersSection').hidden=!canAdminWorkspace()&&!state.user.is_admin;
 if(state.user.is_admin)await loadAdminUsers();if(canAdminWorkspace()||state.user.is_admin)await loadMembers();icons();
}
async function loadAdminUsers(){
 try{
  const d=await api('admin:users'),pending=d.users.filter(u=>u.status==='pending'),active=d.users.filter(u=>u.status==='active');
  $('#pendingBadge').hidden=!pending.length;$('#pendingBadge').textContent=pending.length||'';
  renderPending(pending);renderGlobalUsers(active);
 }catch(e){toast(e.message,'error')}
}
function userRow(u,sub=''){const row=document.createElement('div');row.className='user-row';const main=document.createElement('div');main.className='user-main';const av=document.createElement('span');av.className='user-avatar';av.textContent=(u.username||'?')[0].toUpperCase();const txt=document.createElement('div');txt.innerHTML='<div class="user-name"></div><div class="user-sub"></div>';$('.user-name',txt).textContent='@'+u.username;$('.user-sub',txt).textContent=sub;main.append(av,txt);const actions=document.createElement('div');actions.className='user-actions';row.append(main,actions);return{row,actions}}
function renderPending(users){const box=$('#pendingUsers');box.innerHTML='';if(!users.length){box.innerHTML='<div class="empty-list">Nessuna richiesta in attesa.</div>';return}users.forEach(u=>{const {row,actions}=userRow(u,'registrato '+new Date(u.created_at).toLocaleDateString('it-IT'));const yes=document.createElement('button');yes.className='tiny-btn primary';yes.textContent='Approva';yes.onclick=()=>setUserStatus(u.id,'active');const no=document.createElement('button');no.className='tiny-btn danger';no.textContent='Rifiuta';no.onclick=()=>setUserStatus(u.id,'rejected');actions.append(yes,no);box.append(row)})}
function renderGlobalUsers(users){const box=$('#globalUsers');box.innerHTML='';users.forEach(u=>{const {row,actions}=userRow(u,u.is_admin?'admin globale':'utente attivo');if(Number(u.id)!==Number(state.user.id)){const b=document.createElement('button');b.className='tiny-btn';b.textContent=u.is_admin?'Revoca admin':'Rendi admin';b.onclick=()=>setGlobalAdmin(u.id,!u.is_admin);actions.append(b)}box.append(row)})}
async function setUserStatus(id,status){try{await api('admin:user-status',{body:{user_id:id,status}});await loadAdminUsers();await loadMembers()}catch(e){toast(e.message,'error')}}
async function setGlobalAdmin(id,isAdmin){try{await api('admin:user-admin',{body:{user_id:id,is_admin:isAdmin}});await loadAdminUsers()}catch(e){toast(e.message,'error')}}
async function loadMembers(){
 if(!state.workspace)return;try{const d=await api('members:list',{query:{workspace_id:state.workspace.id,q:$('#memberSearch').value.trim()}});renderMembers(d.users)}catch(e){toast(e.message,'error')}
}
function renderMembers(users){const box=$('#workspaceMembers');box.innerHTML='';if(!users.length){box.innerHTML='<div class="empty-list">Nessun utente trovato.</div>';return}users.forEach(u=>{const {row,actions}=userRow(u,u.role?'ruolo: '+roleLabel(u.role):(u.is_admin?'admin globale · accesso implicito':'non assegnato'));const sel=document.createElement('select');[['','Non assegnato'],['viewer','Lettura'],['editor','Editor'],['admin','Admin workspace']].forEach(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;if((u.role||'')===v)o.selected=true;sel.append(o)});if(u.is_admin){sel.disabled=true;sel.title='Gli admin globali hanno accesso a tutti i workspace'}else sel.onchange=()=>setMember(u.id,sel.value);actions.append(sel);box.append(row)})}
async function setMember(userId,role){try{await api('member:set',{body:{workspace_id:state.workspace.id,user_id:userId,role}});await loadMembers();toast('Accesso aggiornato.')}catch(e){toast(e.message,'error')}}

boot();
})();