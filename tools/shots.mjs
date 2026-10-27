// Headless screenshot driver (Chromium-based browser with --remote-debugging-port=9333).
//   node tools/shots.mjs <url> <t1,t2,...> <outPrefix>
// Turns on no-death + clear weather, then captures half-size JPEGs at the given seconds
// and prints segment / speed / fps per shot plus any console errors.
import fs from 'node:fs';
const [url, times, prefix] = process.argv.slice(2);
const W = 1280, H = 760;
const tgt = await (await fetch('http://localhost:9333/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl); let id = 0; const pend = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  else if (d.method === 'Runtime.exceptionThrown') logs.push('[exception] ' + JSON.stringify(d.params.exceptionDetails).slice(0, 400));
  else if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(d.params.type)) logs.push(`[${d.params.type}] ` + d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 500)); };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.result?.value;
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url }); await new Promise((r) => setTimeout(r, 2500));
await ev(`(()=>{ const s = window.__tron.settings; s.set('godMode', true); s.set('weatherAuto', false); s.set('weatherState', 'clear'); s.set('dof', false); })()`);
let last = 0;
for (const [i, t] of times.split(',').map(Number).entries()) {
  await new Promise((r) => setTimeout(r, (t - last) * 1000)); last = t;
  console.log(JSON.stringify(await ev(`(()=>{ const T = window.__tron, b = T.ball; const c = T.course.chunks.find(c => b.z <= c.zStart && b.z >= c.zEnd); return { t: ${t}, seg: c && c.type, kmh: (b.vt * 3.6) | 0, fps: T.perf.fps | 0 }; })()`)));
  const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip: { x: 0, y: 0, width: W, height: H, scale: 0.5 } });
  fs.writeFileSync(`${prefix}${i}.jpg`, Buffer.from(s.result.data, 'base64'));
}
console.log('console errors/warnings: ' + (logs.join('\n') || 'none'));
await fetch('http://localhost:9333/json/close/' + tgt.id); process.exit(0);
