import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const js = fs.readFileSync('js/app.js', 'utf8');
const php = fs.readFileSync('api/index.php', 'utf8');

function fail(message) {
  console.error('UI contract failed:', message);
  process.exit(1);
}

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const directIdRefs = [...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
const missingIds = [...new Set(directIdRefs.filter(id => !htmlIds.has(id)))];
if (missingIds.length) fail('JS references missing HTML ids: ' + missingIds.join(', '));

const forbiddenCollectionUse = [
  ...js.matchAll(/(?<!\$)\$\([^)]*\)\.(?:forEach|map|filter)\b/g),
].map(m => m[0]);
if (forbiddenCollectionUse.length) {
  fail('Single-element selector used as a collection: ' + forbiddenCollectionUse.join(' | '));
}

const requiredBindings = [
  ["#cardForm submit", "$('#cardForm').addEventListener('submit',saveCard)"],
  ["add card click", "$$('.add-card-btn',boardEl).forEach"],
  ["complete card click", "$$('.card-complete',boardEl).forEach"],
  ["edit card click", "$$('.card-edit',boardEl).forEach"],
  ["card quick-action pointer guard", "$$('.task-quick-actions button',boardEl).forEach"],
  ["due-date calendar", "$('#dueDatePickerBtn').addEventListener('click',openDueDatePicker)"],
  ["due-date quick presets", "$$('.due-quick-list [data-due-offset]').forEach"],
  ["completed view toggle", "$('#completedViewToggle').addEventListener('change'"],
  ["column form submit", "$('#columnForm').addEventListener('submit',saveColumn)"],
  ["workspace form submit", "$('#workspaceForm').addEventListener('submit',saveWorkspace)"],
  ["tag form submit", "$('#tagForm').addEventListener('submit',saveTag)"],
  ["profile form submit", "$('#profileForm').addEventListener('submit',changeOwnPassword)"],
  ["admin reset submit", "$('#resetPasswordForm').addEventListener('submit',resetUserPassword)"],
  ["site settings submit", "$('#siteSettingsForm').addEventListener('submit',saveSiteSettings)"],
];
for (const [name, token] of requiredBindings) {
  if (!js.includes(token)) fail('Missing interaction binding: ' + name);
}

const requiredCardFlow = [
  "function openCardDialog(card=null,columnId)",
  "$$('#cardForm input,#cardForm textarea,#cardForm select').forEach",
  "$('#cardDialog').showModal()",
  "assignee_ids:$$('#cardAssigneeChoices input:checked').map",
  "api(id?'card:update':'card:create',{body})",
  "async function setCardCompleted",
  "api('card:complete'",
  "async function uploadAttachments",
  "filter:'.task-quick-actions,button,a,input,select,textarea,label'",
  "preventOnFilter:false",
  "function updateDueQuickState()",
  "function openDueDatePicker()",
  "const oldIcon=$('svg,i',completeBtn)",
  "oldIcon.replaceWith(newIcon)",
];
for (const token of requiredCardFlow) {
  if (!js.includes(token)) fail('Card flow contract missing: ' + token);
}

const requiredButtons = [
  'saveCardBtn','completeCardBtn','archiveCardBtn','addColumnBtn','refreshBtn',
  'newWorkspaceBtn','adminBtn','logoutBtn','manageTagsBtn','completedViewToggle',
  'dueDatePickerBtn','clearDueDateBtn','cardDueDate'
];
for (const id of requiredButtons) {
  if (!htmlIds.has(id)) fail('Missing critical control #' + id);
}

const requiredApiActions = [
  'workspace:create','workspace:update','column:create','column:update','column:delete',
  'column:reorder','tag:create','tag:update','tag:delete','card:create','card:update',
  'card:archive','card:complete','card:move','attachment:upload','attachment:download',
  'attachment:delete','password:change','site:update','members:list','member:set',
  'admin:users','admin:user-status','admin:user-admin','admin:user-password'
];
for (const action of requiredApiActions) {
  const caseToken = "case '" + action + "'";
  const ifToken = "$action === '" + action + "'";
  if (!php.includes(caseToken) && !php.includes(ifToken)) {
    fail('Frontend/backend contract missing API action: ' + action);
  }
}

const submitButtons = ['saveCardBtn'];
for (const id of submitButtons) {
  const re = new RegExp('<button[^>]*id="' + id + '"[^>]*type="submit"');
  if (!re.test(html)) fail('#' + id + ' must remain type=submit');
}

console.log(
  'UI contract OK:',
  htmlIds.size + ' ids,',
  requiredBindings.length + ' critical bindings,',
  requiredApiActions.length + ' API actions.'
);
