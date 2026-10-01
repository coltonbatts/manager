// Claude usage on the dashboard: a compact masthead gauge on every page,
// and a fuller section on the journal page.

import { compact } from '../commands/usage.ts';
import { usd, type TaskUsage } from '../usage/calls.ts';
import { elapsedFraction, type Limit } from '../usage/limits.ts';
import type { UsageTotals } from '../usage/transcripts.ts';
import { ago } from '../ui.ts';
import { html, raw, type Html } from './html.ts';

export interface UsageView {
  at: number | null; // when limits were last fetched
  limits: Limit[];
  error: string | null;
}

const shortLabel = (l: Limit) => (l.label.startsWith('session') ? 'Session' : l.label.startsWith('week (all') ? 'Week' : l.label.replace(/^week\s*/, 'Week ').replace(/[()]/g, ''));

function resetShort(l: Limit, now: number): string {
  if (!l.resetsAt) return l.resetsText ?? '';
  const d = new Date(l.resetsAt);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(':00', '').replace(' ', '').toLowerCase();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? time : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
}

function state(l: Limit, now: number): 'ok' | 'ahead' | 'high' {
  if (l.percent >= 85) return 'high';
  const pace = elapsedFraction(l, now);
  return pace !== null && l.percent / 100 > pace + 0.1 ? 'ahead' : 'ok';
}

function gauge(l: Limit, now: number, size: 'small' | 'large'): Html {
  const pace = elapsedFraction(l, now);
  const pct = Math.min(100, Math.max(0, l.percent));
  const s = state(l, now);
  const title = `${l.label}: ${Math.round(l.percent)}% used${l.resetsText ? `, resets ${l.resetsText}` : ''}${pace !== null ? `. ${Math.round(pace * 100)}% of the window has passed.` : ''}`;
  return html`<div class="gauge ${size} ${s}" title="${title}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}" aria-label="${title}">
    <span class="g-label">${shortLabel(l)}</span>
    <span class="g-track"><span class="g-fill" style="width:${pct.toFixed(1)}%"></span>${pace !== null ? html`<span class="g-pace" style="left:${(pace * 100).toFixed(1)}%"></span>` : ''}</span>
    <span class="g-pct">${Math.round(l.percent)}%</span>
    ${size === 'large' || l.resetsAt ? html`<span class="g-reset">${size === 'large' ? 'resets ' : ''}${resetShort(l, now)}</span>` : ''}
  </div>`;
}

/** The masthead widget. Re-rendered by /api/usage for live updates. */
export function usageWidget(u: UsageView, now = Date.now()): Html {
  const main = u.limits.filter((l) => l.label.startsWith('session') || l.label.startsWith('week (all'));
  const stale = !u.at || now - u.at > 20 * 60_000;
  if (!main.length) {
    return html`<a class="usage empty" id="usage" href="/journal#claude" title="${u.error ?? 'No usage data yet'}">Claude usage · ${u.error ? 'unavailable' : 'loading'}</a>`;
  }
  return html`<a class="usage ${stale ? 'stale' : ''}" id="usage" href="/journal#claude" title="Claude plan usage, updated ${ago(u.at)}">
    ${main.map((l) => gauge(l, now, 'small'))}
  </a>`;
}

export interface UsageSectionData {
  view: UsageView;
  days: ({ date: string } & UsageTotals)[];
  projects: { project: string; requests: number; output: number }[];
  models: { model: string; requests: number }[];
  calls: TaskUsage[]; // Manager's own LLM calls, last 7 days
}

function dayBars(days: UsageSectionData['days']): Html {
  const W = 720;
  const H = 110;
  const max = Math.max(1, ...days.map((d) => d.requests));
  const slot = W / days.length;
  let out = '';
  days.forEach((d, i) => {
    const h = (d.requests / max) * (H - 24);
    const x = i * slot + slot * 0.18;
    const cls = i === days.length - 1 ? ' class="alt"' : '';
    out += `<rect${cls} x="${x.toFixed(1)}" y="${(H - 18 - h).toFixed(1)}" width="${(slot * 0.64).toFixed(1)}" height="${Math.max(h, d.requests ? 2 : 0.5).toFixed(1)}"><title>${d.date}: ${d.requests} requests, ${compact(d.output)} output tokens</title></rect>`;
    if (i % 2 === 0 || i === days.length - 1) {
      const label = new Date(`${d.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      out += `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${label}</text>`;
    }
  });
  return raw(`<svg class="bars" viewBox="0 0 ${W} ${H}" role="img" aria-label="Claude requests per day, last ${days.length} days">${out}</svg>`);
}

function managerCalls(calls: TaskUsage[]): Html {
  if (!calls.length) return html`<h3 class="label" style="margin-top:3rem">Manager's own calls · 7 days</h3><p class="empty-state">None yet. Calls are recorded from now on.</p>`;
  const total = calls.reduce((a, c) => a + c.costUsd, 0);
  const n = calls.reduce((a, c) => a + c.calls, 0);
  return html`<h3 class="label" style="margin-top:3rem">Manager's own calls · 7 days <span class="n">${n}</span></h3>
    <dl class="facts">${calls.map((c) => html`<dt>${c.calls}</dt><dd>${c.task} <span class="n">${c.model.replace(/^claude-/, '')} · ${compact(c.output)} out · ${usd(c.costUsd)}${c.failed ? ` · ${c.failed} unusable` : ''}</span></dd>`)}</dl>
    <p class="caveat">${usd(total)} at list prices, which is an estimate: a subscription isn't billed per token. These calls leave no transcript, so they're counted here and not in the requests above.</p>`;
}

export function usageSection(d: UsageSectionData, now = Date.now()): Html {
  const { view } = d;
  const total = d.days.reduce((a, x) => a + x.requests, 0);
  const week = d.days.slice(-7);
  const weekReq = week.reduce((a, x) => a + x.requests, 0);
  const weekOut = week.reduce((a, x) => a + x.output, 0);
  const totalModels = d.models.reduce((a, m) => a + m.requests, 0) || 1;
  const ahead = view.limits.filter((l) => state(l, now) !== 'ok');

  return html`<section id="claude">
    <h2 class="label">Claude <span class="n">${view.at ? `updated ${ago(view.at)}` : 'not yet fetched'}</span></h2>
    ${view.limits.length ? html`
      <div class="gauges">${view.limits.map((l) => gauge(l, now, 'large'))}</div>
      <p class="caveat">The thin mark shows how far into each window you are. A fill past the mark means you're using faster than an even pace.${ahead.length ? ` Right now that's true for: ${ahead.map((l) => shortLabel(l).toLowerCase()).join(', ')}.` : ''}</p>`
      : html`<p class="empty-state">${view.error ? `Plan limits unavailable: ${view.error}` : 'Plan limits will appear after the first refresh.'}</p>`}
    <div class="two" style="margin-top:3rem">
      <div>
        <h3 class="label">Requests per day · last ${d.days.length} days <span class="n">${total}</span></h3>
        ${dayBars(d.days)}
        <p class="caveat">Last 7 days: ${weekReq} requests, ${compact(weekOut)} output tokens.</p>
      </div>
      <div>
        <h3 class="label">Where it went · 7 days</h3>
        ${d.projects.length ? html`<dl class="facts">${d.projects.map((p) => html`<dt>${p.requests}</dt><dd>${p.project}</dd>`)}</dl>` : html`<p class="empty-state">No sessions this week.</p>`}
        ${d.models.length ? html`<p class="caveat">${d.models.slice(0, 3).map((m) => `${m.model.replace(/^claude-/, '')} ${Math.round((m.requests / totalModels) * 100)}%`).join(' · ')}</p>` : ''}
      </div>
    </div>
    ${managerCalls(d.calls)}
    <p class="private">From <code>claude /usage</code> and the token counts in your local Claude Code transcripts. Only numbers are read, never conversation text. Doesn't include claude.ai or other devices.</p>
  </section>`;
}
