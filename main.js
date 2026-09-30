const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const url = require('url');

// Carregar .env de múltiplos locais possíveis (dev + packaged)
const possibleEnvPaths = [
  path.join(__dirname, '.env'),
  path.join(process.env.APPDATA || '', 'GameVault', '.env'),
  path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming', 'GameVault', '.env'),
];

for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    require('dotenv').config({ path: envPath });
    console.log('[GameVault] .env carregado de:', envPath);
    break;
  }
}

app.setPath('userData', path.join(process.env.APPDATA || (process.platform === 'win32' ? process.env.USERPROFILE + '\\AppData\\Roaming' : process.env.HOME + '/.config'), 'GameVault'));

// Configurações de timeout para APIs externas
const API_TIMEOUT = 10000; // 10 segundos
const THEGAMESDB_BASE = 'https://api.thegamesdb.net/v1.1'; // v1.1 mais recente
const IGDB_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const IGDB_API_BASE = 'https://api.igdb.com/v4';
const RAWG_API_BASE = 'https://api.rawg.io/api';

let localServer = null;
let currentApiPort = 34127;

function startLocalApiServer() {
  if (localServer) return;

  localServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    try {
      let result = null;

      if (pathname === '/api/thegamesdb/search' && req.method === 'GET') {
        const query = parsedUrl.query.q;
        if (!query) throw new Error('Parâmetro "q" obrigatório');

        const apiKey = process.env.THEGAMESDB_API_KEY;
        if (!apiKey) throw new Error('THEGAMESDB_API_KEY não configurada no .env');

        // TheGamesDB v1.1 endpoint
        const searchUrl = `${THEGAMESDB_BASE}/Games/ByGameName?name=${encodeURIComponent(query)}&apikey=${apiKey}&fields=overview`;
        const searchRes = await httpsRequestWithTimeout(searchUrl);
        if (!searchRes.ok) throw new Error(`TheGamesDB search falhou: ${searchRes.status} - ${searchRes.data?.message || 'Erro desconhecido'}`);

        if (!searchRes.data?.data?.games?.length) {
          result = [];
        } else {
          const gamesData = searchRes.data.data.games.slice(0, 15);
          const gameIds = gamesData.map(g => g.id).join(',');

          const imgUrl = `${THEGAMESDB_BASE}/Games/Images?games_id=${gameIds}&filter[type]=boxart&apikey=${apiKey}`;
          let imagesMap = {};
          let baseUrl = 'https://cdn.thegamesdb.net/images/original/';

          try {
            const imgRes = await httpsRequestWithTimeout(imgUrl);
            if (imgRes.ok && imgRes.data?.data?.images) {
              if (imgRes.data.data.base_url?.original) baseUrl = imgRes.data.data.base_url.original;
              Object.keys(imgRes.data.data.images).forEach(gId => {
                const imgs = imgRes.data.data.images[gId];
                const frontCovers = imgs.filter(i => i.side === 'front');
                imagesMap[gId] = (frontCovers.length > 0 ? frontCovers : imgs).map(i => baseUrl + i.filename);
              });
            }
          } catch (e) { console.warn('Erro capas TheGamesDB:', e); }

          result = gamesData.map(game => ({
            title: game.game_title,
            covers: imagesMap[game.id] || [],
            synopsis: game.overview || 'Sem sinopse disponível.'
          }));
        }
      }
      else if (pathname === '/api/igdb/search' && req.method === 'GET') {
              const query = parsedUrl.query.q;
              if (!query) throw new Error('Parâmetro "q" obrigatório');

              const clientId = process.env.IGDB_CLIENT_ID;
              const clientSecret = process.env.IGDB_CLIENT_SECRET;
              if (!clientId || !clientSecret) throw new Error('IGDB credentials não configuradas no .env');

              const tokenUrl = `${IGDB_TOKEN_URL}?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
              const tokenRes = await httpsRequestWithTimeout(tokenUrl, { method: 'POST' });
              if (!tokenRes.ok) throw new Error(`Erro token Twitch: ${tokenRes.status} - ${tokenRes.data?.message || 'Credenciais inválidas'}`);

              const accessToken = tokenRes.data.access_token;

              const targetUrl = `${IGDB_API_BASE}/games`;
              const safeQuery = query.replace(/"/g, '');
              const queryBody = `search "${safeQuery}"; fields name, cover.image_id, screenshots.image_id, summary; limit 15;`;

              const igdbRes = await httpsRequestWithTimeout(targetUrl, {
                method: 'POST',
                headers: {
                  'Accept': 'application/json',
                  'Client-ID': clientId,
                  'Authorization': `Bearer ${accessToken}`,
                  'Content-Type': 'text/plain'
                },
                body: queryBody
              });

              if (!igdbRes.ok) throw new Error(`Erro IGDB: ${igdbRes.status} - ${JSON.stringify(igdbRes.data)}`);

              result = igdbRes.data.map(game => {
                const covers = [];
                if (game.cover?.image_id) covers.push(`https://images.igdb.com/igdb/image/upload/t_1080p/${game.cover.image_id}.jpg`);
                if (game.screenshots?.length) {
                  game.screenshots.forEach(sc => covers.push(`https://images.igdb.com/igdb/image/upload/t_1080p/${sc.image_id}.jpg`));
                }
                return { title: game.name, covers, synopsis: game.summary || 'Sem sinopse disponível.' };
              });
            }
      else if (pathname === '/api/rawg/search' && req.method === 'GET') {
        const query = parsedUrl.query.q;
        if (!query) throw new Error('Parâmetro "q" obrigatório');

        const apiKey = process.env.RAWG_API_KEY;
        if (!apiKey) throw new Error('RAWG_API_KEY não configurada no .env');

        const searchUrl = `${RAWG_API_BASE}/games?search=${encodeURIComponent(query)}&key=${apiKey}&page_size=15`;
        const searchRes = await httpsRequestWithTimeout(searchUrl);
        if (!searchRes.ok) throw new Error(`RAWG search falhou: ${searchRes.status}`);

        if (!searchRes.data?.results?.length) {
          result = [];
        } else {
          result = searchRes.data.results.map(game => ({
            title: game.name,
            covers: game.background_image ? [game.background_image] : [],
            synopsis: game.description_raw || 'Sem sinopse disponível.',
            platforms: game.platforms?.map(p => p.platform.name).join(', ') || '',
            released: game.released || '',
            rating: game.rating || 0
          }));
        }
      }
      else if (pathname === '/api/translate' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          // Usa IIFE async para capturar erros corretamente
          (async () => {
            try {
              const { text } = JSON.parse(body);
              if (!text) throw new Error('Parâmetro "text" obrigatório');

              const translateUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=${encodeURIComponent(text)}`;
                  const translateRes = await httpsRequest(translateUrl);
                  console.log('[DEBUG] Translate response:', { ok: translateRes.ok, status: translateRes.status, hasData: !!translateRes.data });
                  // SEMPRE retorna sucesso, nunca lança erro
                  if (!translateRes.ok) {
                    const statusCode = translateRes.status || translateRes.statusCode;
                    console.log('[DEBUG] translateRes status check:', { statusCode, is429: statusCode === 429 || statusCode === '429' });
                    // Qualquer erro HTTP -> retorna original
                    console.warn('Erro tradução HTTP', statusCode, '- retornando texto original');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ translated: text }));
                    return;
                  }

              let translated = text;
              if (translateRes.data && translateRes.data[0]) {
                translated = translateRes.data[0].map(item => item[0]).join('');
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ translated }));
            } catch (err) {
              console.error('Erro tradução catch:', err);
              // Em caso de erro, retorna texto original
              try {
                const { text } = JSON.parse(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ translated: text || '' }));
              } catch {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ translated: '' }));
              }
            }
          })().catch(err => {
            console.error('Erro não tratado no handler translate:', err);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Erro interno' }));
          });
        });
        return;
      }
      else if (pathname === '/api/health' && req.method === 'GET') {
        result = { 
          status: 'ok', 
          service: 'GameVault Desktop API', 
          timestamp: Date.now(), 
          port: currentApiPort,
          apiKeys: {
            thegamesdb: !!process.env.THEGAMESDB_API_KEY,
            igdb: !!(process.env.IGDB_CLIENT_ID && process.env.IGDB_CLIENT_SECRET),
            rawg: !!process.env.RAWG_API_KEY
          }
        };
      }
      else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint não encontrado' }));
        return;
      }

      if (result !== null) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }

    } catch (err) {
      console.error('Erro API local:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  localServer.listen(currentApiPort, '127.0.0.1', () => {
    console.log(`[GameVault] API local rodando em http://127.0.0.1:${currentApiPort}`);
    global.GAMEVAULT_API_PORT = currentApiPort;
  });

  localServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      currentApiPort++;
      console.warn(`[GameVault] Porta ${currentApiPort - 1} em uso, tentando ${currentApiPort}...`);
      setTimeout(() => {
        localServer.close();
        localServer = null;
        startLocalApiServer();
      }, 100);
    } else {
      console.error('[GameVault] Erro no servidor local:', err);
    }
  });
}

function stopLocalApiServer() {
  if (localServer) {
    localServer.close();
    localServer = null;
    console.log('[GameVault] API local parada');
  }
}

function httpsRequestWithTimeout(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: API_TIMEOUT
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
        } catch (e) {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout de ${API_TIMEOUT}ms excedido para ${url}`));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// Manter compatibilidade
function httpsRequest(url, options = {}) {
  return httpsRequestWithTimeout(url, options);
}

ipcMain.handle('api:thegamesdb:search', async (event, query) => {
  const apiKey = process.env.THEGAMESDB_API_KEY;
  if (!apiKey) throw new Error('THEGAMESDB_API_KEY não configurada no .env');

  const searchUrl = `${THEGAMESDB_BASE}/Games/ByGameName?name=${encodeURIComponent(query)}&apikey=${apiKey}&fields=overview`;
  const res = await httpsRequestWithTimeout(searchUrl);
  if (!res.ok) throw new Error(`TheGamesDB search falhou: ${res.status} - ${res.data?.message || 'Erro desconhecido'}`);

  if (!res.data?.data?.games?.length) return [];

  const gamesData = res.data.data.games.slice(0, 15);
  const gameIds = gamesData.map(g => g.id).join(',');

  const imgUrl = `${THEGAMESDB_BASE}/Games/Images?games_id=${gameIds}&filter[type]=boxart&apikey=${apiKey}`;
  let imagesMap = {};
  let baseUrl = 'https://cdn.thegamesdb.net/images/original/';

  try {
    const imgRes = await httpsRequestWithTimeout(imgUrl);
    if (imgRes.ok && imgRes.data?.data?.images) {
      if (imgRes.data.data.base_url?.original) baseUrl = imgRes.data.data.base_url.original;
      Object.keys(imgRes.data.data.images).forEach(gId => {
        const imgs = imgRes.data.data.images[gId];
        const frontCovers = imgs.filter(i => i.side === 'front');
        imagesMap[gId] = (frontCovers.length > 0 ? frontCovers : imgs).map(i => baseUrl + i.filename);
      });
    }
  } catch (e) { console.warn('Erro capas TheGamesDB:', e); }

  return gamesData.map(game => ({
    title: game.game_title,
    covers: imagesMap[game.id] || [],
    synopsis: game.overview || 'Sem sinopse disponível.'
  }));
});

ipcMain.handle('api:igdb:search', async (event, query) => {
  const clientId = process.env.IGDB_CLIENT_ID;
  const clientSecret = process.env.IGDB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('IGDB credentials não configuradas no .env');

  const tokenUrl = `${IGDB_TOKEN_URL}?client_id=${clientId}&client_secret=${clientSecret}&grant_type=client_credentials`;
  const tokenRes = await httpsRequestWithTimeout(tokenUrl, { method: 'POST' });
  if (!tokenRes.ok) throw new Error(`Erro token Twitch: ${tokenRes.status} - ${tokenRes.data?.message || 'Credenciais inválidas'}`);

  const accessToken = tokenRes.data.access_token;

  const targetUrl = `${IGDB_API_BASE}/games`;
  const safeQuery = query.replace(/"/g, '');
  const queryBody = `search "${safeQuery}"; fields name, cover.image_id, screenshots.image_id, summary; limit 15;`;

  const igdbRes = await httpsRequestWithTimeout(targetUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Client-ID': clientId,
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'text/plain'
    },
    body: queryBody
  });

  if (!igdbRes.ok) throw new Error(`Erro IGDB: ${igdbRes.status} - ${JSON.stringify(igdbRes.data)}`);

  return igdbRes.data.map(game => {
    const covers = [];
    if (game.cover?.image_id) covers.push(`https://images.igdb.com/igdb/image/upload/t_1080p/${game.cover.image_id}.jpg`);
    if (game.screenshots?.length) {
      game.screenshots.forEach(sc => covers.push(`https://images.igdb.com/igdb/image/upload/t_1080p/${sc.image_id}.jpg`));
    }
    return { title: game.name, covers, synopsis: game.summary || 'Sem sinopse disponível.' };
  });
});

ipcMain.handle('api:rawg:search', async (event, query) => {
  const apiKey = process.env.RAWG_API_KEY;
  if (!apiKey) throw new Error('RAWG_API_KEY não configurada no .env');

  const searchUrl = `${RAWG_API_BASE}/games?search=${encodeURIComponent(query)}&key=${apiKey}&page_size=15`;
  const res = await httpsRequestWithTimeout(searchUrl);
  if (!res.ok) throw new Error(`RAWG search falhou: ${res.status}`);

  if (!res.data?.results?.length) return [];

  return res.data.results.map(game => ({
    title: game.name,
    covers: game.background_image ? [game.background_image] : [],
    synopsis: game.description_raw || 'Sem sinopse disponível.',
    platforms: game.platforms?.map(p => p.platform.name).join(', ') || '',
    released: game.released || '',
    rating: game.rating || 0
  }));
});

ipcMain.handle('api:translate', async (event, text) => {
  try {
    const translateUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=pt&dt=t&q=${encodeURIComponent(text)}`;
    const res = await httpsRequestWithTimeout(translateUrl);
    if (!res.ok) {
      // Se rate limit (429), retorna o texto original
      const statusCode = res.status || res.statusCode;
      if (statusCode === 429 || statusCode === '429') {
        console.warn('Google Translate rate limit (429) no IPC, retornando texto original');
        return text;
      }
      // Para qualquer outro erro, também retorna original sem travar
      console.warn('Erro tradução HTTP', statusCode, 'no IPC - retornando texto original');
      return text;
    }
    if (res.data && res.data[0]) {
      return res.data[0].map(item => item[0]).join('');
    }
    return text;
  } catch (err) {
    console.error('Erro tradução IPC:', err);
    return text; // Retorna texto original em caso de erro
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.loadFile('index.html');

  const menuTemplate = [
    {
      label: 'Arquivo',
      submenu: [
        { 
          label: 'Importar Backup TXT...', 
          accelerator: 'CmdOrCtrl+I',
          click: () => {
            win.webContents.executeJavaScript(`
              if (typeof window.triggerImportarTXT === 'function') {
                window.triggerImportarTXT();
              }
            `).catch(() => {});
          }
        },
        { 
          label: 'Exportar Backup TXT...', 
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            win.webContents.executeJavaScript(`
              if (typeof window.exportarBackupTXT === 'function') {
                window.exportarBackupTXT(); 
              }
            `).catch(() => {});
          }
        },
        { type: 'separator' },
        { 
          label: 'Exportar Coleção para Excel...', 
          accelerator: 'CmdOrCtrl+E',
          click: () => {
            win.webContents.executeJavaScript(`
              if (typeof window.exportarPlanilhaSofisticada === 'function') {
                window.exportarPlanilhaSofisticada().catch(err => console.error(err));
              }
            `).catch(() => {});
          }
        },
        { type: 'separator' },
        { 
          label: 'Criar HTML Viewer...', 
          accelerator: 'CmdOrCtrl+H',
          click: async () => {
            const openDialog = await dialog.showOpenDialog(win, {
              title: 'Selecione a Lista Descarregada (.txt)',
              filters: [{ name: 'Arquivos de Texto', extensions: ['txt'] }],
              properties: ['openFile']
            });

            if (!openDialog.canceled && openDialog.filePaths.length > 0) {
              const saveDialog = await dialog.showSaveDialog(win, {
                title: 'Onde deseja salvar a página HTML?',
                defaultPath: 'MinhaColecao_GameVault.html',
                filters: [{ name: 'Página Web', extensions: ['html'] }]
              });

              if (!saveDialog.canceled && saveDialog.filePath) {
                try {
                  const conteudoTexto = fs.readFileSync(openDialog.filePaths[0], 'utf-8');
                  const caminhoSalvar = saveDialog.filePath.replace(/\\/g, '\\\\');

                  win.webContents.executeJavaScript(`
                    if (typeof window.gerarHTMLViewerNativo === 'function') {
                      window.gerarHTMLViewerNativo(\`${conteudoTexto.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')}\`, "${caminhoSalvar}");
                    } else {
                      console.error('Função gerarHTMLViewerNativo não encontrada no HTML.');
                    }
                  `);
                } catch (err) {
                  dialog.showErrorBox('Erro', 'Não foi possível processar o arquivo.');
                }
              }
            }
          }
        },
        { type: 'separator' },
        { label: 'Sair', role: 'quit' }
      ]
    },
    {
      label: 'Editar',
      submenu: [
        { label: 'Desfazer', role: 'undo' },
        { label: 'Refazer', role: 'redo' },
        { type: 'separator' },
        { label: 'Recortar', role: 'cut' },
        { label: 'Copiar', role: 'copy' },
        { label: 'Colar', role: 'paste' },
        { label: 'Selecionar Tudo', role: 'selectAll' }
      ]
    },
    {
      label: 'Exibir',
      submenu: [
        { label: 'Recarregar a Página', role: 'reload' },
        { label: 'Modo Desenvolvedor (Inspecionar)', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'Tela Cheia', role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Janela',
      submenu: [
        { label: 'Minimizar', role: 'minimize' },
        { label: 'Fechar', role: 'close' }
      ]
    },
    {
      label: 'Ajuda',
      submenu: [
        { 
          label: 'Sobre o GameVault',
          click: () => {
            dialog.showMessageBox(win, {
              type: 'info',
              title: 'Sobre',
              message: 'GameVault® - Gerenciador de Coleção',
              detail: 'Versão 1.0.0\nCriado para gerenciar suas bibliotecas de jogos físicos e digitais.\n\nDesenvolvido em 2026 por Damaceno Softwares.',
              buttons: ['OK']
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

app.whenReady().then(() => {
  startLocalApiServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  stopLocalApiServer();
});

// Previne crash por erros não tratados
process.on('uncaughtException', (err) => {
  console.error('[GameVault] Erro não tratado:', err);
  console.error('[GameVault] Stack:', err.stack);
  // Não encerra o processo, apenas loga
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[GameVault] Promise rejeitada não tratada:', reason);
  console.error('[GameVault] Promise:', promise);
  // Não encerra o processo, apenas loga
});

// Garante que o servidor continue rodando mesmo se a janela fechar
app.on('window-all-closed', (e) => {
  // NÃO chamamos app.quit() aqui - mantemos o processo vivo para o servidor HTTP
  // O usuário deve usar Arquivo > Sair ou o tray para fechar completamente
  e.preventDefault();
  if (process.platform !== 'darwin') {
    // Apenas esconde a janela, mantém o app rodando
    console.log('[GameVault] Janela fechada, mas servidor HTTP continua rodando');
  }
});