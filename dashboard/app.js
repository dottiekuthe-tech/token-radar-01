// Token Launch Radar dashboard: renders window.RADAR (data.js), no network.
// Board: sortable, searchable, filterable; click a row for its detail view
// with the farm plan. The farm steps are rebuilt here from the row itself
// (category, chains, TVL) with the same rules as lib/model.ts farmSteps,
// so the plan shown is the plan board.json carries for that protocol.
(function () {
  var R = window.RADAR;
  var rows = R.rows, live = R.live, fit = R.fit;
  var view = 'board', sortKey = 'rank', sortDir = 1, query = '', cat = '';
  var $ = function (id) { return document.getElementById(id); };
  var tbody = document.querySelector('#board tbody');
  var detail = $('detail');

  function money(n) {
    if (n == null) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function pct(n) {
    if (n == null) return '—';
    var s = (n > 0 ? '+' : '') + n.toFixed(1) + '%';
    return '<span class="' + (n >= 0 ? 'up' : 'down') + '">' + s + '</span>';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- farm plan, same rules as lib/model.ts farmSteps ---------------------
  function capitalFor(tvl) { return tvl >= 5e9 ? 250 : tvl >= 1e9 ? 150 : tvl >= 1e8 ? 100 : 50; }
  function holdFor(tvl) { return tvl >= 1e9 ? 30 : tvl >= 1e8 ? 45 : 60; }
  function actionFor(r, capital, chain) {
    var c = (r.category || '').toLowerCase(), n = r.name;
    if (/lend|cdp|collateral/.test(c)) return 'Supply $' + capital + ' of USDC to ' + n + ' on ' + chain + ' and keep the position open.';
    if (/dex|yield|leveraged farm/.test(c)) return 'Provide $' + capital + ' of liquidity to ' + n + "'s main pool on " + chain + ' and keep the position open.';
    if (/bridge/.test(c)) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + n + ' and use the bridged funds in its app.';
    if (/staking|restak/.test(c)) return 'Stake $' + capital + " of the chain's staking asset through " + n + ' and keep the receipt.';
    if (/perpetual|derivative/.test(c)) return 'Deposit $' + capital + ' of USDC as margin on ' + n + ' and open one small hedge.';
    if (/prediction/.test(c)) return 'Fund $' + capital + ' and place one market position on ' + n + '.';
    if (/curator|allocator/.test(c)) return 'Deposit $' + capital + ' into a ' + n + ' vault on ' + chain + ' and keep the shares.';
    if (/stable/.test(c)) return 'Mint or deposit $' + capital + ' of the stable asset through ' + n + ' on ' + chain + '.';
    if (/rwa/.test(c)) return 'Mint $' + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (/insurance/.test(c)) return 'Buy $' + capital + ' of cover from ' + n + ' on ' + chain + ' and keep the policy.';
    return 'Deposit $' + capital + ' of USDC into ' + n + ' on ' + chain + ' and keep the position open.';
  }
  function farmSteps(r) {
    var chain = (r.chains && r.chains[0]) || 'its main chain';
    var capital = capitalFor(r.tvl_usd), hold = holdFor(r.tvl_usd);
    var gas = capital >= 150 ? 8 : 4;
    var steps = [
      ['Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', 'under $3 of gas for the first transaction', '5 minutes'],
      [actionFor(r, capital, chain), '$' + capital + ' of capital and about $' + gas + ' of gas', '15 minutes to set up'],
      ['Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', 'about $2 of gas a week', '10 minutes a week'],
      ['Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', 'the $' + capital + ' stays in the position', hold + ' days'],
      ["Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", 'no fee to check, and never pay to claim', '10 minutes'],
      ['Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes']
    ];
    return steps.map(function (s) { return s[0] + ' Cost: ' + s[1] + '. Time: ' + s[2] + '.'; });
  }

  // --- header ---------------------------------------------------------------
  $('meta').textContent = 'Snapshot ' + R.as_of + ' · ' + R.board_size + ' protocols ranked · ' +
    R.watchlist_size + ' on the watchlist · model ' + R.model_version +
    ' · holdout error ' + fit.holdout_median_log_error + ' log (starter ' + fit.holdout_starter_median_log_error + ')';
  $('method').textContent = 'How it is priced: each category\u2019s median market-cap/TVL ratio among the ' +
    fit.comparables + ' protocols that already have a token, shrunk toward the global median ' +
    '(k=' + fit.shrink_k + ', cap ' + fit.multiple_cap_low + '\u2013' + fit.multiple_cap_high + '\u00d7), times TVL, times a 7-day growth factor ' +
    '(weight ' + fit.growth_weight + ', clamped ' + fit.growth_floor + '%\u2026' + fit.growth_cap + '%). Age is not weighted: it showed no pricing signal ' +
    '(log market-cap/TVL correlation \u22120.004). Categories with no issued comparable fall back to the global median: ' +
    (fit.fallback_categories.join(', ') || 'none') + '.';

  var cats = [];
  rows.forEach(function (r) { if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category); });
  cats.sort();
  $('cat').innerHTML = '<option value="">All categories</option>' +
    cats.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');

  // --- table ----------------------------------------------------------------
  function filtered() {
    var list = view === 'board' ? rows : live.map(function (p, i) {
      return { rank: i + 1, slug: p.slug, name: p.name, category: p.category, chains: p.chains,
        tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: p.mcap_usd, implied_value_usd: p.mcap_usd };
    });
    if (cat) list = list.filter(function (r) { return r.category === cat; });
    if (query) list = list.filter(function (r) {
      return (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase().indexOf(query) >= 0;
    });
    var k = sortKey;
    list = list.slice().sort(function (a, b) {
      var x = a[k], y = b[k];
      if (x == null) return 1; if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
    });
    return list;
  }
  function render() {
    var list = filtered();
    document.querySelectorAll('#board th')[6].textContent = view === 'board' ? 'Implied value' : 'Market cap';
    tbody.innerHTML = list.map(function (r) {
      return '<tr data-slug="' + esc(r.slug) + '"><td class="num">' + r.rank + '</td><td>' + esc(r.name) +
        '</td><td>' + esc(r.category || '—') + '</td><td>' + esc((r.chains || []).join(', ') || '—') +
        '</td><td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + pct(r.change_7d) +
        '</td><td class="num">' + money(view === 'board' ? r.implied_value_usd : r.mcap_usd) + '</td></tr>';
    }).join('');
  }
  tbody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (!tr) return;
    document.querySelectorAll('tbody tr').forEach(function (t) { t.classList.remove('sel'); });
    tr.classList.add('sel');
    showDetail(tr.getAttribute('data-slug'), true);
  });
  document.querySelectorAll('#board th').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
      render();
    });
  });
  $('q').addEventListener('input', function (e) { query = e.target.value.trim().toLowerCase(); render(); });
  $('cat').addEventListener('change', function (e) { cat = e.target.value; render(); });
  $('view').addEventListener('change', function (e) {
    view = e.target.value; sortKey = view === 'board' ? 'rank' : 'mcap_usd'; sortDir = view === 'board' ? 1 : -1;
    detail.innerHTML = ''; render();
  });

  // --- detail ---------------------------------------------------------------
  // scroll=true only when the reader clicked a row; the first detail shown
  // on load must not move the page, or the board screenshot loses its top.
  function showDetail(slug, scroll) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) return;
    var steps = farmSteps(r);
    detail.innerHTML = '<h2>' + esc(r.name) + '</h2>' +
      '<div class="stats"><span>Rank <b>#' + r.rank + '</b></span><span>TVL <b>' + money(r.tvl_usd) + '</b></span>' +
      '<span>7d <b>' + (r.change_7d == null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</b></span>' +
      '<span>Implied value <b>' + money(r.implied_value_usd) + '</b></span>' +
      '<span>Category <b>' + esc(r.category || '—') + '</b></span>' +
      '<span>Chains <b>' + esc((r.chains || []).join(', ') || '—') + '</b></span></div>' +
      '<p class="method">Model: category multiple ' + r.category_multiple + '\u00d7 (from ' + (fit.category_multiple[r.category] != null ? 'this category' : 'the global median') +
      '), growth factor ' + r.growth_multiplier + '\u00d7. This protocol records no token in the snapshot.</p>' +
      '<h3>How to farm it</h3><ol>' + steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>';
    if (scroll) detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  render();
  if (rows.length) showDetail(rows[0].slug);
})();
