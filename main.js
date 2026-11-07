const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const dataDir = () => app.getPath('userData');
const dataFile = () => path.join(dataDir(), 'data.json');
const backupDir = () => path.join(dataDir(), 'backups');
const KEEP_BACKUPS = 30;

function readData() {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    // Пошкоджений файл: зберегти його окремо, щоб не втратити
    const broken = dataFile() + '.broken-' + Date.now();
    try { fs.copyFileSync(dataFile(), broken); } catch {}
    return null;
  }
}

function writeData(json) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = dataFile() + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, dataFile());
  dailyBackup(json);
}

// Одна копія на день, останні 30 днів
function dailyBackup(json) {
  fs.mkdirSync(backupDir(), { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(path.join(backupDir(), `data-${day}.json`), json, 'utf8');
  const files = fs.readdirSync(backupDir()).filter(f => /^data-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))) {
    fs.unlinkSync(path.join(backupDir(), f));
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1300,
    height: 850,
    title: 'Облік магазину',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.maximize();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

ipcMain.handle('load', () => readData());
ipcMain.handle('save', (_e, json) => { writeData(json); return true; });
ipcMain.handle('openDataFolder', () => {
  fs.mkdirSync(dataDir(), { recursive: true });
  shell.openPath(dataDir());
});
ipcMain.handle('exportFile', async (e, { name, content, kind }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const csv = kind === 'csv';
  const res = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), name),
    filters: [csv ? { name: 'CSV (Excel)', extensions: ['csv'] } : { name: 'Резервна копія', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return false;
  fs.writeFileSync(res.filePath, (csv ? '﻿' : '') + content, 'utf8');
  return true;
});
ipcMain.handle('print', (e) => {
  e.sender.print({ printBackground: true });
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
});
app.on('window-all-closed', () => app.quit());
