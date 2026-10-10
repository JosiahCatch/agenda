// Piccolo server locale per l'Agenda del servizio.
// - serve l'app su http://localhost:8765
// - salva i dati in dati.json (con una copia di sicurezza al giorno in backup/)
// - scarica il foglio Google delle prediche (il browser da solo non può farlo)
// Avvio: node server.js  (oppure doppio clic su "Avvia agenda.bat")

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = +process.env.AGENDA_PORT || 8765;
const URL_APP = `http://localhost:${PORT}`;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'dati.json');
const BACKUP_DIR = path.join(ROOT, 'backup');
const KEEP_BACKUPS = 30;
const STATIC = new Set(['/index.html', '/app.js', '/styles.css', '/seed.js', '/qrcode.js']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function dailyBackup() {
  if (!fs.existsSync(DATA)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const target = path.join(BACKUP_DIR, `dati-${day}.json`);
  if (fs.existsSync(target)) return;
  fs.copyFileSync(DATA, target);
  const old = fs.readdirSync(BACKUP_DIR).filter(f => /^dati-.*\.json$/.test(f)).sort();
  old.slice(0, Math.max(0, old.length - KEEP_BACKUPS)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, URL_APP);
  try {
    if (url.pathname === '/api/data') {
      if (req.method === 'GET') {
        if (!fs.existsSync(DATA)) { res.writeHead(204); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(fs.readFileSync(DATA));
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req);
        JSON.parse(body); // rifiuta dati non validi
        dailyBackup();
        fs.writeFileSync(DATA + '.tmp', body);
        fs.renameSync(DATA + '.tmp', DATA);
        res.writeHead(204); return res.end();
      }
    }

    if (url.pathname === '/api/sheet') {
      const id = url.searchParams.get('id') || '';
      const gid = url.searchParams.get('gid') || '0';
      if (!/^[\w-]+$/.test(id) || !/^\d+$/.test(gid)) { res.writeHead(400); return res.end('Parametri non validi'); }
      const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`);
      if (!r.ok) { res.writeHead(502); return res.end(`Google ha risposto ${r.status}`); }
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
      return res.end(await r.text());
    }

    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    if (req.method === 'GET' && STATIC.has(file)) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(ROOT, file)));
    }
    res.writeHead(404); res.end('Non trovato');
  } catch (e) {
    console.error(e);
    res.writeHead(500); res.end(String(e.message));
  }
});

const openBrowser = () => exec(`start "" ${URL_APP}`);

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log('L\'agenda è già in esecuzione: apro il browser.');
    openBrowser();
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agenda del servizio attiva su ${URL_APP}`);
  console.log('Lascia aperta questa finestra (puoi ridurla a icona). Chiudila per spegnere l\'agenda.');
  if (!process.env.AGENDA_NO_BROWSER) openBrowser();
});
