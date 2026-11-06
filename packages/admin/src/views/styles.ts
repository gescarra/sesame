// The console's only stylesheet, served from /admin/static/admin.css so the CSP can forbid inline styles.
export const STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --surface: #ffffff;
  --surface-2: #f0f2f5;
  --border: #dfe3e8;
  --text: #1f2328;
  --muted: #646d78;
  --accent: #2563eb;
  --ok: #1a7f37;
  --warn: #9a6700;
  --danger: #c2312b;
  --notice-bg: #e7f5ec;
  --error-bg: #fdecea;
  --radius: 8px;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216;
    --surface: #161a20;
    --surface-2: #1d222a;
    --border: #2b323c;
    --text: #e6e9ee;
    --muted: #9aa3ae;
    --accent: #6c9cff;
    --ok: #5cc97b;
    --warn: #e0b341;
    --danger: #ff6b63;
    --notice-bg: #173823;
    --error-bg: #431b19;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
header.top {
  display: flex; align-items: center; gap: 24px; flex-wrap: wrap;
  padding: 12px 24px; background: var(--surface); border-bottom: 1px solid var(--border);
}
.brand { font-weight: 700; font-size: 16px; }
.brand span { color: var(--muted); font-weight: 500; }
nav { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; }
nav a { padding: 6px 10px; border-radius: 6px; color: var(--text); }
nav a.active { background: var(--surface-2); font-weight: 600; }
nav a:hover { text-decoration: none; background: var(--surface-2); }
.who { color: var(--muted); font-size: 13px; display: flex; gap: 12px; }
main { max-width: 1100px; margin: 0 auto; padding: 24px; }
h1 { font-size: 22px; margin: 0 0 16px; }
h2 { font-size: 16px; margin: 0 0 12px; }
.lede { color: var(--muted); margin: -8px 0 20px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-bottom: 16px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; margin-bottom: 16px; overflow-x: auto; }
.stat { font-size: 26px; font-weight: 650; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; background: var(--surface-2); }
.pill.ok { color: var(--ok); }
.pill.warn { color: var(--warn); }
.pill.bad { color: var(--danger); }
.flash { padding: 10px 14px; border-radius: var(--radius); margin-bottom: 16px; }
.flash.notice { background: var(--notice-bg); }
.flash.error { background: var(--error-bg); }
form.inline { display: inline; margin: 0; }
form.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: end; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
input, select {
  font: inherit; color: var(--text); background: var(--surface); padding: 6px 8px;
  border: 1px solid var(--border); border-radius: 6px; min-width: 0;
}
button {
  font: inherit; font-weight: 600; padding: 6px 12px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--accent); background: var(--accent); color: #fff;
}
button.secondary { background: transparent; color: var(--text); border-color: var(--border); }
button.danger { background: transparent; color: var(--danger); border-color: var(--border); }
meter { width: 120px; vertical-align: middle; margin-right: 6px; }
code { font-size: 12px; background: var(--surface-2); padding: 1px 4px; border-radius: 4px; word-break: break-all; }
@media (max-width: 700px) {
  header.top { padding: 12px 16px; gap: 8px; }
  main { padding: 16px; }
  .hide-narrow { display: none; }
}
`;
