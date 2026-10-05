# PRJ Gmail Bridge (Google Apps Script)

Bridge autonomo tra Gmail di lavoro e PRJ. Viene eseguito con l'account Google Workspace del proprietario della casella, legge solo thread recenti e usa OpenAI per classificare le attività.

## Comportamento

- non crea card da notifiche Ticket Unive / Jira Cineca;
- valuta **To / CC / autore** e non considera automaticamente operative le comunicazioni generali;
- riconosce anche gli impegni presi dal proprietario nelle proprie risposte;
- legge da PRJ le colonne e i tag reali a ogni run: non crea categorie hardcoded;
- crea/aggiorna una sola card per thread Gmail tramite `source_external_id`;
- usa data e ora solo quando ricavabili con sufficiente affidabilità;
- non crea card sotto `MIN_CONFIDENCE` (default 0.90);
- conserva solo un cursore temporale nelle Script Properties; non copia l'intera mailbox in PRJ.

## Setup una tantum

Crea uno script standalone in Apps Script con l'account Gmail di lavoro, copia `Code.gs` e `appsscript.json`, quindi configura **Project Settings → Script properties**:

| Proprietà | Valore |
|---|---|
| `PRJ_BASE_URL` | `https://prj.curromatteo.it` |
| `PRJ_AUTOMATION_KEY` | stessa chiave configurata nel secret GitHub `AUTOMATION_KEY` |
| `PRJ_WORKSPACE_ID` | id del workspace di lavoro |
| `OPENAI_API_KEY` | API key OpenAI |
| `PRJ_USERNAME` | username PRJ a cui assegnare le card (opzionale) |
| `OPENAI_MODEL` | default `gpt-6-luna` |
| `MY_EMAIL` | opzionale; default account che esegue lo script |
| `MIN_CONFIDENCE` | opzionale, default `0.90` |
| `LOOKBACK_DAYS` | opzionale, default `3` |
| `MAX_THREADS` | opzionale, default `40` |

Poi:

1. esegui `testConnections()` e autorizza Gmail/URL Fetch;
2. esegui una volta `scanGmailToPrj()` manualmente;
3. controlla PRJ con lo switch **Automazioni** acceso;
4. quando il campione è corretto, esegui `installDailyTrigger()` oppure `installHourlyTrigger()`.

## Sicurezza

Le chiavi non vanno inserite nel codice né nel repository. `PRJ_AUTOMATION_KEY` e `OPENAI_API_KEY` restano nelle Script Properties. L'endpoint PRJ rifiuta le richieste quando `AUTOMATION_KEY` non è configurata lato server.

## Note

Gli installable trigger Apps Script vengono eseguiti sotto l'account che li crea. Il trigger giornaliero può cadere in un punto variabile della fascia oraria scelta; se serve un polling più tempestivo usa il trigger orario.
