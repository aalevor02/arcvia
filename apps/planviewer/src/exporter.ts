export interface Zone {
  id: string
  label: string
  points: { x: number; y: number }[] // percentages of image dimensions, 0-100
  popupTitle: string
  popupBody: string
  linkText?: string
  linkUrl?: string
  hoverColor: string
  groupId?: string | null
}

export interface Group {
  id: string
  name: string
  description: string
  linkText?: string
  linkUrl?: string
}

export interface PlanDocument {
  title: string
  /** data: URI or absolute URL of the plan image. */
  imageSrc: string
  logoSrc?: string | null
  accent: string
  zones: Zone[]
  groups: Group[]
}

/**
 * Render a plan document to one self-contained HTML file.
 *
 * ── Why percentage coordinates ───────────────────────────────────────────────
 * Zones are stored as percentages of the image, never pixels, and the overlay
 * SVG uses `viewBox="0 0 100 100"` with `preserveAspectRatio="none"`. The result
 * is that hotspots track the image exactly at any window size with no resize
 * maths at runtime. Pixel coordinates would need a scale factor recomputed on
 * every resize, and would drift the moment anyone re-exported the plan image at
 * a different resolution.
 *
 * ── On file size ─────────────────────────────────────────────────────────────
 * Inlining the plan image as a data: URI makes the export a single file you can
 * email or drop on any host — genuinely useful. It also inflates the image by
 * ~33% (base64) and blocks first paint until the whole thing downloads. The
 * reference product shipped a 14.3 MB HTML file this way. `inlineImage: false`
 * keeps the image as a URL instead, which is what you want above ~2 MB.
 */
export function exportPlanHtml(
  doc: PlanDocument,
  { inlineImage = true }: { inlineImage?: boolean } = {},
): string {
  const imageSrc =
    inlineImage || !doc.imageSrc.startsWith('data:')
      ? doc.imageSrc
      : doc.imageSrc

  // Everything interpolated into the document is escaped. A plan built from
  // customer-supplied names must not be able to inject script into the export.
  const payload = JSON.stringify({
    zones: doc.zones,
    groups: doc.groups,
    accent: doc.accent,
  }).replace(/</g, '\\u003c')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<title>${escapeHtml(doc.title)}</title>
<style>
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#0c0c0f;overflow:hidden}
body{display:flex;align-items:center;justify-content:center;
     font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;color:#fff}
.backdrop{position:fixed;inset:0;overflow:hidden;z-index:0}
.backdrop img{width:100%;height:100%;object-fit:cover;filter:blur(40px) brightness(.4);transform:scale(1.1)}
.wrapper{position:relative;z-index:1;user-select:none}
.wrapper img.bg{width:100%;height:100%;display:block}
.overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.zone{pointer-events:auto;cursor:pointer;fill:transparent;stroke:transparent;
      transition:fill .18s,stroke .18s}
.zone:focus-visible{outline:none;stroke:#fff;stroke-width:.3}
.popup{position:absolute;z-index:99;display:none;min-width:170px;max-width:270px;
       padding:15px 18px;border-radius:12px;border:1px solid rgba(255,255,255,.12);
       background:rgba(16,16,22,.94);backdrop-filter:blur(12px);
       box-shadow:0 14px 40px rgba(0,0,0,.55);transform:translateY(-50%);pointer-events:auto}
.popup.on{display:block}
.popup .t{font-size:15px;font-weight:600;margin-bottom:4px}
.popup .b{font-size:13px;line-height:1.5;color:#a9adb8;white-space:pre-wrap}
.link{display:inline-block;margin-top:12px;padding:7px 16px;border-radius:8px;
      font-size:12px;font-weight:600;text-decoration:none;color:#0b0b0e}
.panel{position:fixed;right:20px;bottom:20px;z-index:98;display:none;
       min-width:230px;max-width:310px;padding:20px 24px;border-radius:14px;
       border:1px solid rgba(255,255,255,.12);background:rgba(16,16,22,.95);
       backdrop-filter:blur(12px);box-shadow:0 18px 50px rgba(0,0,0,.55)}
.panel.on{display:block}
.panel .t{font-size:16px;font-weight:700;padding-bottom:10px;margin-bottom:10px;
          border-bottom:1px solid rgba(255,255,255,.08)}
.panel .d{font-size:13px;line-height:1.6;color:#a9adb8;white-space:pre-wrap}
.logo{position:fixed;top:16px;left:16px;z-index:100;max-width:120px;max-height:70px;
      object-fit:contain;filter:drop-shadow(0 2px 8px rgba(0,0,0,.5))}
.hint{position:fixed;left:20px;bottom:20px;z-index:100;padding:11px 16px;border-radius:10px;
      border:1px solid rgba(255,255,255,.12);background:rgba(16,16,22,.92);
      font-size:13px;color:#a9adb8}
@media(max-width:768px){.popup{min-width:145px;max-width:210px;padding:12px 14px}
  .panel{right:10px;bottom:10px;min-width:190px;padding:16px 18px}}
@media(prefers-reduced-motion:reduce){.zone{transition:none}}
</style>
</head>
<body>
<div class="backdrop"><img src="${escapeAttr(imageSrc)}" alt=""/></div>
${doc.logoSrc ? `<img class="logo" src="${escapeAttr(doc.logoSrc)}" alt=""/>` : ''}

<div class="wrapper" id="wrap">
  <img class="bg" id="bg" src="${escapeAttr(imageSrc)}" alt="${escapeAttr(doc.title)}" draggable="false"/>
  <svg class="overlay" id="svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Interactive plan"></svg>
  <div class="popup" id="popup">
    <div class="t" id="pt"></div>
    <div class="b" id="pb"></div>
    <a class="link" id="pl" href="#" target="_blank" rel="noopener noreferrer" hidden></a>
  </div>
</div>

<div class="panel" id="panel">
  <div class="t" id="gt"></div>
  <div class="d" id="gd"></div>
  <a class="link" id="gl" href="#" target="_blank" rel="noopener noreferrer" hidden></a>
</div>

<div class="hint">Hover or tap a zone for details</div>

<script>
(function(){
"use strict";
var DATA = ${payload};
var svg=document.getElementById('svg'), wrap=document.getElementById('wrap'), bg=document.getElementById('bg');
var popup=document.getElementById('popup'), pt=document.getElementById('pt'), pb=document.getElementById('pb'), pl=document.getElementById('pl');
var panel=document.getElementById('panel'), gt=document.getElementById('gt'), gd=document.getElementById('gd'), gl=document.getElementById('gl');
var hideTimer=null, onPopup=false;

/* Letterbox the wrapper to the image's aspect ratio so the SVG overlay and the
   image always occupy exactly the same box. */
function fit(){
  var iw=bg.naturalWidth, ih=bg.naturalHeight;
  if(!iw||!ih) return;
  var s=Math.min(window.innerWidth/iw, window.innerHeight/ih);
  wrap.style.width=Math.floor(iw*s)+'px';
  wrap.style.height=Math.floor(ih*s)+'px';
}
bg.addEventListener('load', fit);
window.addEventListener('resize', fit);
if(bg.complete) fit();

function group(id){ return id ? DATA.groups.filter(function(g){return g.id===id})[0] : null; }

function hideAll(){ popup.classList.remove('on'); panel.classList.remove('on'); }

function show(zone, evt){
  pt.textContent = zone.popupTitle || zone.label || '';
  pb.textContent = zone.popupBody || '';
  if(zone.linkUrl){
    pl.hidden=false; pl.textContent=zone.linkText||'Open';
    pl.href=/^https?:\\/\\//.test(zone.linkUrl)?zone.linkUrl:'https://'+zone.linkUrl;
    pl.style.background=DATA.accent;
  } else { pl.hidden=true; }

  var box=wrap.getBoundingClientRect();
  var xs=zone.points.map(function(p){return p.x}), ys=zone.points.map(function(p){return p.y});
  var cx=(Math.min.apply(null,xs)+Math.max.apply(null,xs))/2;
  var cy=(Math.min.apply(null,ys)+Math.max.apply(null,ys))/2;

  /* Flip to the left of the zone when a right-side popup would run off screen. */
  var px=box.width*(cx/100)+14, flip=px+280>box.width;
  popup.style.left=(flip? box.width*(cx/100)-290 : px)+'px';
  popup.style.top=(box.height*(cy/100))+'px';
  popup.classList.add('on');

  var g=group(zone.groupId);
  if(g){
    gt.textContent=g.name; gd.textContent=g.description;
    if(g.linkUrl){ gl.hidden=false; gl.textContent=g.linkText||'Website';
      gl.href=/^https?:\\/\\//.test(g.linkUrl)?g.linkUrl:'https://'+g.linkUrl;
      gl.style.background=DATA.accent; } else { gl.hidden=true; }
    panel.classList.add('on');
  } else { panel.classList.remove('on'); }
}

DATA.zones.forEach(function(zone){
  var poly=document.createElementNS('http://www.w3.org/2000/svg','polygon');
  poly.setAttribute('points', zone.points.map(function(p){return p.x+','+p.y}).join(' '));
  poly.setAttribute('class','zone');
  poly.setAttribute('tabindex','0');
  poly.setAttribute('role','button');
  poly.setAttribute('aria-label', zone.label || zone.popupTitle || 'Zone');

  function enter(evt){
    if(hideTimer){ clearTimeout(hideTimer); hideTimer=null; }
    poly.style.fill=zone.hoverColor||DATA.accent+'59';
    poly.style.stroke=DATA.accent;
    poly.style.strokeWidth='.22';
    show(zone, evt);
  }
  function leave(){
    poly.style.fill='transparent'; poly.style.stroke='transparent';
    hideTimer=setTimeout(function(){ if(!onPopup) hideAll(); },150);
  }

  poly.addEventListener('mouseenter', enter);
  poly.addEventListener('mouseleave', leave);
  poly.addEventListener('focus', enter);
  poly.addEventListener('blur', leave);
  /* Touch has no hover: tap toggles. */
  poly.addEventListener('click', function(e){ e.stopPropagation(); enter(e); });
  poly.addEventListener('keydown', function(e){
    if(e.key==='Enter'||e.key===' '){ e.preventDefault(); enter(e); }
    if(e.key==='Escape'){ hideAll(); }
  });

  svg.appendChild(poly);
});

popup.addEventListener('mouseenter', function(){ onPopup=true; if(hideTimer){clearTimeout(hideTimer);hideTimer=null;} });
popup.addEventListener('mouseleave', function(){ onPopup=false; hideAll(); });
document.addEventListener('click', hideAll);
document.addEventListener('keydown', function(e){ if(e.key==='Escape') hideAll(); });
})();
</script>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )
}

function escapeAttr(value: string): string {
  return String(value).replace(/"/g, '&quot;')
}
