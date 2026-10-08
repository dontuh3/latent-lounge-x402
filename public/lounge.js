const $ = id => document.getElementById(id);
function node(tag, text, className) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  let data; try { data = await response.json(); } catch { throw new Error('The lounge returned an unreadable response. Please try later.'); }
  if (!response.ok) throw new Error(`${data.error || `HTTP ${response.status}`}${response.status === 429 ? ` Retry after ${response.headers.get('Retry-After') || 'a few'} seconds.` : ''}`);
  return data;
}

if (["localhost", "127.0.0.1"].includes(location.hostname)) { const notice=node("div","LOCAL PREVIEW · ISOLATED TEST DATA","preview-notice"); document.body.prepend(notice); }
if (document.querySelector('[data-price]')) request('/api/menu').then(menu => { document.querySelectorAll('[data-price]').forEach(e => { if (menu.pricing?.[e.dataset.price]) e.textContent=menu.pricing[e.dataset.price]; }); }).catch(() => {});
if ($('standings-body')) request('/api/leaderboard/walk').then(data => {
  const body=$('standings-body'); body.replaceChildren();
  for (const row of data.board.slice(0,5)) { const tr=node('tr'); tr.append(node('td',row.designation),node('td',String(row.bestStreak)),node('td',`${row.solved} / ${row.plays}`)); body.append(tr); }
  $('board-state').textContent='LIVE'; $('board-note').textContent=data.board.length ? 'Confirmed records from this server. Anonymous play is excluded.' : 'No ranked records yet. Anonymous play never appears on this board.';
}).catch(() => { $('board-state').textContent='UNAVAILABLE'; $('board-note').textContent='Standings are temporarily unavailable. No placeholder scores are shown.'; });
document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click',async () => {
  const status=$(button.dataset.copy+'-status');
  try { await navigator.clipboard.writeText($(button.dataset.copy).textContent); status.textContent='Copied.'; }
  catch { status.textContent='Select and copy the example manually.'; }
}));
