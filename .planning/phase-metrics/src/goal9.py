"""Goal & Plan demo, v9: the phase as one object.

Goal card unchanged from v8. Phase card = stepper (tap any phase), name,
job line with the phase's own progress, Drona's line, then Train / Eat /
Recover pillars, each with its plan and its tracked targets.
Writes goal9-<variant>.html. Page is taller than a phone; render at
402 x PAGE_H and crop: card 1 = top 874pt, phase view = header + phase card.
"""
from pathlib import Path
import re

PAGE_H = 874
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


def stepper(names, cur):
    out = []
    for i, n in enumerate(names):
        if i < cur:
            out.append('<span class="st past">&#10003;</span>')
        elif i == cur:
            out.append(f'<span class="st cur"><i></i>{n}</span>')
        else:
            out.append(f'<span class="st">{i + 1}</span>')
        if i < len(names) - 1:
            out.append(f'<span class="ln{" past" if i < cur else ""}"></span>')
    return ''.join(out)


def strip(days, fuel):
    out = []
    for i, (lbl, sess) in enumerate(days):
        f = ' f' if i in fuel else ''
        rest = ' r' if sess == 'Rest' else ''
        out.append(f'<div class="dc{f}{rest}"><em>{lbl}</em><b>{sess}</b><s></s></div>')
    return ''.join(out)


def trow(name, now, rest, pct, status, tone):
    return f'<div class="tr"><span class="tn">{name}</span><span class="tv"><b>{now}</b> {rest}</span><span class="ts {tone}">{status}</span></div>'


def chips(items):
    return ''.join(f'<span>{n} <i>&rsaquo;</i></span>' for n in items)


def stack(p, c, f):
    tot = p * 4 + c * 4 + f * 9
    st = f'<div style="flex:{p*4/tot:.3f};background:#e0876b"></div><div style="flex:{c*4/tot:.3f};background:#52b9ae"></div><div style="flex:{f*9/tot:.3f};background:#d4a73c"></div>'
    leg = f'<div><s style="background:#e0876b"></s><b>{p}g</b> protein</div><div><s style="background:#52b9ae"></s><b>{c}g</b> carbs</div><div><s style="background:#d4a73c"></s><b>{f}g</b> fat</div>'
    return st, leg


V = {}
st, leg = stack(150, 255, 65)
V['fatloss'] = dict(
    goal='Summer Cut', pill='Fat loss', when='Week <b>6</b> of 12 &nbsp;&middot;&nbsp; ends Oct 30',
    hero_label='Phase metric &nbsp;&middot;&nbsp; <b>Bodyweight</b>', hero_tag='', logbtn='',
    hero='70.4', unit='kg', hero_sub='<b>0.8 kg</b> to this phase\'s target &nbsp;&middot;&nbsp; 2.4 to the goal',
    chart=line_chart([72.5, 72.2, 71.8, 71.6, 71.1, 70.8, 70.4], 7, 69.6, 68, 12, 67.3, 73.2, 'kg'),
    bar='<div class="seg past" style="flex:2"></div><div class="seg past" style="flex:2"></div><div class="seg" style="flex:3"><div class="fill" style="width:55%"></div></div><div class="seg" style="flex:1"></div><div class="seg" style="flex:3"></div><div class="seg" style="flex:1"></div>',
    phase='Phase 3 &nbsp;&middot;&nbsp; <b>Volume Cut</b>', phase_r='wk 2 of 3',
    stepper=stepper(['Foundation', 'Steady Cut', 'Volume Cut', 'Deload', 'Final Cut'], 2),
    pname='Volume Cut', pweeks='Weeks 5-7 &nbsp;&middot;&nbsp; wk 2 of 3',
    job='Bring weight 71.0 &rarr; 69.6 kg', job_pct='43%',
    coach='On pace. Protein is the one slipping; hit 150g on the two rest days and the scale will follow.',
    train_h='Push / Pull / Legs &nbsp;&middot;&nbsp; <b>4 days</b>',
    strip=strip([('D1', 'Push'), ('D2', 'Rest'), ('D3', 'Pull'), ('D4', 'Legs'), ('D5', 'Rest'), ('D6', 'Push'), ('D7', 'Rest')], {3, 5}),
    strip_cap='<s></s> Fuel day &nbsp;+300 kcal as carbs',
    train_rows=trow('Sessions', '3 of 4', 'this week', 75, 'On track', 'ok') + trow('Steps 8,000', '7,400', 'avg', 92, 'Close', 'ok') + trow('Cardio 2 a week', '1', 'done, Sat left', 50, 'Due', 'dim'),
    routines='Push A &middot; Pull A &middot; Legs A &middot; Push B',
    kcal='2,250', stack=st, leg=leg,
    eat_rows=trow('Protein 150g', '5 of 7', 'days hit', 71, 'Slipping', 'warn'),
    rec_h='Readiness <b>68</b> today',
    rec_rows=trow('Sleep 7h+', '6 of 7', 'nights', 86, 'On track', 'ok'),
    rule='Readiness under 40: drop one working set per exercise, cap RPE at 7.',
)

tmpl = Path(__file__).with_name("goal9.tmpl.html").read_text().replace('{{PAGE_H}}', str(PAGE_H))
for key, v in V.items():
    html = tmpl
    for k, val in v.items():
        html = html.replace('{{' + k.upper() + '}}', val)
    assert not re.search(r'\{\{[A-Z_]+\}\}', html), re.findall(r'\{\{[A-Z_]+\}\}', html)
    Path(__file__).with_name(f"goal9-{key}.html").write_text(html)
print("ok")
