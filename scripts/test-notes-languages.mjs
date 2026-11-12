import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { requestJSON } from './soak.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridgeFile = path.resolve(process.env.PACE_E2E_BRIDGE_FILE || path.join(root, 'artifacts/runtime/e2e-app/e2e-bridge.json'));
assert(bridgeFile.startsWith(path.join(root, 'artifacts/runtime/')));
const bridge = JSON.parse(await fs.readFile(bridgeFile, 'utf8'));
assert.equal(new URL(bridge.url).hostname, '127.0.0.1');
const call = (method, params = {}) => requestJSON(new URL(bridge.url), bridge.token, method, params);
const state = await call('app.state');
assert.equal(state.settings.memoryEnabled, false);
assert(!state.meetings.some(meeting => ['recording', 'finalizing'].includes(meeting.status)), 'Wait for the paced workload to finish.');
const fixtures = [
  { language: 'zh', source: '这次会议讨论桌面宠物应用的发布。我是安娜。我将在周五发送报告。我也会编写培训文档，但培训文档的截止日期尚未约定。我们决定桌面宠物应用于周一发布。是否增加音效还未决定。', report: /报告/, tutorial: /培训|教程/, friday: /周五|星期五/, monday: /周一|星期一/, unknown: /未定|待定|未(?:明确|确定|约定)|无(?:明确)?截止|没有.*(?:截止|期限)|尚未约定/, script: /[\u3400-\u9fff]/ },
  { language: 'ja', source: 'この会議はDesktop Petsアプリの公開についてです。私はアキです。金曜日までにレポートを送ります。チュートリアルも私が書きますが、チュートリアルの締め切りは決まっていません。Desktop Petsアプリのリリースは月曜日に決まりました。効果音の追加は未決定です。', report: /レポート|報告/, tutorial: /チュートリアル/, friday: /金曜/, monday: /月曜/, unknown: /未定|不明|未確定|未設定|決まってい|合意.*(?:なし|未)|期限.*(?:なし|未)/, script: /[\u3040-\u30ff]/ },
  { language: 'es', source: 'Esta reunión trata del lanzamiento de la aplicación Desktop Pets. Soy Ana. Enviaré el informe el viernes. También escribiré el tutorial, pero aún no hemos acordado una fecha límite para el tutorial. Decidimos lanzar la aplicación Desktop Pets el lunes. No hemos decidido si añadiremos sonidos.', report: /informe/i, tutorial: /tutorial/i, friday: /viernes/i, monday: /lunes/i, unknown: /sin (?:fecha|plazo)|no (?:hay|se ha|se han|acordad)|no (?:fijad|definid|establecid)|por (?:definir|acordar)|pendiente/i, script: /informe|decidi|lunes/i },
];
const results = [];
const created = [];
try {
  for (const fixture of fixtures) {
    await call('settings.update', { patch: { language: fixture.language } });
    const id = randomUUID(); created.push(id);
    await call('_test.meeting.seed', { id, title: `Synthetic ${fixture.language} notes`, status: 'completed', startedAt: new Date().toISOString(), segments: [{ speaker: 'Speaker 1', start: 0, end: 15, text: fixture.source }] });
    const started = performance.now();
    const meeting = await call('meeting.summarize', { id });
    const actions = meeting.actionItems.map(item => typeof item === 'string' ? item : item.text);
    results.push({ language: fixture.language, seconds: (performance.now() - started) / 1000, notes: meeting.notes, actions });
    await fs.writeFile(path.join(root, 'artifacts/runtime/notes-languages.json'), JSON.stringify(results, null, 2));
    assert.match(meeting.notes, fixture.script);
    assert.match(meeting.notes, fixture.monday);
    assert.equal((meeting.notes.match(/^## (Summary|Decisions|Action items|Open questions)\s*$/gim) || []).length, 4);
    const report = actions.find(action => fixture.report.test(action));
    const tutorial = actions.find(action => fixture.tutorial.test(action));
    assert(report && fixture.friday.test(report), `${fixture.language}: report retains its Friday deadline`);
    assert(!fixture.unknown.test(report), `${fixture.language}: report cannot have both Friday and an unknown deadline`);
    assert(tutorial && fixture.unknown.test(tutorial) && !fixture.friday.test(tutorial) && !fixture.monday.test(tutorial), `${fixture.language}: tutorial has no invented deadline`);
    assert.notEqual(report, tutorial, `${fixture.language}: separate actions retain their own metadata`);
    console.log(`${fixture.language}: actual local notes and factual actions passed`);
  }
} finally {
  await call('settings.update', { patch: { language: state.settings.language } });
  for (const id of created) await call('meeting.delete', { id });
}
