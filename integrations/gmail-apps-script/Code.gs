/**
 * PRJ Gmail Bridge — Google Apps Script
 *
 * Legge i thread recenti dell'account che esegue lo script, elimina a monte
 * notifiche già gestite da ticketing/Jira e usa OpenAI Structured Outputs
 * per decidere se esiste un'attività personale da inserire in PRJ.
 *
 * Proprietà script richieste:
 *   PRJ_BASE_URL          es. https://prj.curromatteo.it
 *   PRJ_AUTOMATION_KEY    stessa chiave configurata in PRJ
 *   PRJ_WORKSPACE_ID      id numerico del workspace lavoro
 *   OPENAI_API_KEY
 *
 * Proprietà opzionali:
 *   OPENAI_MODEL          default gpt-6-luna
 *   MY_EMAIL              default account effettivo dello script
 *   MIN_CONFIDENCE        default 0.90
 *   LOOKBACK_DAYS         default 3
 *   MAX_THREADS           default 40
 *
 * Primo avvio:
 *   1. configura le proprietà
 *   2. esegui testConnections()
 *   3. esegui scanGmailToPrj() manualmente e controlla il log
 *   4. esegui installDailyTrigger()
 */

const PRJ_GMAIL = Object.freeze({
  VERSION: '0.1.0',
  DEFAULT_MODEL: 'gpt-6-luna',
  DEFAULT_MIN_CONFIDENCE: 0.90,
  DEFAULT_LOOKBACK_DAYS: 3,
  DEFAULT_MAX_THREADS: 40,
  MAX_MESSAGES_PER_THREAD: 14,
  MAX_BODY_CHARS_PER_MESSAGE: 5000,
  MAX_THREAD_CHARS: 30000,
  CURSOR_KEY: 'PRJ_GMAIL_LAST_SCAN_MS',
  INITIAL_LOOKBACK_HOURS: 36,
  IGNORE_SENDERS: [
    'ticket@unive.it',
    'no-reply-jira@cineca.it',
    'noreply-jira@cineca.it'
  ],
  IGNORE_SUBJECT_PATTERNS: [
    /^nuovo ticket assegnato/i,
    /^nuova attività per il ticket/i,
    /^SD[A-Z]+-\d+\b/i
  ]
});

function scanGmailToPrj() {
  const cfg = loadConfig_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('Scansione già in corso: esco.');
    return;
  }

  try {
    const now = Date.now();
    const cursor = getCursorMs_(now);
    const context = fetchPrjContext_(cfg);
    const workspace = resolveWorkspace_(context, cfg);
    const columns = flattenColumns_(workspace);
    if (!columns.length) throw new Error('Nessuna colonna disponibile nel workspace PRJ configurato.');

    const query = 'newer_than:' + cfg.lookbackDays + 'd -in:spam -in:trash';
    const threads = GmailApp.search(query, 0, cfg.maxThreads);
    let examined = 0;
    let classified = 0;
    let upserted = 0;
    let ignored = 0;
    let lowConfidence = 0;

    // Ordine cronologico: utile se più thread aggiornano lo stesso ambito.
    threads.sort((a, b) => a.getLastMessageDate().getTime() - b.getLastMessageDate().getTime());

    for (const thread of threads) {
      const lastMs = thread.getLastMessageDate().getTime();
      if (lastMs <= cursor) continue;
      examined++;

      const envelope = buildThreadEnvelope_(thread, cfg.myEmail, cursor);
      if (!envelope.messages.length) {
        ignored++;
        continue;
      }
      if (shouldHardIgnore_(envelope)) {
        ignored++;
        continue;
      }

      const decision = classifyThread_(cfg, columns, envelope);
      classified++;

      if (!decision.task) {
        console.log('IGNORE [%s] %s — %s', decision.confidence, envelope.subject, decision.reason);
        ignored++;
        continue;
      }

      if (decision.confidence < cfg.minConfidence) {
        console.log(
          'LOW CONFIDENCE [%s] %s → %s — %s',
          decision.confidence,
          envelope.subject,
          decision.column_name,
          decision.reason
        );
        lowConfidence++;
        continue;
      }

      const chosen = columns.find(c => Number(c.id) === Number(decision.column_id));
      if (!chosen) {
        console.log('Colonna proposta non valida: %s (%s)', decision.column_name, decision.column_id);
        ignored++;
        continue;
      }

      const payload = {
        workspace_id: workspace.id,
        column_id: chosen.id,
        source: 'gmail',
        source_external_id: 'gmail-thread-' + envelope.thread_id,
        source_url: envelope.permalink,
        title: decision.title,
        description: buildCardDescription_(decision, envelope),
        due_date: decision.due_date || null,
        due_time: decision.due_time || null,
        priority: decision.priority || 'normal',
        automation_confidence: decision.confidence,
        assignee_username: cfg.prjUsername || ''
      };

      const result = prjUpsert_(cfg, payload);
      upserted++;
      console.log(
        '%s [%s] %s → %s%s',
        result.created ? 'CREATED' : 'UPDATED',
        decision.confidence,
        decision.title,
        chosen.name,
        decision.due_date ? ' · ' + decision.due_date + (decision.due_time ? ' ' + decision.due_time : '') : ''
      );
    }

    // Aggiorniamo il cursore solo dopo una scansione completata senza eccezioni:
    // in caso di errore, al run successivo i thread vengono rivalutati e l'upsert evita doppioni.
    PropertiesService.getScriptProperties().setProperty(PRJ_GMAIL.CURSOR_KEY, String(now));

    console.log(JSON.stringify({
      ok: true,
      examined,
      classified,
      upserted,
      ignored,
      low_confidence: lowConfidence,
      cursor_from: new Date(cursor).toISOString(),
      cursor_to: new Date(now).toISOString()
    }));
  } finally {
    lock.releaseLock();
  }
}

function testConnections() {
  const cfg = loadConfig_();
  const context = fetchPrjContext_(cfg);
  const workspace = resolveWorkspace_(context, cfg);

  const me = cfg.myEmail;
  const openAiResponse = UrlFetchApp.fetch('https://api.openai.com/v1/models/' + encodeURIComponent(cfg.model), {
    method: 'get',
    headers: { Authorization: 'Bearer ' + cfg.openAiKey },
    muteHttpExceptions: true
  });
  if (openAiResponse.getResponseCode() >= 300) {
    throw new Error('OpenAI non raggiungibile: HTTP ' + openAiResponse.getResponseCode() + ' ' + openAiResponse.getContentText());
  }

  console.log(JSON.stringify({
    ok: true,
    gmail_user: me,
    workspace_id: workspace.id,
    workspace_name: workspace.name,
    columns: (workspace.columns || []).map(c => ({ id: c.id, name: c.name, tags: c.tags || [] })),
    model: cfg.model
  }, null, 2));
}

function installDailyTrigger() {
  deleteBridgeTriggers_();
  ScriptApp.newTrigger('scanGmailToPrj')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();
  console.log('Trigger giornaliero installato. Apps Script può eseguirlo con uno scostamento entro la fascia oraria.');
}

function installHourlyTrigger() {
  deleteBridgeTriggers_();
  ScriptApp.newTrigger('scanGmailToPrj')
    .timeBased()
    .everyHours(1)
    .create();
  console.log('Trigger orario installato.');
}

function removeBridgeTriggers() {
  deleteBridgeTriggers_();
  console.log('Trigger PRJ Gmail rimossi.');
}

function resetScanCursor() {
  PropertiesService.getScriptProperties().deleteProperty(PRJ_GMAIL.CURSOR_KEY);
  console.log('Cursore azzerato: il prossimo run userà il lookback iniziale.');
}

function deleteBridgeTriggers_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'scanGmailToPrj')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function loadConfig_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  const required = ['PRJ_BASE_URL', 'PRJ_AUTOMATION_KEY', 'OPENAI_API_KEY'];
  const missing = required.filter(k => !String(p[k] || '').trim());
  if (missing.length) throw new Error('Proprietà script mancanti: ' + missing.join(', '));

  const workspaceIdRaw = String(p.PRJ_WORKSPACE_ID || '').trim();
  const workspaceId = workspaceIdRaw ? Number(workspaceIdRaw) : null;
  if (workspaceId !== null && (!Number.isInteger(workspaceId) || workspaceId < 1)) throw new Error('PRJ_WORKSPACE_ID non valido.');
  const workspaceName = String(p.PRJ_WORKSPACE_NAME || '').trim();

  const myEmail = String(p.MY_EMAIL || Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!myEmail) throw new Error('Impossibile determinare l’email dell’account. Imposta MY_EMAIL.');

  return {
    prjBaseUrl: String(p.PRJ_BASE_URL).replace(/\/+$/, ''),
    automationKey: String(p.PRJ_AUTOMATION_KEY),
    workspaceId,
    workspaceName,
    openAiKey: String(p.OPENAI_API_KEY),
    model: String(p.OPENAI_MODEL || PRJ_GMAIL.DEFAULT_MODEL).trim(),
    myEmail,
    prjUsername: String(p.PRJ_USERNAME || '').trim(),
    minConfidence: clamp_(Number(p.MIN_CONFIDENCE || PRJ_GMAIL.DEFAULT_MIN_CONFIDENCE), 0, 1),
    lookbackDays: clampInt_(Number(p.LOOKBACK_DAYS || PRJ_GMAIL.DEFAULT_LOOKBACK_DAYS), 1, 30),
    maxThreads: clampInt_(Number(p.MAX_THREADS || PRJ_GMAIL.DEFAULT_MAX_THREADS), 1, 100)
  };
}

function getCursorMs_(now) {
  const raw = PropertiesService.getScriptProperties().getProperty(PRJ_GMAIL.CURSOR_KEY);
  const parsed = Number(raw || 0);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return now - PRJ_GMAIL.INITIAL_LOOKBACK_HOURS * 3600000;
}

function fetchPrjContext_(cfg) {
  let url = cfg.prjBaseUrl + '/api/automation.php?action=context';
  if (cfg.workspaceId) url += '&workspace_id=' + encodeURIComponent(cfg.workspaceId);
  return fetchJson_(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + cfg.automationKey }
  }, 'PRJ context');
}

function resolveWorkspace_(context, cfg) {
  const workspaces = context.workspaces || [];
  if (cfg.workspaceId) {
    const byId = workspaces.find(w => Number(w.id) === Number(cfg.workspaceId));
    if (!byId) throw new Error('Workspace PRJ non trovato: id ' + cfg.workspaceId);
    return byId;
  }
  if (cfg.workspaceName) {
    const target = cfg.workspaceName.toLowerCase();
    const byName = workspaces.find(w => String(w.name || '').trim().toLowerCase() === target);
    if (!byName) throw new Error('Workspace PRJ non trovato: "' + cfg.workspaceName + '". Disponibili: ' + workspaces.map(w => w.name).join(', '));
    return byName;
  }
  if (workspaces.length === 1) return workspaces[0];
  throw new Error('Imposta PRJ_WORKSPACE_ID oppure PRJ_WORKSPACE_NAME. Workspace disponibili: ' + workspaces.map(w => w.id + ' = ' + w.name).join(', '));
}

function flattenColumns_(workspace) {
  return (workspace.columns || []).map(c => ({
    id: Number(c.id),
    name: String(c.name || ''),
    tags: (c.tags || []).map(t => String(t.name || '')).filter(Boolean)
  }));
}

function buildThreadEnvelope_(thread, myEmail, cursorMs) {
  const messages = thread.getMessages();
  const sliced = messages.slice(-PRJ_GMAIL.MAX_MESSAGES_PER_THREAD);
  const rows = [];
  let totalChars = 0;

  for (const msg of sliced) {
    const body = normalizeBody_(msg.getPlainBody());
    const clipped = body.slice(0, PRJ_GMAIL.MAX_BODY_CHARS_PER_MESSAGE);
    const row = {
      id: msg.getId(),
      date: msg.getDate().toISOString(),
      from: msg.getFrom(),
      to: msg.getTo(),
      cc: msg.getCc(),
      subject: msg.getSubject(),
      body: clipped,
      is_from_me: containsEmail_(msg.getFrom(), myEmail),
      is_direct_to_me: containsEmail_(msg.getTo(), myEmail),
      is_cc_to_me: containsEmail_(msg.getCc(), myEmail),
      is_new_since_cursor: msg.getDate().getTime() > cursorMs
    };

    const serializedLength = clipped.length + row.from.length + row.to.length + row.cc.length + row.subject.length + 100;
    if (totalChars + serializedLength > PRJ_GMAIL.MAX_THREAD_CHARS && rows.length) break;
    rows.push(row);
    totalChars += serializedLength;
  }

  return {
    thread_id: thread.getId(),
    subject: thread.getFirstMessageSubject(),
    permalink: thread.getPermalink(),
    last_message_date: thread.getLastMessageDate().toISOString(),
    my_email: myEmail,
    messages: rows
  };
}

function shouldHardIgnore_(envelope) {
  const newest = envelope.messages[envelope.messages.length - 1];
  if (!newest) return true;

  const from = extractEmail_(newest.from);
  if (PRJ_GMAIL.IGNORE_SENDERS.includes(from)) return true;

  const subject = String(newest.subject || envelope.subject || '');
  if (PRJ_GMAIL.IGNORE_SUBJECT_PATTERNS.some(re => re.test(subject))) return true;

  // Se nessun messaggio nuovo riguarda l'utente né come destinatario né come autore,
  // è quasi certamente una comunicazione generale non operativa per lui.
  const newRelevant = envelope.messages.some(m =>
    m.is_new_since_cursor && (m.is_from_me || m.is_direct_to_me || m.is_cc_to_me)
  );
  return !newRelevant;
}

function classifyThread_(cfg, columns, envelope) {
  const columnText = columns.map(c =>
    '- ID ' + c.id + ': "' + c.name + '"' + (c.tags.length ? ' | tag: ' + c.tags.join(', ') : '')
  ).join('\n');

  const system = [
    'Sei un classificatore operativo per una singola casella email di lavoro.',
    'Devi decidere se dal thread emerge UNA attività concreta che il proprietario della casella deve svolgere.',
    '',
    'Regole vincolanti:',
    '1. Non creare task per semplici comunicazioni informative, newsletter, FYI, notifiche automatiche o messaggi rivolti genericamente a molti destinatari.',
    '2. Se il proprietario è solo in CC, crea un task soltanto se il testo gli assegna esplicitamente un’azione oppure se lui stesso prende un impegno nel thread.',
    '3. Gli impegni scritti dal proprietario ("domani preparo...", "verifico...", "ti mando...") valgono come task.',
    '4. Non duplicare workflow di ticket/Jira/helpdesk: una mera notifica di quei sistemi non è un task PRJ.',
    '5. Scegli ESCLUSIVAMENTE una delle colonne PRJ fornite. Non inventare colonne. Se nessuna colonna è realmente pertinente, task=false.',
    '6. Le colonne rappresentano applicativi o macro-aree, NON stati come Da fare/In corso/Attesa.',
    '7. Estrai una scadenza solo se è esplicita o implicita con alta affidabilità. L’ora è opzionale: non inventarla.',
    '8. Interpreta date relative usando Europe/Rome e la data/ora dei messaggi.',
    '9. Se un thread è già sostanzialmente risolto e non resta alcuna azione del proprietario, task=false.',
    '10. Il titolo deve essere operativo, breve e comprensibile fuori dal thread.',
    '11. Descrizione/summary: massimo 500 caratteri, niente firme, disclaimer o citazioni lunghe.',
    '12. confidence misura la sicurezza complessiva che il task debba davvero entrare in PRJ e nella colonna scelta.',
    '',
    'Colonne PRJ disponibili:',
    columnText
  ].join('\n');

  const userPayload = JSON.stringify({
    now_europe_rome: Utilities.formatDate(new Date(), 'Europe/Rome', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    mailbox_owner: cfg.myEmail,
    thread: envelope
  });

  const schema = {
    type: 'object',
    properties: {
      task: { type: 'boolean' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      column_id: { type: 'integer' },
      column_name: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      due_date: { type: 'string' },
      due_time: { type: 'string' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      reason: { type: 'string' }
    },
    required: [
      'task', 'confidence', 'column_id', 'column_name', 'title', 'summary',
      'due_date', 'due_time', 'priority', 'reason'
    ],
    additionalProperties: false
  };

  const request = {
    model: cfg.model,
    store: false,
    reasoning: { effort: 'low' },
    input: [
      { role: 'system', content: system },
      { role: 'user', content: userPayload }
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'prj_email_task',
        strict: true,
        schema
      }
    },
    max_output_tokens: 700
  };

  const response = fetchJson_('https://api.openai.com/v1/responses', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.openAiKey },
    payload: JSON.stringify(request)
  }, 'OpenAI');

  const outputText = extractOpenAiOutputText_(response);
  const decision = JSON.parse(outputText);

  decision.confidence = clamp_(Number(decision.confidence || 0), 0, 1);
  decision.column_id = Number(decision.column_id || 0);
  decision.due_date = normalizeDate_(decision.due_date);
  decision.due_time = normalizeTime_(decision.due_time);
  if (!decision.due_date) decision.due_time = '';
  decision.title = String(decision.title || '').trim().slice(0, 180);
  decision.summary = String(decision.summary || '').trim().slice(0, 500);
  decision.reason = String(decision.reason || '').trim().slice(0, 500);

  if (!decision.task) {
    decision.column_id = 0;
    decision.column_name = '';
    decision.title = '';
    decision.summary = '';
    decision.due_date = '';
    decision.due_time = '';
  }

  return decision;
}

function extractOpenAiOutputText_(response) {
  if (typeof response.output_text === 'string' && response.output_text.trim()) return response.output_text.trim();
  const output = response.output || [];
  for (const item of output) {
    if (item.type !== 'message') continue;
    for (const content of (item.content || [])) {
      if (content.type === 'output_text' && content.text) return String(content.text).trim();
    }
  }
  throw new Error('OpenAI non ha restituito output strutturato.');
}

function buildCardDescription_(decision, envelope) {
  const newest = envelope.messages[envelope.messages.length - 1] || {};
  const sender = extractEmail_(newest.from) || newest.from || '';
  const parts = [];
  if (decision.summary) parts.push(decision.summary);
  if (sender) parts.push('Ultimo mittente: ' + sender);
  if (envelope.subject) parts.push('Thread: ' + envelope.subject);
  return parts.join('\n\n').slice(0, 1800);
}

function prjUpsert_(cfg, payload) {
  const url = cfg.prjBaseUrl + '/api/automation.php?action=upsert';
  return fetchJson_(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + cfg.automationKey },
    payload: JSON.stringify(payload)
  }, 'PRJ upsert');
}

function fetchJson_(url, options, label) {
  const opts = Object.assign({ muteHttpExceptions: true }, options || {});
  const response = UrlFetchApp.fetch(url, opts);
  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error(label + ' HTTP ' + code + ': ' + text.slice(0, 1200));
  }
  try {
    const data = JSON.parse(text);
    if (data && data.ok === false) throw new Error(label + ': ' + (data.error || 'errore'));
    return data;
  } catch (e) {
    if (e && String(e.message || '').startsWith(label + ':')) throw e;
    throw new Error(label + ' ha restituito JSON non valido: ' + text.slice(0, 500));
  }
}

function containsEmail_(field, email) {
  return String(field || '').toLowerCase().includes(String(email || '').toLowerCase());
}

function extractEmail_(value) {
  const s = String(value || '').toLowerCase();
  const bracket = s.match(/<([^>]+@[^>]+)>/);
  if (bracket) return bracket[1].trim();
  const plain = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return plain ? plain[0].trim() : '';
}

function normalizeBody_(body) {
  return String(body || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeDate_(value) {
  const s = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function normalizeTime_(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(?:[01]\d|2[0-3]):[0-5]\d/);
  return m ? m[0] : '';
}

function clamp_(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function clampInt_(n, min, max) {
  return Math.round(clamp_(n, min, max));
}
