/* Pixel Planet
   - canvas rendering grid masked to circular planet
   - localStorage + BroadcastChannel real-time sync
   - 10s cooldown per user
   - zoom & pan, pixel pop animations
   - time-lapse replay
*/

(() => {
  // Config
  const GRID_SIZE = 160; // planet grid NxN (keeps performance on mobile)
  const PIXEL_DISPLAY_SCALE = 4; // base pixel size, will scale with zoom
  const COOLDOWN = 10 * 1000; // 10 seconds
  const STORAGE_KEY = 'pixelPlanet_pixels_v1';
  const HISTORY_KEY = 'pixelPlanet_history_v1';
  const NICK_KEY = 'pixelPlanet_nick';
  const PALETTE = [
    '#00d4ff','#6ef0ff','#9b7cff','#c3a0ff','#ff9bd7',
    '#ffbd6b','#ffd36b','#7cffc7','#6bffb7','#ffffff',
    '#ff6b6b','#ff8b8b','#ffd3d3','#c9ffa9','#9bd0ff'
  ];

  // DOM
  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d', { alpha: true });
  const paletteEl = document.getElementById('palette');
  const cooldownTimerEl = document.getElementById('cooldown-timer');
  const pixelCountEl = document.getElementById('pixel-count');
  const recentListEl = document.getElementById('recent-list');
  const timelapseBtn = document.getElementById('timelapse-btn');
  const nickInput = document.getElementById('nick');
  const clearBtn = document.getElementById('clear-btn');
  const centerBtn = document.getElementById('center-btn');
  const colorToggle = document.getElementById('color-toggle');
  const zoomLevelEl = document.getElementById('zoom-level');
  const tooltip = document.getElementById('tooltip');

  let devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2.5);

  // State
  let canvasW = 1000, canvasH = 700;
  let view = { x: 0, y: 0, zoom: 1 }; // pan & zoom
  let dragging = false, dragStart = null;
  let selectedColor = PALETTE[0];
  let pixels = {}; // key "x,y" => {c:color, t:timestamp, nick}
  let history = []; // array of placements {x,y,c,t,nick}
  let anims = []; // active animations {x,y,progress,scale,alpha}
  let lastTick = performance.now();
  let planetRotation = 0; // radians
  let cooldownUntil = 0;
  let bc = null;

  // Try BroadcastChannel for realtime; fallback to storage events
  try {
    bc = new BroadcastChannel('pixel-planet-channel');
    bc.onmessage = (ev) => {
      if (!ev.data) return;
      handleRemote(ev.data);
    };
  } catch (e) {
    bc = null;
    window.addEventListener('storage', (ev) => {
      if (ev.key === STORAGE_KEY || ev.key === HISTORY_KEY) {
        loadFromStorage();
      } else if (ev.key === 'pixelPlanet_message') {
        const d = JSON.parse(ev.newValue || '{}');
        handleRemote(d);
      }
    });
  }

  // Helpers: storage
  function saveToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pixels));
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-5000)));
      // notify other tabs
      const msg = { type: 'sync', pixels: null, recent: null, stamp: Date.now() };
      if (bc) bc.postMessage(msg);
      else localStorage.setItem('pixelPlanet_message', JSON.stringify(msg));
    } catch (e) { console.warn('save fail', e); }
    updateUI();
  }
  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const hraw = localStorage.getItem(HISTORY_KEY);
      if (raw) pixels = JSON.parse(raw);
      if (hraw) history = JSON.parse(hraw);
    } catch (e) {
      console.warn('load fail', e);
    }
    updateUI();
  }

  function handleRemote(data) {
    // "place" message or sync
    if (!data) return;
    if (data.type === 'place') {
      applyPlacement(data.payload, false);
    } else if (data.type === 'clear') {
      pixels = {}; history = []; saveToStorage();
    } else if (data.type === 'sync') {
      // just reload
      loadFromStorage();
    }
  }

  // Apply placement (local or remote)
  function applyPlacement(p, local = true) {
    const key = `${p.x},${p.y}`;
    pixels[key] = { c: p.c, t: p.t, nick: p.nick || '' };
    history.push(p);
    // animation
    anims.push({ x: p.x, y: p.y, start: performance.now(), dur: 450 });
    if (local) {
      // broadcast
      const msg = { type: 'place', payload: p };
      if (bc) bc.postMessage(msg);
      else localStorage.setItem('pixelPlanet_message', JSON.stringify(msg));
      saveToStorage();
    } else {
      // remote placement -> update UI and save
      saveToStorage();
    }
    updateUI();
  }

  // UI setup
  function buildPalette() {
    paletteEl.innerHTML = '';
    PALETTE.forEach((c, i) => {
      const sw = document.createElement('div');
      sw.className = 'color-swatch' + (i===0 ? ' selected' : '');
      sw.style.background = c;
      sw.dataset.color = c;
      sw.addEventListener('click', () => {
        document.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));
        sw.classList.add('selected');
        selectedColor = c;
      });
      paletteEl.appendChild(sw);
    });
  }

  function updateUI() {
    pixelCountEl.textContent = Object.keys(pixels).length;
    // recent
    const recent = history.slice(-8).reverse();
    recentListEl.innerHTML = recent.map(r => {
      const time = new Date(r.t);
      const name = r.nick ? sanitize(r.nick) : 'anon';
      const colorBox = `<span style="display:inline-block;width:12px;height:12px;background:${r.c};border-radius:3px;margin-right:8px;vertical-align:middle;border:1px solid rgba(255,255,255,0.06)"></span>`;
      return `<div class="recent-item"><div>${colorBox}<strong>${name}</strong> <span style="opacity:.7;margin-left:6px;font-size:12px">${time.toLocaleTimeString()}</span></div><div style="opacity:.9">(${r.x},${r.y})</div></div>`;
    }).join('');
    // cooldown display
    const now = Date.now();
    if (cooldownUntil && cooldownUntil > now) {
      const s = Math.ceil((cooldownUntil - now) / 1000);
      cooldownTimerEl.textContent = `Wait ${s}s`;
    } else {
      cooldownTimerEl.textContent = 'Ready';
    }
    // recent list small
  }

  function sanitize(str){ return String(str).replace(/[<>]/g,'').slice(0,20); }

  // Canvas resize
  function resizeCanvas() {
    const wrap = canvas.parentElement;
    canvasW = wrap.clientWidth;
    canvasH = Math.max(360, window.innerHeight * 0.6);
    canvas.style.width = canvasW + 'px';
    canvas.style.height = canvasH + 'px';
    devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.floor(canvasW * devicePixelRatio);
    canvas.height = Math.floor(canvasH * devicePixelRatio);
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  }

  // Coordinate transforms
  function screenToWorld(sx, sy) {
    // canvas element space -> world (planet grid coordinates)
    const rect = canvas.getBoundingClientRect();
    const cx = (sx - rect.left);
    const cy = (sy - rect.top);
    // transform by view (pan & zoom)
    const wx = (cx - canvasW/2) / view.zoom - view.x;
    const wy = (cy - canvasH/2) / view.zoom - view.y;
    return { x: wx, y: wy };
  }
  function worldToGrid(wx, wy) {
    // map world coords to grid coords (centered)
    // planet diameter in world units
    const planetDiameter = GRID_SIZE * PIXEL_DISPLAY_SCALE;
    const localX = wx + planetDiameter/2;
    const localY = wy + planetDiameter/2;
    const gx = Math.floor(localX / PIXEL_DISPLAY_SCALE);
    const gy = Math.floor(localY / PIXEL_DISPLAY_SCALE);
    return { gx, gy };
  }

  // Planet mask test
  function isOnPlanet(gx, gy) {
    const cx = GRID_SIZE/2 - 0.5, cy = GRID_SIZE/2 - 0.5;
    const dx = gx - cx, dy = gy - cy;
    const r = GRID_SIZE / 2;
    return (dx*dx + dy*dy) <= (r*r);
  }

  // Place pixel via click
  function placePixelAtScreen(sx, sy) {
    const w = screenToWorld(sx, sy);
    const g = worldToGrid(w.x, w.y);
    const gx = g.gx, gy = g.gy;
    if (gx < 0 || gy < 0 || gx >= GRID_SIZE || gy >= GRID_SIZE) return;
    if (!isOnPlanet(gx, gy)) {
      flashTooltip('Outside planet');
      return;
    }
    // cooldown check
    const now = Date.now();
    if (cooldownUntil > now) {
      flashTooltip(`Cooldown: ${Math.ceil((cooldownUntil - now)/1000)}s`);
      return;
    }
    const key = `${gx},${gy}`;
    const payload = { x: gx, y: gy, c: selectedColor, t: Date.now(), nick: sanitize(nickInput.value || '') };
    applyPlacement(payload, true);
    cooldownUntil = Date.now() + COOLDOWN;
    updateUI();
    // start a small local cooldown loop
    if (!cooldownTicking) startCooldownTicker();
  }

  // Tooltip quick flash
  let tooltipTimeout = null;
  function flashTooltip(msg, x, y) {
    tooltip.hidden = false;
    tooltip.textContent = msg;
    if (typeof x === 'number' && typeof y === 'number') {
      tooltip.style.left = x + 'px';
      tooltip.style.top = y + 'px';
    } else {
      tooltip.style.left = '50%';
      tooltip.style.top = '20px';
      tooltip.style.transform = 'translateX(-50%)';
    }
    clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(()=> tooltip.hidden = true, 1600);
  }

  // Render loop
  function tick(ts) {
    const dt = ts - lastTick;
    lastTick = ts;
    // animate rotation slowly
    planetRotation += dt * 0.00008; // radians per ms
    // clear
    ctx.clearRect(0,0,canvasW,canvasH);
    drawBackgroundParticles(ts);
    // set transform: center, apply zoom & pan
    ctx.save();
    ctx.translate(canvasW/2, canvasH/2);
    ctx.scale(view.zoom, view.zoom);
    ctx.translate(view.x, view.y);

    drawPlanet(ts);

    ctx.restore();

    // update animations list and draw overlays if needed
    drawCursorHighlight();

    // animate and cleanup anims
    const now = performance.now();
    anims = anims.filter(a => {
      const p = Math.min(1, (now - a.start) / a.dur);
      const ease = easeOutBack(p);
      // (the pixel is drawn already in drawPlanet; we add glow/pop by drawing on top)
      // We'll draw glow at the end of draw loop - but easier: draw here
      const px = (a.x - GRID_SIZE/2 + 0.5) * PIXEL_DISPLAY_SCALE;
      const py = (a.y - GRID_SIZE/2 + 0.5) * PIXEL_DISPLAY_SCALE;
      ctx.save();
      ctx.translate(canvasW/2, canvasH/2);
      ctx.scale(view.zoom, view.zoom);
      ctx.translate(view.x, view.y);
      ctx.globalAlpha = 1 - p;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,255,255,' + (0.06 * (1-p)) + ')';
      ctx.arc(px, py, PIXEL_DISPLAY_SCALE * 0.8 * (1 + ease*0.6), 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
      return p < 1;
    });

    // UI updates (cooldown)
    updateUI();

    requestAnimationFrame(tick);
  }

  // Easing
  function easeOutBack(t){ const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3*Math.pow(t-1,3) + c1*Math.pow(t-1,2); }

  // Draw planet (grid masked to circle, with rotation and day/night)
  function drawPlanet(ts) {
    // planet params
    const PD = GRID_SIZE * PIXEL_DISPLAY_SCALE; // diameter in world units
    const radius = PD/2;
    // draw soft atmosphere ring
    ctx.save();
    // atmosphere glow
    ctx.beginPath();
    ctx.fillStyle = 'rgba(110,240,255,0.03)';
    ctx.arc(0,0, radius + 14, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();

    // draw the pixel grid on an offscreen canvas for pixel-perfectness
    const off = getOffscreen(PD, PD);
    const oc = off.ctx;
    const scale = PIXEL_DISPLAY_SCALE;

    // clear
    oc.clearRect(0,0, off.w, off.h);

    // tilt/rotation effect: we'll compute an x offset per-row from planetRotation for subtle shading
    const rot = planetRotation;
    for (let y=0;y<GRID_SIZE;y++){
      for (let x=0;x<GRID_SIZE;x++){
        if (!isOnPlanet(x,y)) continue;
        const key = `${x},${y}`;
        const posX = (x - GRID_SIZE/2 + 0.5) * scale + radius;
        const posY = (y - GRID_SIZE/2 + 0.5) * scale + radius;
        if (pixels[key]) {
          // pixel color
          oc.fillStyle = pixels[key].c;
        } else {
          oc.fillStyle = 'rgba(10,12,20,0.4)'; // subtle base
        }
        oc.fillRect(Math.round(posX), Math.round(posY), Math.ceil(scale), Math.ceil(scale));
      }
    }

    // apply subtle day/night shading by drawing a radial gradient overlay that rotates
    // We'll rotate an additional small offset when drawing onto main ctx
    // create pattern
    const img = off.canvas;
    // clip to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(0,0, radius, 0, Math.PI*2);
    ctx.clip();

    // draw pixel image centered
    ctx.drawImage(img, -radius, -radius, PD, PD);

    // soft lighting overlay (simulate day/night)
    const lg = ctx.createLinearGradient(-radius, -radius, radius, radius);
    // moving light center
    const lightAngle = rot * 1.2;
    const lx = Math.cos(lightAngle), ly = Math.sin(lightAngle);
    lg.addColorStop(0, 'rgba(255,255,220,0.06)');
    lg.addColorStop(0.6, 'rgba(0,0,0,0.18)');
    lg.addColorStop(1, 'rgba(0,0,30,0.32)');
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = lg;
    ctx.fillRect(-radius, -radius, PD, PD);
    ctx.globalCompositeOperation = 'source-over';

    // subtle rim light
    const rim = ctx.createRadialGradient(0, 0, radius*0.8, 0,0, radius*1.2);
    rim.addColorStop(0.95, 'rgba(110,240,255,0.02)');
    rim.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = rim;
    ctx.fillRect(-radius*1.2, -radius*1.2, radius*2.4, radius*2.4);

    // restore
    ctx.restore();

    // draw faint grid lines? subtle highlight on hover handled separately
  }

  // Offscreen cache for drawing grid at scale (improves perf)
  const offscreenCache = {};
  function getOffscreen(w,h) {
    const key = `${w}x${h}`;
    if (offscreenCache[key]) return offscreenCache[key];
    const canvas2 = document.createElement('canvas');
    canvas2.width = Math.max(1, Math.floor(w));
    canvas2.height = Math.max(1, Math.floor(h));
    const ctx2 = canvas2.getContext('2d');
    offscreenCache[key] = { canvas: canvas2, ctx: ctx2, w: canvas2.width, h: canvas2.height };
    return offscreenCache[key];
  }

  // Draw background particles (simple)
  let starSeed = 0;
  const stars = [];
  function initParticles() {
    const count = Math.max(40, Math.floor((canvasW + canvasH) / 25));
    for (let i=0;i<count;i++){
      stars.push({
        x: Math.random()*canvasW,
        y: Math.random()*canvasH,
        r: Math.random()*1.6 + 0.3,
        s: Math.random()*0.5+0.2,
        phase: Math.random()*Math.PI*2
      });
    }
  }
  function drawBackgroundParticles(ts) {
    if (!stars.length) initParticles();
    ctx.save();
    ctx.globalAlpha = 0.9;
    for (let s of stars){
      const sway = Math.sin((ts*0.0001) + s.phase) * 6;
      ctx.beginPath();
      ctx.fillStyle = 'rgba(255,255,255,' + (0.06 + s.s*0.12) + ')';
      ctx.arc(s.x + sway, s.y + Math.sin(ts*0.00007 + s.phase*1.3) * 4, s.r, 0, Math.PI*2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Cursor highlight
  let lastPointer = null;
  function drawCursorHighlight(){
    if (!lastPointer) return;
    const pos = screenToWorld(lastPointer.x, lastPointer.y);
    const g = worldToGrid(pos.x, pos.y);
    if (!isOnPlanet(g.gx, g.gy)) return;
    const px = (g.gx - GRID_SIZE/2 + 0.5) * PIXEL_DISPLAY_SCALE;
    const py = (g.gy - GRID_SIZE/2 + 0.5) * PIXEL_DISPLAY_SCALE;
    ctx.save();
    ctx.translate(canvasW/2, canvasH/2);
    ctx.scale(view.zoom, view.zoom);
    ctx.translate(view.x, view.y);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1.5 / view.zoom;
    ctx.beginPath();
    ctx.rect(px - 0.5, py - 0.5, PIXEL_DISPLAY_SCALE + 1, PIXEL_DISPLAY_SCALE + 1);
    ctx.stroke();
    ctx.restore();
  }

  // Input handlers: pointer events for pan/place
  function onPointerDown(e) {
    const p = getPointer(e);
    dragging = true;
    dragStart = { x: p.x, y: p.y, vx: view.x, vy: view.y };
    lastPointer = p;
  }
  function onPointerMove(e) {
    const p = getPointer(e);
    lastPointer = p;
    if (dragging) {
      // pan
      const dx = (p.x - dragStart.x) / view.zoom;
      const dy = (p.y - dragStart.y) / view.zoom;
      view.x = dragStart.vx + dx;
      view.y = dragStart.vy + dy;
    } else {
      // track for hover highlight
    }
  }
  function onPointerUp(e) {
    const p = getPointer(e);
    if (!dragging) return;
    dragging = false;
    // quick click: if minimal movement, place pixel
    const dx = Math.abs(p.x - dragStart.x), dy = Math.abs(p.y - dragStart.y);
    if (dx < 8 && dy < 8) {
      placePixelAtScreen(p.x, p.y);
    }
  }
  function getPointer(e) {
    if (e.touches && e.touches[0]) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else {
      return { x: e.clientX, y: e.clientY };
    }
  }

  // Wheel zoom
  function onWheel(e) {
    e.preventDefault();
    const delta = -e.deltaY;
    const zoomFactor = delta > 0 ? 1.08 : 0.92;
    // zoom about mouse position
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const worldBefore = screenToWorld(e.clientX, e.clientY);
    view.zoom = clamp(view.zoom * zoomFactor, 0.35, 4);
    const worldAfter = screenToWorld(e.clientX, e.clientY);
    // adjust pan so that world point under cursor remains stable
    view.x += (worldAfter.x - worldBefore.x);
    view.y += (worldAfter.y - worldBefore.y);
    zoomLevelEl.textContent = Math.round(view.zoom * 100) + '%';
  }

  function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

  // Keyboard shortcuts
  function onKey(e) {
    if (e.key === 'p' || e.key === 'P') {
      paletteEl.classList.toggle('hidden');
      e.preventDefault();
    } else if (e.key === 'c' || e.key === 'C') {
      openClear();
    } else if (e.key === ' ') {
      // center
      view.x = 0; view.y = 0; view.zoom = 1;
      e.preventDefault();
    }
  }

  // Clear planet
  function openClear() {
    if (!confirm('Clear the planet for everyone? This deletes all pixels.')) return;
    pixels = {}; history = [];
    const msg = { type: 'clear' };
    if (bc) bc.postMessage(msg);
    else localStorage.setItem('pixelPlanet_message', JSON.stringify(msg));
    saveToStorage();
  }

  // Time-lapse replay
  let playbackRunning = false;
  async function runTimelapse() {
    if (playbackRunning) return;
    playbackRunning = true;
    const recent = history.slice(-200);
    // temporarily show an overlay by clearing and painting from scratch
    const savedPixels = { ...pixels };
    // clear visible, but we keep storage
    // We'll render sequentially
    pixels = {};
    const oldAnims = [...anims];
    anims = [];
    for (let i = 0; i < recent.length; i++) {
      applyPlacement(recent[i], false);
      // small delay
      await new Promise(r => setTimeout(r, 80));
    }
    // restore
    setTimeout(() => {
      pixels = savedPixels;
      anims = oldAnims;
      saveToStorage();
      playbackRunning = false;
    }, 700);
  }

  // Cooldown ticker
  let cooldownTicking = false;
  function startCooldownTicker(){
    if (cooldownTicking) return;
    cooldownTicking = true;
    const iv = setInterval(() => {
      if (Date.now() > cooldownUntil) {
        cooldownTicking = false;
        clearInterval(iv);
        updateUI();
      } else updateUI();
    }, 300);
  }

  // Init
  function init() {
    resizeCanvas();
    window.addEventListener('resize', () => { resizeCanvas(); initParticles(); });
    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    canvas.addEventListener('touchstart', onPointerDown, {passive:false});
    canvas.addEventListener('touchmove', onPointerMove, {passive:false});
    canvas.addEventListener('touchend', onPointerUp);

    canvas.addEventListener('wheel', onWheel, { passive: false });

    document.addEventListener('keydown', onKey);

    // UI handlers
    buildPalette();
    paletteEl.classList.remove('hidden');
    colorToggle.addEventListener('click', ()=> paletteEl.classList.toggle('hidden'));
    timelapseBtn.addEventListener('click', runTimelapse);
    clearBtn.addEventListener('click', openClear);
    centerBtn.addEventListener('click', ()=>{ view.x=0;view.y=0; view.zoom=1; zoomLevelEl.textContent = Math.round(view.zoom*100)+'%'; });

    // nickname persist
    nickInput.value = localStorage.getItem(NICK_KEY) || '';
    nickInput.addEventListener('change', ()=> localStorage.setItem(NICK_KEY, nickInput.value));

    // load
    loadFromStorage();

    // start rendering
    requestAnimationFrame(tick);
  }

  // Simple utilities
  function clampInt(v,a,b){ return Math.max(a, Math.min(b, v)); }

  // Start
  init();

  // expose small functions for debug & external control
  window.pixelPlanet = { placePixelAtScreen, getState: ()=> ({pixels, history}) };

})();
