# PRJ Board — Roadmap post v1.0

Baseline stabile: branch `stable-v1.0`.

## 1. Mobile polish — priorità alta, intervento leggero
- Header più compatto e azioni principali non sovrapposte.
- Colonne quasi full-width su telefono, snap orizzontale morbido.
- Touch target minimi 40–44 px.
- Modali card a quasi tutta altezza, footer Salva/Fatto sticky.
- Drag card solo da una piccola handle su touch, evitando click accidentali.
- Riduzione della densità visiva di tag, assegnatari e meta sulle card.

Obiettivo: buona usabilità mobile senza trasformare PRJ in un'app mobile separata.

## 2. Profilo utente
Campi proposti:
- `display_name` — nome visualizzato; fallback a `@username`.
- `notification_email` — indirizzo usato solo per recap/notifiche.
- `digest_frequency` — off / daily / weekly.
- `digest_due_days` — finestra di anticipo, default 3 giorni.
- opzionale in seguito: avatar/iniziali.

Le pill assegnatario mostrano `display_name`, con username disponibile in tooltip/dettaglio.

## 3. Recap email scadenze
Architettura consigliata:
- un solo job PHP Gandi eseguito ogni giorno via anacron;
- il job seleziona gli utenti con recap attivo;
- daily: task assegnati scaduti o in scadenza nella finestra configurata;
- weekly: invio se sono trascorsi >=7 giorni dall'ultimo digest;
- niente email se non esistono task pertinenti;
- log invii/errori nel DB;
- endpoint/admin action "Invia email di test".

SMTP:
- prima scelta: SMTP locale Gandi `localhost:25`, senza autenticazione, per basso volume;
- mittente reale sul dominio (es. `prj@curromatteo.it` o `noreply@curromatteo.it`);
- SPF del dominio deve includere `_spf.gpaas.net` se si invia dal Web Hosting;
- se la deliverability non è soddisfacente, seconda scelta: Gandi Mail autenticato su `mail.gandi.net:465`;
- per volumi futuri più alti: SMTP transazionale esterno.

Prima di attivare i digest: test reale verso almeno Gmail + altro provider e verifica header/SPF/DKIM.

## 4. Calendario workspace / Google Calendar

### Fase A consigliata — calendario ICS dedicato
Generare per ogni workspace un feed calendario separato contenente solo card:
- non completate;
- con due date;
- opzionalmente filtrate per utente assegnato.

Ogni evento usa UID stabile derivato da workspace/card, quindi modifica/rimozione nel board si riflette nel feed senza creare duplicati.

Vantaggi:
- nessun OAuth;
- nessuna modifica ai calendari personali esistenti;
- il calendario PRJ resta separato e disattivabile/rimovibile in blocco;
- compatibile anche con Apple Calendar / Outlook.

Limite: Google Calendar aggiorna i calendari da URL secondo una propria frequenza e non garantisce refresh immediato. È quindi adatto come calendario di scadenze, non per sincronizzazione real-time.

Sicurezza:
- URL feed con token lungo revocabile, non ID sequenziale;
- rigenerazione token da impostazioni;
- feed personale = solo card assegnate a quell'utente;
- feed workspace = tutte le scadenze visibili nel workspace.

### Fase B opzionale — Google Calendar API
Se serve sincronizzazione quasi immediata:
- OAuth Google per singolo utente;
- scope ristretto `calendar.app.created`;
- PRJ crea un calendario secondario dedicato, ad esempio "PRJ · Nome workspace";
- salva `calendar_id` e `event_id` per ogni card sincronizzata;
- create/update/delete solo dentro quel calendario;
- mai scrivere o cancellare eventi del calendario principale dell'utente.

Google consente di creare calendari secondari e gestire gli eventi dei calendari creati dall'app tramite lo scope `calendar.app.created`.

## 5. Migliorie semplici consigliate
Ordine suggerito:

1. **Filtri rapidi**: "Mie", "In scadenza", "Senza assegnatario", "Senza scadenza".
2. **Priorità card**: bassa / normale / alta / urgente, indipendente dai tag di colonna.
3. **Checklist interna**: piccola lista di sotto-task dentro una card.
4. **Duplicazione card**: utile per attività ricorrenti.
5. **Cronologia essenziale**: creato da, ultimo aggiornamento, completato da/data.
6. **Ricerca estesa**: includere assegnatari, tag e allegati.
7. **Link diretto alla card**: URL copiabile per condividere una card con utenti del workspace.
8. **Vista "Le mie attività" cross-workspace**: tutte le card assegnate all'utente, ordinate per scadenza.
9. **Export/import**: JSON/CSV per backup portabile oltre al DB.
10. **Notifiche in-app**: badge per task nuovi/riassegnati o prossimi alla scadenza.

## Sequenza proposta
- ✅ v1.1: profilo utente + mobile polish + filtri "Mie/In scadenza".
- ✅ v1.2: recap email + test SMTP + anacron.
- v1.3: feed ICS personale/workspace.
- v1.4: checklist + priorità + vista Le mie attività.
- v2 opzionale: Google OAuth/API per sincronizzazione Calendar real-time.
