# Agenda del servizio

Agenda personale per prediche, presidenze, studi dei giovanissimi, chiesa in casa e studio personale.
Ogni impegno diventa una tabella di marcia a piccoli passi, distribuiti nei blocchi della giornata
(☀️ mattina 7–9, 🌙 sera 19–20). La pagina iniziale mostra i prossimi 7 giorni e, in base all'ora, una sola cosa da fare adesso.

## Due modi di usarla

**Sito (GitHub Pages)**: https://josiahcatch.github.io/agenda/
I dati restano nel browser che usi. Il foglio delle prediche si collega da *Impostazioni*.
Per spostare i dati da un dispositivo all'altro: *Impostazioni → Scarica backup / Ripristina da backup*.

**Sul PC, con salvataggio su file**: doppio clic su `Avvia agenda.bat` (serve [Node.js](https://nodejs.org)).
I dati vengono salvati in `dati.json`, con una copia automatica al giorno nella cartella `backup/`.

## File

- `index.html`, `app.js`, `styles.css`: l'app, senza dipendenze
- `server.js`: piccolo server locale (salvataggio su file e lettura del foglio Google)
- `seed.js` (non pubblicato): dati iniziali privati, caricati una sola volta al primo avvio
