import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// 系統工具用絕對路徑，不受 PATH 中同名程式影響（例如 Git Bash 的 whoami）。
const system32 = (...name) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...name);
const UNREADABLE = '無法解開登入資料；請刪除 credentials.json 與 master.key 後重新登入／設定 API key。';

// Windows DPAPI（CurrentUser）：資料以 base64 經 stdin 傳給 PowerShell，結果由 stdout 取回，明文不落地。
function dpapi(op, data) {
  const out = execFileSync(system32('WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Security; $d = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
    `[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::${op}($d, $null, 'CurrentUser')))`],
  { input: data.toString('base64'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  return Buffer.from(out.trim(), 'base64');
}
export const dpapiProtector = { protect: data => dpapi('Protect', data), unprotect: data => dpapi('Unprotect', data) };

function writeAtomic(filename, content) {
  // 先寫暫存檔，再原子替換，避免寫到一半遺失 refresh token。
  const temp = `${filename}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, filename);
}

// protector：{ protect(Buffer) → Buffer, unprotect(Buffer) → Buffer }；Windows 預設 DPAPI，其他平台預設不加密（0600 明文）。
export function createStore(directory = path.join(os.homedir(), '.my-chatgpt-local'),
  { protector = process.platform === 'win32' ? dpapiProtector : null } = {}) {
  // Step 1：憑證放在使用者目錄，限制為目前使用者可讀寫。
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const sid = execFileSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[0-9-]+/)?.[0];
    if (!sid) throw new Error('無法確認 Windows 使用者，停止保存憑證。');
    execFileSync(system32('icacls.exe'), [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { stdio: 'pipe' });
  } else fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, 'credentials.json');
  const keyFile = path.join(directory, 'master.key');
  let stored = null;
  try { stored = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('登入資料無法讀取；請先備份 credentials.json，再修復或移除檔案。');
  }
  const encrypted = stored?.enc === 'aes-256-gcm';
  // Step 2：主金鑰（32 bytes）只在啟動時解開一次；檔案已加密卻沒有可用金鑰時停止，絕不覆寫。
  let key = null;
  if (protector) {
    if (fs.existsSync(keyFile)) {
      try { key = protector.unprotect(Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64')); }
      catch { throw new Error(UNREADABLE); }
      if (key.length !== 32) throw new Error(UNREADABLE);
    } else if (encrypted) throw new Error(UNREADABLE);
    else {
      key = randomBytes(32);
      writeAtomic(keyFile, protector.protect(key).toString('base64'));
    }
  } else if (encrypted) throw new Error(UNREADABLE);
  let data;
  if (encrypted) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
      data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch { throw new Error(UNREADABLE); }
  } else data = stored || { hostId: `urn:uuid:${randomUUID()}`, accounts: [], activeId: null };
  const save = () => {
    const plain = JSON.stringify(data, null, 2);
    if (!key) return writeAtomic(filename, plain);
    // Step 3：每次保存用新的 12-byte IV 以 AES-256-GCM 加密整份資料。
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    writeAtomic(filename, JSON.stringify({ v: 1, enc: 'aes-256-gcm', iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), data: body.toString('base64') }));
  };
  // 舊版明文檔在此立即改存為加密格式。
  save();
  return { data, save };
}
