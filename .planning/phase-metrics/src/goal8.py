"""Goal & Plan demo, v7: coach-chosen phase metrics.

Each phase has one hero metric (what the phase is judged on) and supporting
targets, all picked by Drona from what the app already tracks. The chart
plots the hero metric; a habit-type metric gets a week grid instead of a line.
Writes goal7-<variant>.html (402x874 pt, content scrolls past the bottom).
"""
from pathlib import Path

CW, CH = 334, 88
PADT, PADB = 12, 22
X0, X1 = 4, CW - 16


def line_chart(values, phase_end_week, phase_target, target, weeks, lo, hi, unit):
    def X(w): return X0 + (X1 - X0) * w / weeks
    def Y(v): return PADT + (CH - PADT - PADB) * (hi - v) / (hi - lo)
    pts = [(X(w), Y(v)) for w, v in enumerate(values)]
    d = f"M{pts[0][0]:.1f},{pts[0][1]:.1f}"
    for i in range(len(pts) - 1):
        p0 = pts[i - 1] if i else pts[i]
        p1, p2 = pts[i], pts[i + 1]
        p3 = pts[i + 2] if i + 2 < len(pts) else p2
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f" C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}"
    nx, ny = pts[-1]
    px, py = X(phase_end_week), Y(phase_target)
    tx, ty = X(weeks), Y(target)
    return f"""
<svg width="{CW}" height="{CH}" viewBox="0 0 {CW} {CH}" style="display:block;overflow:visible">
  <path d="M{nx:.1f},{ny:.1f} L{px:.1f},{py:.1f} L{tx:.1f},{ty:.1f}" stroke="rgba(255,255,255,.38)" stroke-width="2" stroke-dasharray="1 6" stroke-linecap="round" fill="none"/>
  <path d="{d}" stroke="#c8ff00" stroke-width="2.5" fill="none" stroke-linecap="round"/>
  <circle cx="{nx:.1f}" cy="{ny:.1f}" r="5.5" fill="#c8ff00"/>
  <circle cx="{nx:.1f}" cy="{ny:.1f}" r="2.2" fill="#0a0a0a"/>
  <circle cx="{px:.1f}" cy="{py:.1f}" r="4" fill="#1c1c1e" stroke="#c8ff00" stroke-width="2"/>
  <text x="{px:.1f}" y="{py + 20:.1f}" text-anchor="middle" font-family="system-ui" font-size="10.5" font-weight="600" fill="#c8ff00">{phase_target} by wk {phase_end_week}</text>
  <g transform="translate({tx:.1f},{ty:.1f})">
    <circle r="9" fill="#1c1c1e" stroke="rgba(255,255,255,.5)" stroke-width="1.4"/>
    <path d="M-2.8,4.2 L-2.8,-4.6 M-2.8,-4.6 L3.8,-2.5 L-2.8,-0.4" stroke="#fff" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="{tx:.1f}" y="{ty + 22:.1f}" text-anchor="middle" font-family="system-ui" font-size="10.5" font-weight="600" fill="#a1a1aa">{target} {unit}</text>
</svg>"""


def habit_grid(weeks_done, per_week, weeks, cur_week):
    """No measurable number: a week-by-week grid of sessions. Lime = done."""
    cells = []
    for w in range(weeks):
        done = weeks_done[w] if w < len(weeks_done) else 0
        for s in range(per_week):
            if w < cur_week - 1 or (w == cur_week - 1 and s < done):
                c = '#c8ff00' if s < done else '#3a3a40'
            elif w == cur_week - 1:
                c = '#3a3a40'
            else:
                c = '#2a2a2e'
            cells.append(f'<i style="background:{c}"></i>')
    return f'<div class="grid" style="grid-template-rows:repeat({per_week},1fr);grid-auto-flow:column">{"".join(cells)}</div><div class="gl"><span>Week 1</span><span>Week {weeks}</span></div>'


def bars_chart(values, target, weeks, cur_week, unit_label):
    """Habit metric: one bar per week against a dotted target line."""
    top, bot, mx = 14, CH - 18, max(target, *values) + 1
    slot = (X1 - X0) / weeks
    bw = slot * 0.62
    out = []
    for w in range(weeks):
        x = X0 + w * slot + (slot - bw) / 2
        if w < len(values):
            h = (bot - top) * values[w] / mx
            fill = '#c8ff00' if w < cur_week - 1 else 'rgba(200,255,0,.45)'
            out.append(f'<rect x="{x:.1f}" y="{bot - h:.1f}" width="{bw:.1f}" height="{h:.1f}" rx="4" fill="{fill}"/>')
        else:
            out.append(f'<rect x="{x:.1f}" y="{bot - 6}" width="{bw:.1f}" height="6" rx="3" fill="#2e2e33"/>')
        out.append(f'<text x="{x + bw / 2:.1f}" y="{bot + 13}" text-anchor="middle" font-family="system-ui" font-size="10" font-weight="600" fill="#6a6a72">{w + 1}</text>')
    ty = bot - (bot - top) * target / mx
    return f"""
<svg width="{CW}" height="{CH}" viewBox="0 0 {CW} {CH}" style="display:block;overflow:visible">
  {''.join(out)}
  <line x1="{X0}" x2="{X1}" y1="{ty:.1f}" y2="{ty:.1f}" stroke="rgba(255,255,255,.45)" stroke-width="1.5" stroke-dasharray="2 5" stroke-linecap="round"/>
  <text x="{X1}" y="{ty - 6:.1f}" text-anchor="end" font-family="system-ui" font-size="10.5" font-weight="600" fill="#a1a1aa">{unit_label}</text>
</svg>"""


def macros(kcal, p, c, f):
    tot = p * 4 + c * 4 + f * 9
    return f"""<div class="mac"><div class="row"><span class="eyebrow">Daily targets</span><span class="kc"><b>{kcal}</b> kcal</span></div>
<div class="stack"><div style="flex:{p*4/tot:.3f};background:#e0876b"></div><div style="flex:{c*4/tot:.3f};background:#52b9ae"></div><div style="flex:{f*9/tot:.3f};background:#d4a73c"></div></div>
<div class="leg"><div><s style="background:#e0876b"></s><b>{p}g</b> protein</div><div><s style="background:#52b9ae"></s><b>{c}g</b> carbs</div><div><s style="background:#d4a73c"></s><b>{f}g</b> fat</div></div></div>"""


def strip(days, fuel):
    out = []
    for i, (lbl, sess) in enumerate(days):
        f = ' f' if i in fuel else ''
        rest = ' r' if sess == 'Rest' else ''
        out.append(f'<div class="dc{f}{rest}"><em>{lbl}</em><b>{sess}</b><s></s></div>')
    return ''.join(out)


def metric(name, now, goal, pct, status, tone):
    return f'''<div class="m"><div class="mt"><span class="mn">{name}</span><span class="ms {tone}">{status}</span></div>
<div class="mv"><b>{now}</b><i>{goal}</i></div><div class="mb"><span style="width:{pct}%"></span></div></div>'''


VARIANTS = {
    'fatloss': dict(
        goal='Summer Cut', pill='Fat loss', when='Week <b>6</b> of 12 &nbsp;&middot;&nbsp; ends Oct 30',
        hero_label='Phase metric &nbsp;&middot;&nbsp; <b>Bodyweight</b>', hero='70.4', unit='kg',
        hero_sub='<b>0.8 kg</b> to this phase\'s target &nbsp;&middot;&nbsp; 2.4 to the goal',
        chart=line_chart([72.5, 72.2, 71.8, 71.6, 71.1, 70.8, 70.4], 7, 69.6, 68, 12, 67.3, 73.2, 'kg'),
        bar='<div class="seg past" style="flex:2"></div><div class="seg past" style="flex:2"></div><div class="seg" style="flex:3"><div class="fill" style="width:55%"></div></div><div class="seg" style="flex:1"></div><div class="seg" style="flex:3"></div><div class="seg" style="flex:1"></div>',
        phase='Phase 3 &nbsp;&middot;&nbsp; <b>Volume Cut</b>', phase_r='wk 2 of 3',
        coach='On pace. Protein is the one slipping; hit 150g on the two rest days and the scale will follow.',
        strip=strip([('D1', 'Push'), ('D2', 'Rest'), ('D3', 'Pull'), ('D4', 'Legs'), ('D5', 'Rest'), ('D6', 'Push'), ('D7', 'Rest')], {3, 5}),
        strip_cap='<s></s> Fuel day &nbsp;+300 kcal as carbs',
        macros=macros('2,250', 150, 255, 65), hero_tag='', logbtn='',
        metrics=(metric('Protein 150g', '5 of 7', 'days this week', 71, 'Slipping', 'warn')
                 + metric('Cardio 2 a week', '1', 'done, Sat left', 50, 'Due', 'dim')
                 + metric('Steps 8,000', '7,400', 'avg this week', 92, 'Close', 'ok')
                 + metric('Sleep 7h+', '6 of 7', 'nights', 86, 'On track', 'ok')),
        rule='Readiness under 40: drop one working set per exercise, cap RPE at 7.',
        rows=[('Foundation', 'Weeks 1-2', 'past', 'Bodyweight &rarr; 71.8'), ('Steady Cut', 'Weeks 3-4', 'past', 'Bodyweight &rarr; 71.0'),
              ('Volume Cut', 'Now', 'cur', 'Bodyweight &rarr; 69.6'), ('Deload', 'Week 8', 'next', 'Hold 69.6 &nbsp;&middot;&nbsp; sleep 7h+'),
              ('Final Cut', 'Weeks 9-12', 'next', 'Bodyweight &rarr; 68.0')],
    ),
    'fitness': dict(
        goal='Get Moving', pill='Fitness', when='Week <b>4</b> of 8 &nbsp;&middot;&nbsp; ends Dec 5',
        hero_label='Phase metric &nbsp;&middot;&nbsp; <b>Sessions a week</b>', hero='3', unit='of 4',
        hero_sub='No number to chase yet. Drona tracks the habit first.',
        chart=bars_chart([4, 3, 4, 3], 4, 8, 4, '4 a week'),
        macros=macros('2,100', 120, 230, 65), hero_tag='', logbtn='',
        bar='<div class="seg past" style="flex:2"></div><div class="seg" style="flex:3"><div class="fill" style="width:40%"></div></div><div class="seg" style="flex:3"></div>',
        phase='Phase 2 &nbsp;&middot;&nbsp; <b>Build the habit</b>', phase_r='wk 2 of 3',
        coach='Three a week is sticking. One more session and we start chasing a number in phase 3.',
        strip=strip([('D1', 'Full A'), ('D2', 'Walk'), ('D3', 'Full B'), ('D4', 'Rest'), ('D5', 'Full A'), ('D6', 'Walk'), ('D7', 'Rest')], set()),
        strip_cap='Walks count as sessions this phase',
        metrics=(metric('Sessions', '3', 'of 4 this week', 75, 'One to go', 'warn')
                 + metric('Steps 6,000', '6,900', 'avg this week', 100, 'Done', 'ok')
                 + metric('Sleep 7h+', '4 of 7', 'nights', 57, 'Behind', 'warn')
                 + metric('Protein 110g', '6 of 7', 'days', 86, 'On track', 'ok')),
        rule='Readiness under 40: swap the session for a walk.',
        rows=[('Show up', 'Weeks 1-2', 'past', '2 sessions a week'), ('Build the habit', 'Now', 'cur', '4 sessions a week'),
              ('First numbers', 'Weeks 6-8', 'next', 'Squat bodyweight &nbsp;&middot;&nbsp; 5 km walk')],
    ),
    'custom': dict(
        goal='Hold a Handstand', pill='Fitness', when='Week <b>3</b> of 8 &nbsp;&middot;&nbsp; ends Dec 12',
        hero_label='Phase metric &nbsp;&middot;&nbsp; <b>Handstand hold</b>', hero_tag='<span class="tag">You log it</span>',
        hero='12', unit='s', hero_sub='<b>3 s</b> to this phase\'s target &nbsp;&middot;&nbsp; 8 to the goal',
        logbtn='<span class="log">+ Log a hold</span>',
        chart=line_chart([4, 6, 9, 12], 4, 15, 20, 8, 2, 22, 's'),
        macros=macros('2,400', 130, 290, 70),
        bar='<div class="seg past" style="flex:2"></div><div class="seg" style="flex:2"><div class="fill" style="width:50%"></div></div><div class="seg" style="flex:4"></div>',
        phase='Phase 2 &nbsp;&middot;&nbsp; <b>Wall to free</b>', phase_r='wk 1 of 2',
        coach='Holds are climbing 3 s a week. Keep wrist prep daily; that is what is letting you push.',
        strip=strip([('D1', 'Hold'), ('D2', 'Rest'), ('D3', 'Hold'), ('D4', 'Full A'), ('D5', 'Rest'), ('D6', 'Hold'), ('D7', 'Rest')], set()),
        strip_cap='Holds before lifting on those days',
        metrics=(metric('Hold sessions', '2 of 3', 'this week', 67, 'One to go', 'warn')
                 + metric('Wrist prep 5 min', '6 of 7', 'days', 86, 'On track', 'ok')
                 + metric('Sleep 7h+', '5 of 7', 'nights', 71, 'Close', 'ok')
                 + metric('Protein 130g', '7 of 7', 'days', 100, 'Done', 'ok')),
        rule='Any wrist pain: skip the holds, keep the prep.',
        rows=[('Wrist prep', 'Weeks 1-2', 'past', 'Wall hold &rarr; 10 s'), ('Wall to free', 'Now', 'cur', 'Free hold &rarr; 15 s'),
              ('Free hold', 'Weeks 5-8', 'next', 'Free hold &rarr; 20 s')],
    ),
}

tmpl = Path(__file__).with_name("goal8.tmpl.html").read_text()
for key, v in VARIANTS.items():
    html = tmpl
    for k, val in v.items():
        if k == 'rows':
            continue
        html = html.replace('{{' + k.upper() + '}}', val)
    rows = []
    for name, when, state, metric_txt in v['rows']:
        d = {'past': 'd past', 'cur': 'd cur', 'next': 'd'}[state]
        rows.append(f'<div class="ph"><span class="{d}"></span><div class="pn"><span class="n{" past" if state == "past" else ""}">{name}</span><span class="pm">{metric_txt}</span></div><span class="w{" cur" if state == "cur" else ""}">{when}</span></div>')
    html = html.replace('{{PHASES}}', ''.join(rows))
    Path(__file__).with_name(f"goal8-{key}.html").write_text(html)
print("ok")
