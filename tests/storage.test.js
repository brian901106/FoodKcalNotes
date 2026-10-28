import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createStore, dpapiProtector } from '../server/storage.js';

// 假的保護器：可逆但非明文，模擬 DPAPI；不是 'P1' 開頭的資料視為損毀。
const protector = {
  protect: data => Buffer.concat([Buffer.from('P1'), Buffer.from(data.map(x => x ^ 0x5a))]),
  unprotect: blob => { if (blob.subarray(0, 2).toString() !== 'P1') throw new Error('bad blob'); return Buffer.from(blob.subarray(2).map(x => x ^ 0x5a)); },
};
const SECRETS = ['test-access-token-ABC123', 'test-refresh-token-DEF456', 'sk-ant-test-fake-secret-7890'];
const temp = t => { const dir = fs.mkdtempSync(path.join(tmpdir(), 'store-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const fill = store => {
  store.data.accounts.push({ client_id: 'oaiapp_x', access_token: SECRETS[0], refresh_token: SECRETS[1] });
  store.data.providers = [{ id: 'claude', enabled: true, model: 'claude-haiku-5-5', apiKey: SECRETS[2] }];
  store.save();
};
const noSecrets = dir => {
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const secret of SECRETS) assert.equal(text.includes(secret), false, `${name} 含明文`);
  }
};
const UNREADABLE = /無法解開登入資料；請刪除 credentials\.json 與 master\.key 後重新登入／設定 API key。/;

test('加密儲存：AES-256-GCM 往返、檔案無明文、主金鑰經保護器存成 master.key', t => {
  const dir = temp(t);
  const store = createStore(dir, { protector }); fill(store);
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
  assert.deepEqual(Object.keys(file).sort(), ['data', 'enc', 'iv', 'tag', 'v']); assert.equal(file.v, 1); assert.equal(file.enc, 'aes-256-gcm');
  assert.equal(protector.unprotect(Buffer.from(fs.readFileSync(path.join(dir, 'master.key'), 'utf8'), 'base64')).length, 32);
  noSecrets(dir);
  const again = createStore(dir, { protector });
  assert.deepEqual(again.data, store.data);
  // 每次保存用新的 IV。
  const before = fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'); again.save();
  assert.notEqual(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['credentials.json', 'master.key']); // 暫存檔已替換
});

test('舊版明文 credentials.json 啟動時讀入並立即改存為加密', t => {
  const dir = temp(t);
  const legacy = { hostId: 'urn:uuid:legacy', accounts: [{ client_id: 'oaiapp_x', access_token: SECRETS[0], refresh_token: SECRETS[1] }], activeId: 'oaiapp_x',
    providers: [{ id: 'claude', enabled: false, model: 'claude-opus-5-5', apiKey: SECRETS[2] }] };
  fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(legacy));
  const store = createStore(dir, { protector });
  assert.deepEqual(store.data, legacy);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')).enc, 'aes-256-gcm');
  noSecrets(dir);
  assert.deepEqual(createStore(dir, { protector }).data, legacy);
});

test('主金鑰錯誤、遺失或損毀：丟出清楚錯誤，不覆寫 credentials.json', t => {
  const dir = temp(t);
  fill(createStore(dir, { protector }));
  const cred = path.join(dir, 'credentials.json'); const keyFile = path.join(dir, 'master.key');
  const original = fs.readFileSync(cred);
  fs.writeFileSync(keyFile, protector.protect(randomBytes(32)).toString('base64')); // 另一把金鑰
  assert.throws(() => createStore(dir, { protector }), UNREADABLE);
  fs.writeFileSync(keyFile, 'not-a-valid-blob');
  assert.throws(() => createStore(dir, { protector }), UNREADABLE);
  fs.rmSync(keyFile);
  assert.throws(() => createStore(dir, { protector }), UNREADABLE);
  assert.equal(fs.existsSync(keyFile), false); // 不會產生新金鑰蓋掉舊資料
  // 沒有保護器（非 Windows）也無法讀加密檔。
  assert.throws(() => createStore(dir, { protector: null }), UNREADABLE);
  assert.deepEqual(fs.readFileSync(cred), original);
});

test('沒有保護器（非 Windows）：維持明文 JSON，不產生 master.key', t => {
  const dir = temp(t);
  fill(createStore(dir, { protector: null }));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8')).accounts[0].access_token, SECRETS[0]);
  assert.equal(fs.existsSync(path.join(dir, 'master.key')), false);
});

test('Windows DPAPI 實際往返（暫存資料夾）', { skip: process.platform !== 'win32' }, t => {
  const dir = temp(t);
  fill(createStore(dir));
  noSecrets(dir);
  assert.deepEqual(dpapiProtector.unprotect(dpapiProtector.protect(Buffer.from('x'))), Buffer.from('x'));
  assert.equal(createStore(dir).data.accounts[0].access_token, SECRETS[0]);
});
