# PRJ Board

Mini project board self-hosted, ispirata a Trello/Kan e ottimizzata per Gandi.

## Versione 0.2

- più workspace, ciascuno con nome e logo opzionale
- fallback automatico all'iniziale quando il logo non è presente
- registrazione utenti con username/password
- primo admin creato inserendo anche `APP_PASSWORD` durante la registrazione
- registrazioni successive in stato **pending** fino all'approvazione dell'admin
- verifica antispam leggera: honeypot + challenge numerica + controllo tempo
- admin globale con pannello richieste utenti
- possibilità di nominare altri admin globali
- membri per workspace con ruoli:
  - `viewer`: sola lettura
  - `editor`: gestisce colonne e card
  - `admin`: gestisce workspace, contenuti e membri
- ricerca utenti attivi e associazione ai workspace
- colonne con colore personalizzato
- card riordinabili nella stessa colonna e tra colonne via SortableJS
- card con titolo, descrizione, etichetta e scadenza
- archivio card
- ricerca client-side
- persistenza MySQL
- sessioni PHP
- UI responsive dark mode
- font **Bricolage Grotesque** + **Inter**
- accento principale `#B6174B`
- deploy automatico GitHub Actions → Gandi SFTP

## Bootstrap primo admin

Quando non esiste ancora nessun amministratore:

1. apri `https://prj.curromatteo.it/`
2. scegli **Registrati**
3. inserisci username e password personali
4. nel campo **Password amministratore iniziale** inserisci il valore configurato nel secret `APP_PASSWORD`
5. l'account viene creato immediatamente come admin globale

Dopo la creazione del primo admin, `APP_PASSWORD` non è una password di login utente: serve solo al bootstrap iniziale.

Gli utenti successivi possono registrarsi normalmente e compariranno nel pannello **Utenti e accessi** come richieste da approvare.

## Produzione

- URL: `https://prj.curromatteo.it/`
- document root: `/lamp0/web/vhosts/prj.curromatteo.it/htdocs`
- database: `prj_cur`
- config privata: `/lamp0/web/vhosts/prj.curromatteo.it/private/config.php`

## Secrets GitHub

- `GANDI_SFTP_HOST`
- `GANDI_SFTP_USER`
- `GANDI_SFTP_PRIVATE_KEY`
- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `APP_PASSWORD`

## Database e migrazioni

L'API crea e aggiorna automaticamente lo schema. Non serve importare SQL a mano.

La migrazione 0.1 → 0.2 è additiva: workspace, colonne e card esistenti vengono preservati.

Tabelle principali:

- `boards` — workspace
- `board_columns`
- `cards`
- `users`
- `workspace_members`

## Stack

- HTML/CSS/JavaScript
- SortableJS
- Lucide
- PHP 8 + PDO
- MySQL / MariaDB

**Reuse first**: librerie piccole e consolidate dove utili, codice custom soltanto per dominio applicativo e permessi.
