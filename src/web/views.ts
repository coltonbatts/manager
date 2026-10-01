// Server-rendered pages. Read-only views over manager.db and journal.db; no LLM calls here.

import type { Entry, Checkin } from '../journal/journal.ts';
import type { CorrelationReport } from '../journal/correlate.ts';
import { describeCorrelation } from '../journal/correlate.ts';
import type { PatternsReport } from '../patterns/hypotheses.ts';
import type { Patterns } from '../patterns/metrics.ts';
import { tildify } from '../paths.ts';
import type { ProjectView, State } from '../store.ts';
import type { PortfolioReport } from '../understand/portfolio.ts';
import type { StoredProfile } from '../understand/profile.ts';
import { ago, bytes } from '../ui.ts';
import { html, raw, type Html } from './html.ts';

type Nav = 'wall' | 'patterns' | 'journal' | null;

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const word = (n: number) => WORDS[n] ?? String(n);
const lower = (n: number) => (WORDS[n] ?? String(n)).toLowerCase();
const today = () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export function layout(title: string, nav: Nav, body: Html): string {
  const navLink = (href: string, key: Nav, label: string) =>
    html`<a href="${href}" ${key === nav ? raw('aria-current="page"') : ''}>${label}</a>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='3' y='3' width='10' height='10' fill='%23b5482b'/%3E%3C/svg%3E">
</head>
<body>
<div class="wrap">
  <header class="mast">
    <a class="mark" href="/">Manager · Alternative Design</a>
    <nav>${navLink('/', 'wall', 'Wall')}${navLink('/patterns', 'patterns', 'Patterns')}${navLink('/journal', 'journal', 'Journal')}</nav>
    <span>${today()}</span>
  </header>
  ${body}
  <footer>Local only. Read-only toward your projects. Data lives in ~/MANAGER/data.</footer>
</div>
</body>
</html>`.value;
}

/** One tick per week; height = active days that week (0–7). */
export function strip(weeks: number[], width = 156, height = 22, extraClass = ''): Html {
  const n = weeks.length || 1;
  const gap = 2;
  const w = (width - gap * (n - 1)) / n;
  const rects = weeks.map((v, i) => {
    const h = v ? Math.max(3, (Math.min(v, 7) / 7) * height) : 1;
    const cls = v === 0 ? 'empty' : i >= n - 2 ? 'now' : '';
    return `<rect class="${cls}" x="${(i * (w + gap)).toFixed(1)}" y="${(height - h).toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`;
  }).join('');
  return raw(`<svg class="strip ${extraClass}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="weekly activity, last ${n} weeks">${rects}</svg>`);
}

function metaLine(p: ProjectView): Html {
  const f = p.facts;
  const bits: Html[] = [html`${ago(f.lastActivityAt)}`];
  if (f.stack.length) bits.push(html`${f.stack.filter((s) => s !== 'TypeScript').slice(0, 2).join(' + ') || 'TypeScript'}`);
  else bits.push(html`${p.kind}`);
  if (f.git?.commits30) bits.push(html`${f.git.commits30} commits / 30d`);
  const dirty = f.git ? f.git.modified + f.git.untracked : 0;
  if (dirty) bits.push(html`<span class="hot">${dirty} uncommitted</span>`);
  return html`<div class="meta">${bits.map((b, i) => html`${i ? ' · ' : ''}${b}`)}</div>`;
}

function card(p: ProjectView, profile: StoredProfile | null, weeks: number[], i: number): Html {
  const blurb = profile?.profile.summary;
  return html`<a class="card" href="/p/${p.id}" style="--i:${i}">
    <h3>${p.name}</h3>
    ${blurb ? html`<p>${blurb}</p>` : ''}
    ${strip(weeks)}
    ${metaLine(p)}
  </a>`;
}

export interface OverviewData {
  projects: ProjectView[];
  profiles: Map<string, StoredProfile | null>;
  weekly: Map<string, number[]>;
  report: { report: PortfolioReport; generatedAt: number } | null;
  week: { touched: number; commits: number; shipped: number };
  scannedAt: number | null;
}

const GROUPS: { state: State; label: string }[] = [
  { state: 'active', label: 'Moving · this week' },
  { state: 'warm', label: 'Warm · this month' },
  { state: 'cooling', label: 'Cooling · one to three months' },
];

export function overview(d: OverviewData): string {
  if (!d.scannedAt) {
    return layout('Manager', 'wall', html`<div class="lede"><h1>The wall is empty.</h1><p>Run <code>manager scan</code> to put your projects up.</p></div>`);
  }
  const count = (s: State) => d.projects.filter((p) => p.state === s).length;
  const moving = count('active');
  const resting = count('dormant') + count('unknown');
  const headline = d.report?.report.headline
    ?? `${word(moving)} ${moving === 1 ? 'thing is' : 'things are'} moving. ${word(count('warm') + count('cooling'))} are within reach. ${resting} are resting.`;

  let i = 0;
  const groups = GROUPS.map(({ state, label }) => {
    const ps = d.projects.filter((p) => p.state === state);
    if (!ps.length) return '';
    return html`<section>
      <h2 class="label">${label} <span class="n">${ps.length}</span></h2>
      <div class="wall">${ps.map((p) => card(p, d.profiles.get(p.id) ?? null, d.weekly.get(p.id) ?? new Array(26).fill(0), i++))}</div>
    </section>`;
  });

  const rest = d.projects.filter((p) => p.state === 'dormant' || p.state === 'unknown');
  const focus = d.report?.report.suggestedFocus;

  return layout('Manager', 'wall', html`
    <div class="lede">
      <h1>${headline}</h1>
      <div class="week">This week: <b>${d.week.touched}</b> ${d.week.touched === 1 ? 'project' : 'projects'} touched · <b>${d.week.commits}</b> commits · <b>${d.week.shipped}</b> shipped · scanned ${ago(d.scannedAt)}</div>
    </div>
    ${focus ? html`<section><h2 class="label">If you pick one thing</h2><div class="focus"><h3>${focus.project}</h3><p>${focus.why}</p></div></section>` : ''}
    ${groups}
    ${rest.length ? html`<section>
      <h2 class="label">Resting · three months and longer <span class="n">${rest.length}</span></h2>
      <div class="colophon">${rest.map((p) => html`<a href="/p/${p.id}">${p.name}<span class="age">${p.facts.lastActivityAt ? ago(p.facts.lastActivityAt).replace(' ago', '') : 'empty'}</span></a>`)}</div>
    </section>` : ''}
    ${d.report ? reportNotes(d.report.report, d.report.generatedAt) : html`<section><p class="caveat">Run <code>manager report</code> for a written read of the whole portfolio.</p></section>`}
  `);
}

function reportNotes(r: PortfolioReport, at: number): Html {
  const block = (label: string, items: { project: string; note: string }[]) => items.length
    ? html`<section><h2 class="label">${label}</h2><ul class="notes">${items.map((x) => html`<li><span class="who">${x.project}</span> · ${x.note}</li>`)}</ul></section>`
    : '';
  return html`
    ${block('Close to shipping', r.closeToShipping)}
    ${block('Stalled', r.stalled)}
    ${r.overlaps.length ? html`<section><h2 class="label">Overlaps</h2><ul class="notes">${r.overlaps.map((o) => html`<li><span class="who">${o.projects.join(' · ')}</span> · ${o.note}</li>`)}</ul></section>` : ''}
    ${r.observations.length ? html`<section><h2 class="label">Observations</h2><ul class="notes">${r.observations.map((o) => html`<li>${o}</li>`)}</ul><p class="caveat">Portfolio read written ${ago(at)}.</p></section>` : ''}
  `;
}

export interface ProjectData {
  p: ProjectView;
  profile: StoredProfile | null;
  weeks: number[]; // 52
  signals: { date: string; kind: string; text: string }[];
  marks: { date: string; type: string; note: string | null }[];
}

export function projectPage(d: ProjectData): string {
  const { p, profile } = d;
  const f = p.facts;
  const pr = profile?.profile;
  const row = (k: string, v: unknown) => (v === null || v === undefined || v === '' ? '' : html`<dt>${k}</dt><dd>${v}</dd>`);
  const langs = Object.entries(f.languages).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l]) => l).join(', ');
  const media = Object.entries(f.media).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ');
  const docs = [f.docs.readme && 'README', f.docs.claudeMd && 'CLAUDE.md', f.docs.agentsMd && 'AGENTS.md'].filter(Boolean).join(', ');

  return layout(`${p.name} · Manager`, null, html`
    <div class="crumb"><a href="/">Wall</a> / ${p.state}</div>
    <div class="lede" style="margin-top:1.25rem">
      <h1>${p.name}</h1>
      ${pr ? html`<p>${pr.summary}</p>` : html`<p class="empty-state">Not profiled yet. Run <code>manager project ${p.id}</code> or <code>manager report</code>.</p>`}
      <div class="path">${tildify(p.path)}</div>
    </div>
    <section>
      <h2 class="label">Last 52 weeks</h2>
      ${strip(d.weeks, 720, 40, 'big-strip')}
    </section>
    <section class="two">
      <div>
        ${pr ? html`
          <h2 class="label">Where it is</h2>
          <ul class="notes">
            <li>${pr.currentState}<small>now</small></li>
            <li>${pr.nextStep}<small>next</small></li>
            ${pr.risks.map((r) => html`<li>${r}<small>risk</small></li>`)}
          </ul>
          <p class="caveat">${pr.category} · ${pr.stage} · ${pr.closeness} · ${pr.confidence} confidence · written ${ago(profile!.generatedAt)}${profile!.fresh ? '' : ' · project changed since'}</p>
        ` : ''}
        ${d.signals.length || d.marks.length ? html`
          <h2 class="label" style="margin-top:3rem">Ship evidence &amp; marks</h2>
          <ul class="notes">
            ${d.marks.map((m) => html`<li>Marked <span class="who">${m.type}</span>${m.note ? html` · ${m.note}` : ''}<small>${m.date}</small></li>`)}
            ${d.signals.slice(0, 8).map((s) => html`<li>${s.text}<small>${s.date} · ${s.kind}</small></li>`)}
          </ul>` : ''}
      </div>
      <div>
        <h2 class="label">Facts</h2>
        <dl class="facts">
          ${row('kind', p.kind)}
          ${row('last active', ago(f.lastActivityAt))}
          ${row('stack', f.stack.join(', '))}
          ${row('languages', langs)}
          ${f.git ? html`
            ${row('branch', f.git.branch)}
            ${row('commits', `${f.git.commitCount} yours · ${f.git.commits30} this month${f.git.othersCommitCount ? ` · ${f.git.othersCommitCount} by others` : ''}`)}
            ${row('started', f.git.firstCommitAt ? ago(f.git.firstCommitAt) : null)}
            ${row('uncommitted', `${f.git.modified} modified · ${f.git.untracked} untracked`)}
            ${row('remote', f.git.hasRemote ? 'yes' : 'none')}
          ` : row('git', 'not a repo')}
          ${row('files', `${f.fileCount}${f.truncated ? '+' : ''} · ${bytes(f.sizeBytes)}`)}
          ${row('media', media)}
          ${row('docs', docs || 'none')}
          ${row('todo / fixme', f.todoCount)}
        </dl>
      </div>
    </section>
  `);
}

function bars(values: number[], labels: string[], alt?: number[]): Html {
  const W = 720;
  const H = 120;
  const n = values.length;
  const max = Math.max(1, ...values, ...(alt ?? []));
  const slot = W / n;
  const bw = alt ? slot * 0.32 : slot * 0.6;
  let out = '';
  values.forEach((v, i) => {
    const h = (v / max) * (H - 22);
    const x = i * slot + (alt ? slot * 0.16 : slot * 0.2);
    out += `<rect x="${x.toFixed(1)}" y="${(H - 18 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, v ? 2 : 0.5).toFixed(1)}"/>`;
    if (alt) {
      const h2 = (alt[i] / max) * (H - 22);
      out += `<rect class="alt" x="${(x + bw + 2).toFixed(1)}" y="${(H - 18 - h2).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h2, alt[i] ? 2 : 0.5).toFixed(1)}"/>`;
    }
    if (labels[i]) out += `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${labels[i]}</text>`;
  });
  return raw(`<svg class="bars" viewBox="0 0 ${W} ${H}" role="img">${out}</svg>`);
}

export function patternsPage(p: Patterns, hyp: { report: PatternsReport; generatedAt: number } | null, corr: CorrelationReport): string {
  const c = p.coverage;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const fig = (num: unknown, unit: string, text: string) => html`<div class="figure"><div class="num">${num}<small>${unit}</small></div><p>${text}</p></div>`;
  const monthLabel = (m: string) => new Date(`${m}-15`).toLocaleDateString('en-US', { month: 'short' });

  return layout('Patterns · Manager', 'patterns', html`
    <div class="lede">
      <h1>What your history suggests, with the sample sizes attached.</h1>
      <p>${c.commits} of your commits across ${c.gitProjects} repos, plus ${c.fileProjects} folders without git, since ${c.firstDate ?? '—'}. ${c.foreignExcluded} clones of other people's repos are left out.</p>
    </div>

    <section>
      <h2 class="label">At a glance</h2>
      <div class="figures">
        ${fig(p.breadth.medianPerActiveWeek, ' / wk', `projects touched in a typical active week. Last four weeks averaged ${p.breadth.recent4}; before that ${p.breadth.prior}.`)}
        ${fig(p.startsVsFinishes.started, ` : ${p.startsVsFinishes.shipped}`, 'projects started vs. projects with any ship evidence, last 12 months.')}
        ${fig(pct(p.oneBurst.count / (p.oneBurst.n || 1)), '', `of ${p.oneBurst.n} projects got three or fewer active days in total.`)}
        ${fig(pct(p.attention.top3Share), '', 'of the last 90 days of attention went to your top three projects.')}
      </div>
    </section>

    <section>
      <h2 class="label">Projects touched per week · last 26 weeks</h2>
      ${bars(p.breadth.weeks.map((w) => w.projects), p.breadth.weeks.map((w, i) => (i % 4 === 0 ? w.week.slice(5) : '')))}
    </section>

    <section>
      <h2 class="label">Started <span class="n">ink</span> vs. shipped <span class="n" style="color:var(--accent)">accent</span> · by month</h2>
      ${bars(p.startsVsFinishes.months.map((m) => m.started), p.startsVsFinishes.months.map((m) => monthLabel(m.month)), p.startsVsFinishes.months.map((m) => m.shipped))}
      <p class="caveat">"Shipped" means a release tag, a launch-like commit, or a manual mark. It's probably an undercount.</p>
    </section>

    <section class="two">
      <div>
        <h2 class="label">How long things stay alive <span class="n">n=${p.lifespan.n}</span></h2>
        <dl class="facts">${Object.entries(p.lifespan.buckets).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
        <p class="caveat">First to last activity, for projects quiet 30+ days. Median ${p.lifespan.medianSpanDays} days span, ${p.lifespan.medianActiveDays} active days. ${p.revivals.revived} of ${p.revivals.gaps} quiet spells ended in a revival.</p>
      </div>
      <div>
        <h2 class="label">Attention · 90 days</h2>
        <dl class="facts">${p.attention.projects.map((a) => html`<dt>${a.activeDays} days</dt><dd>${a.name}</dd>`)}</dl>
      </div>
    </section>

    <section>
      <h2 class="label">Where things stop <span class="n">${p.stallPoint.quiet} quiet · ${p.stallPoint.profiled} profiled</span></h2>
      ${p.stallPoint.profiled ? html`<dl class="facts">
        ${Object.entries(p.stallPoint.byStage).sort((a, b) => b[1] - a[1]).map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}
      </dl>` : html`<p class="empty-state">Needs project profiles. Run <code>manager report</code>.</p>`}
      <p class="caveat">${p.stallPoint.quietWithShipEvidence} of ${p.stallPoint.quiet} quiet projects show any ship evidence.</p>
    </section>

    <section>
      <h2 class="label">Hypotheses</h2>
      ${hyp ? html`<ul class="notes">${hyp.report.hypotheses.map((h) => html`<li>${h.claim}
          <small>${h.confidence} confidence · n=${h.n} · ${h.evidence.join(' · ')}</small>
          <small>or: ${h.alternative}</small>
          <small>would change with: ${h.wouldChangeMyMind}</small></li>`)}</ul>
        <p class="caveat">${hyp.report.dataCaveat} Written ${ago(hyp.generatedAt)}.</p>`
      : html`<p class="empty-state">None yet. Run <code>manager patterns</code> to form some.</p>`}
    </section>

    <section>
      <h2 class="label">Energy, mood &amp; activity</h2>
      ${correlationBlock(corr)}
    </section>
  `);
}

function correlationBlock(corr: CorrelationReport): Html {
  const { energy, mood } = corr.scoredDays;
  if (Math.max(energy, mood) < corr.minDays) {
    return html`<p class="empty-state">Not enough scored days yet: energy ${energy}, mood ${mood}. Correlations appear after ${corr.minDays}.</p>`;
  }
  if (!corr.findings.length) return html`<p>No clear relationship across ${corr.checked} comparisons. That's a real result too.</p>`;
  return html`<ul class="notes">${corr.findings.map((f) => html`<li>${describeCorrelation(f)}</li>`)}</ul>
    <p class="caveat">Observations, not diagnoses. With ${corr.checked} comparisons, expect some to be chance.</p>`;
}

export function journalPage(entries: Entry[], checkins: Checkin[], corr: CorrelationReport, saved: boolean): string {
  const scale = (name: string) => html`<div class="scale"><span>${name}</span>${[1, 2, 3, 4, 5].map((n) =>
    html`<input type="radio" name="${name}" id="${name}${n}" value="${n}"><label for="${name}${n}">${n}</label>`)}</div>`;
  const when = (at: number) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return layout('Journal · Manager', 'journal', html`
    <div class="lede">
      <h1>${saved ? 'Noted.' : 'How is it going, honestly?'}</h1>
    </div>
    <section style="--i:1">
      <form class="log" method="post" action="/journal">
        <textarea name="text" required placeholder="feeling scattered, too many tabs open…" aria-label="Journal entry"></textarea>
        ${scale('energy')}
        ${scale('mood')}
        <button type="submit">Log it</button>
      </form>
      <p class="private">Stored only in data/journal.db on this machine, separate from project data.</p>
    </section>

    <section>
      <h2 class="label">Entries <span class="n">${entries.length}</span></h2>
      ${entries.length ? html`<ul class="entries">${entries.slice(0, 40).map((e) => html`<li>
        <div><time>${when(e.at)}</time>${e.energy || e.mood ? html`<span class="sc">${e.energy ? `energy ${e.energy}` : ''}${e.energy && e.mood ? ' · ' : ''}${e.mood ? `mood ${e.mood}` : ''}</span>` : ''}</div>
        <div>${e.text}</div></li>`)}</ul>` : html`<p class="empty-state">Nothing yet.</p>`}
    </section>

    <section>
      <h2 class="label">Energy, mood &amp; activity</h2>
      ${correlationBlock(corr)}
    </section>

    <section>
      <h2 class="label">Check-ins</h2>
      ${checkins.length ? checkins.map((c) => html`<dl class="qa" style="max-width:46rem;margin-bottom:2.5rem">
        <div class="meta">${when(c.at)}</div>
        ${c.questions.map((q, i) => html`<dt>${q.question}</dt><dd>${c.answers[i] ?? html`<span class="empty-state">no answer</span>`}</dd>`)}
      </dl>`) : html`<p class="empty-state">Run <code>manager checkin</code> in a terminal.</p>`}
    </section>
  `);
}

export function notFound(): string {
  return layout('Not found · Manager', null, html`<div class="lede"><h1>Nothing pinned here.</h1><p><a href="/">Back to the wall</a></p></div>`);
}

