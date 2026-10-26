"""Train / Eat / Recover as three individual, flat screens (demo)."""
from pathlib import Path

CSS = """
:root{--bg:#0a0a0a;--card:#1c1c1e;--mfg:#a1a1aa;--dim:#6a6a72;--lime:#c8ff00;--line:rgba(255,255,255,.08);--warn:#f59e0b;
  --p:#e0876b;--c:#52b9ae;--f:#d4a73c}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:402px;height:874px;overflow:hidden;background:var(--bg);color:#fff;font-family:system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.status{height:54px;position:relative}
.time{position:absolute;left:52px;top:17px;font-weight:600;font-size:17px}
.island{position:absolute;left:50%;top:11px;width:124px;height:36px;margin-left:-62px;background:#000;border-radius:20px}
.icons{position:absolute;right:30px;top:20px;display:flex;gap:6px;align-items:center}
.nav{height:44px;display:flex;align-items:center;padding:0 16px}
.nav svg{display:block}
.page{padding:6px 24px 0}
.eyebrow{font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--mfg)}
h1{font-size:34px;line-height:40px;font-weight:700;letter-spacing:-.8px;margin-top:4px}
.hero{margin-top:26px;display:flex;align-items:baseline;gap:8px}
.hero b{font-size:56px;line-height:58px;font-weight:700;letter-spacing:-2px}
.hero span{font-size:18px;color:var(--mfg);font-weight:500}
.herosub{margin-top:4px;font-size:15px;color:var(--mfg);font-weight:500}
.herosub .ok{color:var(--lime);font-weight:600}.herosub .warn{color:var(--warn);font-weight:600}
.sec{margin-top:34px}
.sh{font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:var(--mfg);margin-bottom:12px}
.week{display:flex;justify-content:space-between}
.day{width:44px;display:flex;flex-direction:column;align-items:center;gap:8px}
.day em{font-style:normal;font-size:11px;font-weight:600;color:var(--dim)}
.dot{width:40px;height:40px;border-radius:20px;display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:700;color:#fff;background:var(--card)}
.dot.done{background:var(--lime);color:#0a0a0a}
.dot.today{background:transparent;box-shadow:inset 0 0 0 2px var(--lime);color:var(--lime)}
.dot.rest{background:transparent;color:var(--dim);font-weight:500}
.dot.fuel{box-shadow:inset 0 0 0 2px var(--lime)}
.day b{font-size:11px;font-weight:600;color:var(--mfg)}
.row{display:flex;align-items:center;height:52px;border-bottom:1px solid var(--line)}
.row:first-of-type{border-top:1px solid var(--line)}
.row .n{flex:1;font-size:16px;font-weight:500}
.row .v{font-size:15px;color:var(--mfg);font-weight:500;margin-right:16px}
.row .v b{color:#fff;font-weight:600}
.row .s{font-size:13px;font-weight:600;min-width:62px;text-align:right}
.ok{color:var(--lime)}.warn{color:var(--warn)}.dimc{color:var(--dim)}
.row .chev{color:var(--dim);font-size:22px;margin-left:10px}
.row .meta{font-size:14px;color:var(--mfg);font-weight:500}
.note{margin-top:30px;display:flex;gap:12px}
.note i{flex:none;width:3px;border-radius:2px;background:var(--lime)}
.note p{font-size:15px;line-height:21px;color:#e4e4e7;font-weight:500}
.macros{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px}
.mc b{display:block;font-size:26px;font-weight:700;letter-spacing:-.6px}
.mc span{display:block;font-size:13px;color:var(--mfg);font-weight:500;margin-top:2px}
.mc i{display:block;height:4px;border-radius:2px;margin-top:10px}
.sleep{display:flex;justify-content:space-between;align-items:flex-end;height:118px;margin-bottom:28px;border-bottom:1px dashed rgba(255,255,255,.12)}
.nt{width:40px;display:flex;flex-direction:column;align-items:center;gap:6px}
.nt i{display:block;width:26px;border-radius:7px}
.nt em{font-style:normal;font-size:11px;font-weight:600;color:var(--dim);margin-bottom:-22px}
.nt .hv{font-size:11px;font-weight:600;color:var(--mfg)}
"""

STATUS = """<div class="status"><div class="time">9:41</div><div class="island"></div>
<div class="icons"><svg width="19" height="12" viewBox="0 0 19 12"><rect x="0" y="8" width="3.2" height="4" rx="1" fill="#fff"/><rect x="5" y="5.5" width="3.2" height="6.5" rx="1" fill="#fff"/><rect x="10" y="3" width="3.2" height="9" rx="1" fill="#fff"/><rect x="15" y="0" width="3.2" height="12" rx="1" fill="#fff"/></svg>
<svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.8" fill="none" stroke="rgba(255,255,255,.4)"/><rect x="2" y="2" width="20" height="9" rx="2.4" fill="#fff"/></svg></div></div>
<div class="nav"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></div>"""


def page(body):
    return f"<!doctype html><html><head><meta charset='utf-8'><style>{CSS}</style></head><body>{STATUS}<div class='page'>{body}</div></body></html>"


def day(lbl, sess, cls):
    return f'<div class="day"><em>{lbl}</em><div class="dot {cls}">{"&#10003;" if cls=="done" else sess[:1] if cls!="rest" else "&ndash;"}</div><b>{sess}</b></div>'


TRAIN = page(f"""
<div class="eyebrow">Deficit block 1 &middot; Week 4 of 5</div>
<h1>Train</h1>
<div class="hero"><b>3</b><span>of 4 sessions this week</span></div>
<div class="herosub">Push / Pull / Legs &middot; <span class="ok">On track</span></div>
<div class="sec"><div class="sh">This week</div>
  <div class="week">{day('M','Push','done')}{day('T','Pull','done')}{day('W','Legs','done')}{day('T','Rest','rest')}{day('F','Push','today')}{day('S','Pull','')}{day('S','Rest','rest')}</div></div>
<div class="sec"><div class="sh">Targets</div>
  <div class="row"><span class="n">Steps</span><span class="v"><b>7,400</b> of 8,000</span><span class="s ok">Close</span></div>
  <div class="row"><span class="n">Cardio</span><span class="v"><b>1</b> of 2</span><span class="s dimc">Due Sat</span></div></div>
<div class="sec"><div class="sh">Workouts</div>
  <div class="row"><span class="n">Push</span><span class="meta">5 exercises</span><span class="chev">&rsaquo;</span></div>
  <div class="row"><span class="n">Pull</span><span class="meta">5 exercises</span><span class="chev">&rsaquo;</span></div>
  <div class="row"><span class="n">Legs</span><span class="meta">5 exercises</span><span class="chev">&rsaquo;</span></div></div>
""")

EAT = page(f"""
<div class="eyebrow">Deficit block 1 &middot; Week 4 of 5</div>
<h1>Eat</h1>
<div class="hero"><b>1,800</b><span>kcal a day</span></div>
<div class="herosub">Protein 5 of 7 days &middot; <span class="warn">Slipping</span></div>
<div class="sec"><div class="sh">Daily targets</div>
  <div class="macros">
    <div class="mc"><b>115g</b><span>Protein</span><i style="background:var(--p)"></i></div>
    <div class="mc"><b>225g</b><span>Carbs</span><i style="background:var(--c)"></i></div>
    <div class="mc"><b>50g</b><span>Fat</span><i style="background:var(--f)"></i></div>
  </div></div>
<div class="sec"><div class="sh">Fuel days &middot; +300 kcal as carbs</div>
  <div class="week">{day('M','Push','')}{day('T','Pull','')}{day('W','Legs','fuel')}{day('T','Rest','rest')}{day('F','Push','')}{day('S','Pull','fuel')}{day('S','Rest','rest')}</div></div>
<div class="note"><i></i><p>Protein first, every meal. Log it and I hold the line.</p></div>
""")

nights=[('M',7.4),('T',7.1),('W',6.6),('T',7.6),('F',7.2),('S',7.9),('S',7.3)]
bars=''.join(f'<div class="nt"><span class="hv">{h}</span><i style="height:{int((h-5)/3.5*70)+8}px;background:{"var(--lime)" if h>=7 else "#3a3a40"}"></i><em>{d}</em></div>' for d,h in nights)
RECOVER = page(f"""
<div class="eyebrow">Deficit block 1 &middot; Week 4 of 5</div>
<h1>Recover</h1>
<div class="hero"><b>7.3</b><span>h sleep a night</span></div>
<div class="herosub">6 of 7 nights at 7h+ &middot; <span class="ok">On track</span></div>
<div class="sec"><div class="sh">Today</div>
  <div class="row"><span class="n">Readiness</span><span class="v"><b>68</b></span><span class="s ok">Push today</span></div>
  <div class="row"><span class="n">Resting heart rate</span><span class="v"><b>58</b> bpm</span><span class="s ok">Low</span></div>
  <div class="row"><span class="n">HRV</span><span class="v"><b>64</b> ms</span><span class="s ok">Up</span></div></div>
<div class="sec"><div class="sh">Last 7 nights</div>
  <div class="sleep">{bars}</div></div>
<div class="note"><i></i><p>On a low-readiness day cut the top set, keep the working volume.</p></div>
""")

out = Path(__file__).parent
for name, html in [('train', TRAIN), ('eat', EAT), ('recover', RECOVER)]:
    (out / f'pillar-{name}.html').write_text(html)
print('ok')
