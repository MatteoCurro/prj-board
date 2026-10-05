# PRJ Board

Mini project board self-hosted, pensata come alternativa essenziale a Trello/Kan e ottimizzata per il deploy su Gandi.

## V1

- board singola rinominabile
- colonne creabili, rinominabili, eliminabili e riordinabili
- card con titolo, descrizione, etichetta e scadenza
- drag & drop tra colonne con SortableJS
- ricerca client-side
- archivio card
- persistenza MySQL
- login monoutente con sessione PHP
- responsive desktop/mobile
- tema scuro
- font Unlock Venice: **Bricolage Grotesque** + **Inter**
- accento principale Unlock Venice: `#B6174B`
- deploy automatico GitHub Actions → Gandi SFTP

## Stack

La V1 evita framework e build step intenzionalmente:

- HTML/CSS/JavaScript
- SortableJS via CDN per drag & drop
- Lucide via CDN per le icone
- PHP 8 + PDO
- MySQL / MariaDB

Questo mantiene il progetto piccolo, facile da correggere e adatto a hosting condiviso.

## Produzione

URL:

`https://prj.curromatteo.it/`

Document root:

`/lamp0/web/vhosts/prj.curromatteo.it/htdocs`

Database:

`prj_cur`

La configurazione runtime viene generata dalla GitHub Action e caricata fuori dalla document root:

`/lamp0/web/vhosts/prj.curromatteo.it/private/config.php`

Le credenziali non sono quindi presenti nella repository pubblica.

## Secrets GitHub richiesti

In **Settings → Secrets and variables → Actions → Repository secrets**:

| Secret | Valore |
| --- | --- |
| `GANDI_SFTP_HOST` | stesso host già usato per gli altri deploy Gandi |
| `GANDI_SFTP_USER` | utente SFTP Gandi |
| `GANDI_SFTP_PRIVATE_KEY` | chiave privata deploy |
| `DB_HOST` | host MySQL fornito da Gandi |
| `DB_USER` | utente del DB `prj_cur` |
| `DB_PASSWORD` | password del DB |
| `APP_PASSWORD` | password scelta per accedere a PRJ |

Il nome database `prj_cur` e il path di produzione sono già fissati nel workflow.

Se i secrets non sono ancora presenti, il workflow termina correttamente senza fare deploy. Appena sono configurati, basta rieseguire **Deploy PRJ Board** oppure fare un nuovo push su `main`.

## Database

Non è necessario importare manualmente `database/schema.sql`.

Al primo accesso autenticato l'API:

1. crea le tabelle mancanti;
2. crea la board **Progetti**;
3. crea le colonne iniziali **Da fare**, **In corso**, **In attesa**, **Fatto**.

`database/schema.sql` resta nella repository solo come riferimento.

## Struttura

```text
/
├── index.html
├── assets/
│   └── app.css
├── js/
│   └── app.js
├── api/
│   └── index.php
├── database/
│   └── schema.sql
└── .github/workflows/
    └── deploy.yml
```

## Principio di sviluppo

**Reuse first**: prima librerie piccole e consolidate, poi codice custom solo dove porta valore. La V1 evita intenzionalmente account multipli, realtime WebSocket, allegati, notifiche e automazioni: sono estensioni successive e non sono necessarie al core della board.
