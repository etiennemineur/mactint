/* =====================================================================
   MacPaint 1.5 — réplique bitmap pour le navigateur
   Écran 512 × 342, document 576 × 720, palette fixe, menus Apple.
   Tout est dessiné au pixel sur un seul canvas.
   ===================================================================== */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- *
   *  1. Géométrie de l'écran
   * ---------------------------------------------------------------- */
  /* L'écran simulé : 640 × 480, la définition du Macintosh II couleur (1987). Le décor
     d'origine (512 × 342, relevé sur MacPaint) est redécoupé et réassemblé à cette taille. */
  let SW = 640, SH = 480, DX = 76, DY = 138;                       // recalculés par fit() : l'écran simulé remplit la fenêtre du navigateur
  const OW = 512, OH = 342;   // DX, DY : ce que la fenêtre gagne
  const CLASSIC = window.MP15_DATA;
  if (!CLASSIC) throw new Error("MacPaint reference data not loaded");
  const MENUBAR = 19;
  const PAL_X = 15, PAL_Y = 27, PAL_W = 53, PAL_H = 221;
  const TITLE_H = 19;
  const DOC_X = 79, DOC_Y = 28, DOC_W = 419, DOC_H = 306;
  const SB = 0, SB_R = 0, SB_B = 0;
  const WIN = { x: 80, y: 47, w: 416 + DX, h: 240 + DY };          // l'intérieur de la fenêtre de travail
  const VIEW = { x: 80, y: 47, w: 416 + DX, h: 240 + DY };         // la partie de la page qu'on y voit (centrée quand la page est plus petite)
  let widthPopup = false, showPage = false, alignment = "left";
  let polygonPoints = null, helpPage = null;

  let DW = 640, DH = 480;              // la page : sa taille se change au menu « Page »

  const cv = document.getElementById("screen");
  const ctx = cv.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = false;
  const touchMode = document.documentElement.hasAttribute("data-macpaint-touch");
  const changeListeners = new Set();
  function notifyChange() { for (const fn of changeListeners) fn(); }

  /* ---------------------------------------------------------------- *
   *  2. État
   * ---------------------------------------------------------------- */
  /* Calques, du fond vers le dessus. « doc » est toujours le calque actif : tous les outils
     écrivent dedans sans le savoir. Sur un calque, l'index 0 est du vide (on voit dessous). */
  const LAYERS = [{ name: "1", visible: true, data: new Uint8Array(DW * DH) }];
  let LA = 0, layerSeq = 1;
  let doc = LAYERS[0].data;                // un index de couleur par point : 0 = blanc (papier), 1 = noir, 2 à 15 = couleurs
  /* Les seize couleurs de la palette système 4 bits du Macintosh II (1987), rangées
     pour que 0 reste le papier blanc et 1 l'encre noire de MacPaint. */
  const PALETTE = ["#ffffff", "#000000", "#404040", "#808080", "#c0c0c0", "#90713a", "#562c05", "#dd0806",
                   "#ff6402", "#fcf305", "#1fb714", "#006411", "#02abea", "#0000d4", "#4600a5", "#f20884"];
  const PAL_RGB = PALETTE.map(h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
  const NPAL = 256;                        // 16 fixes, 40 de rampes, 128 de reflets (un jeu de 8 par couleur), 8 de la rampe de l'éditeur, puis 64 couleurs personnelles (192 à 255)
  const PAL32 = new Uint32Array(NPAL);     // 16 couleurs fixes, puis 5 rampes animées de 8 cases (pinceau « Color Cycling »)
  PAL_RGB.forEach((c, i) => { PAL32[i] = (0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0; });
  function nearestColor(r, g, b) {
    let best = 0, bd = 1e9;
    for (let i = 0; i < 16; i++) { const c = PAL_RGB[i], d = (c[0] - r) * (c[0] - r) * 0.3 + (c[1] - g) * (c[1] - g) * 0.59 + (c[2] - b) * (c[2] - b) * 0.11; if (d < bd) { bd = d; best = i; } }
    return best;
  }
  const PAL_INV = PAL_RGB.map(c => nearestColor(255 - c[0], 255 - c[1], 255 - c[2]));   // « Invert » : la couleur opposée la plus proche
  for (let i = 16; i < NPAL; i++) PAL_INV[i] = i;                // une couleur animée le reste
  let ink = 1;                           // couleur courante
  /* Dégradé : la couleur courante glisse vers une couleur d'arrivée (clic droit sur une pastille), d'un bord de la
     page à l'autre, en trame ordonnée (le dessin ne contient toujours que des couleurs franches). L'échantillon de
     trame, en bas à gauche, le montre ; un clic dessus change sa direction, puis l'éteint. */
  const GRAD = { on: false, c2: 0, dir: 0 };                      // dir : 0 haut→bas, 1 gauche→droite, 2 en biais, 3 du centre vers les bords
  const GRAD_B = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  try { const q = JSON.parse(localStorage.getItem("colorpaint.grad") || "null"); if (q) { GRAD.on = !!q.on; GRAD.c2 = q.c2 | 0; GRAD.dir = Math.max(0, Math.min(7, q.dir | 0)); } } catch (e) {}
  function gradSave() { try { localStorage.setItem("colorpaint.grad", JSON.stringify(GRAD)); } catch (e) {} }
  /* Quatre types (GRAD.dir) : 0 trame haut→bas, 1 trame ronde (du centre vers les bords), 2 lignes horizontales de
     plus en plus épaisses vers le bas, 3 lignes verticales de plus en plus épaisses vers la droite. */
  function gradPick(x, y, w, h, P, kind) {                        // vrai : couleur d'arrivée ; faux : couleur courante. P = pas des lignes
    const u = x / Math.max(1, w - 1), v = y / Math.max(1, h - 1), th = (GRAD_B[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
    return kind === 0 ? th < v : kind === 1 ? th < Math.min(1, Math.hypot(u - 0.5, v - 0.5) / 0.7071) : kind === 2 ? (y % P) + 0.5 < v * P : (x % P) + 0.5 < u * P;
  }
  const RAINBOW_G = [7, 8, 9, 10, 12, 13, 14, 15];                 // rouge, orange, jaune, vert, cyan, bleu, violet, rose
  function gradCol(x, y, w, h, P, kind, a, b) {                   // la couleur du dégradé en ce point. Types 0 à 3 : entre les deux couleurs ; 4 à 7 : l'arc-en-ciel entier, dans les quatre mêmes styles
    if (kind < 4) return gradPick(x, y, w, h, P, kind) ? b : a;
    const st = kind & 3, u = x / Math.max(1, w - 1), v = y / Math.max(1, h - 1), pos = st === 0 || st === 2 ? v : st === 1 ? Math.min(1, Math.hypot(u - 0.5, v - 0.5) / 0.7071) : u;
    const t = pos * (RAINBOW_G.length - 1), i = Math.min(RAINBOW_G.length - 2, Math.floor(t)), f = t - i;
    const next = st < 2 ? (GRAD_B[(y & 3) * 4 + (x & 3)] + 0.5) / 16 < f : st === 2 ? (y % P) + 0.5 < f * P : (x % P) + 0.5 < f * P;   // trame de points, ou lignes qui s'épaississent
    return next ? RAINBOW_G[i + 1] : RAINBOW_G[i];
  }
  function gradInk(x, y) { return gradCol(x, y, DW, DH, 8, GRAD.dir, ink, GRAD.c2); }
  /* Le monde arc-en-ciel. Quand un des quatre dégradés arc-en-ciel est choisi, la couleur courante n'est plus une des
     pastilles : c'est une encre à part (index 255). Tous les outils la déposent telle quelle, quel que soit leur
     chemin (coulures, billes, volumes, métal…) ; au dessin suivant de la feuille, chaque point de cette encre prend
     pour de bon la couleur de l'arc-en-ciel à cet endroit. Ce qui vit encore à l'écran est teinté de la même façon. */
  const RB = 255, RB_MARK = 0xff030201;
  let rbPrev = 1, rbDir = 4, rbLinger = 0;
  const rbOn = () => ink === RB;
  const rbAt = (x, y) => gradCol(x, y, DW, DH, 8, rbDir, 0, 0);
  const inkShown = () => ink === RB ? rbPrev : ink;               // la couleur de base à montrer dans les cases des dégradés entre deux couleurs
  function gradSync() {                                           // met l'encre en accord avec le dégradé choisi
    if (GRAD.on && GRAD.dir > 3) { rbDir = GRAD.dir; if (ink !== RB) { rbPrev = ink; ink = RB; } }
    else if (ink === RB) { ink = rbPrev; rbLinger = 900; }
  }
  function rbResolve(d) { for (let i = 0; i < d.length; i++) if (d[i] === RB) d[i] = rbAt(i % DW, (i / DW) | 0); }
  if (GRAD.on && GRAD.dir > 3) { rbDir = GRAD.dir; rbPrev = 1; ink = RB; }   // on retrouve le monde arc-en-ciel laissé la dernière fois
  const inkAt = (x, y) => GRAD.on ? gradInk(x, y) : ink;          // la couleur que dépose un outil à cet endroit
  function gradEnd(i) { if (!isInk(i)) return; GRAD.c2 = i; GRAD.on = true; if (GRAD.dir > 3) GRAD.dir &= 3; gradSync(); gradFix(); gradSave(); uiSnd("item", 2); render(); }
  function gradCycle() { if (!GRAD.on) { GRAD.on = true; GRAD.dir = 0; } else if (GRAD.dir < 7) GRAD.dir++; else GRAD.on = false; gradSync(); gradFix(); gradSave(); uiSnd("item", GRAD.on ? GRAD.dir : 5); render(); }
  function gradFix() { if (GRAD.on && GRAD.dir < 4 && GRAD.c2 === ink) GRAD.c2 = ink === 0 ? 1 : 0; }   // un dégradé d'une couleur vers elle-même ne se verrait pas : il va vers le blanc
  function gradChoose(k) { if (GRAD.on && GRAD.dir === k) GRAD.on = false; else { GRAD.on = true; GRAD.dir = k; } gradSync(); gradFix(); gradSave(); uiSnd("item", GRAD.on ? k : 5); render(); }
  /* Les quatre cases de dégradé : un bloc de deux sur deux, entre les seize couleurs et les couleurs personnelles. */
  const gradX0 = () => SWATCH.x + 8 * SWATCH.w + 6, customX0 = () => gradX0() + 4 * SWATCH.w + 6;   // quatre colonnes : quatre dégradés entre deux couleurs, puis les quatre mêmes en arc-en-ciel
  function gradAt(p) {
    const x0 = gradX0(), c = Math.floor((p.x - x0) / SWATCH.w), r = p.y < SWATCH.y + SWATCH.h ? 0 : 1;
    const k = (c >= 2 ? 4 : 0) + r * 2 + (c & 1);
    return p.x >= x0 && c < 4 && p.y >= SWATCH.y - 1 && p.y < SWATCH.y + 2 * SWATCH.h ? k : -1;
  }
  const GRAD_CELLS = { key: "", c: [] };
  function drawGradCells() {
    const x0 = gradX0(), W = 4 * SWATCH.w + 1, H = 2 * SWATCH.h + 1, X = x0 - 1, Y = SWATCH.y - 1, base = inkShown(), c2 = GRAD.c2 === base ? (base === 0 ? 1 : 0) : GRAD.c2;
    ctx.fillStyle = "#000"; ctx.fillRect(X - 2, Y - 2, W + 4, H + 4); ctx.fillStyle = "#fff"; ctx.fillRect(X - 1, Y - 1, W + 2, H + 2); ctx.fillStyle = "#000"; ctx.fillRect(X, Y, W, H);
    const gkey = base + "," + c2 + "," + PALETTE[base] + PALETTE[c2];
    if (GRAD_CELLS.key !== gkey) {                                // huit vignettes composées point par point : seulement quand les deux couleurs changent
      GRAD_CELLS.key = gkey;
      for (let k = 0; k < 8; k++) {
        const c = GRAD_CELLS.c[k] || (GRAD_CELLS.c[k] = document.createElement("canvas")); c.width = 19; c.height = 16;
        const g = c.getContext("2d");
        for (let j = 0; j < 16; j++) for (let i = 0; i < 19; i++) { g.fillStyle = PALETTE[gradCol(i, j, 19, 16, 4, k, base, c2)]; g.fillRect(i, j, 1, 1); }
      }
    }
    for (let k = 0; k < 8; k++) {
      const x = x0 + ((k >> 2) * 2 + (k & 1)) * SWATCH.w, y = SWATCH.y + ((k >> 1) & 1) * SWATCH.h, w = 19, h = 16;
      ctx.drawImage(GRAD_CELLS.c[k], x, y);
      if (GRAD.on && GRAD.dir === k) {                             // le type choisi : même cadre intérieur que la couleur choisie
        ctx.fillStyle = "#fff"; ctx.fillRect(x + 1, y + 1, w - 2, 2); ctx.fillRect(x + 1, y + h - 3, w - 2, 2); ctx.fillRect(x + 1, y + 1, 2, h - 2); ctx.fillRect(x + w - 3, y + 1, 2, h - 2);
        ctx.fillStyle = "#000"; ctx.fillRect(x + 3, y + 3, w - 6, 1); ctx.fillRect(x + 3, y + h - 4, w - 6, 1); ctx.fillRect(x + 3, y + 3, 1, h - 6); ctx.fillRect(x + w - 4, y + 3, 1, h - 6);
      }
    }
    ctx.fillStyle = "#000";
  }
  /* Couleurs personnelles : jusqu'à 64, ajoutées par l'utilisateur avec la roue chromatique. Elles
     prennent les index 192 à 255 de la palette ; changer l'une d'elles recolore tout ce qui a été
     peint avec. Elles sont gardées dans le navigateur. */
  const CUSTOM0 = 192, CUSTOM_MAX = 62;                           // 62 : les deux derniers index de la palette sont réservés (255 = encre arc-en-ciel)
  let CUSTOM = [];
  try { const q = JSON.parse(localStorage.getItem("colorpaint.custom") || "[]"); if (Array.isArray(q)) CUSTOM = q.filter(c => Array.isArray(c) && c.length === 3).slice(0, CUSTOM_MAX).map(c => c.map(v => Math.max(0, Math.min(255, v | 0)))); } catch (e) {}
  const hex2 = v => (v < 16 ? "0" : "") + v.toString(16);
  function customApply() { CUSTOM.forEach(function (c, n) { PAL_RGB[CUSTOM0 + n] = c; PALETTE[CUSTOM0 + n] = "#" + hex2(c[0]) + hex2(c[1]) + hex2(c[2]); PAL32[CUSTOM0 + n] = (0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0; }); }
  function customSave() { customApply(); try { localStorage.setItem("colorpaint.custom", JSON.stringify(CUSTOM)); } catch (e) {} }
  customApply();
  PAL32[255] = 0xff030201; PALETTE[255] = "#f20884"; PAL_RGB[255] = [242, 8, 132];        // l'encre arc-en-ciel, là où elle ne peut pas être teinte point par point (pictogrammes, billes en vol)
  const isInk = i => (i >= 0 && i < 16) || (i >= CUSTOM0 && i < CUSTOM0 + CUSTOM.length);
  /* Nuancier : seize pastilles sur deux rangs, à droite de la barre de menus. */
  const SWATCH = { x: 516, y: 300 + DY, w: 20, h: 17 };            // nuancier : seize carrés sur deux rangs, à droite des trames
  function swatchAt(p) {
    const i = Math.floor((p.x - SWATCH.x) / SWATCH.w), j = p.y < SWATCH.y + SWATCH.h ? 0 : 1;
    return i >= 0 && i < 8 ? j * 8 + i : -1;
  }
  function setInk(i) {
    if (!isInk(i)) return;
    if (ink === RB) { GRAD.on = false; rbLinger = 900; gradSave(); }   // choisir une pastille fait sortir du monde arc-en-ciel
    ink = i; gradFix();
    if (SND && SND.color && !touchMode) try { SND.color(ink > 15 ? 1 + ink % 15 : ink); } catch (e) {}   // une couleur personnelle emprunte une des quinze gammes
    render();
  }
  const darkInk = i => i >= CUSTOM0 ? (PAL_RGB[i] ? PAL_RGB[i][0] * 0.3 + PAL_RGB[i][1] * 0.59 + PAL_RGB[i][2] * 0.11 < 115 : false) : [1, 2, 6, 11, 13, 14].includes(i);
  /* Les cases des couleurs personnelles, à droite du nuancier : deux rangs, autant de colonnes que
     l'écran en offre. La dernière, en pointillés, sert à en ajouter une (double-clic). */
  const customCols = () => Math.max(1, Math.min(CUSTOM_MAX / 2, Math.floor((SW - 8 - customX0()) / SWATCH.w)));
  const customShown = () => Math.min(CUSTOM.length + (CUSTOM.length < CUSTOM_MAX ? 1 : 0), customCols() * 2);
  function customAt(p) {
    const x0 = customX0(), c = Math.floor((p.x - x0) / SWATCH.w), r = p.y < SWATCH.y + SWATCH.h ? 0 : 1, n = c * 2 + r;
    return p.x >= x0 && p.y >= SWATCH.y - 1 && p.y < SWATCH.y + 2 * SWATCH.h && n < customShown() ? n : -1;
  }
  let lastCustom = { n: -1, t: 0 };
  function customClick(n) {
    const now = performance.now(), dbl = lastCustom.n === n && now - lastCustom.t < 450;
    lastCustom = { n: n, t: now };
    if (n < CUSTOM.length) { setInk(CUSTOM0 + n); if (dbl) cwOpen(n); }      // clic : on la choisit ; double-clic : on la retouche
    else if (dbl) cwOpen(-1); else { uiSnd("item", 3); render(); }             // la case en pointillés : double-clic pour créer
  }
  function gradMark(x, y, w, h) {                                 // coin corné : la couleur d'arrivée du dégradé
    for (let k = 0; k < 8; k++) { ctx.fillStyle = "#000"; ctx.fillRect(x + w - 8 + k, y + h - 1 - k, 8 - k, 1); ctx.fillStyle = "#fff"; if (k < 6) ctx.fillRect(x + w - 6 + k, y + h - 1 - k, 6 - k, 1); }
  }
  function drawCustomSwatches() {
    const n = customShown(), cols = Math.ceil(n / 2), x0 = customX0(), W = cols * SWATCH.w + 1, H = 2 * SWATCH.h + 1, X = x0 - 1, Y = SWATCH.y - 1;
    ctx.fillStyle = "#000"; ctx.fillRect(X - 2, Y - 2, W + 4, H + 4); ctx.fillStyle = "#fff"; ctx.fillRect(X - 1, Y - 1, W + 2, H + 2); ctx.fillStyle = "#000"; ctx.fillRect(X, Y, W, H);
    for (let k = 0; k < cols * 2; k++) {
      const x = x0 + (k >> 1) * SWATCH.w, y = SWATCH.y + (k & 1) * SWATCH.h, w = 19, h = 16;
      if (k < CUSTOM.length) {
        ctx.fillStyle = PALETTE[CUSTOM0 + k]; ctx.fillRect(x, y, w, h);
        if (GRAD.on && CUSTOM0 + k === GRAD.c2) gradMark(x, y, w, h);
        if (CUSTOM0 + k === ink) {
          ctx.fillStyle = "#fff"; ctx.fillRect(x + 1, y + 1, w - 2, 2); ctx.fillRect(x + 1, y + h - 3, w - 2, 2); ctx.fillRect(x + 1, y + 1, 2, h - 2); ctx.fillRect(x + w - 3, y + 1, 2, h - 2);
          ctx.fillStyle = "#000"; ctx.fillRect(x + 3, y + 3, w - 6, 1); ctx.fillRect(x + 3, y + h - 4, w - 6, 1); ctx.fillRect(x + 3, y + 3, 1, h - 6); ctx.fillRect(x + w - 4, y + 3, 1, h - 6);
        }
      } else {
        ctx.fillStyle = "#fff"; ctx.fillRect(x, y, w, h);
        if (k === CUSTOM.length && k < n) {                         // la case « ajouter » : pointillés et petit plus
          ctx.fillStyle = "#000";
          for (let i = 2; i < w - 2; i += 2) { ctx.fillRect(x + i, y + 2, 1, 1); ctx.fillRect(x + i, y + h - 3, 1, 1); }
          for (let j = 2; j < h - 2; j += 2) { ctx.fillRect(x + 2, y + j, 1, 1); ctx.fillRect(x + w - 3, y + j, 1, 1); }
          ctx.fillRect(x + 7, y + 8, 5, 1); ctx.fillRect(x + 9, y + 6, 1, 5);
        }
      }
    }
    ctx.fillStyle = "#000";
  }
  /* ---- La roue chromatique : la teinte autour, la saturation du centre vers le bord, et une
     réglette de luminosité. Tout se règle en glissant. */
  const CW = { on: false, edit: -1, h: 0, s: 1, v: 1, wheel: null, wv: -1 };
  function hsv(h, s, v) { const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s); const m = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6]; return m.map(c => Math.round(c * 255)); }
  function cwRect() { return { x: Math.round((SW - 260) / 2), y: Math.round((SH - 236) / 2), w: 260, h: 236 }; }
  function cwOpen(n) {
    CW.on = true; CW.edit = n; CW.h = 0; CW.s = 1; CW.v = 1;
    if (n >= 0) { const c = CUSTOM[n].map(v => v / 255), mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]), d = mx - mn; CW.v = mx; CW.s = mx ? d / mx : 0; CW.h = !d ? 0 : (mx === c[0] ? ((c[1] - c[2]) / d + 6) % 6 : mx === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4) / 6; }
    uiSnd("item", 4); render();
  }
  function cwSet(p, part) {
    const r = cwRect(), cx = r.x + 86, cy = r.y + 108, R = 66;
    if (part === "wheel") { const dx = p.x - cx, dy = p.y - cy; CW.s = Math.min(1, Math.hypot(dx, dy) / R); CW.h = ((Math.atan2(dy, dx) / (Math.PI * 2)) + 1) % 1; }
    else CW.v = Math.max(0, Math.min(1, 1 - (p.y - (r.y + 44)) / 128));
    render();
  }
  function cwClick(p) {
    const r = cwRect(), cx = r.x + 86, cy = r.y + 108, inB = x => p.y >= r.y + r.h - 36 && p.y < r.y + r.h - 14 && p.x >= r.x + x && p.x < r.x + x + 70;
    if (Math.hypot(p.x - cx, p.y - cy) <= 70) { cwSet(p, "wheel"); drag = { kind: "cw", part: "wheel" }; return; }
    if (p.x >= r.x + 176 && p.x < r.x + 204 && p.y >= r.y + 38 && p.y < r.y + 178) { cwSet(p, "value"); drag = { kind: "cw", part: "value" }; return; }
    if (inB(170)) {                                              // OK : la couleur entre dans la palette et devient la couleur courante
      const c = hsv(CW.h, CW.s, CW.v); let n = CW.edit;
      if (n >= 0) CUSTOM[n] = c; else if (CUSTOM.length < CUSTOM_MAX) { CUSTOM.push(c); n = CUSTOM.length - 1; }
      customSave(); gifLut.clear(); CW.on = false; if (n >= 0) setInk(CUSTOM0 + n); render(); return;
    }
    if (inB(86) || p.x < r.x || p.y < r.y || p.x >= r.x + r.w || p.y >= r.y + r.h) { CW.on = false; render(); }
  }
  function drawCW() {
    const r = cwRect(), cx = r.x + 86, cy = r.y + 108, R = 66, T = (str, x, y) => blit(ctx, textBmp(str, "Chicago", 12, false, false), r.x + x, r.y + y);
    ctx.fillStyle = "#000"; for (let j = 0; j < r.h; j += 2) for (let i = 2; i < r.w + 2; i += 2) ctx.fillRect(r.x + i, r.y + j + 2, 1, 1);
    ctx.fillStyle = "#fff"; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#000"; ctx.fillRect(r.x, r.y, r.w, 1); ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1); ctx.fillRect(r.x, r.y, 1, r.h); ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
    ctx.fillRect(r.x + 3, r.y + 3, r.w - 6, 2); ctx.fillRect(r.x + 3, r.y + r.h - 5, r.w - 6, 2); ctx.fillRect(r.x + 3, r.y + 3, 2, r.h - 6); ctx.fillRect(r.x + r.w - 5, r.y + 3, 2, r.h - 6);
    T(CW.edit >= 0 ? "Edit this color" : "New color", 16, 12);
    const q = Math.round(CW.v * 24);                             // la roue est redessinée seulement quand la luminosité change
    if (!CW.wheel || CW.wv !== q) {
      const c = CW.wheel || (CW.wheel = document.createElement("canvas")); c.width = c.height = 2 * R + 1; CW.wv = q;
      const g = c.getContext("2d"), im = g.createImageData(c.width, c.height), d = im.data;
      for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { const dd = Math.hypot(i, j); if (dd > R) continue; const col = hsv(((Math.atan2(j, i) / (Math.PI * 2)) + 1) % 1, dd / R, q / 24), k = ((j + R) * c.width + i + R) * 4; d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = 255; }
      g.putImageData(im, 0, 0);
    }
    for (let j = -R - 2; j <= R + 2; j++) for (let i = -R - 2; i <= R + 2; i++) { const dd = Math.hypot(i, j); if (dd > R && dd <= R + 1.5) ctx.fillRect(cx + i, cy + j, 1, 1); }
    ctx.drawImage(CW.wheel, cx - R, cy - R);
    const mx = Math.round(cx + Math.cos(CW.h * Math.PI * 2) * CW.s * R), my = Math.round(cy + Math.sin(CW.h * Math.PI * 2) * CW.s * R);      // le repère : un petit anneau
    ctx.fillStyle = "#000"; ctx.fillRect(mx - 4, my - 4, 9, 9); ctx.fillStyle = "#fff"; ctx.fillRect(mx - 3, my - 3, 7, 7); ctx.fillStyle = "#000"; ctx.fillRect(mx - 2, my - 2, 5, 5);
    ctx.fillStyle = "rgb(" + hsv(CW.h, CW.s, CW.v).join(",") + ")"; ctx.fillRect(mx - 1, my - 1, 3, 3);
    ctx.fillStyle = "#000"; ctx.fillRect(r.x + 180, r.y + 43, 20, 130);                                                                    // la réglette de luminosité
    for (let j = 0; j < 128; j++) { ctx.fillStyle = "rgb(" + hsv(CW.h, CW.s, 1 - j / 127).join(",") + ")"; ctx.fillRect(r.x + 181, r.y + 44 + j, 18, 1); }
    const vy = r.y + 44 + Math.round((1 - CW.v) * 127); ctx.fillStyle = "#000"; ctx.fillRect(r.x + 176, vy - 2, 28, 5); ctx.fillStyle = "#fff"; ctx.fillRect(r.x + 177, vy - 1, 26, 3);
    ctx.fillStyle = "#000"; ctx.fillRect(r.x + 214, r.y + 43, 32, 34); ctx.fillStyle = "rgb(" + hsv(CW.h, CW.s, CW.v).join(",") + ")"; ctx.fillRect(r.x + 215, r.y + 44, 30, 32);   // l'aperçu
    ctx.fillStyle = "#000";
    const btn = (x, label, def) => { const bx = r.x + x, by = r.y + r.h - 36; ctx.fillStyle = "#000"; if (def) { ctx.fillRect(bx - 3, by - 2, 76, 26); ctx.fillStyle = "#fff"; ctx.fillRect(bx - 1, by, 72, 22); ctx.fillStyle = "#000"; } ctx.fillRect(bx + 1, by, 68, 22); ctx.fillRect(bx, by + 1, 70, 20); ctx.fillStyle = "#fff"; ctx.fillRect(bx + 1, by + 1, 68, 20); ctx.fillStyle = "#000"; const tb = textBmp(label, "Chicago", 12, false, false); blit(ctx, tb, bx + 35 - (tb.w >> 1), by + 4); };
    btn(86, "Cancel", false); btn(170, "OK", true);
  }
  function drawSwatches() {
    /* Mêmes cases que les trames : 19 × 16 points, séparées par un filet noir d'un point, sur
       deux rangs alignés avec elles. */
    const W = 8 * SWATCH.w + 1, H = 2 * SWATCH.h + 1, X = SWATCH.x - 1, Y = SWATCH.y - 1;
    ctx.fillStyle = "#000"; ctx.fillRect(X - 2, Y - 2, W + 4, H + 4);
    ctx.fillStyle = "#fff"; ctx.fillRect(X - 1, Y - 1, W + 2, H + 2);
    ctx.fillStyle = "#000"; ctx.fillRect(X, Y, W, H);
    for (let i = 0; i < 16; i++) {
      const x = SWATCH.x + (i % 8) * SWATCH.w, y = SWATCH.y + (i >> 3) * SWATCH.h, w = 19, h = 16;
      ctx.fillStyle = PALETTE[i]; ctx.fillRect(x, y, w, h);
      if (GRAD.on && i === GRAD.c2) gradMark(x, y, w, h);
      if (i === ink) {                                           // la couleur choisie : un cadre intérieur, blanc puis noir
        ctx.fillStyle = "#fff"; ctx.fillRect(x + 1, y + 1, w - 2, 2); ctx.fillRect(x + 1, y + h - 3, w - 2, 2); ctx.fillRect(x + 1, y + 1, 2, h - 2); ctx.fillRect(x + w - 3, y + 1, 2, h - 2);
        ctx.fillStyle = "#000"; ctx.fillRect(x + 3, y + 3, w - 6, 1); ctx.fillRect(x + 3, y + h - 4, w - 6, 1); ctx.fillRect(x + 3, y + 3, 1, h - 6); ctx.fillRect(x + w - 4, y + 3, 1, h - 6);
      }
    }
    ctx.fillStyle = "#000";
    drawGradCells(); drawCustomSwatches();
  }
  const view = { x: 0, y: 0 };           // haut-gauche de la vue dans la feuille
  let zoom = 1;
  let tool = "brush";
  const PAGES = [["640 x 480", 640, 480], ["480 x 640", 480, 640], ["1024 x 768", 1024, 768], ["768 x 1024", 768, 1024], ["1024 x 1024", 1024, 1024], ["1920 x 1080", 1920, 1080], ["1080 x 1920", 1080, 1920], ["2048 x 1536", 2048, 1536], ["MacPaint 576 x 720", 576, 720]];
  const PAGE_MAX = 2048;                                           // au-delà, recomposer l'image à chaque trait deviendrait trop lent
  const ZOOMS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16];
  const FX_TOOLS = ["wild", "type", "cycle", "dynamite", "acid", "drip"];      // les six cases de la barre de menus
  /* Tous les outils bizarres, par famille, pour le menu déroulant (la case « … »). */
  /* Tous les outils bizarres, par famille : l'ordre des cases de la palette de droite, et le
     contenu des trois menus « Brush », « Matter » et « Life ». (null : un filet dans le menu.) */
  const FX_FAMILIES = {
    /* Tracer : tout ce qui dépose un trait, une matière, une lettre ou un volume. */
    Draw: [["wild", "Living Brush"], ["leaky", "Leaky Pen"], ["frizzy", "Frizzy"], ["web", "Spider Web"], ["tree", "Tree Brush"], ["paste", "Toothpaste"], ["hose", "Image Hose"], ["jelly", "Jelly Line"], ["ribbon", "Paper Ribbon"], ["spike", "Barbed Brush"], null,
      ["wet", "Wet Ink"], ["drip", "Dripping Paint"], ["hot", "Hot Paint"], ["yeast", "Yeast Brush"], null,
      ["type", "Living Type"], ["alpha", "Alphabet Brush"], ["balloon", "Balloon Type"], null,
      ["custom", "Custom 3D Brush"], ["extrude", "Extruder"], ["lathe", "Potter's Lathe"], ["fold", "Origami Fold"]],
    /* Transformer ce qui est déjà dessiné : retoucher la surface, la découper, la casser. */
    Effects: [["bayer", "Bayer Roller"], ["blend", "Dither Blender"], ["comb", "Pattern Comb"], ["waves", "Waves"], ["dryer", "Dryer"], ["glitch", "Glitch Brush"], ["melt", "Melting Brush"], null,
      ["grid", "Mondrian Knife"], ["blinds", "Op-Art Blinds"], ["moire", "Moire Film"], ["accordion", "Accordion"], null,
      ["acid", "Acid"], ["dynamite", "Dynamite"], ["hammer", "Glass Hammer"], ["ball", "Wrecking Ball"], ["slice", "Fault Slicer"]],
    /* Animer : ce qui bouge, pousse ou vit tout seul. */
    Life: [["balls", "Flying Spheres"], ["worm", "Caterpillar"], ["rain", "Rain"], ["snow", "Snow"], null,
      ["pump", "Bicycle Pump"], ["amoeba", "Amoeba Drops"], ["heart", "Beating Heart"], ["metal", "Liquid Metal"], null,
      ["graft", "Seed & Flowers"], ["sun", "Moving Sun"], ["coral", "Coral Growth"], ["shaker", "Pollen Shaker"], null,
      ["motor", "Motor"], ["elastic", "Elastic"], ["repel", "Force Field"], ["fly", "Fly Away"]],
    Cycle: [["cycle", "Color Cycling Brush"], ["cfill", "Cycling Fill"]],
    /* Volumes : six formes de base, éclairées et tramées. */
    "3D": [["cube", "Cube"], ["sphere", "Sphere"], ["cylinder", "Cylinder"], ["cone", "Cone"], ["pyramid", "Pyramid"], ["torus", "Torus"]]
  };

  const FX_NAMES = {};
  const FX_ALL = [].concat(...Object.values(FX_FAMILIES)).filter(Boolean).map(m => { FX_NAMES[m[0]] = m[1]; return m[0]; });
  const FXCELL = { x: SW - 55, y: 27, w: 26, h: 22 };              // palette de droite : deux colonnes de cases 25 × 21, comme à gauche
  const XMENUS = [["Draw", 0, 0], ["Effects", 0, 0], ["Life", 0, 0], ["Cycle", 0, 0], ["3D", 0, 0], ["Layer", 0, 0], ["Page", 0, 0]];   // menus écrits en Chicago, placés au premier dessin
  /* Sur un écran assez grand, chaque famille d'outils a sa petite palette, avec son onglet :
     Draw, Effects, Life, Cycle, 3D, puis Layers. Elles se rangent en colonnes à droite. Sur un
     écran trop petit, on retrouve la palette unique qui défile. */
  const PALS = { on: false, n: 1, list: [], lx: 0, ly: 0 };
  /* Les calques se rangent à gauche, sous les outils et la boussole, dès que l'écran est assez haut pour huit calques ;
     sinon ils restent à droite, après les palettes. */
  const layersLeft = () => SH - OH >= 279;
  function palsLayout() {
    const fam = Object.keys(FX_FAMILIES).map(n => ({ name: n, tools: FX_FAMILIES[n].filter(Boolean).map(m => m[0]) }));
    const top = 27 + 15, bottom = SH - 52, layersH = 6 * 18 + 22;
    for (let n = 1; n <= 4; n++) {
      if (n > 1 && SW - OW - 52 - (n - 1) * 58 + 416 < 440) break;      // la fenêtre de dessin garde au moins 440 points
      let c = 0, y = top, ok = true; const out = [];
      for (const f of fam) {
        const rows = Math.ceil(f.tools.length / 2), h = rows * 22 + 1;
        if (y + h > bottom && y > top) { c++; y = top; }
        if (c >= n || y + h > bottom) { ok = false; break; }
        out.push({ name: f.name, tools: f.tools, c: c, y: y, rows: rows }); y += h + 23;
      }
      if (ok && !layersLeft() && y + layersH > bottom && y > top) { c++; y = top; }
      if (ok && c < n) { out.forEach(q => { q.x = SW - 55 - (n - 1 - q.c) * 58; }); PALS.on = true; PALS.n = n; PALS.list = out; PALS.lx = SW - 55 - (n - 1 - c) * 58; PALS.ly = y; return n; }
    }
    PALS.on = false; PALS.n = 1; return 1;
  }
  function palAt(p) {
    for (const q of PALS.list) { const c = Math.floor((p.x - q.x) / 26), r = Math.floor((p.y - q.y) / 22), k = r * 2 + c; if (p.x >= q.x && c < 2 && p.y >= q.y && r < q.rows && k < q.tools.length) return q.tools[k]; }
    return null;
  }
  function drawPals() {
    for (const q of PALS.list) {
      const W = 53, H = q.rows * 22 + 1;
      ctx.fillStyle = "#000"; ctx.fillRect(q.x - 2, q.y - 15, W + 4, 15); ctx.fillStyle = "#fff"; ctx.fillRect(q.x - 1, q.y - 14, W + 2, 13);      // l'onglet du titre, comme celui des calques
      const tb = textBmp(q.name, "Geneva", 9, false, false); blit(ctx, tb, q.x + Math.round((W - tb.w) / 2), q.y - 13);
      ctx.fillStyle = "#000"; ctx.fillRect(q.x - 2, q.y - 2, W + 4, H + 4); ctx.fillStyle = "#fff"; ctx.fillRect(q.x - 1, q.y - 1, W + 2, H + 2);
      ctx.fillStyle = "#000"; ctx.fillRect(q.x, q.y, W, H);
      for (let k = 0; k < q.rows * 2; k++) {
        const x = q.x + (k % 2) * 26 + 1, y = q.y + (k >> 1) * 22 + 1, t = q.tools[k], on = t && tool === t;
        ctx.fillStyle = on ? "#000" : "#fff"; ctx.fillRect(x, y, 25, 21);
        if (t) fxIcon(t, x, y, on ? "#fff" : "#000");
      }
    }
    ctx.fillStyle = "#000";
  }
  let FXROWS = 8;                                                // rangées visibles de la palette de droite ; le reste défile

  /* ------------------------------------------------------------------ *
   *  Sons satiriques + rebond des pictogrammes (délégation à satire.js).
   *  satire.js est chargé avant macpaint.js ; en son absence (fichier
   *  local partiel), tout est neutralisé sans erreur.
   * ------------------------------------------------------------------ */
  const SND = (typeof Studio !== "undefined" && Studio.audio) ? Studio.audio : null;
  const MOT = (typeof Studio !== "undefined" && Studio.motion) ? Studio.motion : null;
  /* En mode tactile, touch.js gère déjà les sons ; ici on ne joue qu'en
     mode classique pour éviter les doublons. */
  function cheer(a) { if (touchMode || !SND) return; try { SND.cheer(a); } catch (e) {} }
  function stopSnd() { if (touchMode || !SND) return; try { SND.stop(); } catch (e) {} }
  function selectSnd(t) { if (touchMode || !SND) return; try { SND.select(t); } catch (e) {} }
  function loopSnd(kind) { if (touchMode || !SND) return; try { SND.loop(kind); } catch (e) {} }
  function loopStopSnd() { if (touchMode || !SND) return; try { SND.loopStop(); } catch (e) {} }
  function moveSnd(kind) { if (touchMode || !SND || !SND.motion) return; try { SND.motion(kind); } catch (e) {} }
  function uiSnd(kind, n) { if (touchMode || !SND || !SND.ui) return; try { SND.ui(kind, n); } catch (e) {} }
  /* Le geste en cours, pour la musique : position dans la fenêtre (0 à 1), outil, couleur. */
  function gestureSnd(phase, p) { if (touchMode || !SND || !SND.gesture || !topt("snd")) return; try { SND.gesture(phase, (p.x - VIEW.x) / VIEW.w, (p.y - VIEW.y) / VIEW.h, tool, ink); } catch (e) {} }
  function tickSnd(kind) { if (touchMode || !SND) return; try { SND.tick(kind); } catch (e) {} }

/* Chaque case de la palette a ses propres ressorts : la case entière saute,
     s'affaisse ou tremble. L'humeur de la salle (Studio.on) décide du reste :
     les cases ricanent, sursautent, font la ola ou somnolent. */
  const cellSprings = {};       // outil → { y, x }
  const cellQueue = [];         // coups différés : { at, tool, vy, vx }
  let bounceFrame = null;
  let working = false;          // la case tremble doucement pendant le dessin
  let liveNext = 0;
  let workTime = 0;
  let suspense = false;         // long trait : le tremblement s'emballe
  let idleUntil = 0;            // la palette somnole (grillons)
  let hoverCell = null;
  const STROBE = { hit: false, beat: -1e9, next: 0, last: 0, gap: 280, quiet: 0, acc: 0 };
  function startAnim() { if (!bounceFrame) bounceFrame = requestAnimationFrame(stepToolBounce); }
  function cellSpring(t) {
    return cellSprings[t] || (cellSprings[t] = { y: MOT.spring(240, 9), x: MOT.spring(300, 12) });
  }
  /* Niveau 1 (I'm Too Young To Die) : l'application classique, immobile. */
  function classicOnly() { return typeof Studio !== "undefined" && Studio.difficulty && Studio.difficulty.classic(); }
  function kickCell(t, vy, vx, delay) {
    if (!MOT || touchMode || classicOnly()) return;
    if (delay) cellQueue.push({ at: performance.now() + delay, tool: t, vy: vy, vx: vx || 0 });
    else { const sp = cellSpring(t); MOT.kick(sp.y, vy); MOT.kick(sp.x, vx || 0); }
    startAnim();
  }
  /* Sélection : la case choisie bondit et bouscule ses voisines. */
  function kickToolBounce(t) {
    if (!MOT) return;
    kickCell(t, -150, 60);
    const me = CLASSIC.tools.find(c => c.tool === t);
    if (!me) return;
    for (const c of CLASSIC.tools) {
      if (c === me) continue;
      const dx = (cellPos[c.tool].tx - cellPos[t].tx) / 26, dy = (cellPos[c.tool].ty - cellPos[t].ty) / 22, d = Math.hypot(dx, dy);
      if (d <= 2.3) kickCell(c.tool, dy / d * 55 / d, dx / d * 55 / d, d * 45);
    }
  }
  function paletteWave(power, stagger) {
    moveSnd("wave");
    CLASSIC.tools.forEach((c, i) => kickCell(c.tool, -power, 0, 1 + Math.floor(i / 2) * stagger + (i % 2) * stagger / 2));
  }
  function paletteSnicker(times) {
    moveSnd("snicker");
    for (let k = 0; k < times; k++)
      CLASSIC.tools.forEach((c, i) => kickCell(c.tool, -36, (i % 2 ? 1 : -1) * 22, 1 + k * 110 + (i * 37) % 60));
  }
  function paletteFlinch() {
    moveSnd("flinch");
    for (const c of CLASSIC.tools) if (c.tool !== tool) kickCell(c.tool, 0, c.x < 30 ? -75 : 75, 1 + Math.random() * 90);
  }
  function randomCell() {
    const others = CLASSIC.tools.filter(c => c.tool !== tool);
    return others[Math.floor(Math.random() * others.length)].tool;
  }
  if (!touchMode && MOT && typeof Studio.on === "function") Studio.on(function (type, d) {
    switch (type) {
      case "select": idleUntil = 0; break;
      case "difficulty": if (Studio.difficulty.classic()) legoReset(); paletteWave(90, 30); break;   // sinon on garde l'interface en l'état : le nouveau niveau s'installe dessus
      case "mock": paletteSnicker(4); physAvalanche(4); break;
      case "combo": kickCell(tool, -50 - 8 * Math.min(d.n, 10), (d.n % 2 ? 1 : -1) * 40); break;
      case "surprise": physDrop(randomCell(), (Math.random() - 0.5) * 120, -230); break;
      case "suspense": suspense = true; startAnim(); break;
      case "idle": if (!classicOnly()) { idleUntil = performance.now() + 14000; startAnim(); } break;
      case "bored": idleUntil = 0; kickCell(randomCell(), -170, 0); break;
      case "cheer":
        idleUntil = 0;
        if (d.action === "new") legoReset();
        else if (d.action === "draw" || d.action === "fill" || d.action === "erase" || d.action === "text" || d.action === "dot" || d.action === "ovation") legoProgress();
        if (d.action === "undo") { kickCell(tool, 130, 0); moveSnd("droop"); if (d.streak === 3) physDrop(tool, 30, -60); if (d.streak >= 2) paletteSnicker(1); }
        else if (d.action === "redo") kickCell(tool, -110, 0);
        else if (d.action === "erase") paletteFlinch();
        else if (d.action === "ovation") { paletteWave(170, 35); physAvalanche(20); }
        else if (d.action === "new" || d.action === "save") paletteWave(110, 45);
        else if (d.action === "dot") kickCell(tool, -60, 0);
        else if (d.action === "draw" || d.action === "fill" || d.action === "text") {
          kickCell(tool, -70 - 90 * d.energy, 0);
          if (d.category === "hysteria") paletteWave(70, 30);
          else if (d.category === "laugh") paletteSnicker(1);
        }
        break;
    }
  });
  function stepToolBounce() {
    bounceFrame = null;
    const t = performance.now();
    let busy = false;
    for (let i = cellQueue.length - 1; i >= 0; i--) {
      if (cellQueue[i].at > t) continue;
      const q = cellQueue.splice(i, 1)[0], sp = cellSpring(q.tool);
      MOT.kick(sp.y, q.vy); MOT.kick(sp.x, q.vx);
    }
    /* Animation fluide, à la cadence de l'écran. La simulation avance de 60 pas par seconde
       quel que soit l'écran : un pas par image à 60 Hz, un pas une image sur deux à 120 Hz
       (sinon tout irait deux fois plus vite), rattrapage si une image a été sautée. */
    if (t - STROBE.last > 100) STROBE.acc = 1; else STROBE.acc += (t - STROBE.last) * 0.06;
    STROBE.last = t;
    const turns = Math.min(4, Math.floor(STROBE.acc + 0.001));
    STROBE.acc -= turns;
    if (frenzyWas) busy = true;
    for (let n = 0; n < turns; n++) {
      for (const k in cellSprings) {
        const sp = cellSprings[k];
        MOT.stepSpring(sp.y, 1 / 60); MOT.stepSpring(sp.x, 1 / 60);
        if (!sp.y.done || !sp.x.done) busy = true;
      }
      if (legoStep(t)) busy = true;
      if (MOT && physStep(t)) busy = true;
      if (MOT && frenzyStep(t)) busy = true;
    }
    if (working) workTime += 1 / 60; else suspense = false;
    /* Ultra-Violence et au-delà : l'interface ne s'arrête pas pendant qu'on dessine. Tant que le
       trait dure, des cases de la palette continuent de bondir et les blocs de tressaillir. */
    /* … ni quand une fenêtre, un piège ou une publicité est ouvert : à ces niveaux rien ne
       s'arrête jamais, l'interface bouge en permanence dès le premier clic. */
    const restless = MOT && !touchMode && Studio.difficulty.get() >= 3 && Studio.difficulty.started();
    if (restless) busy = true;
    if (restless && t > liveNext) {
      liveNext = t + 140 + Math.random() * 240;
      kickCell(randomCell(), -35 - Math.random() * 60, (Math.random() - 0.5) * 80);
      if (Math.random() < 0.35) { const b = LEGO[1 + Math.floor(Math.random() * 3)]; MOT.kick(b.sy, (Math.random() - 0.5) * 120); MOT.kick(b.sx, (Math.random() - 0.5) * 80); b.sx.done = b.sy.done = false; }
    }
    if (turns > 0 || working) render();
    if (working || busy || cellQueue.length || t < idleUntil) bounceFrame = requestAnimationFrame(stepToolBounce);
  }

  /* ------------------------------------------------------------------ *
   *  Interface « Lego ». L'écran est découpé en blocs (menus, palette,
   *  épaisseurs, trames, fenêtre). Le moteur continue de tout dessiner à
   *  sa place d'origine ; legoCompose() recopie ensuite chaque bloc là où
   *  il se trouve aujourd'hui, et legoMap() ramène chaque clic dans le
   *  repère d'origine du bloc touché. Plus on travaille, plus l'interface
   *  prend ses aises : les cases s'échangent, les blocs déménagent.
   * ------------------------------------------------------------------ */
  const LEGO = [
    { id: "window",   x: 76, y: 24,  w: 426, h: 270 },
    { id: "patterns", x: 76, y: 296, w: 430, h: 42 },
    { id: "tools",    x: 12, y: 24,  w: 58,  h: 226 },
    { id: "lines",    x: 2,  y: 252, w: 68,  h: 86 },
    { id: "menubar",  x: 0,  y: 0,   w: 512, h: 19 }      // dessiné en dernier : au-dessus
  ];
  const LEGO_LAYOUTS = [
    {},                                                                                   // 0 : comme en 1984
    { tools: [430, 0], lines: [442, 0], window: [-70, 0], patterns: [-70, 0] },           // 1 : palette à droite
    { patterns: [0, -274], window: [0, 44] },                                             // 2 : trames en haut
    { tools: [430, 0], lines: [442, 0], window: [-70, 44], patterns: [-70, -274] },       // 3 : les deux
    { menubar: [0, 323], tools: [0, -20], lines: [0, -20], window: [0, -20], patterns: [0, -20] },        // 4 : menus en bas
    { menubar: [0, 323], tools: [430, -20], lines: [442, -20], window: [-70, -20], patterns: [-70, -20] },// 5
    { menubar: [0, 323], patterns: [0, -294], window: [0, 22], tools: [0, -20], lines: [0, -20] }         // 6
  ];
  let mischief = 0, legoLevel = 0, legoLayout = 0, legoGrab = null, legoMoved = false;
  let legoScene = null, legoTmp = null, legoMenu = null;
  const cellPos = {};                        // outil → place actuelle de sa case
  for (const b of LEGO) { b.ox = 0; b.oy = 0; b.sx = MOT ? MOT.spring(70, 12) : null; b.sy = MOT ? MOT.spring(70, 12) : null; }
  /* La zone de travail (bloc « window ») peut aussi tourner et changer d'échelle
     autour de son centre : en Ultra-Violence elle pivote lentement vers un nouvel
     angle toutes les quelques secondes ; en Nightmare! angle et échelle changent
     brutalement plusieurs fois par seconde. Les clics sont ramenés dans le repère
     de la feuille par la transformation inverse (legoWindowPoint). */
  const WORK = LEGO[0];
  WORK.rot = 0; WORK.sc = 1; WORK.nextTurn = 0; WORK.hit = false; WORK.pulse = 1; WORK.lastBeat = -1e9; WORK.jx = 0; WORK.jy = 0;
  WORK.rs = MOT ? MOT.spring(30, 8) : null; WORK.ss = MOT ? MOT.spring(30, 8) : null;
  if (WORK.ss) { WORK.ss.x = 1; WORK.ss.target = 1; }
  const HEAD = { drag: null, x: 0, y: 0 };
  function headingFollow(e) {
    if (touchMode || !MOT || typeof Studio === "undefined" || Studio.difficulty.get() !== 2 || !Studio.difficulty.started()) return;
    if (HEAD.drag !== drag) { HEAD.drag = drag; HEAD.x = e.clientX; HEAD.y = e.clientY; HEAD.vx = HEAD.vy = 0; return; }
    /* Direction lissée : chaque petit déplacement de la souris tire un peu sur une direction
       moyenne, au lieu de la remplacer. La cible tourne donc en continu, sans à-coups. */
    const dx = e.clientX - HEAD.x, dy = e.clientY - HEAD.y;
    HEAD.x = e.clientX; HEAD.y = e.clientY;
    HEAD.vx = (HEAD.vx || 0) * 0.9 + dx * 0.1; HEAD.vy = (HEAD.vy || 0) * 0.9 + dy * 0.1;
    if (HEAD.vx * HEAD.vx + HEAD.vy * HEAD.vy < 0.5) return;     // presque immobile : pas de direction
    let d = Math.atan2(HEAD.vy, HEAD.vx) - WORK.rs.target;       // par le plus court chemin, sans jamais rembobiner
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
    d *= 0.25;                                                   // la cible elle-même ne fait qu'un quart du chemin
    WORK.rs.target += d; WORK.rs.done = false; WORK.followed = true;
    startAnim();
  }
  function workStep(t) {
    const level = (touchMode || !MOT || (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)) || !Studio.difficulty.started() ? 0 : Studio.difficulty.get();
    const wild = level === 4, turning = level >= 3;          // fenêtre ouverte ou non : ça tourne
    /* Nightmare! : les déplacements se font petit à petit (une à deux secondes), par poses
       successives sur les frappes de la musique, jamais d'un seul coup. */
    WORK.rs.stiffness = WORK.ss.stiffness = wild ? 70 : 30;
    WORK.rs.damping = WORK.ss.damping = wild ? 12 : 8;
    if (!wild) WORK.jxT = WORK.jyT = 0;
    WORK.jx += ((WORK.jxT || 0) - WORK.jx) * 0.09; WORK.jy += ((WORK.jyT || 0) - WORK.jy) * 0.09;
    /* Hurt Me Plenty : la feuille tourne vers la direction du trait (headingFollow), avec un
       ressort mou : elle suit le dessin, toujours un peu en retard sur lui. */
    const follow = level === 2 && !dialog;
    if (follow) { WORK.rs.stiffness = 7; WORK.rs.damping = 5.4; WORK.ss.target = 1; }   // amorti critique : aucun rebond, aucune secousse
    else if (WORK.followed) { WORK.followed = false; WORK.rs.target = 0; }
    if (follow) { /* cible posée par headingFollow */ }
    else if (!turning) { WORK.rs.target = 0; WORK.ss.target = 1; }
    else if (t > WORK.nextTurn) {
      WORK.hit = false;                                         // en musique : un saut par temps, pas au hasard
      /* Nightmare! : nouvel angle, nouvelle échelle et saut de position quatre à huit
         fois par seconde ; une fois sur cinq, la feuille se retrouve la tête en bas. */
      WORK.nextTurn = t + (wild ? 1400 + Math.random() * 1000 : 3500 + Math.random() * 2500);
      const R = Studio.difficulty.ramp();                         // montée progressive après un changement de niveau
      WORK.rs.target = ((Math.random() - 0.5) * (wild ? 1.0 : 0.5) + (wild && R >= 1 && Math.random() < 0.07 ? Math.PI : 0)) * R;   // ± 29° ou ± 14°
      WORK.ss.target = wild ? 1 + (Math.random() * 0.3 - 0.12) * R : 1;
      WORK.jxT = wild ? Math.round((Math.random() - 0.5) * 50 * R) : 0; WORK.jyT = wild ? Math.round((Math.random() - 0.5) * 30 * R) : 0;
      if (wild) moveSnd("swap"); else moveSnd("move");
    }
    MOT.stepSpring(WORK.rs, 1 / 60); MOT.stepSpring(WORK.ss, 1 / 60);
    /* Le tremblement suit la musique : une secousse sur chaque temps, qui retombe aussitôt.
       Sans musique (son coupé), elle tremble en continu comme avant. */
    WORK.pulse *= 0.9;                                           // la secousse d'une frappe retombe en douceur
    const shiver = wild ? WORK.pulse * 1.6 * Studio.difficulty.ramp() : 0;
    WORK.rot = Math.abs(WORK.rs.x) < 0.002 && !wild ? 0 : WORK.rs.x + shiver * (WORK.shR || 0) * 0.12;
    WORK.sc = Math.abs(WORK.ss.x - 1) < 0.004 && !wild ? 1 : Math.max(0.3, WORK.ss.x + shiver * (WORK.shS || 0) * 0.08);
    return level >= 3 || WORK.rot !== 0 || WORK.sc !== 1;
  }
  /* Point de l'écran → point de la scène, à travers la transformation d'un bloc
     (déplacement, rotation et échelle autour de son centre) ; et l'inverse. */
  function blockPoint(b, p) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = b.rot || 0, sc = b.sc || 1;
    const dx = p.x - cx - b.ox, dy = p.y - cy - b.oy, c = Math.cos(-r), n = Math.sin(-r);
    return { x: cx + (dx * c - dy * n) / sc, y: cy + (dx * n + dy * c) / sc };
  }
  function blockSpot(b, x, y) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = b.rot || 0, sc = b.sc || 1;
    const dx = (x - cx) * sc, dy = (y - cy) * sc, c = Math.cos(r), n = Math.sin(r);
    return { x: cx + b.ox + dx * c - dy * n, y: cy + b.oy + dx * n + dy * c };
  }
  function legoWindowPoint(p) { return blockPoint(WORK, p); }

  /* ------------------------------------------------------------------ *
   *  Nightmare! : apocalypse graphique. Les blocs (palette, épaisseurs,
   *  trames) tournent et changent de taille chacun de leur côté, et par
   *  moments la barre des trames vole en éclats : chacun des 38 carrés,
   *  plus l'échantillon courant, part ailleurs sur l'écran avec sa propre
   *  taille et son propre angle, puis tout se rassemble. Un carré envolé
   *  reste cliquable là où il se trouve.
   * ------------------------------------------------------------------ */
  const FRAGS = [];
  for (let i = 0; i < 38; i++) FRAGS.push({ x: 120 + (i % 19) * 20, y: 300 + Math.floor(i / 19) * 17, w: 19, h: 16 });
  FRAGS.push({ x: 85, y: 305, w: 28, h: 23 });
  for (const f of FRAGS) { f.parent = LEGO[1]; f.k = 0; f.kt = 0; f.next = 0; f.px = 0; f.py = 0; f.rot = 0; f.sc = 1; f.ax = 0; f.ay = 0; f.ar = 0; f.as = 1; f.tx = 0; f.ty = 0; f.tr = 0; f.ts = 1; }
  for (const b of LEGO) if (b !== WORK && b.id !== "menubar") {
    b.rot = 0; b.sc = 1; b.nextTurn = 0;
    b.rs = MOT ? MOT.spring(70, 12) : null; b.ss = MOT ? MOT.spring(70, 12) : null;
    if (b.ss) { b.ss.x = 1; b.ss.target = 1; }
  }
  let shatterNext = 0, shatterUntil = 0;
  function apocalypseStep(t) {
    const wild = frenzyWas;
    for (const b of LEGO) {
      if (b === WORK || b.id === "menubar") continue;
      if (!wild) { b.rs.target = 0; b.ss.target = 1; }
      else if (t > b.nextTurn) {
        b.nextTurn = t + 2600 + Math.random() * 2200;             // une pose toutes les 3 à 5 s : on a le temps de lire
        const still = Math.random() < 0.6;                       // le plus souvent, un bloc reprend sa forme
        const R = Studio.difficulty.ramp();
        b.rs.target = still ? 0 : (Math.random() - 0.5) * 0.5 * R;          // ± 14°
        b.ss.target = still ? 1 : 1 + (Math.random() * 0.3 - 0.12) * R;     // de 0,88 à 1,18
      }
      MOT.stepSpring(b.rs, 1 / 60); MOT.stepSpring(b.ss, 1 / 60);
      b.rot = Math.abs(b.rs.x) < 0.003 ? 0 : b.rs.x;
      b.sc = Math.abs(b.ss.x - 1) < 0.005 ? 1 : Math.max(0.3, b.ss.x);
    }
    if (wild && t > shatterNext && Studio.difficulty.ramp() >= 1) {
      shatterNext = t + 15000 + Math.random() * 6000;              // en vol un dixième du temps environ
      shatterUntil = t + 1800 + Math.random() * 700;
      moveSnd("flinch");
    }
    const flying = wild && t < shatterUntil;
    let busy = false;
    for (const f of FRAGS) {
      const home = blockSpot(f.parent, f.x + f.w / 2, f.y + f.h / 2);
      if (flying) {
        if (t > f.next) {
          if (!f.k) { f.ax = home.x; f.ay = home.y; f.ar = f.parent.rot; f.as = f.parent.sc; }
          f.next = 1e15; f.kt = 1; f.hop = 1;                      // un seul bond par éclatement
          f.tx = f.w + Math.random() * (SW - 2 * f.w); f.ty = 24 + Math.random() * (SH - 48);
          /* Les carrés se posent autour de la feuille, pas dessus : le dessin reste visible. */
          const wx = WORK.x + WORK.w / 2 + WORK.ox, wy = WORK.y + WORK.h / 2 + WORK.oy, hx = WORK.w * 0.4, hy = WORK.h * 0.4;
          if (Math.abs(f.tx - wx) < hx && Math.abs(f.ty - wy) < hy) {
            if (Math.random() < 0.5) f.tx = wx + (f.tx < wx ? -1 : 1) * (hx + Math.random() * 30); else f.ty = wy + (f.ty < wy ? -1 : 1) * (hy + Math.random() * 20);
            f.tx = Math.max(f.w, Math.min(SW - f.w, f.tx)); f.ty = Math.max(24, Math.min(SH - f.h, f.ty));
          }
          f.tr = (Math.random() - 0.5) * 1.6; f.ts = 0.85 + Math.random() * 0.45;
        }
      } else { f.kt = 0; f.next = 0; }
      f.k += (f.kt - f.k) * 0.1;
      if (!f.kt && f.k < 0.01) f.k = 0;
      if (!f.k) continue;
      busy = true;
      f.ax += (f.tx - f.ax) * 0.1; f.ay += (f.ty - f.ay) * 0.1; f.ar += (f.tr - f.ar) * 0.1; f.as += (f.ts - f.as) * 0.1;   // trajet en une demi-seconde environ
      f.hop = (f.hop || 0) * 0.93;                                 // chaque déplacement est un bond
      f.px = home.x + (f.ax - home.x) * f.k; f.py = home.y + (f.ay - home.y) * f.k - Math.sin(Math.PI * f.hop) * 46 * f.k;
      f.rot = f.parent.rot * (1 - f.k) + f.ar * f.k; f.sc = f.parent.sc * (1 - f.k) + f.as * f.k;
    }
    return busy || wild;
  }
  for (const c of CLASSIC.tools) cellPos[c.tool] = { x: c.x, y: c.y, tx: c.x, ty: c.y };
  function cellAt(p) {
    return CLASSIC.tools.find(c => { if (bodies[c.tool]) return false; const q = cellPos[c.tool]; return p.x >= q.x && p.x < q.x + 25 && p.y >= q.y && p.y < q.y + 21; });
  }
  function swapCells(a, b) {
    const list = CLASSIC.tools;
    a = a || list[Math.floor(Math.random() * list.length)].tool;
    while (!b || b === a) b = list[Math.floor(Math.random() * list.length)].tool;
    const A = cellPos[a], B = cellPos[b], tx = A.tx, ty = A.ty;
    A.tx = B.tx; A.ty = B.ty; B.tx = tx; B.ty = ty;
    moveSnd("swap");
    startAnim();
  }
  function legoSetLayout(i) {
    if (i !== legoLayout) moveSnd("move");
    legoLayout = i;
    const L = LEGO_LAYOUTS[i];
    for (const b of LEGO) { const o = L[b.id] || [0, 0]; b.sx.target = o[0]; b.sy.target = o[1]; b.sx.done = b.sy.done = false; }
    startAnim();
  }
  function legoRearrange() {
    const max = legoLevel >= 4 ? LEGO_LAYOUTS.length : 4;       // les menus ne déménagent qu'au palier 4
    let i = legoLayout;
    while (i === legoLayout) i = Math.floor(Math.random() * max);
    legoSetLayout(i);
  }
  function legoReset() {
    mischief = 0; legoLevel = 0;
    physRecall();
    for (const c of CLASSIC.tools) { cellPos[c.tool].tx = c.x; cellPos[c.tool].ty = c.y; }
    legoSetLayout(0);
  }
  /* Appelé à chaque geste accompli. */
  function legoProgress() {
    if (!MOT || touchMode) return;
    mischief++;
    const level = Studio.difficulty.levelFor(mischief);     // paliers réglés par la difficulté choisie
    if (level !== legoLevel) {
      legoLevel = level;
      cheer("level");
      paletteWave(120, 30);
      if (level >= 3) legoRearrange(); else if (level === 2) { swapCells(); swapCells(); }
      physAvalanche(2 + 3 * level);
      return;
    }
    if (legoLevel >= 1 && mischief % 7 === 3) physAvalanche(1 + legoLevel);
    if (legoLevel >= 1) moveSnd("thump");
    if (legoLevel >= 1) for (const b of LEGO) if (b.id !== "window" && b.id !== "menubar") MOT.kick(b.sy, -40 - 10 * legoLevel);
    if (legoLevel >= 2 && mischief % (legoLevel >= 5 ? 3 : 6) === 0) swapCells();
    if (legoLevel >= 3 && mischief % (legoLevel >= 5 ? 5 : 10) === 0) legoRearrange();
    startAnim();
  }
  function legoStep(t) {
    if (!MOT) return false;
    if (!legoTight) legoTighten();
    let busy = legoLevel >= 5;
    if (workStep(t)) busy = true;
    if (apocalypseStep(t)) busy = true;                                  // dernier palier : tout tangue en permanence
    LEGO.forEach((b, i) => {
      MOT.stepSpring(b.sx, 1 / 60); MOT.stepSpring(b.sy, 1 / 60);
      if (!b.sx.done || !b.sy.done) busy = true;
      let x = b.sx.x, y = b.sy.x;
      if (legoLevel >= 5 && b.id !== "window") { x += Math.sin(t / 900 + i * 1.7) * 3; y += Math.cos(t / 1100 + i) * 2; }
      // Pas de deux pixels : la trame grise du bureau reste en phase.
      if (frenzyWas) { x += b.jx2 || 0; y += b.jy2 || 0; }       // secousse posée sur chaque frappe (pas de bruit image par image : ce serait du flou)
      if (b === WORK) { x += WORK.jx; y += WORK.jy; }
      b.ox = Math.round(x / 2) * 2; b.oy = b.id === "menubar" ? Math.round(y) : Math.round(y / 2) * 2;
    });
    for (const k in cellPos) {
      const q = cellPos[k];
      if (q.x === q.tx && q.y === q.ty) continue;
      const ease = frenzyWas ? 0.1 : 0.2;
      q.x += (q.tx - q.x) * ease; q.y += (q.ty - q.y) * ease;
      if (Math.abs(q.tx - q.x) < 0.6 && Math.abs(q.ty - q.y) < 0.6) { q.x = q.tx; q.y = q.ty; } else busy = true;
    }
    return busy;
  }
  function legoCompose() {
    legoMoved = LEGO.some(b => b.ox || b.oy || b.rot || (b.sc !== undefined && b.sc !== 1)) || FRAGS.some(f => f.k);
    if (!legoMoved) return;
    if (!legoScene) {
      legoScene = document.createElement("canvas"); legoScene.width = SW; legoScene.height = SH;
      legoTmp = document.createElement("canvas"); legoTmp.width = SW; legoTmp.height = SH;
    }
    legoScene.getContext("2d").drawImage(cv, 0, 0);
    fillDesk();
    ctx.imageSmoothingEnabled = false;
    for (const b of LEGO) {
      if (b.rot || (b.sc !== undefined && b.sc !== 1)) {
        ctx.save();
        ctx.translate(b.x + b.w / 2 + b.ox, b.y + b.h / 2 + b.oy);
        ctx.rotate(b.rot); ctx.scale(b.sc, b.sc);
        ctx.drawImage(legoScene, b.x, b.y, b.w, b.h, -b.w / 2, -b.h / 2, b.w, b.h);
        ctx.fillStyle = "#fff";                                  // la place vide des carrés envolés
        for (const f of FRAGS) if (f.k && f.parent === b) ctx.fillRect(f.x - b.x - b.w / 2, f.y - b.y - b.h / 2, f.w, f.h);
        ctx.restore();
      } else {
        ctx.drawImage(legoScene, b.x, b.y, b.w, b.h, b.x + b.ox, b.y + b.oy, b.w, b.h);
        ctx.fillStyle = "#fff";
        for (const f of FRAGS) if (f.k && f.parent === b) ctx.fillRect(f.x + b.ox, f.y + b.oy, f.w, f.h);
      }
    }
    for (const f of FRAGS) {                                      // les carrés envolés, par-dessus tout
      if (!f.k) continue;
      ctx.save();
      ctx.translate(f.px, f.py); ctx.rotate(f.rot); ctx.scale(f.sc, f.sc);
      ctx.fillStyle = "#000"; ctx.fillRect(-f.w / 2 - 1, -f.h / 2 - 1, f.w + 2, f.h + 2);
      ctx.drawImage(legoScene, f.x, f.y, f.w, f.h, -f.w / 2, -f.h / 2, f.w, f.h);
      ctx.restore();
    }
    ctx.fillStyle = "#000";
  }
  function legoDrop() {                                          // menu déroulant : suit la barre, s'ouvre vers le haut au besoin
    const L = menuLayout(menuOpen), bar = LEGO[4];
    let x = L.x; if (x + L.w > SW) x = SW - L.w;
    const r = { x: Math.max(0, x - 1), y: MENUBAR, w: L.w + 6, h: Math.min(SH - MENUBAR, L.h + 8) };
    r.dx = bar.ox; r.dy = r.y + bar.oy + r.h > SH ? bar.oy - r.h - MENUBAR : bar.oy;
    return r;
  }
  function legoDrawMenu() {
    if (!legoMoved) { drawMenu(); return; }
    const t = legoTmp.getContext("2d");
    t.drawImage(cv, 0, 0);                                       // écran composé, mis de côté
    ctx.drawImage(legoScene, 0, 0);                              // le menu se dessine dans le repère d'origine
    drawMenu();
    if (!legoMenu) { legoMenu = document.createElement("canvas"); legoMenu.width = SW; legoMenu.height = SH; }
    const r = legoDrop(), m = legoMenu.getContext("2d");
    m.drawImage(cv, 0, 0);
    ctx.drawImage(legoTmp, 0, 0);
    ctx.drawImage(legoMenu, r.x, r.y, r.w, r.h, r.x + r.dx, r.y + r.dy, r.w, r.h);
  }

  /* ------------------------------------------------------------------ *
   *  Rendu net des blocs tournés. L'écran simulé ne fait que 512 × 342
   *  points : y faire tourner une fenêtre de quelques degrés casse ses
   *  lignes en escaliers et effiloche ses bords. Dès qu'un bloc tourne,
   *  change de taille ou qu'une case vole, la composition est donc refaite
   *  sur un second canevas, posé exactement sur l'écran mais à la
   *  définition réelle de l'appareil : chaque point du Mac y est un carré
   *  net, quelle que soit sa rotation. Les menus et dialogues, eux, restent
   *  droits et sont recopiés tels quels. Les clics vont toujours à l'écran.
   * ------------------------------------------------------------------ */
  let legoHi = null, legoHiDesk = null;
  function legoSharp() {
    const need = !touchMode && (LEGO.some(b => b.rot || (b.sc !== undefined && b.sc !== 1)) || FRAGS.some(f => f.k) || Object.keys(bodies).length > 0);
    if (!need) { if (legoHi && legoHi.style.display !== "none") legoHi.style.display = "none"; if (cv.style.opacity) cv.style.opacity = ""; return; }
    if (!legoHi) {
      legoHi = document.createElement("canvas");
      legoHi.setAttribute("aria-hidden", "true");
      cv.parentNode.insertBefore(legoHi, cv.nextSibling);
    }
    const dpr = window.devicePixelRatio || 1, W = Math.max(SW, Math.round(cv.clientWidth * dpr)), H = Math.round(W * SH / SW);
    const K = W / SW;
    /* Nightmare! : tout l'écran du Mac bouge, tourne et change de taille dans la page.
       Faire cela par une transformation CSS obligeait le navigateur à rééchantillonner
       une image déjà tramée : le damier gris du bureau moirait et les bords bavaient.
       La toile nette couvre donc toute la page, sans aucune transformation CSS, et
       l'écran y est redessiné à sa pose du moment, à la définition réelle de l'appareil.
       Le damier du bureau, lui, est posé droit sur les pixels de l'appareil : il ne
       tourne pas, donc il ne moire jamais. L'écran d'origine reste dessous, invisible,
       et continue de recevoir les clics. */
    const full = frenzyWas;
    const g = legoHi.getContext("2d");
    if (full) {
      const VW = Math.round(window.innerWidth * dpr), VH = Math.round(window.innerHeight * dpr);
      if (legoHi.width !== VW || legoHi.height !== VH) { legoHi.width = VW; legoHi.height = VH; }
      legoHi.style.cssText = "position:fixed;pointer-events:none;display:block;left:0;top:0;width:" + window.innerWidth + "px;height:" + window.innerHeight + "px";
      cv.style.opacity = "0";
      const sx = (WORK.shR || 0) * frenzyShake, sy = (WORK.shS || 0) * frenzyShake;
      const cx = Math.round((cv.offsetLeft + cv.offsetWidth / 2 + APP.x.x + sx) * dpr), cy = Math.round((cv.offsetTop + cv.offsetHeight / 2 + APP.y.x + sy) * dpr);
      g.save();                                                  // après le changement de taille, qui vide la pile d'états
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, VW, VH);
      g.translate(cx, cy); g.rotate(APP.rot); g.scale(APP.sc * K, APP.sc * K); g.translate(-SW / 2, -SH / 2);
      g.fillStyle = "#000"; g.fillRect(-1, -1, SW + 2, SH + 2);    // liseré noir de l'écran
      g.beginPath(); g.rect(0, 0, SW, SH); g.clip();               // (rogné à l'écran ; l'état est rendu en fin de fonction)
    } else {
      if (cv.style.opacity) cv.style.opacity = "";
      if (legoHi.width !== W || legoHi.height !== H) { legoHi.width = W; legoHi.height = H; legoHiDesk = null; }
      legoHi.style.cssText = "position:absolute;pointer-events:none;display:block;left:" + cv.style.left + ";top:" + cv.style.top +
        ";width:" + cv.style.width + ";height:" + cv.style.height + ";transform:" + (cv.style.transform || "none");
      g.save();
      g.setTransform(K, 0, 0, K, 0, 0);
    }
    g.imageSmoothingEnabled = false;
    if (!legoMoved) g.drawImage(cv, 0, 0);                       // rien n'a bougé : seules des cases volent par-dessus
    else {
      if (full) {
        /* Damier en pixels d'appareil : cases entières, à la taille d'un point du Mac. */
        const cell = Math.max(2, Math.round(K * APP.sc));
        if (!legoHiDesk || legoHiDesk.cell !== cell || !legoHiDesk.full) {
          const c = document.createElement("canvas"); c.width = c.height = cell * 2;
          const x = c.getContext("2d");
          x.fillStyle = "#fff"; x.fillRect(0, 0, cell * 2, cell * 2); x.fillStyle = "#000"; x.fillRect(0, 0, cell, cell); x.fillRect(cell, cell, cell, cell);
          legoHiDesk = { cell: cell, full: true, pat: g.createPattern(c, "repeat") };
        }
        const m = g.getTransform();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.fillStyle = legoHiDesk.pat; g.fillRect(0, 0, legoHi.width, legoHi.height);
        g.setTransform(m);
      } else {
        if (!legoHiDesk || legoHiDesk.full) {
          const c = document.createElement("canvas"); c.width = 2; c.height = 2;
          const x = c.getContext("2d");
          x.fillStyle = "#fff"; x.fillRect(0, 0, 2, 2); x.fillStyle = "#000"; x.fillRect(0, 0, 1, 1); x.fillRect(1, 1, 1, 1);
          legoHiDesk = { full: false, pat: g.createPattern(c, "repeat") };
        }
        g.fillStyle = legoHiDesk.pat; g.fillRect(0, 0, SW, SH);
      }
      for (const b of LEGO) {
        g.save();
        g.translate(b.x + b.w / 2 + b.ox, b.y + b.h / 2 + b.oy);
        if (b.rot) g.rotate(b.rot);
        if (b.sc !== undefined && b.sc !== 1) g.scale(b.sc, b.sc);
        g.drawImage(legoScene, b.x, b.y, b.w, b.h, -b.w / 2, -b.h / 2, b.w, b.h);
        g.fillStyle = "#fff";
        for (const f of FRAGS) if (f.k && f.parent === b) g.fillRect(f.x - b.x - b.w / 2, f.y - b.y - b.h / 2, f.w, f.h);
        g.restore();
      }
      for (const f of FRAGS) {
        if (!f.k) continue;
        g.save();
        g.translate(f.px, f.py); g.rotate(f.rot); g.scale(f.sc, f.sc);
        g.fillStyle = "#000"; g.fillRect(-f.w / 2 - 1, -f.h / 2 - 1, f.w + 2, f.h + 2);
        g.drawImage(legoScene, f.x, f.y, f.w, f.h, -f.w / 2, -f.h / 2, f.w, f.h);
        g.restore();
      }
    }
    drawBodies(g);
    if (menuOpen >= 0) {                                           // menu déroulant : recopié droit depuis l'écran
      const bar = LEGO[4], r = legoMoved ? legoDrop() : null;
      g.drawImage(cv, bar.x + bar.ox, bar.y + bar.oy, bar.w, bar.h, bar.x + bar.ox, bar.y + bar.oy, bar.w, bar.h);
      if (r) g.drawImage(cv, r.x + r.dx, r.y + r.dy, r.w, r.h, r.x + r.dx, r.y + r.dy, r.w, r.h);
      else { const L = menuLayout(menuOpen); g.drawImage(cv, 0, MENUBAR, SW, Math.min(SH - MENUBAR, L.h + 8), 0, MENUBAR, SW, Math.min(SH - MENUBAR, L.h + 8)); }
    }
    if (dialog && dialog._rect) { const r = dialog._rect; g.drawImage(cv, r.x - 2, r.y - 2, r.w + 8, r.h + 8, r.x - 2, r.y - 2, r.w + 8, r.h + 8); }
    g.restore();
  }
  /* Les blocs sont rognés au plus près de leur objet : sans cela chacun emportait
     une marge de trame grise du bureau, qui tournait avec lui et jurait avec le fond. */
  let legoTight = false;
  function legoTighten() {
    legoTight = true;
    const data = chromeCtx.getImageData(0, 0, SW, SH).data;
    const dark = (x, y) => data[(y * SW + x) * 4] < 128;
    const desk = (x, y, w, h) => {                                // segment entièrement en damier
      const first = dark(x, y);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (dark(x + i, y + j) !== (((i + j) & 1) ? !first : first)) return false;
      return w * h > 1;
    };
    for (const b of LEGO) {
      if (b.id === "menubar") continue;
      while (b.h > 8 && desk(b.x, b.y, b.w, 1)) { b.y++; b.h--; }
      while (b.h > 8 && desk(b.x, b.y + b.h - 1, b.w, 1)) b.h--;
      while (b.w > 8 && desk(b.x, b.y, 1, b.h)) { b.x++; b.w--; }
      while (b.w > 8 && desk(b.x + b.w - 1, b.y, 1, b.h)) b.w--;
    }
  }
  /* Point de l'écran → point dans le repère d'origine du bloc touché. */
  function legoMap(p, down) {
    if (!legoMoved || dialog) return p;
    const inside = (b, ox, oy) => p.x >= b.x + ox && p.x < b.x + ox + b.w && p.y >= b.y + oy && p.y < b.y + oy + b.h;
    const within = (r, q) => q.x >= r.x && q.x < r.x + r.w && q.y >= r.y && q.y < r.y + r.h;
    if (menuOpen >= 0) {
      const bar = LEGO[4];
      if (inside(bar, bar.ox, bar.oy)) return { x: p.x - bar.ox, y: p.y - bar.oy };
      const r = legoDrop();
      if (inside(r, r.dx, r.dy)) return { x: p.x - r.dx, y: p.y - r.dy };
    }
    let b = !down && drag ? legoGrab : null;
    if (!b) {
      for (let i = FRAGS.length - 1; i >= 0; i--) {              // un carré envolé se clique là où il est
        const f = FRAGS[i];
        if (!f.k) continue;
        const dx = p.x - f.px, dy = p.y - f.py, c = Math.cos(-f.rot), n = Math.sin(-f.rot);
        const q = { x: f.x + f.w / 2 + (dx * c - dy * n) / f.sc, y: f.y + f.h / 2 + (dx * n + dy * c) / f.sc };
        if (within(f, q)) { if (down) legoGrab = f.parent; return q; }
      }
      for (let i = LEGO.length - 1; i >= 0 && !b; i--) if (within(LEGO[i], blockPoint(LEGO[i], p))) b = LEGO[i];
    }
    if (down) legoGrab = b;
    return b ? blockPoint(b, p) : { x: 4, y: 150 };             // entre deux blocs : le bureau
  }

  /* ------------------------------------------------------------------ *
   *  Modèle physique. Une case peut se décrocher de la palette : elle
   *  devient un corps soumis à la gravité, qui tombe, rebondit sur le bas
   *  et les bords de l'écran, s'écrase à l'impact, heurte les autres
   *  cases, puis est rappelée à sa place par un ressort (avec dépassement).
   *  Les corps vivent dans le repère de l'écran, par-dessus les blocs, et
   *  restent cliquables là où ils se trouvent. Chaque choc a son bruit.
   * ------------------------------------------------------------------ */
  const bodies = {};                         // outil → corps libre
  const GRAVITY = 560, BOUNCE = 0.6;
  let rawPointer = { x: -99, y: -99 };
  function physHome(t) { const q = cellPos[t], b = LEGO[2]; return { x: q.tx + b.ox, y: q.ty + b.oy }; }
  function physDrop(t, vx, vy, stay) {
    if (!MOT || touchMode || bodies[t] || classicOnly()) return;
    const q = cellPos[t], b = LEGO[2];
    bodies[t] = { x: q.x + b.ox, y: q.y + b.oy, vx: vx, vy: vy, a: 0, va: (Math.random() - 0.5) * 9, sq: 0, zoom: 1, zt: 1,
                  free: true, until: performance.now() + (stay || 2600) + Math.random() * 2400 };
    startAnim();
  }
  function physAvalanche(n) {
    const left = CLASSIC.tools.map(c => c.tool).filter(t => !bodies[t]);
    for (let i = 0; i < n && left.length; i++) {
      const t = left.splice(Math.floor(Math.random() * left.length), 1)[0];
      physDrop(t, (Math.random() - 0.3) * 150, -40 - Math.random() * 140);
    }
  }
  function physRecall() { for (const t in bodies) bodies[t].until = 0; }
  function bodyAt(p) {
    // La case grandit depuis son bord bas : la zone cliquable suit sa taille.
    for (const t in bodies) {
      const b = bodies[t], z = b.zoom || 1, cx = b.x + 12.5, bottom = b.y + 21;
      if (Math.abs(p.x - cx) <= 13.5 * z && p.y <= bottom + 2 && p.y >= bottom - 23 * z) return t;
    }
    return null;
  }
  function physStep(now) {
    const dt = 1 / 60, list = Object.keys(bodies);
    for (const t of list) {
      const b = bodies[t];
      b.sq *= 0.8;
      b.zoom += (b.zt - b.zoom) * 0.2;
      if (frenzyWas && now < frenzyAir) {
        /* Nightmare!, pendant une rafale : dès qu'elle touche le sol la case rebondit
           ailleurs, avec une nouvelle taille ; à la fin de la rafale elle rentre. */
        b.free = true; b.until = frenzyAir;
        if (b.y >= SH - 23 && Math.abs(b.vy) < 60 && Math.random() < 0.09) {
          b.vy = -(240 + Math.random() * 330); b.vx = (Math.random() - 0.5) * 520; b.va = (Math.random() - 0.5) * 14;
          b.zt = 0.9 + Math.random() * 0.4;
          moveSnd("bounce", 0.35);
        }
        if (b.y < 22 && b.vy < 0) b.vy = -b.vy * 0.6;                 // plafond : sous la barre de menus
      } else b.zt = 1;
      if (b.free && now > b.until) { b.free = false; moveSnd("spring"); }
      if (b.free) {
        b.vy += GRAVITY * dt;
        if (legoLevel >= 4) {                                    // palier 4 : les cases fuient le pointeur
          const dx = b.x + 12 - rawPointer.x, dy = b.y + 10 - rawPointer.y, d = Math.hypot(dx, dy);
          if (d < 34 && d > 0.5) { b.vx += dx / d * 26; b.vy += dy / d * 26 - 8; }
        }
        b.x += b.vx * dt; b.y += b.vy * dt; b.a += b.va * dt;
        const floor = SH - 22;
        if (b.y > floor) {
          b.y = floor;
          if (b.vy > 55) { moveSnd("bounce", b.vy / 420); b.sq = Math.min(0.4, b.vy / 700); b.vy = -b.vy * BOUNCE; b.va = -b.va * 0.5 + b.vx * 0.03; }
          else { b.vy = 0; b.va = 0; b.a *= 0.7; }
          b.vx *= 0.82;
        }
        if (b.x < 1) { b.x = 1; if (b.vx < -40) moveSnd("bounce", -b.vx / 420); b.vx = -b.vx * BOUNCE; }
        if (b.x > SW - 26) { b.x = SW - 26; if (b.vx > 40) moveSnd("bounce", b.vx / 420); b.vx = -b.vx * BOUNCE; }
      } else {
        // Ressort de rappel, peu amorti : la case dépasse sa place et oscille.
        const h = physHome(t);
        b.vx += ((h.x - b.x) * 95 - b.vx * 6.5) * dt; b.vy += ((h.y - b.y) * 95 - b.vy * 6.5) * dt;
        b.x += b.vx * dt; b.y += b.vy * dt; b.a *= 0.86;
        if (Math.abs(h.x - b.x) < 0.6 && Math.abs(h.y - b.y) < 0.6 && Math.hypot(b.vx, b.vy) < 9) {
          delete bodies[t]; moveSnd("bounce", 0.25); kickCell(t, -40, 0);
        }
      }
    }
    // Chocs entre cases libres : deux disques qui se repoussent.
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const A = bodies[list[i]], B = bodies[list[j]];
      if (!A || !B || !A.free || !B.free) continue;
      const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy);
      if (d >= 23 || d < 0.01) continue;
      const nx = dx / d, ny = dy / d, push = (23 - d) / 2;
      A.x -= nx * push; A.y -= ny * push; B.x += nx * push; B.y += ny * push;
      const rel = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
      if (rel < 0) {
        const imp = -(1 + 0.5) * rel / 2;
        A.vx -= imp * nx; A.vy -= imp * ny; B.vx += imp * nx; B.vy += imp * ny;
        if (rel < -70) moveSnd("bounce", -rel / 500);
      }
    }
    return Object.keys(bodies).length > 0;
  }
  function drawBodies(g) {
    g = g || ctx;
    for (const t in bodies) {
      const b = bodies[t], cell = CLASSIC.tools.find(c => c.tool === t), selected = t === tool;
      g.save();
      g.translate(Math.round(b.x) + 12.5, Math.round(b.y) + 21);          // pivot : le bas de la case
      g.scale((1 + b.sq * 0.6) * (b.zoom || 1), (1 - b.sq) * (b.zoom || 1));   // écrasement à l'impact, et taille propre
      g.translate(0, -10.5);
      if (Math.abs(b.a) > 0.02) g.rotate(b.a);
      g.translate(-12.5, -10.5);
      g.fillStyle = "#000"; g.fillRect(-1, -1, 27, 23);
      g.fillStyle = selected ? "#000" : "#fff"; g.fillRect(0, 0, 25, 21);
      g.fillStyle = selected ? ACCENT : "#000";
      for (let y = 0; y < 21; y++) for (let x = 0; x < 25; x++) if (cell.rows[y][x] === "1") g.fillRect(x, y, 1, 1);
      g.restore();
    }
    g.fillStyle = "#000";
  }

  /* ------------------------------------------------------------------ *
   *  Nightmare! : frénésie. Tout vibre en permanence, la barre de menus
   *  change de hauteur deux fois par seconde, les blocs déménagent, les
   *  cases s'échangent et tombent sans attendre les paliers, et tout
   *  l'écran tressaute sur chaque coup de grosse caisse de la musique.
   *  La barre de menus s'arrête le temps qu'un menu est ouvert.
   * ------------------------------------------------------------------ */
  const calmMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function frenzy() { return !!MOT && !touchMode && !calmMotion && Studio.difficulty.frenzy(); }
  let frenzyBar = 0, frenzyMove = 0, frenzyDrop = 0, frenzyAir = 0, frenzyShake = 0, frenzyWas = false;
  const APP = { rot: 0, sc: 1, next: 0, hold: 0, x: null, y: null, r: null, s: null };
  if (MOT) { APP.x = MOT.spring(95, 13); APP.y = MOT.spring(95, 13); APP.r = MOT.spring(95, 13); APP.s = MOT.spring(95, 13); APP.s.x = APP.s.target = 1; }
  function appTarget(t) {
    const R = Studio.difficulty.ramp(), w = cv.offsetWidth || 512, h = cv.offsetHeight || 342;
    if (t < APP.hold) return;                                    // pas plus d'une pose par 0,7 s, même si la musique s'emballe
    APP.next = t + 900; APP.hold = t + 700;
    APP.x.target = (Math.random() - 0.5) * 0.2 * w * R; APP.y.target = (Math.random() - 0.5) * 0.16 * h * R;
    APP.r.target = ((Math.random() - 0.5) * (Math.random() < 0.15 ? 0.7 : 0.34)) * R;     // ± 10°, parfois ± 20°
    APP.s.target = 1 + (Math.random() * 0.24 - 0.14) * R;                                 // de 0,86 à 1,10
    for (const k of ["x", "y", "r", "s"]) APP[k].done = false;
  }
  function frenzyStep(t) {
    const on = frenzy();
    if (on !== frenzyWas) {
      frenzyWas = on;
      document.body.style.overflow = on ? "hidden" : "";      // la fenêtre qui tourne déborde : pas de barres de défilement
      for (const b of LEGO) { b.sx.stiffness = b.sy.stiffness = on ? 80 : 70; b.sx.damping = b.sy.damping = on ? 13 : 12; }
      if (!on) { cv.style.transform = ""; cv.style.opacity = ""; APP.rot = 0; APP.sc = 1; for (const k of ["x", "y", "r"]) { APP[k].x = APP[k].v = APP[k].target = 0; } APP.s.x = APP.s.target = 1; APP.s.v = 0; }
    }
    if (!on) return false;
    if (menuOpen < 0 && t > frenzyBar && Studio.difficulty.ramp() > 0.5) {
      frenzyBar = t + 2800 + Math.random() * 1800;
      const bar = LEGO[4], spots = [0, 323, 46, 120, 200, 270];
      let y = bar.sy.target;
      while (y === bar.sy.target) y = spots[Math.floor(Math.random() * spots.length)];
      bar.sy.target = y; bar.sy.done = false;
      moveSnd("hop");
    }
    if (t > frenzyMove && Studio.difficulty.ramp() > 0.75) {
      frenzyMove = t + 5000 + Math.random() * 3000;
      const barY = LEGO[4].sy.target;
      legoSetLayout(Math.floor(Math.random() * 4));
      LEGO[4].sy.target = barY;
      swapCells();
    }
    /* Huit cases d'outils s'envolent par rafales de 2 s environ, puis rentrent : entre deux
       rafales (13 à 19 s), on voit la palette et le plan de travail. */
    if (t > frenzyDrop && Studio.difficulty.ramp() >= 1) { frenzyDrop = t + 13000 + Math.random() * 6000; frenzyAir = t + 1800 + Math.random() * 800; physAvalanche(8); }
    frenzyShake *= 0.88;
    /* Toute la fenêtre du logiciel bouge dans la page noire : position, rotation et taille.
       Les cibles sont tirées sur les frappes de la musique (appTarget), les ressorts y vont
       vite mais sans à-coup ; sans musique, une nouvelle cible toutes les 450 ms. */
    if (performance.now() - WORK.lastBeat > 700 && t > APP.next) appTarget(t);
    for (const k of ["x", "y", "r", "s"]) MOT.stepSpring(APP[k], 1 / 60);
    APP.rot = APP.r.x; APP.sc = Math.max(0.35, APP.s.x);
    cv.style.transform = "translate(" + (APP.x.x + (WORK.shR || 0) * frenzyShake).toFixed(1) + "px," + (APP.y.x + (WORK.shS || 0) * frenzyShake).toFixed(1) + "px) rotate(" + APP.rot.toFixed(4) + "rad) scale(" + APP.sc.toFixed(4) + ")";
    return true;
  }
  if (!touchMode && MOT && typeof Studio.on === "function") {
    Studio.on(function (type, d) {
      if (type === "beat" && frenzy()) {                         // la grosse caisse secoue tout
        frenzyShake = d.fill ? 9 : 5;
        WORK.hit = true; WORK.pulse = 1; WORK.lastBeat = performance.now();
        WORK.shR = Math.random() - 0.5; WORK.shS = Math.random() - 0.5;
        /* la fenêtre entière : nouvelle pose sur les frappes espacées, coup de zoom sur chacune */
        if ((d.gap || 0.3) >= 0.16 || Math.random() < 0.3) appTarget(performance.now());
        MOT.kick(APP.s, (Math.random() < 0.5 ? -1 : 1) * 0.5 * Studio.difficulty.ramp());
        for (const b of LEGO) { const k = (b.id === "window" ? 5 : 3) * Studio.difficulty.ramp(); b.jx2 = (Math.random() - 0.5) * k; b.jy2 = (Math.random() - 0.5) * k; }
        STROBE.hit = true; STROBE.beat = WORK.lastBeat; STROBE.gap = Math.max(60, (d.gap || 0.28) * 1000); STROBE.quiet = STROBE.beat + STROBE.gap + 400;   // pendant un silence de la boucle, tout se fige
        for (let i = 0; i < 4; i++) kickCell(randomCell(), -30 - Math.random() * 30, (Math.random() - 0.5) * 40);   // quatre cases sursautent, pas toute la palette
      }
      if (frenzy() || Studio.difficulty.get() >= 3) startAnim();
    });
    setTimeout(function () { if (Studio.difficulty.get() >= 3) startAnim(); }, 900);
  }
  let newConfirmed = false;
  let pattern = 0;
  /* Le texte suit la trame, comme les formes : trame blanche → texte blanc,
     toute autre trame → texte noir. Plus de sélecteur d'encre séparé. */
  function inkWhite() { return PAT[pattern].every(function (v) { return !v; }); }
  let penW = 4;                          // l'épaisseur, de 1 à 200 points : la même pour tous les outils
  let noOutline = false;                // Independent of spray dispersion.
  /* Une seule épaisseur pour tous les outils, réglée en bas à gauche : les quatre crans de
     MacPaint (1, 2, 4, 8) ou n'importe quelle valeur de 1 à 200 sur la réglette au-dessus. */
  const PEN_MAX = 200;
  const LW = () => Math.max(1, Math.round(PW() / 2));            // rayon des outils spéciaux : la moitié de l'épaisseur
  const WBOX = { x: 15, w: 53, h: 30, top: () => 257 + DY - 30 };   // posée sur le cadre d'origine : un seul cadre pour toute l'épaisseur
  const penAt = x => { const t = Math.max(0, Math.min(1, (x - (WBOX.x + 4)) / (WBOX.w - 9))); return Math.max(1, Math.min(PEN_MAX, Math.round(1 + (PEN_MAX - 1) * t * t))); };   // fin en bas d'échelle, large en haut
  const penX = () => WBOX.x + 4 + Math.round(Math.sqrt((penW - 1) / (PEN_MAX - 1)) * (WBOX.w - 9));
  function setPen(w) { w = Math.max(1, Math.min(PEN_MAX, Math.round(w))); noOutline = false; if (w !== penW) { penW = w; uiSnd("width", Math.min(7, Math.round(Math.log2(w)))); } render(); }
  /* Options par outil : un clic droit sur son pictogramme ouvre ses réglages. Trois réglages
     communs (taille par rapport à l'épaisseur, trame, son), plus ceux propres à certains outils. */
  const TOPT_COMMON = [["size", "Size", ["1/2", "x1", "x2", "x4"], 1], ["pat", "Use the pattern", null, true], ["snd", "Sound", null, true]];
  const TOPT_3D = [["tilt", "Tilt", ["Low", "Medium", "High"], 1], ["light", "Light from", ["Left", "Right"], 0], ["edges", "Edges", null, true], ["shine", "Highlight", null, true], ["shade", "Shadow", ["Soft", "Normal", "Deep"], 1]];
  const S3 = ["Small", "Normal", "Big"], SP3 = ["Slow", "Normal", "Fast"];
  const TOPT_OWN = {
    brush: [["gap", "Spacing", ["Solid", "Dotted", "Sparse"], 0]],
    spray: [["dens", "Density", ["Light", "Normal", "Heavy"], 1], ["spread", "Spread", ["Tight", "Normal", "Wide"], 1]],
    eraser: [["shape", "Shape", ["Square", "Round"], 0]],
    rrect: [["corner", "Corners", ["Small", "Medium", "Large"], 1]], rrectFill: [["corner", "Corners", ["Small", "Medium", "Large"], 1]],
    wild: [["rainbow", "Rainbow sections", null, true], ["stamps", "Stamps", null, true], ["wobble", "Thickness waves", ["Calm", "Normal", "Wild"], 1], ["rate", "Stamp rate", ["Few", "Normal", "Many"], 1]],
    pump: [["resist", "Resistance", ["Fragile", "Normal", "Tough", "Never bursts"], 1]],
    worm: [["len", "Length", ["Short", "Normal", "Long"], 1], ["life", "Life", ["Short", "Normal", "Long"], 1]],
    fly: [["lift", "Lift", ["Slow", "Normal", "Fast"], 1], ["sway", "Sway", ["Straight", "Normal", "Wild"], 1]],
    melt: [["run", "Runs", ["Short", "Normal", "Long"], 1]],
    glitch: [["amount", "Shift", ["Small", "Normal", "Big"], 1], ["ghost", "Color ghosts", null, true]],
    ribbon: [["fold", "Folds", ["Tight", "Normal", "Wide"], 1]],
    spike: [["len", "Spikes", ["Short", "Normal", "Long"], 1], ["dens", "Density", ["Sparse", "Normal", "Dense"], 1]],
    jelly: [["wobble", "Wobble", ["Calm", "Normal", "Wild"], 1]],
    slice: [["slip", "Slip", ["Small", "Normal", "Big"], 1]],
    leaky: [["leak", "Leaks", ["Dry", "Normal", "Flood"], 1], ["splash", "Splashes", null, true]],
    frizzy: [["len", "Hair length", ["Short", "Normal", "Long"], 1], ["dens", "Hair density", ["Few", "Normal", "Many"], 1]],
    web: [["reach", "Reach", ["Near", "Normal", "Far"], 1], ["threads", "Threads", ["1", "2", "4"], 1]],
    tree: [["branch", "Branches", ["Sparse", "Normal", "Dense"], 1], ["depth", "Depth", ["2", "4", "6"], 1], ["leaves", "Leaves", null, true]],
    paste: [["twist", "Twist", SP3, 1]],
    hose: [["motif", "Picture", ["Auto", "Leaf", "Pebble", "Eye", "Coin"], 0], ["gap", "Spacing", ["Dense", "Normal", "Loose"], 1]],
    type: [["sizes", "Sizes", ["Small", "Mixed", "Huge"], 1], ["moods", "Effects", null, true]],
    alpha: [["chars", "Characters", ["A-Z", "a-z", "0-9"], 0], ["gap", "Spacing", ["Tight", "Normal", "Loose"], 1]],
    extrude: [["depth", "Depth", ["Short", "Normal", "Long"], 1]],
    cycle: [["bands", "Bands", ["Fine", "Normal", "Wide"], 1]],
    dynamite: [["fuse", "Fuse", ["Short", "Normal", "Long"], 1]],
    ball: [["size", "Ball", S3, 1]],
    balls: [["grav", "Gravity", ["Random", "None", "Heavy", "Up"], 0], ["bounce", "Bounce", ["Soft", "Random", "Super"], 1], ["trail", "Trail", ["Random", "Line", "Dots", "Squares"], 0], ["life", "Life", ["Short", "Normal", "Long"], 1]],
    rain: [["amount", "Amount", ["Light", "Normal", "Storm"], 1]], snow: [["amount", "Amount", ["Light", "Normal", "Storm"], 1]],
    motor: [["speed", "Speed", SP3, 1], ["dir", "Turns", ["Clockwise", "Counter"], 0]],
    graft: [["height", "Height", ["Short", "Normal", "Tall"], 1]],
    amoeba: [["drop", "Drops", S3, 1]], metal: [["drop", "Drops", S3, 1]],
    cube: TOPT_3D, sphere: TOPT_3D, cylinder: TOPT_3D, cone: TOPT_3D, pyramid: TOPT_3D, torus: TOPT_3D };
  /* Les outils qui ne peignent pas (sélection, main, texte, pot…) n'ont que le réglage du son. */
  const TOPT_PLAIN = ["lasso", "marquee", "grabber", "text", "bucket", "motor", "dynamite", "hammer", "ball", "slice", "acid", "dryer", "bayer", "blend", "comb", "waves", "grid", "blinds", "moire", "accordion", "pump", "heart", "sun", "shaker", "repel", "elastic", "fold", "extrude", "lathe", "custom", "cfill", "graft", "coral", "rain", "snow"];
  const TK = (key, arr, t) => arr[topt(key, t)];
  let TOPTS = {}, TOPTV = 0;
  try { TOPTS = JSON.parse(localStorage.getItem("colorpaint.toolopts") || "{}") || {}; } catch (e) { TOPTS = {}; }
  const toptList = t => (TOPT_PLAIN.includes(t) ? TOPT_COMMON.slice(2) : TOPT_COMMON).concat(TOPT_OWN[t] || []);
  function topt(key, t) { t = t || tool; const o = TOPTS[t]; if (o && key in o) return o[key]; const d = toptList(t).find(q => q[0] === key); return d ? d[3] : undefined; }
  function toptSet(t, key, v) { TOPTV++; (TOPTS[t] = TOPTS[t] || {})[key] = v; try { localStorage.setItem("colorpaint.toolopts", JSON.stringify(TOPTS)); } catch (e) {} }
  const PW = () => Math.max(1, Math.min(400, Math.round(penW * [0.5, 1, 2, 4][topt("size") === undefined ? 1 : topt("size")])));   // l'épaisseur de l'outil courant
  const TO = { on: false, tool: "" };
  const outlineWidth = () => noOutline ? 0 : PW();
  /* À partir du niveau 3 (Hurt Me Plenty), l'épaisseur du trait ne tient plus en
     place : elle saute au hasard entre 1, 2, 4 et 8, même au milieu d'un trait.
     De plus en plus vite : toutes les 0,9 à 1,8 s, puis 0,4 à 0,9 s en
     Ultra-Violence, puis 0,09 à 0,26 s en Nightmare!. Le pinceau, les contours
     des formes et la bombe suivent ; le crayon reste à un pixel. */
  let widthNext = 0;
  setInterval(function () {
    if (typeof Studio === "undefined" || !Studio.difficulty) return;
    const level = Studio.difficulty.get(), t = performance.now();
    if (level < 2 || document.hidden || t < widthNext) return;
    const pace = level === 2 ? [900, 900] : level === 3 ? [400, 500] : [90, 170];
    widthNext = t + pace[0] + Math.random() * pace[1];
    let next = penW;
    while (next === penW) next = [1, 2, 4, 8][Math.floor(Math.random() * 4)];
    penW = next;
    if (level < 4 && Studio.audio && Studio.audio.motion) { try { Studio.audio.motion("hop"); } catch (e) {} }
    render();
  }, 60);
  let fontName = "Geneva";
  let fontSize = 12;
  let style = "plain";
  const styles = new Set();
  let gridOn = false;
  let fatBits = false;
  let brushShape = 3;
  let mirror = 0;                        // 0 aucun, 1 horizontal, 2 vertical, 3 les deux
  let sel = null;                        // {x,y,w,h,mask,data}
  let clipboard = null;
  const undoStack = [], redoStack = [];
  let menuOpen = -1, menuHover = -1, menuTrack = false;
  let documentOpen = true;
  let dialog = null;
  let dirty = true;
  let mouse = { x: 0, y: 0, in: false };

  /* ---------------------------------------------------------------- *
   *  3. Polices et texte 1 bit
   * ---------------------------------------------------------------- */
  const FONTS = Object.keys(CLASSIC.fonts).sort().map(name=>({name,css:name}));

  const SIZES = [9, 10, 12, 14, 18, 24, 36, 48, 72];

  const textCache = new Map();

  /* Original FONT strikes: integer bearings/advances, MacRoman, no vector rasterizer. */
  function textBmp(str, fam, size, bold, italic) {
    const key = [str,fam,size,!!bold,!!italic].join("\0");
    if (textCache.has(key)) return textCache.get(key);
    const family = CLASSIC.fonts[fam] || CLASSIC.fonts.Geneva;
    const sizes = Object.keys(family).map(Number);
    const base = sizes.includes(size) ? size : sizes.reduce((a,b)=>Math.abs(b-size)<Math.abs(a-size)?b:a);
    // Prefer an exact integer enlargement when possible (36=18x2,48=24x2,72=24x3).
    const div = sizes.filter(n=>size>=n && size%n===0).sort((a,b)=>b-a);
    const chosen = div.length ? div[0] : base;
    const f = family[chosen], scale = size/chosen;
    const chars = Array.from(str||"").map(ch=>f.glyphs[String(CLASSIC.charcodes[ch] === undefined ? 0xffff : CLASSIC.charcodes[ch])] || f.glyphs["65535"]);
    const advance = chars.reduce((a,g)=>a+(g?g.advance:0),0);
    const h0=f.height;
    let minX=0,maxX=Math.max(1,advance+4+(italic?Math.ceil(h0/4):0)),extentPen=1;
    for(const g of chars) {
      if(!g)continue;
      if(g.w) {
        minX=Math.min(minX,extentPen+g.offset+(italic?Math.floor((f.ascent-h0+1)/4):0));
        maxX=Math.max(maxX,extentPen+g.offset+g.w+(italic?Math.floor(f.ascent/4):0)+(bold?1:0));
      }
      extentPen+=g.advance;
    }
    const shift=-minX,w0=maxX+shift;
    const bits0=new Uint8Array(w0*h0);let pen=1+shift;
    for(const g of chars) {
      if(!g)continue;
      for(let y=0;y<h0;y++) for(let x=0;x<g.w;x++) if(g.rows[y][x]==="1") {
        const X=pen+g.offset+x+(italic?Math.floor((f.ascent-y)/4):0);
        if(X>=0&&X<w0) {bits0[y*w0+X]=1;if(bold&&X+1<w0)bits0[y*w0+X+1]=1;}
      }
      pen+=g.advance;
    }
    const w=Math.max(1,Math.round(w0*scale)),h=Math.max(1,Math.round(h0*scale));
    const bits=new Uint8Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)bits[y*w+x]=bits0[Math.min(h0-1,Math.floor(y/scale))*w0+Math.min(w0-1,Math.floor(x/scale))];
    const result={bits,w,h,pad:Math.round((1+shift)*scale),asc:Math.round(f.ascent*scale),adv:Math.round(advance*scale),lineHeight:Math.round((f.ascent+f.descent+f.leading)*scale)};
    textCache.set(key,result);return result;
  }

  /* Dessine un bitmap 1 bit, avec options (dither pour le grisé). */
  function blit(ctx2, bmp, x, y, opt) {
    const dither = opt && opt.dither;
    const bx = Math.round(x), by = Math.round(y);
    ctx2.fillStyle = "#000";
    for (let j = 0; j < bmp.h; j++) {
      const sy = by + j;
      if (sy < 0 || sy >= SH) continue;
      let run = -1;
      for (let i = 0; i <= bmp.w; i++) {
        const on = i < bmp.w && bmp.bits[j * bmp.w + i];
        if (on && run < 0) run = i;
        if ((!on || i === bmp.w) && run >= 0) {
          let a = bx + run, b = bx + i;
          run = -1;
          if (b <= 0 || a >= SW) continue;
          if (a < 0) a = 0;
          if (b > SW) b = SW;
          if (dither) {                       // texte grisé : une ligne sur deux
            if ((sy & 1) === 0) ctx2.fillRect(a, sy, b - a, 1);
          } else {
            ctx2.fillRect(a, sy, b - a, 1);
          }
        }
      }
    }
  }

  /* Texte à la ligne de base (y = baseline). */
  function drawText(str, x, y, fam, size, bold, italic, opt) {
    const b = textBmp(str, fam, size, bold, italic);
    blit(ctx, b, x + 1 - b.pad, y - b.asc, opt);
    return b.adv;
  }

  function textWidth(str, fam, size, bold, italic) {
    return textBmp(str, fam, size, bold, italic).adv;
  }

  /* ---------------------------------------------------------------- *
   *  4. Motifs 8 × 8
   * ---------------------------------------------------------------- */
  /* Trames 8 × 8 au format QuickDraw : 8 octets, ligne par ligne, bit de poids
     fort à gauche, 1 = encre. Valeurs des ressources PAT# et des constantes
     QuickDraw (white, ltGray, gray, dkGray, black). */
  const PAT_LIB = CLASSIC.patterns.map((hex,i)=>["Pattern "+(i+1),hex]);

  function hexToPat(hex) {
    const a = new Uint8Array(64);
    for (let y = 0; y < 8; y++) {
      const b = parseInt(hex.substr(y * 2, 2), 16);
      for (let x = 0; x < 8; x++) a[y * 8 + x] = (b >> (7 - x)) & 1;
    }
    return a;
  }

  const PAT = CLASSIC.patterns.map(hexToPat);
  const PAT_DEF = PAT.map(p=>p.slice());

  let patTool = null, patVer = -1, patOn = true;
  function pat(x, y) {
    if (patTool !== tool || patVer !== TOPTV) { patTool = tool; patVer = TOPTV; patOn = topt("pat") !== false; }   // option de l'outil, relue seulement quand elle change
    if (!patOn) return 1;                                        // sans trame, l'outil peint plein
    return PAT[pattern][(y & 7) * 8 + (x & 7)];
  }

  /* ---------------------------------------------------------------- *
   *  5. Icônes de la palette (bitmaps 23 × 21, relevés sur MacPaint)
   * ---------------------------------------------------------------- */
  const ICON = {
    lasso: [
      "······#######···",
      "···###·······##·",
      "··#············#",
      "·#·············#",
      "#··············#",
      "#············##·",
      "#·········###···",
      "·###···###······",
      "##··###·········",
      "#·#·#···········",
      "·###············",
      "···#············",
      "···#············",
      "··#·············",
    ],
    marquee: [
      "####··#####··###",
      "#··············#",
      "#··············#",
      "················",
      "················",
      "#··············#",
      "#··············#",
      "#··············#",
      "················",
      "················",
      "#··············#",
      "#··············#",
      "###··#####··####",
    ],
    brush: [
      "·······##·······",
      "···##·#··###····",
      "··#··##··#··#···",
      "··#··##··#··#·#·",
      "···#··#··#··##·#",
      "···#··#··#··#··#",
      "·##·#·······#··#",
      "#··##··········#",
      "#···#·········#·",
      "·#············#·",
      "··#···········#·",
      "··#··········#··",
      "···#·········#··",
      "····#·······#···",
      "·····#······#···",
      "·····#······#···",
    ],
    pencil: [
      "·········#··········",
      "········###·········",
      "········###·········",
      "·······#####········",
      "·······#·###········",
      "······##··###·······",
      "······#···###·······",
      "·····##····###······",
      "·····#·····###······",
      "····##······###·····",
      "····###########·····",
      "···##········###····",
      "···##········###····",
      "··##··········###···",
      "·###··········####··",
      "#####·······########",
    ],
    spray: [
      "·····###········",
      "····#···#·······",
      "····#··##·······",
      "····#·#·##······",
      "····##··#·##····",
      "····#···#··###··",
      "···#····#···###·",
      "··#····#·#···###",
      "·#······#····###",
      "#···········####",
      "#··········#·###",
      "·#········#··###",
      "··#······#···###",
      "···#····#····###",
      "····#··#·····##·",
      "·····##······#··",
    ],
    bucket: [
      "#···········",
      "··#·········",
      "#···#·#·#···",
      "··#····###··",
      "#·····#···#·",
      "·····#######",
      "·····#·····#",
      "·····#··####",
      "·····#··#··#",
      "·····#··####",
      "·····#··#··#",
      "·····#··####",
      "·····#··####",
      "·····#·····#",
      "·····#·····#",
      "·····#######",
    ],
    eraser: [
      "·····###···",
      "·····#·#···",
      "·····###···",
      "·····###···",
      "·····###···",
      "·····###···",
      "·····###···",
      "··#########",
      "··#·······#",
      "··#########",
      "··#·······#",
      "··#·······#",
      "··#·······#",
      "··#·#·#·#·#",
      "·#·#·#·#·##",
      "##########·",
    ],
    text: [
      "·····####·",
      "·····#···#",
      "····#····#",
      "····##··#·",
      "···#··###·",
      "···#···#··",
      "··#····#··",
      "··#···#···",
      "·#····#···",
      "·#···#····",
      "#····#····",
      "#···#·····",
      "####······",
      "###·······",
      "##········",
      "#·········",
    ],
    line: [
      "##··············",
      "··##············",
      "····##··········",
      "······##········",
      "········##······",
      "··········##····",
      "············##··",
      "··············##",
    ],
    rrect: [
      "········#######·",
      "·······#······#·",
      "······#······###",
      "·····#······#·##",
      "····#······#·##·",
      "···#······#·##··",
      "··#······#·##···",
      "·#······#·##····",
      "########·##·····",
      "#······###······",
      "#······##·······",
      "########········",
    ],
    rect: [
      "################",
      "#··············#",
      "#··············#",
      "#··············#",
      "#··············#",
      "#··············#",
      "#··············#",
      "#··············#",
      "#··············#",
      "#··············#",
      "################",
    ],
    oval: [
      ".......................",
      ".......................",
      ".......................",
      ".......................",
      ".......................",
      "........########.......",
      "......###......###.....",
      ".....##..........##....",
      "....##............##...",
      "....#..............#...",
      "....#..............#...",
      "....#..............#...",
      "....##............##...",
      ".....##..........##....",
      "......###......###.....",
      "........########.......",
      ".......................",
      ".......................",
      ".......................",
      ".......................",
      "......................."
    ],
  };

  const APPLE = [
    "....##.....",
    "...###.....",
    "...##......",
    "..#######..",
    ".#########.",
    "###########",
    "###########",
    "###########",
    "##########.",
    ".########..",
    "..######..."
  ];

  const CHECK = [
    "......X",
    ".....XX",
    "X...XX.",
    "XX.XX..",
    ".XXX...",
    "..X....",
    "......."
  ];

  function drawBitmap(rows, x, y) {
    ctx.fillStyle = "#000";
    for (let j = 0; j < rows.length; j++)
      for (let i = 0; i < rows[j].length; i++)
        if (rows[j][i] === "X" || rows[j][i] === "#") ctx.fillRect(x + i, y + j, 1, 1);
  }

  /* ---------------------------------------------------------------- *
   *  6. Primitives de dessin
   * ---------------------------------------------------------------- */
  /* Une sélection bornée : MacPaint n'écrit jamais en dehors de la sélection
     active, ni pour le pinceau, ni pour le pot de peinture, ni pour les formes. */
  function inSel(x, y) {
    if (!sel) return true;
    if (x < sel.x || y < sel.y || x >= sel.x + sel.w || y >= sel.y + sel.h) return false;
    if (!sel.mask) return true;
    return !!sel.mask[(y - sel.y) * sel.w + (x - sel.x)];
  }

  function px(x, y, v) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= DW || y >= DH) return;
    if (sel && !inSel(x, y)) return;
    v = v ? inkAt(x, y) : 0;                                     // un point « noir » prend la couleur courante (ou celle du dégradé à cet endroit)
    doc[y * DW + x] = v;
    if (mirror & 1) { const mx = DW - 1 - x; if (mx >= 0 && mx < DW) doc[y * DW + mx] = v; }
    if (mirror & 2) { const my = DH - 1 - y; if (my >= 0 && my < DH) doc[my * DW + x] = v; }
  }

  function stamp(x, y, size, v, usePat) {
    const o = Math.floor((size - 1) / 2);
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const X = x - o + i, Y = y - o + j;
        px(X, Y, usePat ? pat(X, Y) : v);
      }
  }

  function line(x0, y0, x1, y1, size, v, usePat) {
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    const o = Math.floor((size - 1) / 2);
    stamp(x0, y0, size, v, usePat);
    for (;;) {                                                   // trait large : seuls les bords d'attaque du carré sont repeints à chaque pas
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      let mx = 0, my = 0;
      if (e2 >= dy) { err += dy; x0 += sx; mx = sx; }
      if (e2 <= dx) { err += dx; y0 += sy; my = sy; }
      if (size <= 4) { stamp(x0, y0, size, v, usePat); continue; }
      if (mx) { const X = mx > 0 ? x0 - o + size - 1 : x0 - o; for (let j = 0; j < size; j++) px(X, y0 - o + j, usePat ? pat(X, y0 - o + j) : v); }
      if (my) { const Y = my > 0 ? y0 - o + size - 1 : y0 - o; for (let i = 0; i < size; i++) px(x0 - o + i, Y, usePat ? pat(x0 - o + i, Y) : v); }
    }
  }

  function rectShape(x0, y0, x1, y1, w, fill) {
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const edge = x < x0 + w || x > x1 - w || y < y0 + w || y > y1 - w;
        if (edge) px(x, y, 1);
        else if (fill) px(x, y, pat(x, y));
      }
  }

  function rrectShape(x0, y0, x1, y1, w, fill) {
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    const r = Math.min(TK("corner", [4, 8, 28], "rrect"), Math.floor((x1 - x0) / 2), Math.floor((y1 - y0) / 2));
    const inside = function (x, y, inset) {
      const ax = x0 + inset, ay = y0 + inset, bx = x1 - inset, by = y1 - inset;
      if (x < ax || x > bx || y < ay || y > by) return false;
      const rr = Math.max(0, r - inset);
      if (rr === 0) return true;
      const cx = x < ax + rr ? ax + rr : (x > bx - rr ? bx - rr : x);
      const cy = y < ay + rr ? ay + rr : (y > by - rr ? by - rr : y);
      const dx = x - cx, dy = y - cy;
      return dx * dx + dy * dy <= rr * rr + rr;
    };
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (!inside(x, y, 0)) continue;
        if (!inside(x, y, w)) px(x, y, 1);
        else if (fill) px(x, y, pat(x, y));
      }
  }

  function ovalShape(x0, y0, x1, y1, w, fill) {
    if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
    if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const rx = (x1 - x0) / 2 + 0.5, ry = (y1 - y0) / 2 + 0.5;
    if (rx <= 0 || ry <= 0) return;
    const inEll = function (x, y, inset) {
      const ax = rx - inset, ay = ry - inset;
      if (ax <= 0 || ay <= 0) return false;
      const u = (x + 0.5 - cx - 0.5) / ax, v = (y + 0.5 - cy - 0.5) / ay;
      return u * u + v * v <= 1;
    };
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (!inEll(x, y, 0)) continue;
        if (!inEll(x, y, w)) px(x, y, 1);
        else if (fill) px(x, y, pat(x, y));
      }
  }

  function floodFill(x, y) {
    if (x < 0 || y < 0 || x >= DW || y >= DH) return;
    const target = doc[y * DW + x];
    const seen = new Uint8Array(DW * DH);
    const stack = [x, y];
    while (stack.length) {
      const cy = stack.pop(), cx = stack.pop();
      if (cx < 0 || cy < 0 || cx >= DW || cy >= DH) continue;
      const i = cy * DW + cx;
      if (seen[i] || doc[i] !== target) continue;
      if (sel && !inSel(cx, cy)) continue;
      seen[i] = 1;
      stack.push(cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1);
    }
    for (let i = 0; i < seen.length; i++) if (seen[i]) { const v = pat(i % DW, (i / DW) | 0); doc[i] = (target === ink ? 1 - v : v) ? inkAt(i % DW, (i / DW) | 0) : 0; }   // sur sa propre couleur, la trame s'inverse (comme le noir sur noir d'origine)
  }

  const BRUSHES = [
    { w: 2, h: 2, bits: "11" + "11" },
    { w: 4, h: 4, bits: "1111".repeat(4) },
    { w: 8, h: 8, bits: "11111111".repeat(8) },
    { w: 3, h: 3, bits: "010" + "111" + "010" },
    { w: 5, h: 5, bits: "01110" + "11111" + "11111" + "11111" + "01110" },
    { w: 7, h: 7, bits: "0011100" + "0111110" + "1111111" + "1111111" + "1111111" + "0111110" + "0011100" },
    { w: 8, h: 1, bits: "11111111" },
    { w: 1, h: 8, bits: "11111111" }
  ];

  function brushAt(x, y) {
    /* La forme de brosse choisie, ramenée à l'épaisseur courante : sa plus grande dimension
       vaut toujours l'épaisseur (1 à 200 points), quelle que soit la brosse. */
    const b = BRUSHES[brushShape], m = Math.max(b.w, b.h), w = Math.max(1, Math.round(b.w * PW() / m)), h = Math.max(1, Math.round(b.h * PW() / m));
    const ox = Math.floor((w - 1) / 2), oy = Math.floor((h - 1) / 2);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++)
        if (b.bits[Math.min(b.h - 1, (j * b.h / h) | 0) * b.w + Math.min(b.w - 1, (i * b.w / w) | 0)] === "1") px(x - ox + i, y - oy + j, pat(x - ox + i, y - oy + j));
  }

  /* ---------------------------------------------------------------- *
   *  7. Historique et feuille
   * ---------------------------------------------------------------- */
  function pushUndo() {
    record();
    undoStack.push({ d: doc.slice(), l: layerSnapshot(), L: LAYERS[LA] });
    if (undoStack.length > 24) undoStack.shift();
    redoStack.length = 0;
    scheduleSave();
  }
  function undo() {
    if (!undoStack.length) return;
    textCommit();
    const s = undoStack.pop();
    if (s.L && LAYERS.includes(s.L)) { LA = LAYERS.indexOf(s.L); doc = s.L.data; }
    redoStack.push({ d: doc.slice(), l: layerSnapshot(), L: LAYERS[LA] });
    doc.set(s.d); restoreLayers(s.l);
    sel = null; selectedText = null;
    renderTextLayers();
    scheduleSave();
    cheer("undo");
    render();
  }
  /* Ultra-Violence : pour annuler, il faut retracer le dernier trait à l'envers
     (partir de là où il finissait, finir là où il commençait). Demander
     l'annulation une seconde fois fait céder le logiciel : le filet de sécurité
     reste là. */
  let strokeA = null, strokeB = null, lastEnds = null, undoArmed = false;
  function requestUndo() {
    const hard = typeof Studio !== "undefined" && Studio.difficulty && Studio.difficulty.get() === 3 && Studio.traps && Studio.traps.note;
    if (!hard || !lastEnds || !undoStack.length || undoArmed) { undoArmed = false; undo(); return; }
    undoArmed = true;
    Studio.traps.note("Pour annuler, retracez votre dernier trait à l’envers. (Ou redemandez, si vous y tenez.)");
  }
  function redo() {
    if (!redoStack.length) return;
    const s = redoStack.pop();
    if (s.L && LAYERS.includes(s.L)) { LA = LAYERS.indexOf(s.L); doc = s.L.data; }
    undoStack.push({ d: doc.slice(), l: layerSnapshot(), L: LAYERS[LA] });
    doc.set(s.d); restoreLayers(s.l);
    selectedText = null;
    renderTextLayers();
    scheduleSave();
    cheer("redo");
    render();
  }

  let saveTimer = null;
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLocal, 600);
  }
  /* Tous les calques, compressés par plages (nombre, valeur) : un dessin est surtout du vide. */
  function rle(d) {
    const out = [];
    for (let i = 0; i < d.length;) { const v = d[i]; let n = 1; while (n < 255 && i + n < d.length && d[i + n] === v) n++; out.push(n, v); i += n; }
    let str = ""; for (let i = 0; i < out.length; i += 8192) str += String.fromCharCode.apply(null, out.slice(i, i + 8192));
    return btoa(str);
  }
  function unrle(b64, len) {
    const str = atob(b64), d = new Uint8Array(len); let k = 0;
    for (let i = 0; i + 1 < str.length && k < len; i += 2) { const n = str.charCodeAt(i), v = str.charCodeAt(i + 1); d.fill(v < NPAL ? v : 0, k, Math.min(len, k + n)); k += n; }
    return d;
  }
  function saveLocal() {
    try {
      localStorage.setItem("colorpaint.doc", JSON.stringify({ v: 2, w: DW, h: DH, active: LA, layers: LAYERS.map((l, i) => { let d = l.data; if (i === LA && (FX.hearts.length || FX.parts.length || FX.live.length || FX.grid || FX.plants.length || FX.metal.length)) { d = d.slice(); liveBake(d); heartsBake(d); for (const k of FX.parts) d[k] = FX.wetAt[k]; } return { name: l.name, visible: l.visible, data: rle(d) }; }) }));
    } catch (e) { /* stockage plein ou refusé */ }
  }
  function loadLocal() {
    try {
      const o = JSON.parse(localStorage.getItem("colorpaint.doc") || "null");
      if (!o || o.v !== 2 || !o.layers || !o.layers.length) return false;
      pageResize(o.w, o.h, true);
      LAYERS.length = 0;
      for (const l of o.layers.slice(0, 8)) LAYERS.push({ name: String(l.name), visible: l.visible !== false, data: unrle(l.data, DW * DH) });
      LA = Math.max(0, Math.min(LAYERS.length - 1, o.active | 0)); doc = LAYERS[LA].data;
      layerSeq = LAYERS.reduce((m, l) => Math.max(m, parseInt(l.name, 10) || 0), 0);
      return true;
    } catch (e) { return false; }
  }

  /* ---------------------------------------------------------------- *
   *  8. Sélections
   * ---------------------------------------------------------------- */
  function selContains(x, y) {
    if (!sel) return false;
    const i = x - sel.x, j = y - sel.y;
    if (i < 0 || j < 0 || i >= sel.w || j >= sel.h) return false;
    return !sel.mask || sel.mask[j * sel.w + i] === 1;
  }

  function selClear() {
    sel = null;
  }

  function selLift() {
    if (!sel) return;
    pushUndo();
    const d = new Uint8Array(sel.w * sel.h);
    for (let j = 0; j < sel.h; j++)
      for (let i = 0; i < sel.w; i++) {
        const X = sel.x + i, Y = sel.y + j;
        if (X < 0 || Y < 0 || X >= DW || Y >= DH) continue;
        if (sel.mask && !sel.mask[j * sel.w + i]) continue;
        d[j * sel.w + i] = doc[Y * DW + X];
        doc[Y * DW + X] = 0;
      }
    sel.data = d;
  }

  function selCommit() {
    if (!sel || !sel.data) return;
    for (let j = 0; j < sel.h; j++)
      for (let i = 0; i < sel.w; i++) {
        if (sel.mask && !sel.mask[j * sel.w + i]) continue;
        const X = sel.x + i, Y = sel.y + j;
        if (X < 0 || Y < 0 || X >= DW || Y >= DH) continue;
        doc[Y * DW + X] = sel.data[j * sel.w + i];
      }
    sel.data = null;
  }

  function selBounds() {
    if (sel) return { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
    return { x: 0, y: 0, w: DW, h: DH };
  }

  function selApply(fn) {
    const b = selBounds();
    pushUndo();
    const src = new Uint8Array(b.w * b.h);
    for (let j = 0; j < b.h; j++)
      for (let i = 0; i < b.w; i++)
        src[j * b.w + i] = doc[(b.y + j) * DW + b.x + i];
    fn(src, b);
    for (let j = 0; j < b.h; j++)
      for (let i = 0; i < b.w; i++)
        doc[(b.y + j) * DW + b.x + i] = src[j * b.w + i];
    scheduleSave();
    render();
  }

  /* ---------------------------------------------------------------- *
   *  9. Texte (outil)
   * ---------------------------------------------------------------- */
  const textState = { active: false, x: 0, y: 0, lines: [""], li: 0, ci: 0, base: null, blink: 0 };

  /* Calques de texte : un texte validé reste un objet superposé, déplaçable et
     rééditable, au lieu d'être figé dans la feuille (comme un logiciel moderne). */
  const textLayers = [];   // {id, x, y, lines, font, size, styles, alignment}
  let textLayerId = 1;
  let selectedText = null; // id du calque sélectionné (déplacement / édition)
  function cloneTextLayer(l){return {id:l.id,x:l.x,y:l.y,lines:l.lines.slice(),font:l.font,size:l.size,styles:l.styles.slice(),alignment:l.alignment,white:!!l.white,color:l.color||1};}
  function layerSnapshot(){return textLayers.map(cloneTextLayer);}
  function restoreLayers(layers){textLayers.length=0;for(const l of layers)textLayers.push(cloneTextLayer(l));}

  /* Rendu des calques de texte : un canevas superposé 1 bit, redessiné quand un
     calque change, puis composé au-dessus de la feuille. */
  const textCanvas = document.createElement("canvas");
  textCanvas.width = DW; textCanvas.height = DH;
  const tctx = textCanvas.getContext("2d");

  function layerLineHeight(layer){ return textBmp("", layer.font, layer.size, false, false).lineHeight; }

  function stampLayerLine(layer, str, x, baseline, fam, bold, italic) {
    if (!str) return;
    if (layer.alignment !== "left") {
      const tw = textWidth(str, fam, layer.size, bold, italic);
      x -= layer.alignment === "middle" ? Math.round(tw / 2) : tw;
    }
    const b = textBmp(str, fam, layer.size, bold, italic);
    const bw = b.w, bh = b.h;
    let g = b.bits.slice();
    const at = function (arr, i, j) { return (i >= 0 && j >= 0 && i < bw && j < bh) ? arr[j * bw + i] : 0; };
    if (layer.styles.includes("outline") || layer.styles.includes("shadow")) {
      const o = new Uint8Array(bw * bh);
      for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
        if (at(g, i, j)) continue;
        o[j * bw + i] = (at(g, i - 1, j) || at(g, i + 1, j) || at(g, i, j - 1) || at(g, i, j + 1)) ? 1 : 0;
      }
      g = o;
      if (layer.styles.includes("shadow")) {
        const s = g.slice();
        for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
          const v = at(s, i, j);
          if (v && i + 1 < bw && j + 1 < bh) g[(j + 1) * bw + i + 1] = 1;
        }
      }
    }
    tctx.fillStyle = layer.white ? "#fff" : PALETTE[layer.color || 1];
    for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
      if (!g[j * bw + i]) continue;
      tctx.fillRect(x + i - b.pad, baseline - b.asc + j, 1, 1);
    }
    if (layer.styles.includes("underline")) {
      const y = baseline + 2;
      for (let i = 0; i < b.adv; i++) tctx.fillRect(x + i, y, 1, 1);
    }
  }

  function drawLayerText(layer) {
    const fam = (FONTS.find(function (f) { return f.name === layer.font; }) || FONTS[0]).css;
    const bold = layer.styles.includes("bold");
    const italic = layer.styles.includes("italic");
    const lh = layerLineHeight(layer);
    for (let i = 0; i < layer.lines.length; i++) stampLayerLine(layer, layer.lines[i], layer.x, layer.y + i * lh, fam, bold, italic);
  }

  function renderTextLayers() {
    tctx.clearRect(0, 0, DW, DH);
    for (const layer of textLayers) drawLayerText(layer);
  }

  /* Boîte englobante d'un calque (pour le pointage et le déplacement). */
  function textLayerBounds(layer) {
    const lh = layerLineHeight(layer);
    const fam = (FONTS.find(function (f) { return f.name === layer.font; }) || FONTS[0]).css;
    const bold = layer.styles.includes("bold");
    const italic = layer.styles.includes("italic");
    let w = 0;
    for (const line of layer.lines) w = Math.max(w, textWidth(line, fam, layer.size, bold, italic));
    const asc = textBmp("M", layer.font, layer.size, bold, italic).asc;
    const x = layer.alignment === "middle" ? layer.x - Math.round(w / 2) : layer.alignment === "right" ? layer.x - w : layer.x;
    return { x: x - 2, y: layer.y - asc - 2, w: w + 4, h: lh * layer.lines.length + 4 };
  }

  function textLayerAt(x, y) {
    for (let i = textLayers.length - 1; i >= 0; i--) {
      const b = textLayerBounds(textLayers[i]);
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) return textLayers[i];
    }
    return null;
  }

  /* Rééditer un calque : on le retire de la liste, on recharge son contenu et son
     style dans l'éditeur, puis l'utilisateur revalide (nouveau calque). */
  function editTextLayerById(id) {
    const i = textLayers.findIndex(function (t) { return t.id === id; });
    if (i < 0) return false;
    const layer = textLayers[i];
    pushUndo();
    textLayers.splice(i, 1);
    renderTextLayers();
    fontName = layer.font; fontSize = layer.size;
    styles.clear(); layer.styles.forEach(function (s) { styles.add(s); });
    alignment = layer.alignment;
    selectedText = null;
    textState.active = true; textState.x = layer.x; textState.y = layer.y;
    textState.lines = layer.lines.slice(); textState.li = layer.lines.length - 1; textState.ci = textState.lines[textState.li].length;
    textState.base = doc.slice(); textState.blink = Date.now();
    render();
    return true;
  }

  function textLineHeight() {
    return textBmp("",fontName,fontSize,false,false).lineHeight;
  }

  function textRender() {
    if (!textState.base) return;
    doc.set(textState.base);
    for (let i = 0; i < textState.lines.length; i++) {
      stampLine(textState.lines[i], textState.x, textState.y + i * textLineHeight());
    }
    render();
  }

  function stampLine(str, x, baseline) {
    if (!str) return;
    const fam = (FONTS.find(function (f) { return f.name === fontName; }) || FONTS[0]).css;
    const bold = styles.has("bold");
    if(alignment!=="left") {
      const tw=textWidth(str,fam,fontSize,bold,styles.has("italic"));
      x-=alignment==="middle"?Math.round(tw/2):tw;
    }
    const italic = styles.has("italic");
    const b = textBmp(str, fam, fontSize, bold, italic);
    const bw = b.w, bh = b.h;
    /* application des styles */
    let g = b.bits.slice();
    const at = function (arr, i, j) { return (i >= 0 && j >= 0 && i < bw && j < bh) ? arr[j * bw + i] : 0; };
    if (styles.has("outline") || styles.has("shadow")) {
      const o = new Uint8Array(bw * bh);
      for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
        if (at(g, i, j)) continue;
        o[j * bw + i] = (at(g, i - 1, j) || at(g, i + 1, j) || at(g, i, j - 1) || at(g, i, j + 1)) ? 1 : 0;
      }
      g = o;
      if (styles.has("shadow")) {
        const s = g.slice();
        for (let j = 0; j < bh; j++) for (let i = 0; i < bw; i++) {
          const v = at(s, i, j);
          if (v && i + 1 < bw && j + 1 < bh) g[(j + 1) * bw + i + 1] = 1;
        }
      }
    }
    for (let j = 0; j < bh; j++)
      for (let i = 0; i < bw; i++) {
        if (!g[j * bw + i]) continue;
        px(x + i - b.pad, baseline - b.asc + j, inkWhite() ? 0 : 1);
      }
    if (styles.has("underline")) {
      const y = baseline + 2;
      for (let i = 0; i < b.adv; i++) px(x + i, y, inkWhite() ? 0 : 1);
    }
  }

  function textCommit() {
    if (!textState.active) return;
    textState.active = false;
    /* Le texte validé quitte la feuille bitmap et devient un calque superposé. */
    if (textState.base) doc.set(textState.base);
    const content = textState.lines.filter(function (l) { return l.length > 0; });
    if (content.length) {
      textLayers.push({ id: textLayerId++, x: textState.x, y: textState.y, lines: content, font: fontName, size: fontSize, styles: [...styles], alignment: alignment, white: inkWhite(), color: ink });
      renderTextLayers();
      cheer("text");
    }
    textState.base = null;
    scheduleSave();
    render();
  }
  function textBegin(x, y) {
    textCommit();
    pushUndo();
    textState.active = true;
    textState.x = x;
    textState.y = y;
    textState.lines = [""];
    textState.li = 0;
    textState.ci = 0;
    textState.base = doc.slice();
    textState.blink = Date.now();
    render();
  }
  function textInsert(ch) {
    if (!textState.active) return;
    const l = textState.lines[textState.li];
    textState.lines[textState.li] = l.slice(0, textState.ci) + ch + l.slice(textState.ci);
    textState.ci += ch.length;
    tickSnd("type");
    textRender();
  }
  function textBackspace() {
    if (!textState.active) return;
    const l = textState.lines[textState.li];
    if (textState.ci > 0) {
      textState.lines[textState.li] = l.slice(0, textState.ci - 1) + l.slice(textState.ci);
      textState.ci--;
    } else if (textState.li > 0) {
      textState.ci = textState.lines[textState.li - 1].length;
      textState.lines[textState.li - 1] += l;
      textState.lines.splice(textState.li, 1);
      textState.li--;
    }
    textRender();
  }
  function textCaretPos() {
    const fam = (FONTS.find(function (f) { return f.name === fontName; }) || FONTS[0]).css;
    const bold = styles.has("bold");
    const str = textState.lines[textState.li].slice(0, textState.ci);
    const w = str ? textWidth(str, fam, fontSize, bold, styles.has("italic")) : 0;
    const full=textState.lines[textState.li],tw=textWidth(full,fam,fontSize,bold,styles.has("italic"));
    const offset=alignment==="middle"?Math.round(tw/2):alignment==="right"?tw:0;
    return { x: textState.x + w-offset, y: textState.y + textState.li * textLineHeight() };
  }

  /* ---------------------------------------------------------------- *
   *  10. Rendu de l'écran
   * ---------------------------------------------------------------- */
  const docCanvas = document.createElement("canvas");
  docCanvas.width = DW; docCanvas.height = DH;
  const dctx = docCanvas.getContext("2d");
  let docImg = dctx.createImageData(DW, DH);
  let docPx = new Uint32Array(docImg.data.buffer);

  function syncDoc() {
    let live = 0;
    const shown = LAYERS.filter(l => l.visible), now = performance.now();
    LIVE_NOW = now;
    const rb = ink === RB || rbLinger > 0;
    if (rb) { if (ink !== RB) rbLinger--; for (const l of LAYERS) rbResolve(l.data); }   // l'encre arc-en-ciel prend sa couleur définitive
    if (shown.length === 1 && !FX.grid) { const d = shown[0].data; for (let i = 0; i < d.length; i++) { const v = d[i]; docPx[i] = PAL32[v]; if (v > 15 && v < CUSTOM0) live = 1; } }
    else {
      if (FX.grid) gridCompose(now); else docPx.fill(0xffffffff);     // la grille de Mondrian sert de fond ; ce qu'on peint ensuite passe dessus
      for (const l of shown) { const d = l.data; for (let i = 0; i < d.length; i++) { const v = d[i]; if (v) { docPx[i] = PAL32[v]; if (v > 15 && v < CUSTOM0) live = 1; } } }
    }
    if (FX.parts.length) wetCompose();
    if (FX.hearts.length) heartsCompose(now);
    for (const q of FX.shards) rotBlit(q, q.x, q.y, q.a, 1, 1, (X, Y, v) => pxDot(X, Y, v));
    if (FX.plants.length) plantsCompose(now);
    if (FX.metal.length) metalCompose();
    if (FX.live.length || FX.spores.length || FX.sprouts.length) liveCompose(now);
    if (FX.sun) sunCompose();
    if (tool === "repel" || FX.pokes.length) pokesCompose(now);
    if (FX.replay && FX.replay.cur) { const f = FX.replay.cur; for (let i = 0; i < f.length; i++) docPx[i] = PAL32[f[i]]; }
    if (FX.reveal > 0 && FX.reveal < 1) { const q = FX.reveal; for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) if (bayer8(x, y) > q) docPx[y * DW + x] = 0xffffffff; }   // fondu par trame, comme HyperCard
    if (now < FX.strobeUntil) strobeCompose();
    if (rb) for (let i = 0; i < docPx.length; i++) if (docPx[i] === RB_MARK) docPx[i] = PAL32[rbAt(i % DW, (i / DW) | 0)];   // ce qui vit encore (chenille, métal, ligne molle…) est teinté de même
    FX.hasCycle = !!live;
    if (live) fxKick();                                          // de l'encre animée sur la feuille : l'image tourne
    dctx.putImageData(docImg, 0, 0);
  }

  function viewWH() {
    return { w: Math.floor(VIEW.w / zoom), h: Math.floor(VIEW.h / zoom) };
  }
  function clampView() {
    VIEW.w = Math.max(1, Math.min(WIN.w, Math.ceil(DW * zoom))); VIEW.h = Math.max(1, Math.min(WIN.h, Math.ceil(DH * zoom)));
    VIEW.x = WIN.x + ((WIN.w - VIEW.w) >> 1); VIEW.y = WIN.y + ((WIN.h - VIEW.h) >> 1);
    const v = viewWH();
    view.x = Math.max(0, Math.min(DW - v.w, view.x));
    view.y = Math.max(0, Math.min(DH - v.h, view.y));
  }

  function fill(x, y, w, h, c) {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
    if (c !== "#000") ctx.fillStyle = "#000";
  }

  const oldChrome=document.createElement("canvas");oldChrome.width=OW;oldChrome.height=OH;
  {
    const g=oldChrome.getContext("2d"),im=g.createImageData(OW,OH),packed=atob(CLASSIC.chrome);
    for(let i=0;i<OW*OH;i++) {const v=(packed.charCodeAt(i>>3)>>(7-(i&7)))&1;const k=i*4;im.data[k]=im.data[k+1]=im.data[k+2]=v?0:255;im.data[k+3]=255;}
    g.putImageData(im,0,0);
  }
  /* Le gris du bureau : un motif 2 × 2 répété (un seul remplissage, pas un point à la fois). */
  let deskTile=null;
  function deskFill(g,x,y,w,h){
    if(!deskTile){deskTile=document.createElement("canvas");deskTile.width=deskTile.height=2;const q=deskTile.getContext("2d");q.fillStyle="#fff";q.fillRect(0,0,2,2);q.fillStyle="#000";q.fillRect(0,0,1,1);q.fillRect(1,1,1,1);}
    g.save();g.fillStyle=g.createPattern(deskTile,"repeat");g.fillRect(x,y,w,h);g.restore();
  }
  const chromeCanvas=document.createElement("canvas");chromeCanvas.width=SW;chromeCanvas.height=SH;
  const chromeCtx=chromeCanvas.getContext("2d");
  function buildChrome() {
    chromeCanvas.width=SW;chromeCanvas.height=SH;
    const g=chromeCtx, O=oldChrome;
    g.imageSmoothingEnabled=false;
    deskFill(g,0,0,SW,SH);                                         // bureau : damier
    /* barre de menus : étirée par une colonne vide, les coins arrondis gardés */
    g.drawImage(O,0,0,500,MENUBAR+1,0,0,500,MENUBAR+1);
    g.drawImage(O,450,0,1,MENUBAR+1,500,0,SW-OW,MENUBAR+1);
    g.drawImage(O,500,0,12,MENUBAR+1,SW-12,0,12,MENUBAR+1);
    /* palette d'outils : à sa place ; épaisseurs et trames : descendues de DY */
    g.drawImage(O,0,20,76,230,0,20,76,230);
    g.drawImage(O,0,250,76,92,0,250+DY,76,92);
    g.drawImage(O,76,294,432,48,76,294+DY,432,48);
    /* fenêtre : agrandie par tranches (une colonne de filets répétée de part et d'autre du titre,
       une rangée du milieu répétée en hauteur) */
    const wx=76,wy=24,ww=426,wh=270,t=document.createElement("canvas");t.width=ww+DX;t.height=wh;
    const tg=t.getContext("2d");tg.imageSmoothingEnabled=false;
    const half=DX>>1,c1=124-wx,c2=456-wx;
    tg.drawImage(O,wx,wy,c1,wh,0,0,c1,wh);
    tg.drawImage(O,wx+c1,wy,1,wh,c1,0,half,wh);
    tg.drawImage(O,wx+c1,wy,c2-c1,wh,c1+half,0,c2-c1,wh);
    tg.drawImage(O,wx+c2,wy,1,wh,c2+half,0,DX-half,wh);
    tg.drawImage(O,wx+c2,wy,ww-c2,wh,c2+DX,0,ww-c2,wh);
    const r1=150-wy;
    g.drawImage(t,0,0,ww+DX,r1,wx,wy,ww+DX,r1);
    g.drawImage(t,0,r1,ww+DX,1,wx,wy+r1,ww+DX,DY);
    g.drawImage(t,0,r1,ww+DX,wh-r1,wx,wy+r1+DY,ww+DX,wh-r1);
    /* Le rectangle de la fenêtre emporte une marge de bureau : étirée, sa trame devenait des
       barres pleines. Partout où la tranche répétée était du damier, on repose le damier. */
    const od=O.getContext("2d").getImageData(0,0,OW,OH).data, dark=(x,y)=>od[(y*OW+x)*4]<128;
    const oxOf=x=>x<wx+c1?x:x<wx+c1+half?wx+c1:x<wx+c2+half?x-half:x<wx+c2+DX?wx+c2:x-DX;
    const oyOf=y=>y<wy+r1?y:y<wy+r1+DY?wy+r1:y-DY;
    for(let y=wy;y<wy+wh+DY;y++)for(let x=wx;x<wx+ww+DX;x++){
      if(y>wy+12&&y<wy+wh+DY-12&&x>wx+12&&x<wx+ww+DX-12){x=wx+ww+DX-13;continue;}   // l'intérieur n'a pas de marge de bureau
      const ox=oxOf(x),oy=oyOf(y),sx=ox!==x&&(ox===wx+c1||ox===wx+c2)&&(x<wx+c1+half||x>=wx+c2+half),sy=oy===wy+r1&&y>=wy+r1&&y<wy+r1+DY;
      const dh=sx&&dark(ox,oy)!==dark(ox+1,oy)&&dark(ox+1,oy)!==dark(ox+2,oy), dv=sy&&dark(ox,oy)!==dark(ox,oy+1)&&dark(ox,oy+1)!==dark(ox,oy+2);
      if(dh||dv){g.fillStyle=((x+y)&1)?"#fff":"#000";g.fillRect(x,y,1,1);}
    }
  }
  buildChrome();
  function drawWindowChrome() { }
  const LOGO = ['.....###...', '....#..#...', '...#...#...', '..#....#...', '.###..###..', '#####.#####', '#####.#####', '#####.#####', '.###...###.'];   // cerises
  /* Plein écran : une case à droite de la barre de menus. Le navigateur n'accepte la demande que pendant un vrai
     geste : on la note à l'appui, on la fait au relâchement (valable à la souris comme au doigt). */
  const FS = { want: false };
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  const fsCan = () => !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
  const fsRect = () => ({ x: SW - 24, y: 2, w: 19, h: 14 });
  function fsToggle() {
    try {
      const el = document.documentElement;
      if (fsEl()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else { const r = (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: "hide" }); if (r && r.catch) r.catch(function () {}); }
    } catch (e) {}
  }
  function drawFsButton() {
    if (!fsCan()) return;
    const r = fsRect(), on = !!fsEl();
    ctx.fillStyle = "#fff"; ctx.fillRect(r.x - 2, r.y - 1, r.w + 4, r.h + 2);
    ctx.fillStyle = "#000"; ctx.fillRect(r.x, r.y, r.w, r.h); ctx.fillStyle = "#fff"; ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2); ctx.fillStyle = "#000";
    for (const [cx, cy, sx, sy] of [[r.x + 3, r.y + 3, 1, 1], [r.x + r.w - 4, r.y + 3, -1, 1], [r.x + 3, r.y + r.h - 4, 1, -1], [r.x + r.w - 4, r.y + r.h - 4, -1, -1]]) {
      const ox = on ? cx + sx * 3 : cx, oy = on ? cy + sy * 3 : cy, dx = on ? -sx : sx, dy = on ? -sy : sy;   // quatre coins : vers l'extérieur pour agrandir, vers l'intérieur pour revenir
      for (let k = 0; k < 4; k++) { ctx.fillRect(ox + dx * k, oy, 1, 1); ctx.fillRect(ox, oy + dy * k, 1, 1); }
    }
  }
  function drawMenuBar() {
    // Menu headings in the supplied reference; original Chicago bitmap labels.
    const boxes=[[12,23],[35,35],[71,35],[109,64],[174,43],[218,66],[284,46]];   // chaque case s'arrête à mi-chemin du titre voisin : FontSize 218-284, Style 284-330
    if (!XMENUS[0][1]) { let x = 362; for (const m of XMENUS) { m[2] = textWidth(m[0], "Chicago", 12) + 11; m[1] = x; x += m[2]; } }
    for (const m of XMENUS) boxes.push([m[1], m[2]]);
    boxes.forEach((b,i)=>{MENUS[i].x=b[0];MENUS[i].w=b[1];});
    /* Le fruit du logo suit le niveau de difficulté ; la pomme d'origine (niveau 2)
       reste celle de l'image de référence. */
    {
      const rows = LOGO, fx0 = 23 - Math.floor(rows[0].length / 2), fy0 = Math.round(7.5 - rows.length / 2);
      fill(15, 1, 18, 15, "#fff");
      ctx.fillStyle = "#000";
      for (let j = 0; j < rows.length; j++) for (let i = 0; i < rows[j].length; i++) if (rows[j][i] === "#") ctx.fillRect(fx0 + i, fy0 + j, 1, 1);
    }
    for (const m of XMENUS) blit(ctx, textBmp(m[0], "Chicago", 12, false, false), m[1] + 5, 1);
    drawFsButton();
    if(menuOpen>=0) {
      const b=boxes[menuOpen];
      const image=ctx.getImageData(b[0],0,b[1],18);
      for(let i=0;i<image.data.length;i+=4) image.data[i]=image.data[i+1]=image.data[i+2]=255-image.data[i];
      ctx.putImageData(image,b[0],0);
    }
  }

  function drawApple(x, y, color) {
    ctx.fillStyle = color;
    for (let j = 0; j < APPLE.length; j++)
      for (let i = 0; i < APPLE[j].length; i++)
        if (APPLE[j][i] === "#") ctx.fillRect(x + i, y + j, 1, 1);
    ctx.fillStyle = "#000";
  }

  function drawTextInverse(str, x, y, fam, size) {
    const b = textBmp(str, fam, size, false, false);
    const old = ctx.fillStyle;
    ctx.fillStyle = "#fff";
    for (let j = 0; j < b.h; j++)
      for (let i = 0; i < b.w; i++)
        if (b.bits[j * b.w + i]) ctx.fillRect(x + i, y - b.asc + j, 1, 1);
    ctx.fillStyle = old;
  }

  const ACCENT = "#39ff14";

  function drawPalette() {
const now = performance.now(), idle = now < idleUntil, moving = [];
    for (const cell of CLASSIC.tools) {
      const sp = cellSprings[cell.tool], selected = cell.tool === tool, q = cellPos[cell.tool];
      const hx = Math.round(q.x), hy = Math.round(q.y), away = hx !== cell.x || hy !== cell.y;
      let ox = sp ? Math.round(sp.x.x) : 0, oy = sp ? Math.round(sp.y.x) : 0;
      if (frenzyWas) { ox += Math.round((Math.random() - 0.5) * 3); oy += Math.round((Math.random() - 0.5) * 3); }
      if (idle) oy += Math.round(Math.sin(now / 260 - (cell.y - 28) / 22 * 0.7 + (cell.x > 30 ? 0.5 : 0)) * 1.4);
      if (selected && working && !classicOnly()) {
        ox += Math.round(Math.sin(workTime * 26) * (suspense ? 3 : 1.5));
        if (suspense) oy += Math.round(Math.sin(workTime * 41));
      }
      if (bodies[cell.tool]) { fill(cell.x, cell.y, 25, 21, "#fff"); if (!away) continue; fill(hx, hy, 25, 21, "#fff"); continue; }
      if (selected || ox || oy || away) moving.push({ cell: cell, ox: ox, oy: oy, selected: selected, away: away, x: hx, y: hy });
    }
    for (const m of moving) if (m.away) fill(m.cell.x, m.cell.y, 25, 21, "#fff");   // la case a quitté sa place d'origine
    moving.sort((a, b) => a.selected - b.selected);       // la case choisie passe devant
    for (const m of moving) {
      const cell = m.cell, cx = m.x + m.ox, cy = m.y + m.oy;
      if (m.ox || m.oy || (m.away && (cellPos[cell.tool].x !== cellPos[cell.tool].tx || cellPos[cell.tool].y !== cellPos[cell.tool].ty))) {
        if (!m.away) fill(cell.x, cell.y, 25, 21, "#fff");
        fill(cx - 1, cy - 1, 27, 23, "#000");
      }
      fill(cx, cy, 25, 21, m.selected ? "#000" : "#fff");
      ctx.fillStyle = m.selected ? (darkInk(ink) ? "#fff" : PALETTE[ink]) : "#000";   // l'outil choisi porte la couleur courante
      for(let y=0;y<21;y++)for(let x=0;x<25;x++)if(cell.rows[y][x]==="1")ctx.fillRect(cx+x,cy+y,1,1);
      ctx.fillStyle="#000";
    }
    for(let i=0;i<PAT.length;i++) {
      if(PAT[i].every((v,j)=>v===PAT_DEF[i][j]))continue;
      const x=120+(i%19)*20,y=300+DY+Math.floor(i/19)*17;
      fill(x,y,19,16,"#fff");ctx.fillStyle="#000";
      for(let yy=0;yy<16;yy++)for(let xx=0;xx<19;xx++)if(PAT[i][(yy&7)*8+(xx&7)])ctx.fillRect(x+xx,y+yy,1,1);
    }
    // Current pattern sample (the two rows retain their exact original resources).
    fill(85,305+DY,28,23,"#fff");ctx.fillStyle=PALETTE[ink];
    for(let y=0;y<23;y++)for(let x=0;x<28;x++)if(PAT[pattern][(y&7)*8+(x&7)]){if(GRAD.on)ctx.fillStyle=PALETTE[gradCol(x,y,28,23,4,GRAD.dir,ink,GRAD.c2)];ctx.fillRect(85+x,305+DY+y,1,1);}
    ctx.fillStyle="#000";
    // Empty first row = no outline; retain the four historical stroke widths.
    { const li=[1,2,4,8].indexOf(penW); if(li!==0||noOutline){fill(19,271+DY,22,15,"#fff");if(noOutline||li>0)drawBitmap(CHECK,20,DY+(noOutline?262:[277,288,301,316][li]));} }
    {                                                            // la réglette : l'épaisseur en chiffres, et un curseur de 1 à 200
      const y0=WBOX.top(),kx=penX();
      fill(WBOX.x,y0,WBOX.w,WBOX.h+1,"#000");fill(WBOX.x+1,y0+1,WBOX.w-2,WBOX.h,"#fff");   // le blanc recouvre le filet du haut du cadre d'origine : les deux n'en font qu'un
      fill(WBOX.x+WBOX.w,y0+2,2,WBOX.h,"#000");                  // l'ombre du cadre, prolongée vers le haut
      drawText(noOutline?"-":String(penW),WBOX.x+5,y0+12,"Chicago",12);
      const sw=Math.min(12,penW);fill(WBOX.x+WBOX.w-5-12+((12-sw)>>1),y0+8-(sw>>1),sw,Math.max(1,sw),"#000");   // un carré témoin
      fill(WBOX.x+4,y0+22,WBOX.w-8,1,"#000");
      for(let k=0;k<=4;k++)fill(WBOX.x+4+Math.round(k*(WBOX.w-9)/4),y0+20,1,5,"#000");
      fill(kx-2,y0+17,5,11,"#000");fill(kx-1,y0+18,3,9,"#fff");fill(kx,y0+19,1,7,"#000");
    }
  }

  /* Les icônes relevées sur la capture ne partagent pas les mêmes marges : sans
     recentrage, certaines touchaient le filet du haut et d'autres flottaient,
     d'où un décalage visible d'une case à l'autre. On mesure l'encre de chaque
     icône une fois, puis on la pose au centre de sa case. */
  const ICON_BOX = {};
  (function () {
    for (const k in ICON) {
      const rows = ICON[k];
      let x0 = 999, y0 = 999, x1 = -1, y1 = -1;
      for (let j = 0; j < rows.length; j++)
        for (let i = 0; i < rows[j].length; i++)
          if (rows[j][i] === "#") {
            if (i < x0) x0 = i; if (i > x1) x1 = i;
            if (j < y0) y0 = j; if (j > y1) y1 = j;
          }
      if (x1 >= 0) ICON_BOX[k] = { x0: x0, y0: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
  })();

  /* Variante pleine d'une icône : on remplit chaque ligne entre son premier et
     son dernier pixel d'encre. Sert à montrer, dans la palette, que le double-clic
     a mis l'outil de forme en mode plein. */
  function drawIconFilled(name, x, y, color, cellW, cellH) {
    const rows = ICON[name];
    if (!rows) return;
    let dx = 0, dy = 0;
    const b = ICON_BOX[name];
    if (b && cellW && cellH) {
      dx = Math.round((cellW - b.w) / 2) - b.x0;
      dy = Math.round((cellH - b.h) / 2) - b.y0;
    }
    ctx.fillStyle = color;
    for (let j = 0; j < rows.length; j++) {
      const a = rows[j].indexOf("#"), z = rows[j].lastIndexOf("#");
      if (a >= 0) ctx.fillRect(x + dx + a, y + dy + j, z - a + 1, 1);
    }
    ctx.fillStyle = "#000";
  }

  function drawIcon(name, x, y, color, cellW, cellH) {
    const rows = ICON[name];
    if (!rows) return;
    let dx = 0, dy = 0;
    const b = ICON_BOX[name];
    if (b && cellW && cellH) {
      dx = Math.round((cellW - b.w) / 2) - b.x0;
      dy = Math.round((cellH - b.h) / 2) - b.y0;
    }
    ctx.fillStyle = color;
    for (let j = 0; j < rows.length; j++)
      for (let i = 0; i < rows[j].length; i++)
        if (rows[j][i] === "#") ctx.fillRect(x + dx + i, y + dy + j, 1, 1);
    ctx.fillStyle = "#000";
  }

  /* Bureau du Macintosh : trame 50 % dessinée par un motif 2 × 2 mis en cache,
     sinon chaque rendu coûterait quatre-vingt mille rectangles. */
  let DESK_PAT = null;
  function fillDesk() {
    if (!DESK_PAT) {
      const c = document.createElement("canvas");
      c.width = 2; c.height = 2;
      const x = c.getContext("2d");
      x.fillStyle = "#fff"; x.fillRect(0, 0, 2, 2);
      x.fillStyle = "#000"; x.fillRect(0, 0, 1, 1); x.fillRect(1, 1, 1, 1);
      DESK_PAT = ctx.createPattern(c, "repeat");
    }
    ctx.fillStyle = DESK_PAT;
    ctx.fillRect(0, 0, SW, SH);
    ctx.fillStyle = "#000";
  }

  function ditherRect(x, y, w, h) {
    ctx.fillStyle = "#000";
    for (let j = 0; j < h; j++)
      for (let i = (j & 1); i < w; i += 2) ctx.fillRect(x + i, y + j, 1, 1);
  }

  function arrow(x, y, dir) {
    ctx.fillStyle = "#000";
    for (let j = 0; j < 3; j++) {
      if (dir === "up") ctx.fillRect(x + 2 - j, y + j, 2 * j + 1, 1);
      else if (dir === "down") ctx.fillRect(x + 2 - j, y + 4 - j, 2 * j + 1, 1);
      else if (dir === "left") ctx.fillRect(x + j, y + 2 - j, 1, 2 * j + 1);
      else ctx.fillRect(x + 4 - j, y + 2 - j, 1, 2 * j + 1);
    }
    if (dir === "up") ctx.fillRect(x + 2, y + 3, 1, 2);
    else if (dir === "down") ctx.fillRect(x + 2, y, 1, 2);
    else if (dir === "left") ctx.fillRect(x + 3, y + 2, 2, 1);
    else ctx.fillRect(x, y + 2, 2, 1);
  }

  function scrollGeom() {
    const v = viewWH();
    const bx = VIEW.x + VIEW.w, by = VIEW.y + VIEW.h;
    const trackY = VIEW.y + SB, trackH = VIEW.h - 2 * SB;
    const thumbH = Math.max(24, Math.round(trackH * v.h / DH));
    const ty = trackY + Math.round((trackH - thumbH) * (view.y / Math.max(1, DH - v.h)));
    const trackX = VIEW.x + SB, trackW = VIEW.w - 2 * SB;
    const thumbW = Math.max(24, Math.round(trackW * v.w / DW));
    const tx = trackX + Math.round((trackW - thumbW) * (view.x / Math.max(1, DW - v.w)));
    return { bx: bx, by: by, trackY: trackY, trackH: trackH, thumbH: thumbH, ty: ty, trackX: trackX, trackW: trackW, thumbW: thumbW, tx: tx };
  }

  /* Case de redimensionnement, en bas à droite de la fenêtre : un carré blanc
     bordé, traversé de trois diagonales, comme dans MacPaint. */
  function drawSizeBox() {
    const x = VIEW.x + VIEW.w, y = VIEW.y + VIEW.h;
    fill(x, y, SB_R, SB_B, "#fff");
    fill(x, y, SB_R, 1, "#000");
    fill(x, y, 1, SB_B, "#000");
    for (let i = 0; i < 3; i++) {
      const d = 3 + i * 3;
      for (let k = 0; k < d; k++) ctx.fillRect(x + SB_R - 1 - k, y + SB_B - 1 - k, 1, 1);
    }
  }

  function drawScrollbars() {
    const g = scrollGeom();
    const bx = g.bx, by = g.by;

    /* --- barre verticale --- */
    fill(bx, VIEW.y, SB_R, VIEW.h, "#fff");
    ditherRect(bx + 1, g.trackY, SB_R - 2, g.trackH);
    fill(bx, VIEW.y, 1, VIEW.h, "#000");
    fill(bx, VIEW.y, SB_R, 1, "#000");
    fill(bx, by - 1, SB_R, 1, "#000");
    fill(bx, VIEW.y, SB_R, SB, "#fff");
    fill(bx, by - SB, SB_R, SB, "#fff");
    fill(bx, VIEW.y + SB - 1, SB_R, 1, "#000");
    fill(bx, by - SB, SB_R, 1, "#000");
    arrow(bx + Math.floor((SB_R - 5) / 2), VIEW.y + Math.floor((SB - 5) / 2), "up");
    arrow(bx + Math.floor((SB_R - 5) / 2), by - SB + Math.floor((SB - 5) / 2), "down");

    fill(bx + 2, g.ty, SB_R - 4, g.thumbH, "#fff");
    ctx.strokeStyle = "#000";
    ctx.strokeRect(bx + 2.5, g.ty + 0.5, SB_R - 5, g.thumbH - 1);

    /* --- barre horizontale --- */
    fill(VIEW.x, by, VIEW.w, SB_B, "#fff");
    ditherRect(g.trackX, by + 1, g.trackW, SB_B - 2);
    fill(VIEW.x, by, VIEW.w, 1, "#000");
    fill(VIEW.x, by, 1, SB_B, "#000");
    fill(bx - 1, by, 1, SB_B, "#000");
    fill(VIEW.x, by, SB, SB_B, "#fff");
    fill(bx - SB, by, SB, SB_B, "#fff");
    fill(VIEW.x + SB - 1, by, 1, SB_B, "#000");
    fill(bx - SB, by, 1, SB_B, "#000");
    arrow(VIEW.x + Math.floor((SB - 5) / 2), by + Math.floor((SB_B - 5) / 2), "left");
    arrow(bx - SB + Math.floor((SB - 5) / 2), by + Math.floor((SB_B - 5) / 2), "right");

    fill(g.tx, by + 2, g.thumbW, SB_B - 4, "#fff");
    ctx.strokeRect(g.tx + 0.5, by + 2.5, g.thumbW - 1, SB_B - 5);

    /* coin */
    fill(bx, by, SB_R, SB_B, "#fff");
  }

  function drawDoc() {
    syncDoc();
    if (VIEW.w < WIN.w || VIEW.h < WIN.h) {                      // autour de la page : le gris tramé du bureau, et un filet
      deskFill(ctx, WIN.x, WIN.y, WIN.w, WIN.h);
      ctx.fillStyle = "#000"; ctx.fillRect(VIEW.x - 1, VIEW.y - 1, VIEW.w + 3, VIEW.h + 3);
      ctx.fillStyle = "#fff"; ctx.fillRect(VIEW.x, VIEW.y, VIEW.w, VIEW.h); ctx.fillStyle = "#000";
    }
    drawPageInfo();
    if (tool === "balloon") { const q = FX.typing, t = textBmp(q ? (q.letters.length ? "Keep typing   (Return = done, Backspace = erase)" : "Now type letters: they inflate to fill this area") : "Click an empty area, then type letters", "Geneva", 9, false, false); ctx.fillStyle = "#fff"; ctx.fillRect(WIN.x + 20, 27, t.w + 9, 15); ctx.fillStyle = "#000"; blit(ctx, t, WIN.x + 25, 29); }
    if (tool === "custom") { const m = FX.cb, t = textBmp(FX.cbrush ? "Brush " + FX.cbrush.w + "x" + FX.cbrush.h + "   " + (m.rx ? "X " : "") + (m.ry ? "Y " : "") + (m.rz ? "Z " : "") + (m.cyc ? "C " : "") + "  (keys X Y Z C, N new)" : "Click a shape to make it the brush", "Geneva", 9, false, false); ctx.fillStyle = "#fff"; ctx.fillRect(WIN.x + 20, 27, t.w + 9, 15); ctx.fillStyle = "#000"; blit(ctx, t, WIN.x + 25, 29); }
    ctx.save();
    ctx.beginPath();
    ctx.rect(VIEW.x, VIEW.y, VIEW.w, VIEW.h);
    ctx.clip();
    const v = viewWH();
    ctx.imageSmoothingEnabled = false;
    if (FX.boil) {                                               // trois poses qui alternent : tout frémit, rien ne change
      const ph = Math.floor(performance.now() / 110) % 3, band = 3;
      for (let y = 0; y < v.h; y += band) { const hh = Math.sin((view.y + y) * 12.9898 + ph * 78.233) * 43758.5453, o = Math.round((hh - Math.floor(hh)) * 2 - 1); ctx.drawImage(docCanvas, view.x, view.y + y, v.w, band, VIEW.x + o * zoom, VIEW.y + y * zoom, v.w * zoom, band * zoom); }
    } else
    ctx.drawImage(docCanvas, view.x, view.y, v.w, v.h, VIEW.x, VIEW.y, v.w * zoom, v.h * zoom);
    ctx.drawImage(textCanvas, view.x, view.y, v.w, v.h, VIEW.x, VIEW.y, v.w * zoom, v.h * zoom);
    fxDraw();
    if (selectedText !== null) {
      const layer = textLayers.find(function (l) { return l.id === selectedText; });
      if (layer) {
        const b = textLayerBounds(layer);
        const hx = VIEW.x + (b.x - view.x) * zoom, hy = VIEW.y + (b.y - view.y) * zoom;
        ctx.strokeStyle = ACCENT; ctx.setLineDash([4, 4]);
        ctx.strokeRect(hx - 0.5, hy - 0.5, b.w * zoom + 1, b.h * zoom + 1);
        ctx.setLineDash([]);
      }
    }

    /* bord de la feuille */
    const px0 = VIEW.x - view.x * zoom, py0 = VIEW.y - view.y * zoom;
    ctx.strokeStyle = "#000";
    ctx.strokeRect(px0 - 0.5, py0 - 0.5, DW * zoom + 1, DH * zoom + 1);

    if (gridOn) {
      ctx.fillStyle = "rgba(0,0,0,.25)";
      for (let gx = view.x - (view.x % 8); gx < view.x + v.w; gx += 8) {
        const sx = Math.round(VIEW.x + (gx - view.x) * zoom);
        ctx.fillRect(sx, VIEW.y, 1, VIEW.h);
      }
      for (let gy = view.y - (view.y % 8); gy < view.y + v.h; gy += 8) {
        const sy = Math.round(VIEW.y + (gy - view.y) * zoom);
        ctx.fillRect(VIEW.x, sy, VIEW.w, 1);
      }
    }

    if (zoom > 1) {
      ctx.fillStyle = "#fff";
      for (let i = 0; i <= v.w; i++) {
        const sx = Math.round(VIEW.x + i * zoom) - 1;
        ctx.fillRect(sx, VIEW.y, 1, Math.min(VIEW.h, v.h * zoom));
      }
      for (let j = 0; j <= v.h; j++) {
        const sy = Math.round(VIEW.y + j * zoom) - 1;
        ctx.fillRect(VIEW.x, sy, Math.min(VIEW.w, v.w * zoom), 1);
      }
    }
    ctx.restore();
  }

  function drawSelection() {
    if (!sel) return;
    const t = Math.floor(Date.now() / 160) % 8;
    const x0 = VIEW.x + (sel.x - view.x) * zoom;
    const y0 = VIEW.y + (sel.y - view.y) * zoom;
    const w = sel.w * zoom, h = sel.h * zoom;
    ctx.save();
    ctx.beginPath();
    ctx.rect(VIEW.x, VIEW.y, VIEW.w, VIEW.h);
    ctx.clip();
    if (!sel.mask) {
      for (let i = 0; i < w; i++) {
        if (((i + t) & 3) < 2) {
          ctx.fillStyle = ACCENT; ctx.fillRect(x0 + i, y0, 1, 1); ctx.fillRect(x0 + i, y0 + h - 1, 1, 1);
        } else {
          ctx.fillStyle = "#000"; ctx.fillRect(x0 + i, y0, 1, 1); ctx.fillRect(x0 + i, y0 + h - 1, 1, 1);
        }
      }
      for (let j = 0; j < h; j++) {
        if (((j + t) & 3) < 2) { ctx.fillStyle = ACCENT; ctx.fillRect(x0, y0 + j, 1, 1); ctx.fillRect(x0 + w - 1, y0 + j, 1, 1); }
        else { ctx.fillStyle = "#000"; ctx.fillRect(x0, y0 + j, 1, 1); ctx.fillRect(x0 + w - 1, y0 + j, 1, 1); }
      }
    } else {
      for (let j = 0; j < sel.h; j++)
        for (let i = 0; i < sel.w; i++) {
          if (!sel.mask[j * sel.w + i]) continue;
          const edge = i === 0 || j === 0 || i === sel.w - 1 || j === sel.h - 1 ||
            !sel.mask[j * sel.w + i - 1] || !sel.mask[j * sel.w + i + 1] ||
            !sel.mask[(j - 1) * sel.w + i] || !sel.mask[(j + 1) * sel.w + i];
          if (!edge) continue;
          const X = Math.round(x0 + i * zoom), Y = Math.round(y0 + j * zoom);
          ctx.fillStyle = ((i + j + t) & 3) < 2 ? ACCENT : "#000";
          ctx.fillRect(X, Y, Math.max(1, zoom), Math.max(1, zoom));
        }
    }
    ctx.restore();
  }

  /* Le curseur montre la taille réelle de l'outil : un cercle (un carré pour la gomme) en pointillés noirs et blancs,
     lisible sur n'importe quelle couleur, avec une croix au centre. */
  const NO_RING = new Set(["lasso", "marquee", "grabber", "text", "bucket", "polygon", "polygonFill", "freeform", "freeformFill", "motor", "hammer", "ball", "slice", "grid", "moire", "accordion", "pump", "heart", "sun", "shaker", "repel", "fold", "extrude", "lathe", "custom", "cfill", "graft", "coral", "rain", "snow", "type", "balloon", "dynamite", "fly", "cube", "sphere", "cylinder", "cone", "pyramid", "torus"]);
  const ringTool = () => !NO_RING.has(tool);
  function drawBrushCursor() {
    if (!mouse.in || touchMode || menuOpen >= 0 || dialog || TO.on || CW.on || SZ.on || GD.on || RD.on || !ringTool()) return;
    const mx = Math.round(mouse.x), my = Math.round(mouse.y);
    if (mx < VIEW.x || my < VIEW.y || mx >= VIEW.x + VIEW.w || my >= VIEW.y + VIEW.h) return;
    const size = tool === "eraser" ? Math.max(2, ultra() ? eraserSize : PW()) : tool === "melt" ? Math.max(3, Math.min(120, PW())) * 2 : tool === "spray" ? Math.max(4, PW() * TK("spread", [0.5, 1, 2.2], "spray")) : PW();
    const r = size * zoom / 2, ph = Math.floor(performance.now() / 120);
    const dot = (X, Y, k) => { if (X < VIEW.x || Y < VIEW.y || X >= VIEW.x + VIEW.w || Y >= VIEW.y + VIEW.h) return; ctx.fillStyle = ((k + ph) >> 1) & 1 ? "#000" : "#fff"; ctx.fillRect(X, Y, 1, 1); };
    if (r >= 2.5) {
      if (tool === "eraser") { const o = Math.round(r); let k = 0; for (let i = -o; i <= o; i++) { dot(mx + i, my - o, k); dot(mx + i, my + o, k); dot(mx - o, my + i, k); dot(mx + o, my + i, k); k++; } }
      else { const n = Math.max(16, Math.ceil(r * 6.3)); for (let k = 0; k < n; k++) { const an = k / n * 6.2832; dot(Math.round(mx + Math.cos(an) * r), Math.round(my + Math.sin(an) * r), k); } }
    }
    for (let i = 2; i <= 5; i++) for (const [a, b] of [[i, 0], [-i, 0], [0, i], [0, -i]]) { ctx.fillStyle = "#fff"; ctx.fillRect(mx + a - (b ? 1 : 0), my + b - (a ? 1 : 0), b ? 3 : 1, a ? 3 : 1); }   // la croix : blanche dessous…
    ctx.fillStyle = "#000"; for (let i = 2; i <= 5; i++) { ctx.fillRect(mx + i, my, 1, 1); ctx.fillRect(mx - i, my, 1, 1); ctx.fillRect(mx, my + i, 1, 1); ctx.fillRect(mx, my - i, 1, 1); }   // …noire dessus
  }
  function drawFatBitsCursor() {
    if (!fatBits) return;
    const d = screenToDoc(mouse.x, mouse.y);
    if (d.x < 0 || d.y < 0 || d.x >= DW || d.y >= DH) return;
    const x = VIEW.x + (d.x - view.x) * zoom, y = VIEW.y + (d.y - view.y) * zoom;
    ctx.strokeStyle = "#000";
    ctx.strokeRect(x - 0.5, y - 0.5, zoom + 1, zoom + 1);
    ctx.strokeStyle = ACCENT;
    ctx.strokeRect(x + 0.5, y + 0.5, zoom - 1, zoom - 1);
  }

  /* sélection flottante (pixels déplacés ou collés) */
  const floatCanvas = document.createElement("canvas");
  const fctx = floatCanvas.getContext("2d");

  function drawFloating() {
    if (!sel || !sel.data) return;
    floatCanvas.width = sel.w; floatCanvas.height = sel.h;
    const im = fctx.createImageData(sel.w, sel.h);
    const p32 = new Uint32Array(im.data.buffer);
    for (let i = 0; i < sel.data.length; i++) p32[i] = sel.data[i] ? PAL32[sel.data[i]] : 0x00000000;
    fctx.putImageData(im, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(VIEW.x, VIEW.y, VIEW.w, VIEW.h);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(floatCanvas, Math.round(VIEW.x + (sel.x - view.x) * zoom), Math.round(VIEW.y + (sel.y - view.y) * zoom),
      sel.w * zoom, sel.h * zoom);
    ctx.restore();
  }

  function drawLassoPath() {
    if (!drag || drag.kind !== "lasso") return;
    const pts = drag.pts;
    if (!pts || pts.length < 2) return;
    ctx.fillStyle = "#000";
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const x0 = VIEW.x + (a.x - view.x) * zoom, y0 = VIEW.y + (a.y - view.y) * zoom;
      const x1 = VIEW.x + (b.x - view.x) * zoom, y1 = VIEW.y + (b.y - view.y) * zoom;
      const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
      for (let k = 0; k <= n; k += 2) ctx.fillRect(Math.round(x0 + (x1 - x0) * k / n), Math.round(y0 + (y1 - y0) * k / n), 1, 1);
    }
  }

  /* Un seul dessin d'écran par image affichée. Les gestes envoient souvent plusieurs déplacements entre deux images
     (souris rapide, tablette) : chaque demande ne fait que réserver le prochain rafraîchissement. renderNow() dessine
     tout de suite, pour la boucle d'animation et les captures. Page cachée : le navigateur suspend les
     rafraîchissements, on dessine donc sur-le-champ. */
  let renderQ = 0;
  function render() {
    if (touchMode || document.hidden) { renderNow(); return; }
    if (!renderQ) renderQ = requestAnimationFrame(function () { renderQ = 0; renderNow(); });
  }
  function renderNow() {
    if (renderQ) { cancelAnimationFrame(renderQ); renderQ = 0; }
    if (touchMode) { notifyChange(); return; }
    ctx.drawImage(chromeCanvas,0,0);
    if(!documentOpen) {
      fillDesk();
      ctx.drawImage(chromeCanvas,0,0,78,SH,0,0,78,SH);
      ctx.drawImage(chromeCanvas,0,0,SW,19,0,0,SW,19);
      ctx.drawImage(chromeCanvas,0,294+DY,SW,48,0,294+DY,SW,48);
      drawMenuBar();drawPalette();legoCompose();drawBodies();
      if(menuOpen>=0)legoDrawMenu();if(dialog)drawDialog();legoSharp();notifyChange();return;
    }
    drawMenuBar();
    drawPalette();
    drawSwatches(); drawFxCells(); drawLayers(); drawDial();
    drawWindowChrome();
    drawDoc();
    drawFloating();
    drawSelection();
    drawLassoPath();
    // MacPaint 1.5 reference has a fixed paint viewport, no modern scrollbars.
    if(showPage) drawPageOverview();
    if(helpPage) {
      const bits=atob(CLASSIC.help[helpPage]);fill(VIEW.x,VIEW.y,VIEW.w,VIEW.h,"#fff");ctx.fillStyle="#000";
      for(let y=0;y<240;y++)for(let x=0;x<416;x++)if((bits.charCodeAt((y*416+x)>>3)>>(7-(x&7)))&1)ctx.fillRect(VIEW.x+x,VIEW.y+y,1,1);
    }
    drawFatBitsCursor();
    drawBrushCursor();

    /* curseur texte */
    if (textState.active && (Date.now() - textState.blink) % 1000 < 550) {
      const c = textCaretPos();
      const x = VIEW.x + (c.x - view.x) * zoom;
      const cy = VIEW.y + (c.y - view.y) * zoom;
      ctx.fillStyle = ACCENT;
      ctx.fillRect(Math.round(x), Math.round(cy - fontSize), 1, fontSize + 2);
    }

    legoCompose();
    drawBodies();
    if (menuOpen >= 0) legoDrawMenu();
    if (dialog) drawDialog();
    if (SZ.on) drawSize();
    if (TO.on) drawToolOpts();
    if (CW.on) drawCW();
    if (GD.on) drawGifDialog();
    if (RD.on) drawRampDialog();
    if (FX.gif) { ctx.fillStyle = "#000"; ctx.fillRect(WIN.x + 22, 27, 34, 15); ctx.fillStyle = "#fff"; const tb = textBmp("REC", "Chicago", 12, false, false); for (let b = 0; b < tb.h; b++) for (let a2 = 0; a2 < tb.w; a2++) if (tb.bits[b * tb.w + a2]) ctx.fillRect(WIN.x + 27 + a2, 28 + b, 1, 1); ctx.fillStyle = "#000"; }
    legoSharp();
    notifyChange();
  }

  /* ---------------------------------------------------------------- *
   *  11. Menus
   * ---------------------------------------------------------------- */
  const menuCommands = [
    ["about",null],
    ["new","open","closeDocument","save","saveAs","revert","print","print","catalog","quit"],
    ["undo",null,"cut","copy","paste","clearSel",null,"invert","fill","trace","fliph","flipv","rotate"],
    ["grid","fatbits","showpage","editpattern","brushshape","mirrors","intro","shortcuts"],
    [],[],[]
  ];
  const MENUS=CLASSIC.menus.map((m,i)=>({title:i?m.title:"",apple:i===0,
    items:m.items.map((item,j)=>item.text==="-"?{sep:true}:{t:item.text,k:item.key,cmd:menuCommands[i][j]||"close"}),
    dynamic:i===4?"fonts":i===5?"sizes":i===6?"styles":undefined}));
  /* Réglage de la difficulté (satire.js), à la fin du menu Goodies. */
  /* L'application s'appelle MacPain (sans « t ») : le premier article du menu aussi. */
  for (const item of MENUS[0].items) if (item.t) item.t = item.t.replace("MacPaint", "MacTint");
  /* Le niveau de difficulté se change par le menu du fruit (en haut à gauche) et par Goodies. */
  const fxItems = list => list.map(m => m ? { t: m[1], cmd: "fx:" + m[0], check: function () { return tool === m[0]; } } : { sep: true });
  MENUS.push({title:"",items:fxItems(FX_FAMILIES.Draw)});
  MENUS.push({title:"",items:fxItems(FX_FAMILIES.Effects)});
  MENUS.push({title:"",items:fxItems(FX_FAMILIES.Life).concat([{sep:true},{t:"Predator Colors",cmd:"live:pred",check:function(){return FX.pred;}},{t:"Fix Living Shapes",cmd:"live:fix"}])});
  MENUS.push({title:"",items:fxItems(FX_FAMILIES.Cycle).concat([{sep:true},
    {t:"Animate Whole Image",cmd:"cyc:all"},{t:"Freeze Image",cmd:"cyc:freeze"},{sep:true},
    {t:"Edit Ramp...",cmd:"ramp"},{t:"Faster",cmd:"cyc:fast"},{t:"Slower",cmd:"cyc:slow"},{t:"Reverse",cmd:"cyc:rev",check:function(){return FX.cycDir<0;}},{t:"Pause",cmd:"cyc:pause",check:function(){return FX.cycPause;}},{sep:true},
    {t:"Boiling Ink",cmd:"cyc:boil",check:function(){return FX.boil;}},{t:"Strobe Storm",cmd:"cyc:storm",check:function(){return FX.storm;}},{sep:true},
    {t:"Replay Drawing",cmd:"cyc:replay"},{t:"Dissolve In",cmd:"cyc:dissolve"}])});   // l'enregistrement en GIF animé est dans File > Save As
  MENUS.push({title:"",items:fxItems(FX_FAMILIES["3D"])});
  MENUS.push({title:"",items:[{t:"New Layer",cmd:"layer:new"},{t:"Duplicate Layer",cmd:"layer:dup"},{t:"Delete Layer",cmd:"layer:delete"},{sep:true},
    {t:"Bring Forward",cmd:"layer:up"},{t:"Send Backward",cmd:"layer:down"},{sep:true},{t:"Merge Down",cmd:"layer:merge"},{t:"Flatten Image",cmd:"layer:flatten"},{sep:true},
    {t:"Show Layer",cmd:"layer:eye",check:function(){return LAYERS[LA].visible;}}]});
  MENUS.push({title:"",items:PAGES.map((q,i)=>({t:q[0],cmd:"page:"+i,check:function(){return DW===q[1]&&DH===q[2];}})).concat([{t:"Custom Size...",cmd:"page:custom"},{sep:true}],
    [0.25,0.5,1,2,4,8].map(z=>({t:(z*100)+"%",cmd:"zoom:"+z,check:function(){return zoom===z;}})),
    [{sep:true},{t:"Zoom In",cmd:"zoom:in",k:"+"},{t:"Zoom Out",cmd:"zoom:out",k:"-"},{t:"Fit Page",cmd:"zoom:fit",k:"0"}])});
  MENUS[3].items.push({sep:true});
  MENUS[3].items.push({t:"Big Interface",cmd:"bigui",check:function(){return FX.bigUI;}});
  MENUS[3].items.push({t:"Sound",cmd:"sound",check:function(){return !!SND&&SND.isEnabled();}});

  function menuItems(mi) {
    const m = MENUS[mi];
    if (m.dynamic === "fonts") {
      return FONTS.map(function (f) {
        return { t: f.name, cmd: "font:" + f.name, font: "Chicago", check: function () { return fontName === f.name; } };
      });
    }
    if (m.dynamic === "sizes") {
      return SIZES.map(function (s) {
        return { t: s===9?"9 point":String(s), cmd: "size:" + s, check: function () { return fontSize === s; } };
      });
    }
    if (m.dynamic === "styles") {
      return CLASSIC.menus[6].items.map(it=>it.text==="-"?{sep:true}:{t:it.text,k:it.key,
        cmd:it.text.startsWith("Align ")?"align:"+it.text.slice(6).toLowerCase():"style:"+it.text.toLowerCase(),
        check:()=>it.text.startsWith("Align ")?alignment===it.text.slice(6).toLowerCase():it.text==="Plain"?styles.size===0:styles.has(it.text.toLowerCase())});
    }

    return m.items;
  }

  function menuLayout(mi) {
    const items = menuItems(mi);
    let w = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].sep) continue;
      const fam = items[i].font || "Chicago";
      const tw = textWidth(items[i].t, fam, 12) + (items[i].k ? 26 + textWidth(items[i].k, "Chicago", 12) : 0);
      w = Math.max(w, tw);
    }
    w += 32;
    let h = 4;
    for (let i = 0; i < items.length; i++) h += items[i].sep ? 7 : 16;
    return { w: w, h: h, items: items, x: Math.min(MENUS[mi].x, SW - w - 6), y: MENUBAR };
  }

  function drawMenu() {
    const L = menuLayout(menuOpen);
    let x = L.x;
    if (x + L.w > SW) x = SW - L.w;
    /* ombre tramée */
    for (let j = 0; j < L.h; j += 2)
      for (let i = 2; i < L.w + 2; i += 2) ctx.fillRect(x + i, MENUBAR + 3 + j, 1, 1);
    fill(x, MENUBAR, L.w, L.h, "#fff");
    ctx.strokeStyle = "#000";
    ctx.strokeRect(x + 0.5, MENUBAR + 0.5, L.w - 1, L.h - 1);
    // Classic MENU border is one pixel, not a double frame.

    let y = MENUBAR + 2;
    for (let i = 0; i < L.items.length; i++) {
      const it = L.items[i];
      if (it.sep) {
        fill(x + 8, y + 3, L.w - 16, 1, "#000");
        y += 7;
        continue;
      }
      const fam = it.font || "Chicago";
      const dis = it.disabled;
      if (it.check && it.check()) drawBitmap(CHECK, x + 8, y + 4);
      drawText(it.t, x + 24, y + 12, fam, 12, false, false, { dither: dis });
      if (it.k) drawText("⌘"+it.k, x + L.w - 10 - textWidth("⌘"+it.k, "Chicago", 12), y + 12, "Chicago", 12, false, false, { dither: dis });
      it._rect = { x: x, y: y, w: L.w, h: 16 };
      y += 16;
    }
    const hover=L.items[menuHover];
    if(hover&&hover._rect&&!hover.disabled) {
      const r=hover._rect,im=ctx.getImageData(r.x+1,r.y,r.w-2,r.h);
      for(let i=0;i<im.data.length;i+=4){im.data[i]=255-im.data[i];im.data[i+1]=255-im.data[i+1];im.data[i+2]=255-im.data[i+2];}
      ctx.putImageData(im,r.x+1,r.y);
    }
    L.x = x;
    MENUS[menuOpen]._layout = L;
  }

  /* ---------------------------------------------------------------- *
   *  12. Dialogues
   * ---------------------------------------------------------------- */
  function openDialog(d) {
    dialog = d;
    render();
  }
  function closeDialog() {
    dialog = null;
    render();
  }

  function drawDialog() {
    const d = dialog;
    const w = d.w || 320;
    const h = d.h || 120;
    const x = Math.round((SW - w) / 2), y = Math.round((SH - h) / 2);
    for (let j = 0; j < h; j += 2)
      for (let i = 2; i < w + 2; i += 2) ctx.fillRect(x + i, y + j + 2, 1, 1);
    fill(x, y, w, h, "#fff");
    ctx.strokeStyle = "#000";
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.strokeRect(x + 3.5, y + 3.5, w - 7, h - 7);
    d._rect = { x: x, y: y, w: w, h: h };

    let ty = y + 22;
    for (let i = 0; i < d.lines.length; i++) {
      const l = d.lines[i];
      if (typeof l === "string") {
        drawText(l, x + 18, ty, "Geneva", 12);
        ty += 16;
      } else {
        drawText(l.t, x + (l.x || 18), ty, l.font || "Geneva", l.size || 12, !!l.bold);
        ty += l.gap || 16;
      }
    }

    if (d.buttons && d.buttons.length) {
      const bw = 64, bh = 20, gap = 16;
      const total = d.buttons.length * bw + (d.buttons.length - 1) * gap;
      let bx = x + Math.round((w - total) / 2);
      const by = y + h - 30;
      for (let i = 0; i < d.buttons.length; i++) {
        const b = d.buttons[i];
        fill(bx, by, bw, bh, "#fff");
        ctx.strokeStyle = "#000";
        ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        if (b.def) { ctx.strokeRect(bx + 2.5, by + 2.5, bw - 5, bh - 5); }
        drawText(b.label, bx + Math.round((bw - textWidth(b.label, "Chicago", 12)) / 2), by + 14, "Chicago", 12);
        b._rect = { x: bx, y: by, w: bw, h: bh };
        bx += bw + gap;
      }
    }
  }

  /* ---------------------------------------------------------------- *
   *  13. Commandes
   * ---------------------------------------------------------------- */
  const DOC_KEY = "colorpaint.doc";
  const ABOUT = Object.freeze({title:"MacTint",paragraphs:Object.freeze([
    "Un logiciel de dessin bitmap en seize couleurs, d’après MacPaint d’Apple (1984). Version non officielle.",
    "Chaque geste joue une note : la hauteur du pointeur donne la hauteur du son, l’outil choisit l’instrument, la couleur choisit la gamme.",
    "La musique ne vient que de vous. Sans geste, le silence.",
    "Designé et imaginé par Étienne Mineur.",
    "Novembre 2026."
  ])});

  function cmd(name) {
    menuOpen = -1;
    if (name.indexOf("fx:") === 0) { setTool(name.slice(3)); return; }
    if (name.indexOf("cyc:") === 0) { cycleCmd(name.slice(4)); return; }
    if (name === "live:fix") { liveFix(); return; }
    if (name === "live:pred") { FX.pred = !FX.pred; if (FX.pred) pushUndo(); uiSnd("choose", 0); fxKick(); render(); return; }
    if (name === "gif") { GD.on = true; render(); return; }
    if (name === "ramp") { RD.on = true; fxKick(); render(); return; }
    if (name === "bigui") {
      FX.bigUI = !FX.bigUI; fit();
      if (FX.bigUI && FX.bigGain === 1) {                          // la fenêtre est trop petite pour grossir : on le dit au lieu de ne rien faire
        FX.bigUI = false;
        openDialog({ w: 340, h: 130, lines: ["Big Interface", "", "This window is too small to enlarge", "the interface. Make it bigger, or go full screen."], buttons: [{ label: "OK", cmd: "close", def: true }] });
      }
      try { localStorage.setItem("colorpaint.bigui", FX.bigUI ? "1" : "0"); } catch (e) {}
      render(); return;
    }
    if (name.indexOf("layer:") === 0) { layerCmd(name.slice(6)); return; }
    if (name === "page:custom") { sizeOpen(); return; }
    if (name.indexOf("page:") === 0) { const q = PAGES[+name.slice(5)]; if (q[1] !== DW || q[2] !== DH) { pageResize(q[1], q[2]); zoomFit(); scheduleSave(); } render(); return; }
    if (name === "zoom:in") { zoomStep(1); return; } if (name === "zoom:out") { zoomStep(-1); return; } if (name === "zoom:fit") { zoomFit(); return; }
    if (name.indexOf("zoom:") === 0) { zoomSet(parseFloat(name.slice(5))); return; }
    if (name.indexOf("align:")===0) {alignment=name.slice(6);textRender();render();return;}
    if (name.indexOf("font:") === 0) { fontName = name.slice(5); textRender(); render(); return; }
    if (name.indexOf("size:") === 0) { fontSize = parseInt(name.slice(5), 10); textRender(); render(); return; }
    if (name.indexOf("style:") === 0) {
      style=name.slice(6);
      if(style==="plain") styles.clear();else if(styles.has(style))styles.delete(style);else styles.add(style);
      textRender();render();return;
    }

    switch (name) {
      case "about": {
        const lines=[{t:ABOUT.title,font:"Chicago",size:12,gap:24}];
        for(const paragraph of ABOUT.paragraphs){
          let line="";
          for(const word of paragraph.split(" ")){
            const next=line?line+" "+word:word;
            if(line&&textWidth(next,"Geneva",12)>410){lines.push({t:line,gap:16});line=word;}else line=next;
          }
          lines.push({t:line,gap:22});
        }
        openDialog({w:450,h:52+lines.reduce((n,l)=>n+l.gap,0),lines,
          buttons:[{label:"OK",cmd:"close",def:true}]});
        return;
      }

      case "closeDocument": textCommit();selCommit();saveLocal();documentOpen=false;helpPage=null;showPage=false;render();return;
      case "showpage": showPage=!showPage;render();return;
      case "sound": if (SND) SND.setEnabled(!SND.isEnabled()); menuOpen = -1; render(); return;
      case "intro": helpPage="intro";render();return;
      case "shortcuts": helpPage="shortcuts";render();return;
      case "catalog":
        openDialog({w:370,h:140,lines:["Print Catalog — web adaptation", "A browser cannot read a Macintosh disk", "catalog. Use Open… and Save… for PNG files."],buttons:[{label:"OK",cmd:"close",def:true}]});return;
      case "calculator":
        openDialog({ w: 300, h: 110, lines: ["The desk accessory calculator", "is not part of this replica."], buttons: [{ label: "OK", cmd: "close", def: true }] });
        return;

      case "new":
        if (!touchMode && !newConfirmed && typeof Studio !== "undefined" && Studio.traps && doc.some(function (v) { return v; })
            && Studio.traps.confirmNew(function () { newConfirmed = true; cmd("new"); newConfirmed = false; })) return;
        documentOpen=true;textCommit();helpPage=null;showPage=false;
        layersReset();
        textLayers.length = 0; selectedText = null; renderTextLayers();
        sel = null;
        view.x = view.y = 0;
        scheduleSave();
        cheer("new");
        render();
        return;

      case "open": {
        const f = document.getElementById("file");
        f.value = "";
        f.click();
        return;
      }

      case "close":
        closeDialog();
        return;

      case "saveAs":                                           // Save As : on choisit le format, image fixe ou GIF animé
        openDialog({
          w: 330, h: 130,
          lines: ["Save As", "", "PNG: a still image.", "GIF: an animation of everything that moves."],
          buttons: [{ label: "Cancel", cmd: "close" }, { label: "GIF...", cmd: "gif" }, { label: "PNG", cmd: "save", def: true }]
        });
        return;

      case "save": {
        const go = function () { exportPNG(); cheer("save"); };
        if (typeof Studio !== "undefined" && Studio.traps && !touchMode) Studio.traps.gate(go); else go();   // conditions générales aux niveaux 4 et 5
        return;
      }

      case "revert":
        if (loadLocal()) render();
        return;

      case "pagesetup":
        openDialog({
          w: 330, h: 130,
          lines: ["Page Setup", "", "Page: 8 × 10 inches, 576 × 720 pixels,", "72 dots per inch."],
          buttons: [{ label: "OK", cmd: "close", def: true }]
        });
        return;

      case "print": {
        const w = window.open("", "_blank");
        if (!w) return;
        syncDoc();
        const url = docCanvas.toDataURL("image/png");
        w.document.write('<title>MacTint</title><img src="' + url + '" style="image-rendering:pixelated;width:576px">');
        w.document.close();
        setTimeout(function () { w.focus(); w.print(); }, 300);
        return;
      }

      case "png":
      case "import": {
        const f = document.getElementById("file");
        f.value = "";
        f.click();
        return;
      }

      case "quit":
        openDialog({
          w: 330, h: 120,
          lines: ["Quit MacTint and return to the Desktop?", "", "The sheet is kept in the browser."],
          buttons: [{ label: "Annuler", cmd: "close" }, { label: "Quitter", cmd: "reallyquit", def: true }]
        });
        return;

      case "reallyquit":
        dialog = null;
        saveLocal();
        fill(0, 0, SW, SH, "#fff");
        ctx.fillStyle = "#000";
        drawText("Goodbye.", 224, 180, "Geneva", 12);
        return;

      case "undo": requestUndo(); return;
      case "copy": doCopy(); return;
      case "cut": doCut(); return;
      case "paste": doPaste(); return;

      case "clearSel":
        if (sel) {
          pushUndo();
          for (let j = 0; j < sel.h; j++)
            for (let i = 0; i < sel.w; i++)
              if (selContains(sel.x + i, sel.y + j)) doc[(sel.y + j) * DW + sel.x + i] = 0;
          sel.data = null;
          scheduleSave(); render();
        } else clearPage();                                      // sans sélection : toute la page est nettoyée
        return;

      case "invert":
        selApply(function (src) { for (let i = 0; i < src.length; i++) src[i] = PAL_INV[src[i]]; });
        return;

      case "fill":
        selApply(function (src, b) {
          for (let j = 0; j < b.h; j++)
            for (let i = 0; i < b.w; i++)
              src[j * b.w + i] = pat(b.x + i, b.y + j) ? ink : 0;
        });
        return;

      case "trace": {
        selApply(function (src, b) {
          const out = new Uint8Array(src.length);
          const at = function (i, j) { return (i >= 0 && j >= 0 && i < b.w && j < b.h) ? src[j * b.w + i] : 0; };
          for (let j = 0; j < b.h; j++)
            for (let i = 0; i < b.w; i++) {
              if (!src[j * b.w + i]) continue;
              if (!at(i - 1, j) || !at(i + 1, j) || !at(i, j - 1) || !at(i, j + 1)) out[j * b.w + i] = src[j * b.w + i];
            }
          src.set(out);
        });
        return;
      }

      case "fliph":
        selApply(function (src, b) {
          for (let j = 0; j < b.h; j++)
            for (let i = 0; i < b.w / 2; i++) {
              const a = j * b.w + i, c = j * b.w + (b.w - 1 - i);
              const t = src[a]; src[a] = src[c]; src[c] = t;
            }
        });
        return;

      case "flipv":
        selApply(function (src, b) {
          for (let j = 0; j < b.h / 2; j++)
            for (let i = 0; i < b.w; i++) {
              const a = j * b.w + i, c = (b.h - 1 - j) * b.w + i;
              const t = src[a]; src[a] = src[c]; src[c] = t;
            }
        });
        return;

      case "rotate": {
        const b = sel ? { x: sel.x, y: sel.y, w: sel.w, h: sel.h } : { x: 0, y: 0, w: DW, h: DH };
        pushUndo();
        const out = new Uint8Array(b.w * b.h);
        for (let j = 0; j < b.h; j++)
          for (let i = 0; i < b.w; i++) {
            const X = b.x + i, Y = b.y + j;
            const v = (X >= 0 && Y >= 0 && X < DW && Y < DH) ? doc[Y * DW + X] : 0;
            out[i * b.h + (b.h - 1 - j)] = v;
          }
        /* effacer l'ancienne zone, puis écrire la zone tournée */
        for (let j = 0; j < b.h; j++)
          for (let i = 0; i < b.w; i++) {
            const X = b.x + i, Y = b.y + j;
            if (X >= 0 && Y >= 0 && X < DW && Y < DH) doc[Y * DW + X] = 0;
          }
        const nw = b.h, nh = b.w;
        for (let j = 0; j < nh; j++)
          for (let i = 0; i < nw; i++) {
            const X = b.x + i, Y = b.y + j;
            if (X >= 0 && Y >= 0 && X < DW && Y < DH) doc[Y * DW + X] = out[j * nw + i];
          }
        if (sel) sel = { x: b.x, y: b.y, w: nw, h: nh, mask: null, data: null };
        scheduleSave(); render();
        return;
      }

      case "patinv":
        for (let i = 0; i < 64; i++) PAT[pattern][i] ^= 1;
        render();
        return;

      case "patclear":
        PAT[pattern].fill(0);
        render();
        return;

      case "fatbits": {
        const centre = screenToDoc(mouse.x, mouse.y);
        fatBits = !fatBits;
        zoom = fatBits ? 8 : 1; clampView();
        const v = viewWH();
        view.x = Math.max(0, Math.min(DW - v.w, centre.x - Math.floor(v.w / 2)));
        view.y = Math.max(0, Math.min(DH - v.h, centre.y - Math.floor(v.h / 2)));
        clampView();
        render();
        return;
      }

      case "grid":
        gridOn = !gridOn;
        render();
        return;

      case "mirrors":
        mirror = (mirror + 1) % 4;
        render();
        return;

      case "brushshape":
        openDialog(brushDialog());
        return;

      case "editpattern":
        openDialog(patternDialog());
        return;

      case "resetpatterns":
        for (let i = 0; i < PAT.length; i++) PAT[i].set(PAT_DEF[i]);
        render();
        return;
    }
  }

  /* Enregistrement : PNG RGBA à pixels strictement noir/blanc, 576 × 720. */
  function exportPNG() {
    textCommit();
    selCommit();
    syncDoc();
    docCanvas.toBlob(function (b) {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      a.download = "MacTint.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }, "image/png");
  }

  /* presse-papiers interne */
  function doCopy() {
    if (!sel) return;
    const b = selBounds();
    const d = new Uint8Array(b.w * b.h);
    for (let j = 0; j < b.h; j++)
      for (let i = 0; i < b.w; i++) {
        const X = b.x + i, Y = b.y + j;
        if (selContents(X, Y)) d[j * b.w + i] = doc[Y * DW + X];
      }
    clipboard = { w: b.w, h: b.h, data: d };
  }
  function selContents(X, Y) {
    if (!sel) return true;
    const i = X - sel.x, j = Y - sel.y;
    if (i < 0 || j < 0 || i >= sel.w || j >= sel.h) return false;
    return !sel.mask || sel.mask[j * sel.w + i] === 1;
  }
  function doCut() {
    doCopy();
    if (clipboard && sel) {
      pushUndo();
      for (let j = 0; j < sel.h; j++)
        for (let i = 0; i < sel.w; i++)
          if (selChars(i, j)) doc[(sel.y + j) * DW + sel.x + i] = 0;
      sel.data = null;
      scheduleSave(); render();
    }
  }
  function selChars(i, j) { return !sel.mask || sel.mask[j * sel.w + i] === 1; }
  function doPaste() {
    if (!clipboard) return;
    pushUndo();
    const x = Math.max(0, Math.min(DW - clipboard.w, sel ? sel.x : view.x + 8));
    const y = Math.max(0, Math.min(DH - clipboard.h, sel ? sel.y : view.y + 8));
    sel = { x: x, y: y, w: clipboard.w, h: clipboard.h, mask: null, data: clipboard.data.slice() };
    selCommit();
    scheduleSave(); render();
  }

  /* ---------------------------------------------------------------- *
   *  14. Dialogues secondaires
   * ---------------------------------------------------------------- */
  function brushDialog() {
    return {
      w: 320, h: 196,
      lines: [{ t: "Brush Shape", font: "Chicago", size: 12, bold: true, gap: 18 }],
      buttons: [{ label: "OK", cmd: "close", def: true }],
      brushes: true
    };
  }
  function patternDialog() {
    return {
      w: 372, h: 306,
      lines: [
        { t: "Edit Pattern", font: "Chicago", size: 12, bold: true, gap: 22 },
        { t: "Click a square, or pick a classic MacPaint pattern.", gap: 18 }
      ],
      buttons: [
        { label: "Invert", cmd: "patinv" },
        { label: "Clear", cmd: "patclear" },
        { label: "OK", cmd: "close", def: true }
      ],
      pattern: true
    };
  }

  /* ---------------------------------------------------------------- *
   *  15. Souris
   * ---------------------------------------------------------------- */
  function screenToDoc(x, y) {
    return { x: Math.floor(view.x + (x - VIEW.x) / zoom), y: Math.floor(view.y + (y - VIEW.y) / zoom) };
  }
  function inView(x, y) {
    return x >= VIEW.x && y >= VIEW.y && x < VIEW.x + VIEW.w && y < VIEW.y + VIEW.h;
  }

  let drag = null;
  let sprayTimer = null;

  function canvasPos(e) {
    const r = cv.getBoundingClientRect();
    if (APP.rot || APP.sc !== 1) {
      /* Fenêtre tournée ou redimensionnée (Nightmare!) : on ramène le clic dans le repère du
         canevas par la transformation inverse, autour du centre (qui est celui du cadre englobant). */
      const w = cv.offsetWidth, h = cv.offsetHeight, c = Math.cos(-APP.rot), n = Math.sin(-APP.rot);
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      rawPointer = { x: ((dx * c - dy * n) / APP.sc + w / 2) * SW / w, y: ((dx * n + dy * c) / APP.sc + h / 2) * SH / h };
    } else
    rawPointer = { x: (e.clientX - r.left) * SW / r.width, y: (e.clientY - r.top) * SH / r.height };
    return legoMap(rawPointer, e.type === "pointerdown");
  }

  cv.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  cv.addEventListener("pointerdown", function (e) {
    if (e.button === 2 || (e.button === 0 && e.ctrlKey)) {       // clic droit (ou Contrôle-clic) sur un pictogramme : ses réglages
      const busy = TO.on || CW.on || dialog || SZ.on || GD.on || RD.on, rp = canvasPos(e), t = busy ? null : toolCellAt(rp);
      if (t) { e.preventDefault(); toolOptsOpen(t); }
      else if (!busy) {                                          // clic droit sur une pastille : couleur d'arrivée du dégradé
        if (rp.y >= SWATCH.y - 1 && rp.x >= SWATCH.x - 1 && rp.x < SWATCH.x + 8 * SWATCH.w && rp.y < SWATCH.y + 2 * SWATCH.h) { e.preventDefault(); gradEnd(swatchAt(rp)); }
        else { const n = customAt(rp); if (n >= 0 && n < CUSTOM.length) { e.preventDefault(); gradEnd(CUSTOM0 + n); } }
      }
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const p = canvasPos(e);
    mouse.x = p.x; mouse.y = p.y;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { }

    if (RD.on) { rampClick(p); return; }
    if (GD.on) { gifClick(p); return; }
    if (SZ.on) { sizeClick(p); return; }
    if (TO.on) { toolOptsClick(p); return; }
    if (CW.on) { cwClick(p); return; }
    if (dialog) { dialogClick(p); return; }
    if (menuOpen < 0) {                      // une case tombée reste un outil : on la choisit, elle rentre
      const fallen = bodyAt(rawPointer);
      if (fallen) { setTool(fallen); bodies[fallen].until = 0; return; }
    }

    if (p.y < MENUBAR && p.x >= SW - 28 && fsCan()) { FS.want = true; menuOpen = -1; render(); return; }   // la case plein écran
    /* barre de menus */
    if (p.y < MENUBAR) {
      for (let i = 0; i < MENUS.length; i++) {
        if (p.x >= MENUS[i].x - 2 && p.x < MENUS[i].x + MENUS[i].w) {
          menuOpen = (menuOpen === i) ? -1 : i;menuHover=-1;menuTrack=menuOpen>=0;
          if (menuOpen >= 0) uiSnd("menu", i);
          render();
          return;
        }
      }
      menuOpen = -1; render();
      return;
    }
    if (menuOpen >= 0) {
      const L = MENUS[menuOpen]._layout;
      if (L && p.x >= L.x && p.x < L.x + L.w && p.y >= MENUBAR && p.y < MENUBAR + L.h) {
        for (let i = 0; i < L.items.length; i++) {
          const it = L.items[i];
          if (it._rect && p.y >= it._rect.y && p.y < it._rect.y + it._rect.h) {
            if (it.disabled) return;
            uiSnd("choose", i);
            cmd(it.cmd);
            return;
          }
        }
        return;
      }
      menuOpen = -1;
      render();
      return;
    }

    if (p.x >= 85 && p.x < 113 && p.y >= 305 + DY && p.y < 328 + DY) { gradCycle(); return; }   // l'échantillon : dégradé haut→bas, gauche→droite, en biais, rond, puis éteint
    if (p.y >= SWATCH.y - 1 && p.x >= SWATCH.x - 1 && p.x < SWATCH.x + 8 * SWATCH.w && p.y < SWATCH.y + 2 * SWATCH.h) { if (e.shiftKey) gradEnd(swatchAt(p)); else setInk(swatchAt(p)); return; }   // Majuscule-clic : l'autre couleur du dégradé
    { const k = gradAt(p); if (k >= 0) { gradChoose(k); return; } }
    { const n = customAt(p); if (n >= 0) { if (e.shiftKey && n < CUSTOM.length) gradEnd(CUSTOM0 + n); else customClick(n); return; } }
    if (Math.hypot(p.x - DIAL.x, p.y - DIAL.y) <= DIAL.r + 2) { dialSet(p); drag = { kind: "dial" }; return; }
    if (layersClick(p)) return;
    if (PALS.on) { const k = palAt(p); if (k) { setTool(k); return; } if (p.x >= SW - 57 - (PALS.n - 1) * 58 && p.y >= 27) return; }
    else if (p.x >= FXCELL.x && p.y >= FXCELL.y) { const k = fxCellAt(p); if (k) setTool(k); return; }
    if(p.x>=119&&p.x<499&&p.y>=299+DY&&p.y<333+DY) {
      const col=Math.floor((p.x-119)/20),row=p.y<317+DY?0:1;
      pattern=row*19+col;uiSnd("pattern",pattern);
      if(isDoublePat(pattern))cmd("editpattern");render();return;
    }
    if(p.x>=WBOX.x&&p.x<WBOX.x+WBOX.w&&p.y>=WBOX.top()&&p.y<WBOX.top()+WBOX.h){setPen(penAt(p.x));drag={kind:"penw"};return;}
    if(p.x>=15&&p.x<69&&p.y>=257+DY&&p.y<334+DY){if(p.y<273+DY){noOutline=true;uiSnd("width",-1);render();}else setPen(p.y<286+DY?1:p.y<298+DY?2:p.y<312+DY?4:8);return;}
    if(p.x>=85&&p.x<98&&p.y>=32&&p.y<45){cmd("closeDocument");return;}
    /* palette */
    if (p.x >= PAL_X && p.x < PAL_X + PAL_W && p.y >= PAL_Y && p.y < PAL_Y + PAL_H) { paletteClick(p); return; }

    /* barres de défilement */
    if(showPage) {showPage=false;render();return;}

    /* zone de dessin */
    if (!documentOpen)return;
    if (!inView(p.x, p.y)) return;
    const d = screenToDoc(p.x, p.y);
    if (d.x < 0 || d.y < 0 || d.x >= DW || d.y >= DH) {
      if (tool !== "marquee" && tool !== "lasso") return;
    }
    startTool(d, e);
    gestureSnd("down", p);
  });

  /* Molette : fait défiler la page ; avec Ctrl ou Cmd (ou un pincement au pavé tactile), zoome sur le pointeur. */
  let wheelAcc = 0;
  cv.addEventListener("wheel", function (e) {
    const p = canvasPos(e);
    if (!PALS.on && p.x >= FXCELL.x - 2 && p.y >= FXCELL.y && p.y < LPAN.y - 16 && !dialog) { e.preventDefault(); wheelAcc += e.deltaY; if (Math.abs(wheelAcc) > 30) { fxScroll(wheelAcc > 0 ? 1 : -1); wheelAcc = 0; } return; }
    if (p.x < WIN.x || p.y < WIN.y || p.x >= WIN.x + WIN.w || p.y >= WIN.y + WIN.h || dialog || SZ.on || TO.on || CW.on) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { wheelAcc += e.deltaY; if (Math.abs(wheelAcc) > 40) { zoomStep(wheelAcc < 0 ? 1 : -1, p.x, p.y); wheelAcc = 0; } return; }
    view.x += Math.round(e.deltaX / zoom); view.y += Math.round(e.deltaY / zoom); clampView(); render();
  }, { passive: false });
  cv.addEventListener("pointermove", function (e) {
    const p = canvasPos(e);
    mouse.x = p.x; mouse.y = p.y; mouse.in = true;
    if (drag) { headingFollow(e); moveTool(p, e); gestureSnd("move", p); if (ringTool()) render(); return; }
    if (ringTool() && !touchMode) render();                         // le curseur à la taille de l'outil suit le pointeur
    const over = cellAt(p);
    if ((over ? over.tool : null) !== hoverCell) {
      hoverCell = over ? over.tool : null;
      if (hoverCell && hoverCell !== tool && menuOpen < 0 && !dialog) {
        kickCell(hoverCell, -45, 0);
        moveSnd("hop");
        // Palier 4 : une fois sur trois, la case visée se sauve chez une voisine.
        if (legoLevel >= 4 && Math.random() < 0.33) { swapCells(hoverCell); hoverCell = null; }
      }
    }
    if (menuOpen >= 0) {
      /* survol : change de menu ouvert */
      if (p.y < MENUBAR) {
        for (let i = 0; i < MENUS.length; i++) {
          if (p.x >= MENUS[i].x - 2 && p.x < MENUS[i].x + MENUS[i].w && i !== menuOpen) {
            menuOpen = i;menuHover=-1;uiSnd("menu",i);render();return;
          }
        }
      }
      const L=MENUS[menuOpen]._layout;
      const index=L?L.items.findIndex(it=>it._rect&&p.x>=it._rect.x&&p.x<it._rect.x+it._rect.w&&p.y>=it._rect.y&&p.y<it._rect.y+it._rect.h):-1;
      if(index!==menuHover){menuHover=index;if(index>=0)uiSnd("item",index);render();}
    }
    if (fatBits) render();
  });

  cv.addEventListener("pointerup", function (e) {
    if(menuTrack){
      menuTrack=false;
      const item=menuOpen>=0&&MENUS[menuOpen]._layout&&MENUS[menuOpen]._layout.items[menuHover];
      if(item&&!item.disabled&&item.cmd){uiSnd("choose",menuHover);cmd(item.cmd);}
    }
    if (drag) { endTool(e); gestureSnd("up", mouse); }
  });
  cv.addEventListener("pointercancel", function (e) { if (drag) endTool(e); });
  cv.addEventListener("pointerleave", function () { if (mouse.in) { mouse.in = false; render(); } });

  /* Filet : si le relâchement a lieu hors de la toile (fenêtre quittée, capture
     de pointeur perdue), le glisser resterait ouvert et les outils sembleraient
     tous morts, pinceau compris. On ferme le glisser dès que le pointeur est
     relâché n'importe où, ou que la fenêtre perd le focus. */
  window.addEventListener("pointerup", function () { if (FS.want) { FS.want = false; fsToggle(); } if (drag) endTool(); });
  document.addEventListener("fullscreenchange", function () { render(); });
  document.addEventListener("webkitfullscreenchange", function () { render(); });
  window.addEventListener("pointercancel", function () { if (drag) endTool(); });
  window.addEventListener("blur", function () { if (drag) endTool(); });

  function paletteClick(p) {
    const cell=cellAt(p);
    if(cell){setTool(cell.tool);return;}
  }


  let fillShapes = false;              // formes pleines (double-clic sur l'outil)
  let lastPat = { i: -1, t: 0 };
  let lastTool = { i: -1, t: 0 };
  function isDoubleTool(i) {
    const now = Date.now();
    const dbl = lastTool.i === i && now - lastTool.t < 420;
    lastTool = { i: i, t: now };
    return dbl;
  }
  function isDoublePat(i) {
    const now = Date.now();
    const double = lastPat.i === i && now - lastPat.t < 420;
    lastPat = { i: i, t: now };
    return double;
  }

  function scrollClick(p) {
    const v = viewWH();
    const g = scrollGeom();
    if (p.x >= g.bx) {
      const page = Math.round(v.h * 0.9);
      if (p.y < g.trackY) view.y = Math.max(0, view.y - 16);
      else if (p.y >= g.by - 11) view.y = Math.min(DH - v.h, view.y + 16);
      else if (p.y >= g.ty && p.y < g.ty + g.thumbH) drag = { kind: "scrollY", y0: p.y, v0: view.y };
      else if (p.y < g.ty) view.y = Math.max(0, view.y - page);
      else view.y = Math.min(DH - v.h, view.y + page);
    } else {
      if (p.x < g.trackX) view.x = Math.max(0, view.x - 16);
      else if (p.x >= g.bx - 11) view.x = Math.min(DW - v.w, view.x + 16);
      else if (p.x >= g.tx && p.x < g.tx + g.thumbW) drag = { kind: "scrollX", x0: p.x, v0: view.x };
      else if (p.x < g.tx) view.x = Math.max(0, view.x - Math.round(v.w * 0.9));
      else view.x = Math.min(DW - v.w, view.x + Math.round(v.w * 0.9));
    }
    clampView();
    render();
  }


  /* ================================================================== *
   *  Outils bizarres. Quatre outils qui n'existaient pas en 1984 :
   *    cycle     pinceau dont l'encre ne sèche jamais (cycle de palette) ;
   *    dynamite  un bâton à mèche courte : le dessin vole en éclats ;
   *    acid      des gouttes qui tombent et dissolvent ce qu'elles touchent ;
   *    drip      de la peinture qui coule le long des formes.
   *  Tout vit dans le repère de la feuille. Une seule boucle (fxFrame)
   *  anime l'ensemble, et s'arrête dès qu'il n'y a plus rien de vivant.
   * ================================================================== */
  const FX = { raf: 0, last: 0, hasCycle: false, bombs: [], frags: [], rings: [], drops: [], bubbles: [], drips: [], balls: [], sky: [], wet: null, emit: 0,
    bigUI: (function () { try { return localStorage.getItem("colorpaint.bigui") === "1"; } catch (e) { return false; } })(),
    shards: [], coral: null, cbrush: null, cb: { rx: true, ry: false, rz: true, cyc: false }, ramp: [7, 8, 9, 0, 12, 13, 14, 15], rampHz: 10, useRamp: false,
    plants: [], sun: null, pokes: [], pm: { x: 0, y: 0, vx: 0, vy: 0 }, pred: false, eaten: 0, metal: [], hotAt: null, rails: null, spores: [], sprouts: [],
    live: [], grid: null, typing: null, storm: false, stormNext: 0, strobeUntil: 0, strobeMode: 0, strobeRect: null,
    wetAt: null, wetIdx: null, parts: [], grav: 0, moving: 0,
    scroll: 0, cycSpeed: 1, cycDir: 1, cycPause: false, cycT: 0, boil: false, thin: null, thinId: null, stroke: 0,
    wreck: [], plates: [], dough: [], blobs: [], hearts: [], pump: null, replay: null, reveal: 0, rec: [] };
  function fxSnd(kind, x, y, v) { if (FX.storm && (kind === "thud" || kind === "pop" || kind === "boom")) strobe(performance.now());
    if (touchMode || !SND || !SND.fx) return; try { SND.fx(kind, (x - view.x) * zoom / VIEW.w, (y - view.y) * zoom / VIEW.h, v); } catch (e) {} }
  function fxKick() { if (!FX.raf) FX.raf = requestAnimationFrame(fxFrame); }
  function fxFrame(t) {
    FX.raf = 0;
    const dt = Math.min(0.05, FX.last ? (t - FX.last) / 1000 : 1 / 60);
    FX.last = t;
    cycleTick(t);
    const live = fxStep(t, dt);
    if (FX.gif) {
      renderNow();
      if (t >= FX.gif.next) { FX.gif.next = t + 80; FX.gif.frames.push(gifGrab(FX.gif.scale)); }
      if (t >= FX.gif.until) { const g = FX.gif; FX.gif = null; gifSave(g.frames, g.frames.map(() => 8), g.scale); renderNow(); }
      fxKick(); return;
    }
    if (live || FX.hasCycle) { renderNow(); fxKick(); } else { FX.last = 0; if (FX.wet) FX.wet = null; renderNow(); }
  }
  const fxBox = () => { const v = viewWH(); return { x0: view.x, y0: view.y, x1: Math.min(DW, view.x + v.w), y1: Math.min(DH, view.y + v.h) }; };

  /* ---- Color Cycling : cinq rampes de huit couleurs, choisies par la couleur courante.
     Le point reçoit un numéro de case ; c'est la palette qui tourne, pas le dessin
     (comme les cascades des jeux d'aventure et Deluxe Paint sur Amiga). */
  const RAMPS = [
    { c: [7, 8, 9, 8, 7, 6, 7, 8], hz: 18 },        // feu       (rouge, orange, jaune, brun, beige)
    { c: [13, 13, 12, 0, 12, 13, 14, 13], hz: 10 }, // eau       (bleu, cyan)
    { c: [11, 11, 10, 9, 10, 11, 10, 10], hz: 8 },  // sève      (verts)
    { c: [15, 14, 13, 14, 15, 0, 15, 14], hz: 6 },  // néon      (magenta, violet)
    { c: [7, 8, 9, 10, 12, 13, 14, 15], hz: 14 }    // arc-en-ciel (noir, gris, blanc)
  ];
  const rampFor = i => [5, 6, 7, 8, 9].includes(i) ? 0 : (i === 12 || i === 13) ? 1 : (i === 10 || i === 11) ? 2 : (i === 14 || i === 15) ? 3 : 4;
  const GLINT = [0, 2, 3, 4, 0, 9, 5, 8, 9, 0, 9, 10, 0, 12, 15, 0];              // la couleur du reflet de chaque couleur
  function cycleTick(t) {
    if (!FX.cycPause) FX.cycT += (FX.cycLast ? Math.min(100, t - FX.cycLast) : 0) * FX.cycSpeed * FX.cycDir;
    FX.cycLast = t;
    const T = FX.cycT;
    for (let r = 0; r < RAMPS.length; r++) {
      const ph = Math.floor(T / 1000 * RAMPS[r].hz);
      for (let k = 0; k < 8; k++) PAL32[16 + r * 8 + k] = PAL32[RAMPS[r].c[(((k - ph) % 8) + 8) % 8]];
    }
    const cp = Math.floor(T / 1000 * FX.rampHz);                  // la rampe de l'éditeur
    for (let k = 0; k < 8; k++) PAL32[184 + k] = PAL32[FX.ramp[(((k - cp) % 8) + 8) % 8]];
    const g = Math.floor(T / 1000 * 9);                           // reflets : une case sur huit prend la couleur du reflet
    for (let c = 1; c < 16; c++) for (let k = 0; k < 8; k++) PAL32[56 + c * 8 + k] = PAL32[((((k - g) % 8) + 8) % 8) === 0 ? GLINT[c] : c];
  }
  cycleTick(0);
  function cycleDab(x, y, len) {
    const bandW = TK("bands", [1, 2, 6], "cycle");
    const R = LW(), base = FX.useRamp ? 184 : 16 + rampFor(ink) * 8;
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      if (i * i + j * j > R * R + 1) continue;
      const X = x + i, Y = y + j;
      if (X < 0 || Y < 0 || X >= DW || Y >= DH || (sel && !inSel(X, Y))) continue;
      doc[Y * DW + X] = !pat(X, Y) ? 0 : base + (((Math.floor((len + i + j) / bandW)) % 8 + 8) % 8);   // les cases se suivent le long du trait : la couleur y court
    }
  }


  /* ---- Pinceau vivant. Il décide lui-même, au fil du trait : son épaisseur ondule du
     trait de plume à la brosse énorme ; par tronçons il passe d'une couleur unie à un
     arc-en-ciel qui court le long du trait, à un ruban arc-en-ciel (les bandes suivent
     le geste, comme un arc), ou à une trame tirée au hasard ; et il sème des étoiles,
     des ronds, des triangles, des carrés et de petits arcs-en-ciel qui se superposent. */
  const RAINBOW = [7, 8, 9, 10, 12, 13, 14];
  const WILD_MAX = 44;
  /* wp() dépose de la peinture : comme le pinceau, elle passe par la trame choisie (les blancs de
     la trame donnent du papier). wr() remet des points existants tels quels (éclats, tampons). */
  function wp(X, Y, c) { if (X >= 0 && Y >= 0 && X < DW && Y < DH && (!sel || inSel(X, Y))) doc[Y * DW + X] = c && !pat(X, Y) ? 0 : GRAD.on && c === ink ? gradInk(X, Y) : c; }
  function wr(X, Y, c) { if (X >= 0 && Y >= 0 && X < DW && Y < DH && (!sel || inSel(X, Y))) doc[Y * DW + X] = c; }
  function wildMode(w) {
    const r = Math.random();
    w.mode = !topt("rainbow", "wild") ? (r < 0.6 ? "solid" : "pattern") : r < 0.22 ? "solid" : r < 0.48 ? "along" : r < 0.8 ? "ribbon" : "pattern";
    w.color = ink || 1;                                          // toujours la couleur choisie
    w.pat = 1 + Math.floor(Math.random() * (PAT.length - 1));
    w.lambda = (18 + Math.random() * 70) * TK("wobble", [3, 1, 0.3], "wild");                          // longueur d'onde de l'épaisseur
    w.until = w.len + 50 + Math.random() * 130;
    fxSnd("mode", w.x, w.y);
  }
  function wildDab(w, x, y) {
    const k = 0.5 + 0.5 * Math.sin(w.len / w.lambda + w.phase);
    const d = 1 + Math.pow(k, 2.4) * (Math.max(3, PW()) - 1), r = d / 2, R = Math.ceil(r);   // ondule de 1 point à l'épaisseur courante
    w.size = d;
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      if (i * i + j * j > r * r + 0.5) continue;
      const X = x + i, Y = y + j;
      let c = w.color;
      if (w.mode === "along") c = RAINBOW[Math.floor(w.len / 7) % 7];
      else if (w.mode === "ribbon") c = RAINBOW[Math.max(0, Math.min(6, Math.floor(((i * w.nx + j * w.ny) / (r + 0.5) + 1) * 3.5)))];
      else if (w.mode === "pattern" && !PAT[w.pat][(Y & 7) * 8 + (X & 7)]) continue;   // les blancs de la trame restent à jour
      wp(X, Y, c);
    }
  }
  function wildStamp(w, x, y) {
    const kind = ["star", "disc", "ring", "tri", "square", "bow"][Math.floor(Math.random() * 6)];
    const R = 5 + Math.floor(Math.random() * Math.random() * 30), c = ink || 1, a0 = Math.random() * Math.PI * 2;
    const usePat = Math.random() < 0.3 ? PAT[1 + Math.floor(Math.random() * (PAT.length - 1))] : null;
    const put = (X, Y, col) => { if (!usePat || usePat[(Y & 7) * 8 + (X & 7)]) wp(X, Y, col); };
    let poly = null;
    if (kind === "star") { poly = []; for (let k = 0; k < 10; k++) { const a = a0 + k * Math.PI / 5, q = k & 1 ? R * 0.42 : R; poly.push([Math.cos(a) * q, Math.sin(a) * q]); } }
    if (kind === "tri") { poly = []; for (let k = 0; k < 3; k++) { const a = a0 + k * Math.PI * 2 / 3; poly.push([Math.cos(a) * R, Math.sin(a) * R]); } }
    const inPoly = (px, py) => { let s = false; for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) { const A = poly[a], B = poly[b]; if ((A[1] > py) !== (B[1] > py) && px < (B[0] - A[0]) * (py - A[1]) / (B[1] - A[1]) + A[0]) s = !s; } return s; };
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      const d = Math.hypot(i, j);
      if (poly) { if (inPoly(i + 0.5, j + 0.5)) put(x + i, y + j, c); }
      else if (kind === "disc") { if (d <= R) put(x + i, y + j, c); }
      else if (kind === "ring") { if (d <= R && d >= R - Math.max(1.5, R / 4)) put(x + i, y + j, c); }
      else if (kind === "square") { if (Math.max(Math.abs(i), Math.abs(j)) <= R * 0.75) put(x + i, y + j, c); }
      else if (j <= 0 && d <= R && d >= R * 0.45) wp(x + i, y + j, RAINBOW[Math.min(6, Math.floor((R - d) / (R * 0.55) * 7))]);   // petit arc-en-ciel
    }
    fxSnd("stamp", x, y);
  }
  function wildStart(d) {
    const w = drag.w = { len: 0, phase: Math.random() * 6.28, nx: 0, ny: 1, x: d.x, y: d.y, next: 20 + Math.random() * 40 };
    wildMode(w); wildDab(w, d.x, d.y);
  }
  function wildMove(d) {
    const w = drag.w, a = drag.last, dx = d.x - a.x, dy = d.y - a.y, n = Math.max(Math.abs(dx), Math.abs(dy));
    if (!n) return;
    const L = Math.hypot(dx, dy);
    w.nx += (-dy / L - w.nx) * 0.35; w.ny += (dx / L - w.ny) * 0.35;   // normale au geste, lissée : le ruban tourne avec lui
    for (let k = 1; k <= n; k++) {
      w.len++;
      const x = Math.round(a.x + dx * k / n), y = Math.round(a.y + dy * k / n);
      w.x = x; w.y = y;
      if (w.len > w.until) wildMode(w);
      if (w.len % Math.max(1, Math.floor((w.size || 1) / 5)) === 0) wildDab(w, x, y);
      if (w.len > w.next) {
        w.next = w.len + (22 + Math.random() * 60) * TK("rate", [2.6, 1, 0.35], "wild");
        if (topt("stamps", "wild")) wildStamp(w, x + Math.round((Math.random() - 0.5) * 50), y + Math.round((Math.random() - 0.5) * 50));
      }
    }
    render();
  }


  /* ---- Typo vivante. On clique, on tape : chaque lettre tire au sort sa police, son corps,
     son style, sa couleur et son humeur (ombre, écho arc-en-ciel, boîte inversée, encre
     animée, trame, tête en bas, miroir). Les lettres sont peintes directement dans la
     feuille ; la touche Retour arrière rend à la feuille ce que la dernière lettre couvrait. */
  const LT = { on: false, x: 0, y: 0, x0: 0, lineH: 16, hist: [], n: 0 };
  const LT_SIZES = [9, 12, 14, 18, 18, 24, 24, 24, 36, 36, 36, 48, 48, 72, 72, 96];
  function liveStart(d) { pushUndo(); LT.on = true; LT.x = LT.x0 = d.x; LT.y = d.y; LT.lineH = 16; LT.hist = []; fxKick(); render(); }
  function liveSnd(kind, ch, size) { if (touchMode || !SND || !SND.typing) return; try { SND.typing(kind, ch, size, (LT.x - view.x) * zoom / VIEW.w, (LT.y - view.y) * zoom / VIEW.h); } catch (e) {} }
  function liveNewline() { LT.x = LT.x0 + Math.round((Math.random() - 0.5) * 16); LT.y += LT.lineH + Math.round(Math.random() * 6); LT.lineH = 16; const bx = fxBox(); if (LT.y > bx.y1 - 6) LT.y = bx.y0 + 30; }   // en bas de la fenêtre, on repart du haut, par-dessus
  function liveChar(ch) {
    if (ch === " ") { LT.hist.push({ x: LT.x, y: LT.y, lineH: LT.lineH }); LT.x += 5 + Math.round(Math.random() * 16); liveSnd("space", ch, 0); render(); return; }
    if (Math.random() < 0.12) ch = ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
    /* Cairo, Taliesin et Symbol remplacent les lettres par des dessins ou des signes : une surprise
       rare (une frappe sur quatorze), pour que le texte reste lisible. */
    const odd = ["Cairo", "Taliesin", "Symbol"], pool = FONTS.filter(f => (Math.random() < 0.07) === odd.includes(f.name));
    const font = (pool.length ? pool : FONTS)[Math.floor(Math.random() * (pool.length || FONTS.length))].name, sizes = TK("sizes", [[9, 12, 12, 14, 18], LT_SIZES, [36, 48, 48, 72, 72, 96]], "type"), size = snapType(Math.max(9, Math.min(480, sizes[Math.floor(Math.random() * sizes.length)] * PW() / 4)));   // l'épaisseur grossit ou réduit toute la gamme de corps
    const b = textBmp(ch, font, size, Math.random() < 0.3, Math.random() < 0.25);
    const box = fxBox();
    if (LT.x + b.adv > Math.min(DW - 2, box.x1 - 2)) liveNewline();
    const plain = !topt("moods", "type"), flip = !plain && Math.random() < 0.06, mirror = !plain && Math.random() < 0.05;
    const r = plain ? 0 : Math.random(), mood = r < 0.46 ? "solid" : r < 0.6 ? "rainbow" : r < 0.72 ? "cycle" : r < 0.82 ? "pattern" : r < 0.91 ? "box" : "echo";
    const shadow = mood === "solid" && Math.random() < 0.3;
    const c = ink || 1, c2 = 1 + Math.floor(Math.random() * 15);   // la lettre prend la couleur choisie
    const pt = PAT[1 + Math.floor(Math.random() * (PAT.length - 1))], ramp = 16 + Math.floor(Math.random() * 5) * 8;
    const x0 = LT.x - b.pad, y0 = Math.max(box.y0 + 1, LT.y - b.asc + Math.round((Math.random() - 0.5) * size * 0.35));   // jamais au-dessus de la fenêtre
    /* ce que la lettre va couvrir, pour pouvoir l'effacer */
    const m = 8, rx = Math.max(0, x0 - m), ry = Math.max(0, y0 - m), rw = Math.min(DW, x0 + b.w + m) - rx, rh = Math.min(DH, y0 + b.h + m) - ry;
    const h = { x: LT.x, y: LT.y, lineH: LT.lineH };
    if (rw > 0 && rh > 0) { h.rx = rx; h.ry = ry; h.rw = rw; h.rh = rh; h.data = new Uint8Array(rw * rh); for (let j = 0; j < rh; j++) h.data.set(doc.subarray((ry + j) * DW + rx, (ry + j) * DW + rx + rw), j * rw); }
    LT.hist.push(h);
    if (LT.hist.length > 400) LT.hist.shift();
    const bit = (i, j) => b.bits[(flip ? b.h - 1 - j : j) * b.w + (mirror ? b.w - 1 - i : i)];
    const glyph = (dx, dy, col) => { for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) if (bit(i, j)) wp(x0 + i + dx, y0 + j + dy, typeof col === "function" ? col(i, j) : col); };
    if (mood === "box") { for (let j = -2; j < b.h + 2; j++) for (let i = -2; i < b.w + 2; i++) wp(x0 + i, y0 + j, c); glyph(0, 0, c === 9 || c === 4 ? 1 : 0); }
    else if (mood === "echo") { for (let k = 4; k >= 1; k--) glyph(k * 2, k * 2, RAINBOW[(k + LT.n) % 7]); glyph(0, 0, 1); }
    else {
      if (shadow) { const o = Math.max(1, Math.round(size / 14)); glyph(o, o, c === 1 ? 3 : 1); }
      glyph(0, 0, mood === "rainbow" ? (i, j) => RAINBOW[Math.floor(j / Math.max(1, b.h / 7)) % 7]
        : mood === "cycle" ? (i, j) => ramp + (((i + j) >> 1) & 7)
        : mood === "pattern" ? (i, j) => pt[((y0 + j) & 7) * 8 + ((x0 + i) & 7)] ? c : c2
        : c);
    }
    LT.n++;
    LT.x += b.adv + Math.round(Math.random() * 3 - 1);
    LT.lineH = Math.max(LT.lineH, Math.round(b.lineHeight * 0.8));
    liveSnd("char", ch, size);
    scheduleSave(); render();
  }
  function liveKey(e) {
    if (e.key === "Escape") { LT.on = false; render(); return true; }
    if (e.key === "Enter") { LT.hist.push({ x: LT.x, y: LT.y, lineH: LT.lineH }); liveNewline(); liveSnd("enter", "", 0); render(); return true; }
    if (e.key === "Backspace") {
      const h = LT.hist.pop();
      if (h) { if (h.data) for (let j = 0; j < h.rh; j++) doc.set(h.data.subarray(j * h.rw, (j + 1) * h.rw), (h.ry + j) * DW + h.rx); LT.x = h.x; LT.y = h.y; LT.lineH = h.lineH; scheduleSave(); }
      liveSnd("back", "", 0); render(); return true;
    }
    if (e.key.length === 1) { liveChar(e.key); return true; }
    return false;
  }


  /* ================================================================== *
   *  Pinceaux loufoques (premier lot). Tous écrivent dans la feuille par wp().
   * ================================================================== */
  function bline(x0, y0, x1, y1, c, w) {                          // Bresenham, sans lissage
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0; w = w || 1;
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy, guard = 4000;
    for (;;) {
      if (w === 1) wp(x0, y0, c); else for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) wp(x0 + i - (w >> 1), y0 + j - (w >> 1), c);
      if ((x0 === x1 && y0 === y1) || !--guard) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
  function blob(x, y, r, c) {                                     // tache au bord irrégulier
    const n = 10, k = []; for (let i = 0; i < n; i++) k.push(0.7 + Math.random() * 0.5);
    const R = Math.ceil(r * 1.2);
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      const a = (Math.atan2(j, i) / (Math.PI * 2) + 0.5) * n, a0 = Math.floor(a) % n, f = a - Math.floor(a);
      if (Math.hypot(i, j) <= r * (k[a0] * (1 - f) + k[(a0 + 1) % n] * f)) wp(x + i, y + j, c);
    }
  }
  /* Stylo qui fuit : un trait net tant que la main file ; quand elle ralentit franchement, l'encre s'accumule et tache.
     Le débit se compte en temps (pas en mouvements reçus) : souris et tablette donnent le même rythme. */
  const leakyBase = () => 1.5 + PW() * 0.6;                       // la plus petite tache, à l'échelle du trait
  function leakyMove(a, d, sp) {
    bline(a.x, a.y, d.x, d.y, ink, PW());
    const now = performance.now(), el = now - (drag.lt || now), dt = Math.min(50, el); drag.lt = now;
    drag.pool = 0;                                                // la main repart : la prochaine pause regonfle depuis zéro
    if (el > 0) drag.lv = (drag.lv === undefined ? sp : drag.lv) + (Math.hypot(d.x - a.x, d.y - a.y) / el - (drag.lv === undefined ? sp : drag.lv)) * 0.4;   // vitesse mesurée entre deux points réellement tracés
    const slow = Math.max(0, 1 - (drag.lv === undefined ? sp : drag.lv) / 0.12);                      // 0 au-dessus de 120 points par seconde
    drag.leak = (drag.leak || 0) + slow * dt / 1000 * 5 * TK("leak", [0.3, 1, 3], "leaky");
    if (drag.leak > 1) { drag.leak = 0; leakyBlot(d.x, d.y, leakyBase() + Math.random() * (1.5 + PW() * 0.9) * (0.4 + 0.6 * slow)); }
  }
  function leakyEnd(dr) {                                         // la plume quitte le papier : une petite goutte
    if (dr.len0 && Math.hypot(dr.d.x - dr.len0.x, dr.d.y - dr.len0.y) > 6 && !dr.pool) { leakyBlot(dr.d.x, dr.d.y, leakyBase() * (0.8 + Math.random() * 0.5)); render(); }
  }
  function leakyBlot(x, y, r) {
    blob(x, y, r, ink);
    for (let i = 0; i < r / 2 && topt("splash", "leaky"); i++) { const a = Math.random() * 6.28, q = r * (1.3 + Math.random() * 1.6); blob(Math.round(x + Math.cos(a) * q), Math.round(y + Math.sin(a) * q), 0.6 + Math.random() * r / 5, ink); }
    fxSnd("blot", x, y);
  }
  /* Frizzy : des poils électriques, brisés, tout autour du trait. */
  function frizzyMove(a, d) {
    bline(a.x, a.y, d.x, d.y, ink, PW());
    const n = Math.max(1, Math.hypot(d.x - a.x, d.y - a.y) / 2) * TK("dens", [0.35, 1, 2.6], "frizzy"), hl = TK("len", [0.5, 1, 2.4], "frizzy");
    for (let i = 0; i < n; i++) {
      let x = a.x + (d.x - a.x) * Math.random(), y = a.y + (d.y - a.y) * Math.random(), an = Math.random() * 6.28;
      for (let k = 0, m = 2 + Math.floor(Math.random() * 4); k < m; k++) {
        const L = (2 + Math.random() * 6) * hl, nx = x + Math.cos(an) * L, ny = y + Math.sin(an) * L;
        bline(x, y, nx, ny, ink, 1); x = nx; y = ny; an += (Math.random() - 0.5) * 2.4;
      }
    }
    if (Math.random() < 0.3) fxSnd("zap", d.x, d.y);
  }
  /* Arbre : tant que la souris monte, le tronc pousse et lance des branches fractales. */
  function branch(x, y, an, len, depth) {
    const nx = x + Math.cos(an) * len, ny = y + Math.sin(an) * len;
    bline(x, y, nx, ny, ink, Math.max(1, Math.round(PW() * (depth > 2 ? 0.6 : 0.3))));
    if (depth <= 0 || len < 3) { if (!topt("leaves", "tree")) return; const leaf = ink === 10 ? 15 : 10; wp(nx | 0, ny | 0, leaf); wp((nx | 0) + 1, ny | 0, leaf); wp(nx | 0, (ny | 0) - 1, leaf); wp((nx | 0) - 1, ny | 0, leaf); return; }
    const spread = 0.35 + Math.random() * 0.4;
    branch(nx, ny, an - spread, len * (0.6 + Math.random() * 0.2), depth - 1);
    branch(nx, ny, an + spread * (0.7 + Math.random() * 0.6), len * (0.6 + Math.random() * 0.2), depth - 1);
  }
  function treeMove(a, d) {
    bline(a.x, a.y, d.x, d.y, ink, PW());
    if (d.y < a.y) {
      drag.climb = (drag.climb || 0) + (a.y - d.y);
      if (drag.climb > (drag.nextBranch || 12)) {
        drag.nextBranch = drag.climb + (9 + Math.random() * 14) * TK("branch", [2.4, 1, 0.4], "tree"); drag.side = -(drag.side || 1);
        branch(d.x, d.y, -Math.PI / 2 + drag.side * (0.6 + Math.random() * 0.5), 8 + Math.min(26, drag.climb / 5), TK("depth", [2, 4, 6], "tree"));
        fxSnd("branch", d.x, d.y);
      }
    }
  }
  /* Alphabet : le trait est une suite de lettres, dans la police et le corps du menu. */
  /* Corps de lettre le plus proche d'une taille voulue, parmi les agrandissements entiers des corps d'origine (lettres nettes). */
  function snapType(target) {
    let best = 12, gap = 1e9;
    for (const b of [9, 12, 14, 18, 24]) { const m = Math.max(1, Math.round(target / b)), g = Math.abs(b * m - target); if (g < gap) { gap = g; best = b * m; } }
    return best;
  }
  const alphaSize = () => snapType(Math.max(9, Math.min(480, PW() * 4)));   // l'épaisseur donne la hauteur des lettres : quatre fois l'épaisseur
  function alphaMove(a, d) {
    drag.acc = (drag.acc || 0) + Math.hypot(d.x - a.x, d.y - a.y);
    if (drag.acc < (drag.adv || 0)) return;
    const set = topt("chars", "alpha"), ch = String.fromCharCode([65, 97, 48][set] + (drag.letter = ((drag.letter === undefined ? -1 : drag.letter) + 1) % (set === 2 ? 10 : 26)));
    const size = alphaSize(), b = textBmp(ch, fontName, size, styles.has("bold"), styles.has("italic"));
    for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) if (b.bits[j * b.w + i]) wp(d.x - (b.w >> 1) + i, d.y - (b.asc >> 1) + j, ink);
    drag.acc = 0; drag.adv = (Math.max(b.adv, b.asc * 0.8) + 1) * TK("gap", [0.7, 1, 1.9], "alpha");
    if (SND && SND.typing && !touchMode) try { SND.typing("char", ch, Math.min(96, size), (d.x - view.x) * zoom / VIEW.w, (d.y - view.y) * zoom / VIEW.h); } catch (e) {}
  }
  /* Toile d'araignée : le curseur se relie aux points de la même couleur à moins de 40 points. */
  function webMove(a, d) {
    bline(a.x, a.y, d.x, d.y, ink, PW());
    let made = 0;
    for (let t = 0; t < 90 && made < TK("threads", [1, 2, 4], "web"); t++) {
      const an = Math.random() * 6.28, q = (12 + Math.random() * 28) * TK("reach", [0.5, 1, 2.6], "web"), X = Math.round(d.x + Math.cos(an) * q), Y = Math.round(d.y + Math.sin(an) * q);
      if (X < 0 || Y < 0 || X >= DW || Y >= DH || doc[Y * DW + X] !== ink) continue;
            bline(d.x, d.y, X, Y, ink, 1); made++;
    }
    if (made) fxSnd("web", d.x, d.y);
  }
  /* Dentifrice : un boudin en relief, liseré noir, deux rayures qui s'enroulent, une ombre. */
  function pasteMove(a, d) {
    const dx = d.x - a.x, dy = d.y - a.y, L = Math.hypot(dx, dy) || 1, w = drag;
    w.nx = (w.nx === undefined ? -dy / L : w.nx + (-dy / L - w.nx) * 0.4); w.ny = (w.ny === undefined ? dx / L : w.ny + (dx / L - w.ny) * 0.4);
    const R = LW(), stripe = ink === 0 || ink === 4 ? 7 : ink, n = Math.max(1, Math.ceil(L / 2));
    for (let k = 1; k <= n; k++) {
      const x = Math.round(a.x + dx * k / n), y = Math.round(a.y + dy * k / n);
      w.len = (w.len || 0) + L / n;
      const tw = Math.sin(w.len / 9 * TK("twist", [0.35, 1, 2.8], "paste")) * 0.35;
      for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
        const dd = i * i + j * j; if (dd > R * R) continue;
        const sgn = (i * w.nx + j * w.ny) / R, t = sgn + tw;
        /* la couleur ne dépend que de la position en travers du boudin : repasser ne salit rien */
        wp(x + i, y + j, Math.abs(sgn) > 0.8 ? 1 : sgn > 0.5 ? 4 : (t > -0.5 && t < -0.15) ? stripe : (t > 0.1 && t < 0.4) ? 12 : 0);
      }
    }
    if (Math.random() < 0.15) fxSnd("squirt", d.x, d.y);
  }
  /* Tuyau d'arrosage d'images : la direction du geste choisit le motif (droite : feuilles,
     gauche : cailloux, haut : yeux, bas : pièces), la vitesse sa taille, le hasard le reste. */
  function hoseSprite(kind, x, y, s, an) {
    const disc = (cx, cy, r, c) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r + 1) wp(cx + i, cy + j, c); };
    if (kind === "eye") { disc(x, y, s + 1, 1); disc(x, y, s, 0); const px = Math.round(x + Math.cos(an) * s * 0.4), py = Math.round(y + Math.sin(an) * s * 0.4); disc(px, py, Math.max(1, s >> 1), ink > 1 ? ink : 12); disc(px, py, Math.max(0, (s >> 2)), 1); }
    else if (kind === "coin") { disc(x, y, s + 1, 6); disc(x, y, s, 8); disc(x, y, s - 1, ink > 1 ? ink : 9); for (let k = -s + 2; k <= s - 2; k++) wp(x, y + k, 8); wp(x - (s >> 1), y - (s >> 1), 0); }
    else if (kind === "pebble") { const c = ink > 1 ? ink : [3, 4, 2, 5][Math.floor(Math.random() * 4)]; blob(x, y, s + 1.5, 1); blob(x, y, s, c); wp(x - (s >> 1), y - (s >> 1), 0); wp(x - (s >> 1) + 1, y - (s >> 1), 0); }
    else {                                                       // feuille : amande orientée, nervure
      const c = ink > 1 ? ink : [8, 9, 7, 5, 10][Math.floor(Math.random() * 5)], ca = Math.cos(an), sa = Math.sin(an), R = s * 2;
      for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { const u = i * ca + j * sa, v = -i * sa + j * ca, lim = (1 - (u / R) * (u / R)) * s * 0.6; if (Math.abs(u) <= R && Math.abs(v) <= lim) wp(x + i, y + j, Math.abs(v) > lim - 1 ? 6 : c); }
      bline(Math.round(x - ca * R), Math.round(y - sa * R), Math.round(x + ca * (R + 2)), Math.round(y + sa * (R + 2)), 6, 1);
    }
  }
  function hoseMove(a, d, sp) {
    drag.acc = (drag.acc || 0) + Math.hypot(d.x - a.x, d.y - a.y);
    if (drag.acc < 9 * TK("gap", [0.5, 1, 2.4], "hose")) return;
    drag.acc = 0;
    const an = Math.atan2(d.y - a.y, d.x - a.x), q = Math.abs(Math.cos(an)) > Math.abs(Math.sin(an)) ? (Math.cos(an) > 0 ? "leaf" : "pebble") : (Math.sin(an) < 0 ? "eye" : "coin");
    const pick = topt("motif", "hose"), kind = pick ? ["leaf", "pebble", "eye", "coin"][pick - 1] : Math.random() < 0.12 ? ["leaf", "pebble", "eye", "coin"][Math.floor(Math.random() * 4)] : q;
    hoseSprite(kind, d.x + Math.round((Math.random() - 0.5) * 16), d.y + Math.round((Math.random() - 0.5) * 16), Math.max(1, Math.min(60, Math.round((2 + Math.min(5, sp * 3) + Math.random() * 2) * PW() / 8))), an + (Math.random() - 0.5));
    fxSnd("spit", d.x, d.y);
  }
  /* Sphères volantes : des billes lancées avec l'élan de la main. Chacune a sa gravité, son
     rebond et sa façon de laisser une trace ; chaque ricochet contre un bord est une note. */
  function ballThrow(d, vx, vy) {
    if (FX.balls.length >= 28) FX.balls.shift();
    FX.balls.push({ x: d.x, y: d.y, px: d.x, py: d.y, vx: vx + (Math.random() - 0.5) * 60, vy: vy + (Math.random() - 0.5) * 60,
      g: topt("grav", "balls") ? [0, 0, 620, -180][topt("grav", "balls")] : [0, 260, 620, -180][Math.floor(Math.random() * 4)], e: TK("bounce", [0.45, 0.72 + Math.random() * 0.27, 0.99], "balls"), r: Math.max(1, Math.min(60, Math.round(PW() / 2))),
      c: ink || 1, trail: topt("trail", "balls") ? topt("trail", "balls") - 1 : Math.floor(Math.random() * 4), hits: 0, n: 0, life: (4 + Math.random() * 4) * TK("life", [0.4, 1, 3], "balls") });
  }
  function ballsStep(dt, box) {
    for (const b of FX.balls) {
      b.life -= dt; b.vy += b.g * dt; b.px = b.x; b.py = b.y; b.x += b.vx * dt; b.y += b.vy * dt; b.n++;
      let hit = false;
      if (b.x < box.x0 + b.r) { b.x = box.x0 + b.r; b.vx = -b.vx * b.e; hit = true; }
      if (b.x > box.x1 - b.r - 1) { b.x = box.x1 - b.r - 1; b.vx = -b.vx * b.e; hit = true; }
      if (b.y < box.y0 + b.r) { b.y = box.y0 + b.r; b.vy = -b.vy * b.e; hit = true; }
      if (b.y > box.y1 - b.r - 1) { b.y = box.y1 - b.r - 1; b.vy = -b.vy * b.e; hit = true; }
      const X = Math.round(b.x), Y = Math.round(b.y);
      if (b.trail === 0) bline(b.px, b.py, X, Y, b.c, 1);                                   // fil continu
      else if (b.trail === 1) { if (b.n % 3 === 0) wp(X, Y, b.c); }                         // pointillé
      else if (b.trail === 2) { if (b.n % 6 === 0) for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (Math.max(Math.abs(i), Math.abs(j)) === 2) wp(X + i, Y + j, b.c); }   // petits carrés
      else bline(b.px, b.py, X, Y, b.c, 2);                                                 // fil épais
      if (hit) { b.hits++; for (let k = 0; k < 8; k++) wp(X + Math.round(Math.cos(k * 0.785) * (b.r + 2)), Y + Math.round(Math.sin(k * 0.785) * (b.r + 2)), b.c); fxSnd("ping", b.x, b.y); }
      if (b.life <= 0 || b.hits > 12) { for (let j = -b.r; j <= b.r; j++) for (let i = -b.r; i <= b.r; i++) if (i * i + j * j <= b.r * b.r) wp(X + i, Y + j, b.c); b.dead = true; }
    }
    if (FX.balls.some(b => b.dead)) { FX.balls = FX.balls.filter(b => !b.dead); scheduleSave(); }
  }
  /* Pluie et neige : elles tombent sur toute la largeur de la fenêtre tant que le bouton est tenu.
     Une goutte de pluie s'écrase n'importe où en laissant un trait oblique ; un flocon se pose
     sur ce qu'il rencontre (ou au sol) et la neige s'accumule. */
  function weatherStep(dt, box, t) {
    if (drag && drag.kind === "fx" && (drag.sub === "rain" || drag.sub === "snow") && FX.sky.length < 260) {
      const snow = drag.sub === "snow";
      for (let k = 0, kn = (snow ? 2 : 4) * TK("amount", [0.4, 1, 3], snow ? "snow" : "rain"); k < kn && (kn >= 1 || Math.random() < kn); k++) FX.sky.push({ snow: snow, x: box.x0 + Math.random() * (box.x1 - box.x0), y: box.y0, vy: snow ? 30 + Math.random() * 40 : 260 + Math.random() * 160, end: box.y0 + Math.random() * (box.y1 - box.y0), ph: Math.random() * 6, c: drag.c });
      if (Math.random() < 0.2) fxSnd(snow ? "flake" : "drop", box.x0 + Math.random() * (box.x1 - box.x0), box.y0 + Math.random() * (box.y1 - box.y0));
    }
    for (const p of FX.sky) {
      p.y += p.vy * dt;
      if (p.snow) {
        p.ph += dt * 3; p.x += Math.sin(p.ph) * 0.4;
        const X = Math.round(p.x), Y = Math.round(p.y);
        if (Y >= box.y1 - 1 || (X >= 0 && X < DW && Y + 1 < DH && Y >= 0 && doc[(Y + 1) * DW + X] !== 0 && Y > box.y0 + 2)) { wp(X, Y, p.c); wp(X + 1, Y, p.c); if (Math.random() < 0.5) wp(X, Y - 1, p.c); p.dead = true; }
      } else { p.x -= p.vy * dt * 0.25; if (p.y >= p.end) { const X = Math.round(p.x), Y = Math.round(p.y); bline(X, Y, X + 2, Y - 6, p.c, 1); p.dead = true; } }
    }
    FX.sky = FX.sky.filter(p => !p.dead && p.y < box.y1 + 4);
  }


  /* ================================================================== *
   *  Lot « tramage, matière, vie, cycles ».
   * ================================================================== */
  const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];                       // matrice de Bayer 4 × 4
  const bayer = (x, y) => (B4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
  const bayer8 = (x, y) => (B4[(y & 3) * 4 + (x & 3)] * 4 + [0, 2, 3, 1][((y >> 2) & 1) * 2 + ((x >> 2) & 1)] + 0.5) / 64;
  const brushR = () => LW();
  function inPage(x, y) { return x >= 0 && y >= 0 && x < DW && y < DH; }
  /* Zone de même couleur autour d'un point (quatre voisins). Rend la liste des index et le cadre. */
  function region(x, y, cap) {
    if (!inPage(x, y)) return null;
    const c = doc[y * DW + x]; if (!c) return null;
    const seen = new Uint8Array(DW * DH), list = [], st = [y * DW + x]; seen[st[0]] = 1;
    let x0 = x, x1 = x, y0 = y, y1 = y;
    while (st.length) {
      const i = st.pop(), px = i % DW, py = (i / DW) | 0; list.push(i);
      if (list.length > (cap || 90000)) return null;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && !seen[i - 1] && doc[i - 1] === c) { seen[i - 1] = 1; st.push(i - 1); }
      if (px < DW - 1 && !seen[i + 1] && doc[i + 1] === c) { seen[i + 1] = 1; st.push(i + 1); }
      if (py > 0 && !seen[i - DW] && doc[i - DW] === c) { seen[i - DW] = 1; st.push(i - DW); }
      if (py < DH - 1 && !seen[i + DW] && doc[i + DW] === c) { seen[i + DW] = 1; st.push(i + DW); }
    }
    return { c: c, list: list, x0: x0, y0: y0, x1: x1, y1: y1 };
  }
  /* Fait voler en briques de 8 × 8 les points choisis par test(), dans un cadre, loin de (cx, cy). */
  function shatter(x0, y0, x1, y1, test, cx, cy, power, lift) {
    const T = 8;
    for (let ty = Math.floor(y0 / T) * T; ty <= y1; ty += T) for (let tx = Math.floor(x0 / T) * T; tx <= x1; tx += T) {
      const data = new Uint8Array(T * T); let any = 0;
      for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) { const X = tx + i, Y = ty + j; if (!inPage(X, Y)) continue; const v = doc[Y * DW + X]; if (v && test(X, Y)) { data[j * T + i] = v; doc[Y * DW + X] = 0; any = 1; } }
      if (!any) continue;
      const c = document.createElement("canvas"); c.width = c.height = T;
      const g = c.getContext("2d"), im = g.createImageData(T, T), p32 = new Uint32Array(im.data.buffer);
      for (let k = 0; k < T * T; k++) p32[k] = data[k] ? PAL32[data[k]] : 0;
      g.putImageData(im, 0, 0);
      const dx = tx + 4 - cx, dy = ty + 4 - cy, d = Math.hypot(dx, dy) || 1;
      FX.frags.push({ x: tx, y: ty, vx: dx / d * power + (Math.random() - 0.5) * 70, vy: dy / d * power - (lift || 0) + (Math.random() - 0.5) * 70, data: data, c: c, T: T, age: 0, rest: 0 });
    }
  }



  /* ================================================================== *
   *  Affiche vivante : objets animés, recomposés à chaque image dans l'image finale (l'écran,
   *  l'export et le zoom les voient). Le fixateur les fait rentrer dans la feuille.
   * ================================================================== */
  /* La forme sous le pointeur : le contenu de la sélection s'il y en a une, sinon tout ce qui est
     peint d'un seul tenant (toutes couleurs, huit voisins : une trame compte pour une forme). */
  function shapeAt(d, lift) {
    let x0, y0, w, h, data;
    if (sel && !sel.data && d.x >= sel.x && d.x < sel.x + sel.w && d.y >= sel.y && d.y < sel.y + sel.h) {
      x0 = Math.max(0, sel.x); y0 = Math.max(0, sel.y); w = Math.min(DW, sel.x + sel.w) - x0; h = Math.min(DH, sel.y + sel.h) - y0;
      if (w < 2 || h < 2) return null;
      data = new Uint8Array(w * h);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const k = (y0 + j) * DW + x0 + i; data[j * w + i] = doc[k]; if (lift) doc[k] = 0; }
      sel = null;
      return { x: x0, y: y0, w: w, h: h, data: data };
    }
    let sx = -1, sy = -1;
    for (let r = 0; r <= 4 && sx < 0; r++) for (let j = -r; j <= r && sx < 0; j++) for (let i = -r; i <= r; i++) if (inPage(d.x + i, d.y + j) && doc[(d.y + j) * DW + d.x + i]) { sx = d.x + i; sy = d.y + j; break; }
    if (sx < 0) return null;
    const seen = new Uint8Array(DW * DH), list = [], st = [sy * DW + sx]; seen[st[0]] = 1;
    x0 = sx; y0 = sy; let x1 = sx, y1 = sy;
    while (st.length) {
      const k = st.pop(), px = k % DW, py = (k / DW) | 0; list.push(k);
      if (list.length > 500000) return null;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) { const X = px + i, Y = py + j; if (X < 0 || Y < 0 || X >= DW || Y >= DH) continue; const n = Y * DW + X; if (!seen[n] && doc[n]) { seen[n] = 1; st.push(n); } }   // jusqu'à deux points d'écart : une trame reste d'un seul tenant
    }
    w = x1 - x0 + 1; h = y1 - y0 + 1; data = new Uint8Array(w * h);
    for (const k of list) { data[(((k / DW) | 0) - y0) * w + (k % DW) - x0] = doc[k]; if (lift) doc[k] = 0; }
    return { x: x0, y: y0, w: w, h: h, data: data };
  }
  const pointerDoc = () => screenToDoc(mouse.x, mouse.y);

  /* ---- Persiennes : la forme est découpée en lamelles ; les paires glissent d'un côté, les impaires de l'autre. */
  function blindsStamp(d) {
    const q = shapeAt(d, true); if (!q) return;
    q.type = "blinds"; q.th = LW(); q.vert = q.h > q.w * 1.3; q.t0 = performance.now(); q.zero = 0;
    FX.live.push(q); fxSnd("phase", d.x, d.y); fxKick(); render();
  }
  var LIVE_NOW = 0, BAKE_T = 0;                                  // instant de la dernière image affichée ; instant à figer (barre d'espace), 0 sinon
  function blindsCompose(q, now, target) {
    const t = (now - q.t0) / 1000, amp = Math.min(26, (q.vert ? q.h : q.w) * 0.22), ph0 = Math.sin(t * 2.2);
    if (!target && (ph0 >= 0) !== (q.zero >= 0)) fxSnd("phase", q.x + q.w / 2, q.y + q.h / 2, Math.abs(Math.cos(t * 2.2)));   // à chaque passage par l'alignement
    q.zero = ph0;
    const n = q.vert ? q.w : q.h, m = q.vert ? q.h : q.w;
    for (let a = 0; a < n; a++) {
      const band = Math.floor(a / q.th), off = Math.round(Math.sin(t * 2.2 + band * 0.42) * amp) * (band & 1 ? 1 : -1);
      for (let b = 0; b < m; b++) {
        const v = q.vert ? q.data[b * q.w + a] : q.data[a * q.w + b]; if (!v) continue;
        const X = q.vert ? q.x + a : q.x + b + off, Y = q.vert ? q.y + b + off : q.y + a;
        if (X >= 0 && Y >= 0 && X < DW && Y < DH) { if (target) target[Y * DW + X] = v; else docPx[Y * DW + X] = PAL32[v]; }
      }
    }
  }
  /* ---- Film de moiré : une copie de la zone, sur un film transparent qui tourne par-dessus l'original
     (un tour par minute). Deux trames qui se croisent : les interférences se dessinent seules. */
  function moireStamp(d) {
    const q = shapeAt(d, false); if (!q) return;
    q.type = "moire"; q.t0 = performance.now(); q.beat = -1;
    FX.live.push(q); fxSnd("moire", d.x, d.y); fxKick(); render();
  }
  function moireCompose(q, now, target) {
    const still = target && !BAKE_T, t = ((target && BAKE_T ? BAKE_T : now) - q.t0) / 1000, an = q.type === "motor" ? (still ? 0 : t * (q.spd || 2.2)) : still ? 0.12 : t * Math.PI * 2 / 60 + 0.035 * Math.sin(t * 1.3), c = Math.cos(an), n = Math.sin(an);
    const cx = q.x + q.w / 2, cy = q.y + q.h / 2, R = Math.ceil(Math.hypot(q.w, q.h) / 2);
    for (let Y = Math.max(0, Math.floor(cy - R)); Y <= Math.min(DH - 1, Math.ceil(cy + R)); Y++) for (let X = Math.max(0, Math.floor(cx - R)); X <= Math.min(DW - 1, Math.ceil(cx + R)); X++) {
      const dx = X - cx, dy = Y - cy, sx = Math.floor(dx * c + dy * n + q.w / 2), sy = Math.floor(-dx * n + dy * c + q.h / 2);
      if (sx < 0 || sy < 0 || sx >= q.w || sy >= q.h) continue;
      const v = q.data[sy * q.w + sx]; if (!v) continue;
      if (target) target[Y * DW + X] = v; else docPx[Y * DW + X] = PAL32[v];
    }
    if (q.type === "motor") { const tn = Math.floor(t * 2.2 / 6.283 * 4); if (!target && tn !== q.turn) { q.turn = tn; fxSnd("clack", cx, cy); } return; }
    const b = Math.floor(t / 2.9);
    if (!target && b !== q.beat) { q.beat = b; fxSnd("moire", cx, cy, (Math.sin(an * 8) + 1) / 2); }
  }

  /* ---- Couteau de Mondrian : des traits horizontaux et verticaux découpent l'affiche en cases. Les
     traits coulissent en mesure et s'écartent du pointeur ; chaque case étire son contenu pour
     toujours remplir sa boîte. Un clic dans une case y verse la trame courante ; une touche y
     pose une lettre géante. */
  function gridBounds(G, t, axis) {
    const cuts = axis ? G.ys : G.xs, N = axis ? DH : DW, S = [0], D = [0], m = pointerDoc(), mp = axis ? m.y : m.x;
    for (const c of cuts) {
      let p = c.s + Math.sin(t * c.w + c.ph) * c.amp; const dd = p - mp;
      if (mouse.in && Math.abs(dd) < 46) p += (dd >= 0 ? 1 : -1) * 18 * (1 - Math.abs(dd) / 46);
      S.push(c.s); D.push(p);
    }
    S.push(N); D.push(N);
    for (let i = 1; i < D.length - 1; i++) D[i] = Math.round(Math.max(D[i - 1] + 6, Math.min(N - 6 * (D.length - 1 - i), D[i])));
    return { S: S, D: D };
  }
  function gridMap(b, N) {
    const map = new Int32Array(N);
    for (let i = 0; i < b.S.length - 1; i++) { const d0 = b.D[i], d1 = b.D[i + 1], s0 = b.S[i], s1 = b.S[i + 1]; for (let x = d0; x < d1; x++) map[x] = Math.min(s1 - 1, s0 + Math.floor((x - d0) * (s1 - s0) / Math.max(1, d1 - d0))); }
    return map;
  }
  function gridCompose(now, target) {
    const G = FX.grid, t = target ? (BAKE_T ? (BAKE_T - G.t0) / 1000 : 0) : (now - G.t0) / 1000;
    const bx = G.bx = gridBounds(G, t, 0), by = G.by = gridBounds(G, t, 1), mx = gridMap(bx, DW), my = gridMap(by, DH);
    for (let y = 0; y < DH; y++) { const row = my[y] * DW, o = y * DW; for (let x = 0; x < DW; x++) { const v = G.src[row + mx[x]]; if (target) target[o + x] = v; else docPx[o + x] = PAL32[v]; } }
    for (let i = 1; i < bx.D.length - 1; i++) for (let y = 0; y < DH; y++) for (let k = -1; k <= 0; k++) { const o = y * DW + bx.D[i] + k; if (target) target[o] = 1; else docPx[o] = 0xff000000; }
    for (let j = 1; j < by.D.length - 1; j++) for (let x = 0; x < DW; x++) for (let k = -1; k <= 0; k++) { const o = (by.D[j] + k) * DW + x; if (target) target[o] = 1; else docPx[o] = 0xff000000; }
    if (!target) {                                               // l'accord : sa couleur suit le rapport entre la plus grande case et la plus petite
      const beat = Math.floor(t / 1.43);
      if (beat !== G.beat) { G.beat = beat; let lo = 1e9, hi = 0; for (let i = 0; i < bx.D.length - 1; i++) for (let j = 0; j < by.D.length - 1; j++) { const a = (bx.D[i + 1] - bx.D[i]) * (by.D[j + 1] - by.D[j]); lo = Math.min(lo, a); hi = Math.max(hi, a); } fxSnd("chord", DW / 2, DH / 2, Math.min(1, Math.log(hi / Math.max(1, lo)) / 4)); }
    }
  }
  function gridCell(G, d) {                                      // la case affichée sous un point, et son rectangle d'origine
    if (!G.bx) return null;
    let i = 0, j = 0; while (i < G.bx.D.length - 2 && d.x >= G.bx.D[i + 1]) i++; while (j < G.by.D.length - 2 && d.y >= G.by.D[j + 1]) j++;
    return { x0: G.bx.S[i], x1: G.bx.S[i + 1], y0: G.by.S[j], y1: G.by.S[j + 1], dx0: G.bx.D[i], dx1: G.bx.D[i + 1], dy0: G.by.D[j], dy1: G.by.D[j + 1] };
  }
  function gridEnd(dr) {
    const now = performance.now();
    if (!FX.grid) { pushUndo(); FX.grid = { src: doc.slice(), xs: [], ys: [], t0: now, beat: -1 }; doc.fill(0); gridCompose(now); }
    const G = FX.grid, dx = dr.d.x - dr.a.x, dy = dr.d.y - dr.a.y;
    if (Math.hypot(dx, dy) < 6) {                                 // un simple clic : la case reçoit la trame et la couleur courantes
      const c = gridCell(G, dr.d); if (!c) return;
      for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) G.src[y * DW + x] = pat(x, y) ? ink : 0;
      fxSnd("stamp", dr.d.x, dr.d.y);
    } else {
      const horiz = Math.abs(dx) >= Math.abs(dy), list = horiz ? G.ys : G.xs, N = horiz ? DH : DW;
      const pos = horiz ? gridMap(G.by, DH)[Math.max(0, Math.min(DH - 1, dr.a.y))] : gridMap(G.bx, DW)[Math.max(0, Math.min(DW - 1, dr.a.x))];
      if (pos < 8 || pos > N - 8 || list.some(c => Math.abs(c.s - pos) < 8) || list.length >= 9) return;
      list.push({ s: pos, w: Math.PI * 2 / (0.357 * [8, 12, 16][Math.floor(Math.random() * 3)]), ph: Math.random() * 6.28, amp: 10 + Math.random() * 24 });
      list.sort((a, b) => a.s - b.s);
      fxSnd("cut", dr.a.x, dr.a.y);
    }
    fxKick(); scheduleSave();
  }
  function gridLetter(ch) {
    const G = FX.grid, c = gridCell(G, pointerDoc()); if (!c) return false;
    const g = glyphInk(ch); if (!g) return false;
    const w = c.x1 - c.x0, h = c.y1 - c.y0, m = Math.max(2, Math.round(Math.min(w, h) * 0.08));
    for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) if (g.bits[Math.floor((y - m) * g.h / (h - 2 * m)) * g.w + Math.floor((x - m) * g.w / (w - 2 * m))]) G.src[(c.y0 + y) * DW + c.x0 + x] = ink;
    if (SND && SND.typing) try { SND.typing("char", ch, 72, 0.5, 0.5); } catch (e) {}
    return true;
  }
  const glyphCache = {};
  function glyphInk(ch) {                                         // une lettre Chicago, rognée au plus près de son encre
    if (glyphCache[ch] !== undefined) return glyphCache[ch];
    const b = textBmp(ch, "Chicago", 12, false, false); let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) if (b.bits[j * b.w + i]) { if (i < x0) x0 = i; if (i > x1) x1 = i; if (j < y0) y0 = j; if (j > y1) y1 = j; }
    if (x1 < 0) return (glyphCache[ch] = null);
    const w = x1 - x0 + 1, h = y1 - y0 + 1, bits = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) bits[j * w + i] = b.bits[(y0 + j) * b.w + x0 + i];
    return (glyphCache[ch] = { w: w, h: h, bits: bits });
  }

  /* ---- Typo ballon : on clique dans une zone fermée, on tape. Les lettres gonflent jusqu'à remplir la
     zone et se toucher ; le pointeur, une bille ou une boule qui passe les écrase, puis elles
     reprennent leur volume. */
  function balloonStart(d) {
    if (!inPage(d.x, d.y) || doc[d.y * DW + d.x]) return;
    if (FX.typing && !FX.typing.letters.length) { const old = FX.typing; FX.live = FX.live.filter(o => o !== old); }   // une zone choisie puis abandonnée ne reste pas
    const seen = new Uint8Array(DW * DH), st = [d.y * DW + d.x]; seen[st[0]] = 1;
    let x0 = d.x, x1 = d.x, y0 = d.y, y1 = d.y, n = 0;
    while (st.length) {
      const k = st.pop(), px = k % DW, py = (k / DW) | 0; n++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && !seen[k - 1] && !doc[k - 1]) { seen[k - 1] = 1; st.push(k - 1); }
      if (px < DW - 1 && !seen[k + 1] && !doc[k + 1]) { seen[k + 1] = 1; st.push(k + 1); }
      if (py > 0 && !seen[k - DW] && !doc[k - DW]) { seen[k - DW] = 1; st.push(k - DW); }
      if (py < DH - 1 && !seen[k + DW] && !doc[k + DW]) { seen[k + DW] = 1; st.push(k + DW); }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1, mask = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) mask[j * w + i] = seen[(y0 + j) * DW + x0 + i];
    const q = { type: "balloon", x: x0, y: y0, w: w, h: h, mask: mask, letters: [], sq: 0 };
    FX.live.push(q); FX.typing = q; fxSnd("pump", d.x, d.y, 0.2); fxKick(); render();
  }
  function balloonKey(e) {
    const q = FX.typing;
    if (e.key === "Escape" || e.key === "Enter") { FX.typing = null; if (!q.letters.length) FX.live = FX.live.filter(o => o !== q); render(); return true; }
    if (e.key === "Backspace") { q.letters.pop(); fxSnd("rubber", q.x + q.w / 2, q.y + q.h / 2, 0.3); render(); return true; }
    if (e.key.length === 1 && e.key !== " " && glyphInk(e.key)) { if (q.letters.length < 40) q.letters.push({ ch: e.key, c: ink || 1, t: performance.now() }); fxSnd("pump", q.x + q.w / 2, q.y + q.h / 2, Math.min(1, q.letters.length / 10)); if (SND && SND.typing) try { SND.typing("char", e.key, 48, 0.5, 0.5); } catch (er) {} fxKick(); return true; }
    return false;
  }
  function balloonCompose(q, now, target) {
    const n = q.letters.length;
    if (!n) {                                                    // zone choisie, rien de tapé : des hachures qui défilent montrent où les lettres vont gonfler
      if (!target && FX.typing === q) { const ph = Math.floor(now / 90), c = PAL32[ink || 1]; for (let Y = 0; Y < q.h; Y++) for (let X = (8 - ((Y + ph) & 7)) & 7; X < q.w; X += 8) if (q.mask[Y * q.w + X]) docPx[(q.y + Y) * DW + q.x + X] = c; }
      return;
    }
    const rows = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * q.h / q.w / 1.15)))), per = Math.ceil(n / rows);
    const foes = target ? [] : [pointerDoc()].concat(FX.balls, FX.wreck);     // tout ce qui écrase les lettres
    const squash = (cx, cy) => { let s2 = 1; for (const f of foes) { const d = Math.hypot(f.x - cx, f.y - cy); s2 = Math.min(s2, 1 - 0.7 * Math.exp(-(d * d) / 2200)); } return s2; };
    let total = 0, k = 0;
    for (let r = 0; r < rows; r++) {
      const cnt = Math.min(per, n - r * per); if (cnt <= 0) break;
      const y0 = Math.round(r * q.h / rows), y1 = Math.round((r + 1) * q.h / rows), ws = [];
      let sum = 0;
      for (let i = 0; i < cnt; i++) { const s2 = squash(q.x + (i + 0.5) * q.w / cnt, q.y + (y0 + y1) / 2); ws.push(s2); sum += s2; total += 1 - s2; }
      let xa = 0;
      for (let i = 0; i < cnt; i++, k++) {
        const L = q.letters[k], g = glyphInk(L.ch), xb = xa + ws[i] / sum * q.w, X0 = Math.round(xa), X1 = Math.round(xb); xa = xb;
        const age = target ? 1 : Math.min(1, (now - L.t) / 320), grow = age < 1 ? age * (1.25 - 0.25 * age) : 1;          // elle gonfle en un tiers de seconde
        const cw = X1 - X0, chh = y1 - y0, gw = Math.max(1, Math.round((cw - 2) * grow)), gh = Math.max(1, Math.round((chh - 2) * grow)), ox = X0 + ((cw - gw) >> 1), oy = y0 + ((chh - gh) >> 1);
        for (let b = 0; b < gh; b++) { const Y = oy + b; if (Y < 0 || Y >= q.h) continue; const sy = Math.floor(b * g.h / gh); for (let a = 0; a < gw; a++) { const X = ox + a; if (X < 0 || X >= q.w || !q.mask[Y * q.w + X] || !g.bits[sy * g.w + Math.floor(a * g.w / gw)]) continue; const o = (q.y + Y) * DW + q.x + X; if (target) target[o] = L.c; else docPx[o] = PAL32[L.c]; } }
      }
    }
    if (!target && Math.abs(total - q.sq) > 0.08) { fxSnd("rubber", q.x + q.w / 2, q.y + q.h / 2, Math.min(1, total)); q.sq = total; }
  }

  /* ---- Orage stroboscopique : toutes les deux mesures, ou sur un choc violent, cent millisecondes
     d'inversion (une case de la grille s'il y en a une, sinon toute l'affiche) ou de trames décalées. */
  function strobe(now) {
    FX.strobeUntil = now + 100; FX.strobeMode = Math.random() < 0.5 ? 0 : 1; FX.strobeRect = null;
    if (FX.grid && FX.grid.bx && Math.random() < 0.7) { const G = FX.grid, i = Math.floor(Math.random() * (G.bx.D.length - 1)), j = Math.floor(Math.random() * (G.by.D.length - 1)); FX.strobeRect = [G.bx.D[i], G.by.D[j], G.bx.D[i + 1], G.by.D[j + 1]]; FX.strobeMode = 0; }
    if (SND && SND.fx && !touchMode) try { SND.fx("strobe", 0.5, 0.5); } catch (e) {}
    fxKick();
  }
  function strobeCompose() {
    const r = FX.strobeRect || [0, 0, DW, DH];
    if (FX.strobeMode === 0) { for (let y = r[1]; y < r[3]; y++) for (let x = r[0]; x < r[2]; x++) docPx[y * DW + x] ^= 0x00ffffff; }
    else for (let y = 0; y < DH; y++) { const o = y * DW; if (y & 1) docPx.copyWithin(o + 1, o, o + DW - 1); else docPx.copyWithin(o, o + 1, o + DW); }   // lignes paires et impaires tirées en sens contraire
  }
  function liveCompose(now) {
    for (const q of FX.live) {
      if (q.type === "blinds") blindsCompose(q, now); else if (q.type === "moire" || q.type === "motor") moireCompose(q, now); else if (q.type === "balloon") balloonCompose(q, now);
      else if (q.type === "jelly") jellyCompose(q, now); else if (q.type === "worm") wormCompose(q, now); else if (q.type === "fly") flyCompose(q, now);
      else if (q.type === "elastic") elasticCompose(q, now); else if (q.type === "acc") accCompose(q, now);
      else if (q.type === "held") { for (let j = 0; j < q.h; j++) for (let i = 0; i < q.w; i++) { const v = q.data[j * q.w + i]; if (v) pxDot(q.x + i, q.y + j, v); } }
      else if (q.type === "extrude") extrudeDraw(q); else if (q.type === "fold") foldDraw(q);
    }
    for (const g of FX.sprouts) sproutDraw(g, g.g, null);
    for (const p of FX.spores) { pxDot(Math.round(p.x), Math.round(p.y), p.c); pxDot(Math.round(p.x) + 1, Math.round(p.y), p.c); pxDot(Math.round(p.x), Math.round(p.y) + 1, 1); }
  }
  function liveBake(target) {                                    // tout ce qui vit, posé tel quel dans un calque
    if (FX.grid) gridCompose(0, target);
    for (const q of FX.live) {
      if (q.type === "blinds" && BAKE_T) blindsCompose(q, BAKE_T, target);   // figé : les lames restent où on les voit
      else if (q.type === "blinds") { for (let j = 0; j < q.h; j++) for (let i = 0; i < q.w; i++) { const v = q.data[j * q.w + i]; if (v) target[(q.y + j) * DW + q.x + i] = v; } }
      else if (q.type === "moire" || q.type === "motor") moireCompose(q, 0, target);
      else if (q.type === "balloon") balloonCompose(q, 0, target);
      else if (q.type === "jelly") jellyCompose(q, BAKE_T || (q.end ? q.end + JELLY_REST : performance.now()), target);
      else if (q.type === "worm") wormCompose(q, BAKE_T || performance.now(), target);
      else if (q.type === "fly") flyCompose(q, 0, target);
      else if (q.type === "elastic") elasticCompose(q, 0, target);
      else if (q.type === "acc") accCompose(q, 0, target);
      else if (q.type === "held") { for (let j = 0; j < q.h; j++) for (let i = 0; i < q.w; i++) { const v = q.data[j * q.w + i]; if (v && inPage(q.x + i, q.y + j)) target[(q.y + j) * DW + q.x + i] = v; } }
    }
    for (const q of FX.live) { if (q.type === "extrude") extrudeDraw(q, target); if (q.type === "fold") foldDraw(q, target); }
    for (const q of FX.shards) rotBlit(q, q.x, q.y, q.a, 1, 1, (X, Y, v) => { if (inPage(X, Y)) target[Y * DW + X] = v; });
    plantsCompose(0, target); metalCompose(target);
  }


  /* ================================================================== *
   *  Export GIF animé. Seize couleurs, compression LZW écrite ici (aucune bibliothèque).
   * ================================================================== */
  function gifEncode(w, h, frames, delays) {
    let buf = new Uint8Array(1 << 16), n = 0;
    const B = v => { if (n >= buf.length) { const nb = new Uint8Array(buf.length * 2); nb.set(buf); buf = nb; } buf[n++] = v & 255; };
    const W16 = v => { B(v); B(v >> 8); }, S = str => { for (let i = 0; i < str.length; i++) B(str.charCodeAt(i)); };
    S("GIF89a"); W16(w); W16(h); B(0xF3); B(0); B(0);
    for (let i = 0; i < 16; i++) { B(PAL_RGB[i][0]); B(PAL_RGB[i][1]); B(PAL_RGB[i][2]); }
    B(0x21); B(0xFF); B(11); S("NETSCAPE2.0"); B(3); B(1); W16(0); B(0);          // boucle sans fin
    for (let f = 0; f < frames.length; f++) {
      B(0x21); B(0xF9); B(4); B(0x04); W16(delays[f]); B(0); B(0);
      B(0x2C); W16(0); W16(0); W16(w); W16(h); B(0);
      const MIN = 4, CLEAR = 16, EOI = 17, idx = frames[f], block = [];
      let size = MIN + 1, next = EOI + 1, cur = 0, bits = 0, dict = new Map();
      const flush = () => { if (!block.length) return; B(block.length); for (let i = 0; i < block.length; i++) B(block[i]); block.length = 0; };
      const put = code => { cur |= code << bits; bits += size; while (bits >= 8) { block.push(cur & 255); cur >>>= 8; bits -= 8; if (block.length === 255) flush(); } };
      B(MIN); put(CLEAR);
      let pfx = idx[0];
      for (let i = 1; i < idx.length; i++) {
        const c = idx[i], key = (pfx << 8) | c, e = dict.get(key);
        if (e !== undefined) { pfx = e; continue; }
        put(pfx);
        if (next === 4096) { put(CLEAR); next = EOI + 1; size = MIN + 1; dict = new Map(); }
        else { if (next >= (1 << size)) size++; dict.set(key, next++); }
        pfx = c;
      }
      put(pfx); put(EOI); if (bits > 0) block.push(cur & 255);
      flush(); B(0);
    }
    B(0x3B);
    return buf.subarray(0, n);
  }
  /* L'image telle qu'on la voit (calques, cycles, objets vivants), en index de la palette des seize. */
  const gifLut = new Map();
  function gifGrab(scale) {
    if (!gifLut.size) for (let i = 0; i < 16; i++) gifLut.set(PAL32[i], i);
    const f = new Uint8Array(DW * DH);
    for (let i = 0; i < f.length; i++) { const c = docPx[i]; let v = gifLut.get(c); if (v === undefined) { v = nearestColor(c & 255, (c >> 8) & 255, (c >> 16) & 255); gifLut.set(c, v); } f[i] = v; }
    return scale === 2 ? gifScale(f) : f;
  }
  function gifScale(f) { const o = new Uint8Array(DW * DH * 4); for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) { const v = f[y * DW + x], k = y * 2 * DW * 2 + x * 2; o[k] = o[k + 1] = o[k + DW * 2] = o[k + DW * 2 + 1] = v; } return o; }
  function gifSave(frames, delays, scale) {
    const data = gifEncode(DW * scale, DH * scale, frames, delays), blob = new Blob([data], { type: "image/gif" }), url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = "MacTint.gif"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    FX.gifLast = { bytes: data.length, frames: frames.length };
    cheer("save");
  }
  const GIF_MODES = ["Live animation, as on screen", "Boiling ink", "Replay of the drawing", "Dissolve in", "Color by color", "Printer wipe"];
  const GD = { on: false, mode: 0, secs: 4, scale: 1 };
  function gifRect() { return { x: Math.round((SW - 300) / 2), y: Math.round((SH - 236) / 2), w: 300, h: 236 }; }
  function gifStart() {
    GD.on = false;
    const sc = GD.scale, hold = 150;
    syncDoc();
    if (GD.mode === 0) { FX.gif = { frames: [], until: performance.now() + GD.secs * 1000, next: 0, scale: sc }; fxKick(); render(); return; }   // enregistré en direct, 12 images par seconde
    const still = gifGrab(1), frames = [], delays = [], add = (f, d) => { frames.push(sc === 2 ? gifScale(f) : f); delays.push(d); };
    if (GD.mode === 1) {                                         // encre frémissante : trois poses en boucle
      for (let ph = 0; ph < 3; ph++) { const f = new Uint8Array(DW * DH); for (let y = 0; y < DH; y++) { const hh = Math.sin(Math.floor(y / 3) * 3 * 12.9898 + ph * 78.233) * 43758.5453, o = Math.round((hh - Math.floor(hh)) * 2 - 1); for (let x = 0; x < DW; x++) { const sx = x - o; f[y * DW + x] = sx >= 0 && sx < DW ? still[y * DW + sx] : 0; } } add(f, 11); }
    } else if (GD.mode === 2) {                                  // le film du dessin
      const rec = FX.rec.slice(-200);
      for (const r of rec) { const d = unrle(r, DW * DH); for (let i = 0; i < d.length; i++) if (d[i] > 15) d[i] = still[i]; add(d, 9); }
      add(still, hold);
    } else if (GD.mode === 3) {                                  // fondu par trame
      for (let q = 1; q <= 16; q++) { const f = new Uint8Array(DW * DH); for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) if (bayer8(x, y) <= q / 16) f[y * DW + x] = still[y * DW + x]; add(f, q === 16 ? hold : 9); }
    } else if (GD.mode === 4) {                                  // couleur par couleur, de la plus sombre à la plus claire
      const used = new Set(still), order = [...used].filter(c => c !== 0).sort((a, b) => (PAL_RGB[a][0] * 3 + PAL_RGB[a][1] * 6 + PAL_RGB[a][2]) - (PAL_RGB[b][0] * 3 + PAL_RGB[b][1] * 6 + PAL_RGB[b][2])), rank = new Uint8Array(16).fill(255);
      order.forEach((c, i) => { rank[c] = i; });
      for (let q = 0; q < order.length; q++) { const f = new Uint8Array(DW * DH); for (let i = 0; i < f.length; i++) if (rank[still[i]] <= q) f[i] = still[i]; add(f, q === order.length - 1 ? hold : 45); }
      if (!order.length) add(still, hold);
    } else {                                                     // l'imprimante : l'image descend ligne par ligne, sous une tête noire
      const steps = 28;
      for (let q = 1; q <= steps; q++) { const f = new Uint8Array(DW * DH), yy = Math.round(q * DH / steps); f.set(still.subarray(0, yy * DW)); if (q < steps) for (let k = 0; k < 2 * DW && yy * DW + k < f.length; k++) f[yy * DW + k] = 1; add(f, q === steps ? hold : 7); }
    }
    gifSave(frames, delays, sc); render();
  }
  function gifClick(p) {
    const r = gifRect(), y = p.y - r.y, x = p.x - r.x;
    for (let i = 0; i < GIF_MODES.length; i++) if (y >= 34 + i * 18 && y < 52 + i * 18 && x > 14 && x < 286) GD.mode = i;
    if (y >= 150 && y < 168) { [2, 4, 8].forEach((v, i) => { if (x >= 96 + i * 42 && x < 136 + i * 42) GD.secs = v; }); }
    if (y >= 172 && y < 190) { [1, 2].forEach((v, i) => { if (x >= 96 + i * 60 && x < 150 + i * 60) GD.scale = v; }); }
    if (y >= 202 && y < 224) { if (x >= 206 && x < 276) { gifStart(); return; } if (x >= 118 && x < 188) GD.on = false; }
    uiSnd("item", GD.mode); render();
  }
  function drawGifDialog() {
    const r = gifRect(), T = (str, x, y) => blit(ctx, textBmp(str, "Chicago", 12, false, false), r.x + x, r.y + y);
    ctx.fillStyle = "#000"; for (let j = 0; j < r.h; j += 2) for (let i = 2; i < r.w + 2; i += 2) ctx.fillRect(r.x + i, r.y + j + 2, 1, 1);
    ctx.fillStyle = "#fff"; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#000"; ctx.fillRect(r.x, r.y, r.w, 1); ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1); ctx.fillRect(r.x, r.y, 1, r.h); ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
    ctx.fillRect(r.x + 3, r.y + 3, r.w - 6, 2); ctx.fillRect(r.x + 3, r.y + r.h - 5, r.w - 6, 2); ctx.fillRect(r.x + 3, r.y + 3, 2, r.h - 6); ctx.fillRect(r.x + r.w - 5, r.y + 3, 2, r.h - 6);
    T("Save as animated GIF", 16, 13);
    const radio = (x, y, on) => { const X = r.x + x, Y = r.y + y; ctx.fillStyle = "#000"; ctx.fillRect(X + 3, Y, 6, 12); ctx.fillRect(X, Y + 3, 12, 6); ctx.fillRect(X + 1, Y + 1, 10, 10); ctx.fillStyle = "#fff"; ctx.fillRect(X + 3, Y + 1, 6, 10); ctx.fillRect(X + 1, Y + 3, 10, 6); ctx.fillRect(X + 2, Y + 2, 8, 8); if (on) { ctx.fillStyle = "#000"; ctx.fillRect(X + 4, Y + 3, 4, 6); ctx.fillRect(X + 3, Y + 4, 6, 4); } ctx.fillStyle = "#000"; };
    GIF_MODES.forEach((m, i) => { radio(18, 36 + i * 18, GD.mode === i); T(m, 38, 35 + i * 18); });
    T("Seconds", 18, 151); [2, 4, 8].forEach((v, i) => { radio(96 + i * 42, 152, GD.secs === v && GD.mode === 0); T(String(v), 112 + i * 42, 151); });
    T("Size", 18, 173); [1, 2].forEach((v, i) => { radio(96 + i * 60, 174, GD.scale === v); T(v === 1 ? "x 1" : "x 2", 112 + i * 60, 173); });
    const btn = (x, label, def) => { const bx = r.x + x, by = r.y + 202; ctx.fillStyle = "#000"; if (def) { ctx.fillRect(bx - 3, by - 2, 76, 26); ctx.fillStyle = "#fff"; ctx.fillRect(bx - 1, by, 72, 22); ctx.fillStyle = "#000"; } ctx.fillRect(bx + 1, by, 68, 22); ctx.fillRect(bx, by + 1, 70, 20); ctx.fillStyle = "#fff"; ctx.fillRect(bx + 1, by + 1, 68, 20); ctx.fillStyle = "#000"; const tb = textBmp(label, "Chicago", 12, false, false); blit(ctx, tb, bx + 35 - (tb.w >> 1), by + 4); };
    btn(118, "Cancel", false); btn(206, "Save", true);
  }


  /* ================================================================== *
   *  Lot « vivant, champ, matière ».
   * ================================================================== */
  function pxDot(X, Y, c, target) { if (X >= 0 && Y >= 0 && X < DW && Y < DH) { if (target) target[Y * DW + X] = c; else docPx[Y * DW + X] = PAL32[c]; } }
  function pxLine(x0, y0, x1, y1, c, w, target) { x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1); const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1; for (let k = 0; k <= n; k++) { const X = Math.round(x0 + (x1 - x0) * k / n), Y = Math.round(y0 + (y1 - y0) * k / n); for (let j = 0; j < w; j++) for (let i = 0; i < w; i++) pxDot(X + i, Y + j, c, target); } }
  function pxDisc(cx, cy, r, c, target, fill) { cx = Math.round(cx); cy = Math.round(cy); const R = Math.ceil(r); for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { const d2 = i * i + j * j; if (d2 > r * r) continue; const v = fill ? fill(cx + i, cy + j, d2) : c; if (v >= 0) pxDot(cx + i, cy + j, v, target); } }

  /* ---- Greffon : une graine, puis une tige crantée qui pousse en cherchant le blanc (et le soleil),
     et une fleur dont les pétales, remplis de la trame courante, s'ouvrent et se referment.
     Un passage rapide du pointeur couche les tiges, qui se redressent comme des ressorts. */
  function graftPlant(d) {
    const gs = Math.max(0.5, Math.min(6, PW() / 4));               // l'épaisseur donne l'échelle de la plante (tige, feuilles, fleur)
    FX.plants.push({ s: gs, x: d.x, y: d.y, segs: [], n: Math.round((12 + Math.floor(Math.random() * 12)) * TK("height", [0.5, 1, 2], "graft")), ang: -Math.PI / 2, next: 0, bend: 0, bv: 0, c: ink === 0 ? 11 : ink, c2: [7, 8, 9, 15, 12, 14][Math.floor(Math.random() * 6)], pat: pattern, petals: 5 + Math.floor(Math.random() * 4), r: (9 + Math.random() * 9) * gs, ph: Math.random() * 6, bloom: 0 });
    fxSnd("seed", d.x, d.y); fxKick();
  }
  function plantNodes(q) { const pts = [{ x: q.x, y: q.y }], n = q.segs.length; let x = q.x, y = q.y; for (let i = 0; i < n; i++) { const a = q.segs[i] + q.bend * (i + 1) / Math.max(4, n); x += Math.cos(a) * 5 * (q.s || 1); y += Math.sin(a) * 5 * (q.s || 1); pts.push({ x: x, y: y }); } return pts; }
  function plantsStep(t, dt) {
    for (const q of FX.plants) {
      if (q.segs.length < q.n && t > q.next) {                     // la tige pousse d'un cran
        q.next = t + 90;
        const pts = plantNodes(q), tip = pts[pts.length - 1];
        let a = q.ang + (Math.random() - 0.5) * 0.5;
        if (FX.sun) { const want = Math.atan2(FX.sun.y - tip.y, FX.sun.x - tip.x); let dd = want - a; dd -= Math.round(dd / 6.283) * 6.283; a += dd * 0.18; } else a += (-Math.PI / 2 - a) * 0.15;
        for (let tries = 0; tries < 5; tries++) { const ax = Math.round(tip.x + Math.cos(a) * 9 * (q.s || 1)), ay = Math.round(tip.y + Math.sin(a) * 9 * (q.s || 1)); if (!inPage(ax, ay) || doc[ay * DW + ax]) a += (tries & 1 ? -1 : 1) * 0.5 * (tries + 1); else break; }   // un obstacle devant : elle tourne
        q.ang = a; q.segs.push(a);
        if (q.segs.length === q.n) { q.bloom = t; fxSnd("bloom", tip.x, tip.y); } else if (q.segs.length % 3 === 0) fxSnd("grow", tip.x, tip.y);
      }
      /* le vent du pointeur, le rappel du ressort, l'attirance du soleil */
      const m = FX.pm, pts = plantNodes(q); let near = false;
      for (const k of pts) if (Math.abs(k.x - m.x) < 16 * (q.s || 1) && Math.abs(k.y - m.y) < 16 * (q.s || 1)) { near = true; break; }
      if (near && Math.abs(m.vx) > 60) { q.bv += Math.max(-6, Math.min(6, m.vx * 0.004)); if (Math.random() < 0.3) fxSnd("bloom", m.x, m.y, 0.4); }
      const rest = FX.sun ? Math.max(-0.5, Math.min(0.5, (FX.sun.x - q.x) / 400)) : 0;
      q.bv += ((rest - q.bend) * 40 - q.bv * 5) * dt; q.bend += q.bv * dt;
    }
  }
  function plantsCompose(now, target) {
    for (const q of FX.plants) {
      const pts = plantNodes(q), gs = q.s || 1, sw = Math.max(1, Math.round(2 * gs)), lw = Math.max(1, Math.round(gs));
      for (let i = 1; i < pts.length; i++) {
        const o = (i & 1) * Math.max(1, Math.round(gs));           // tige crantée : un décalage un cran sur deux
        pxLine(pts[i - 1].x + o, pts[i - 1].y, pts[i].x + o, pts[i].y, q.c, sw, target);
        if (i % 4 === 2) { const s2 = i % 8 === 2 ? 1 : -1; pxLine(pts[i].x, pts[i].y, pts[i].x + s2 * 6 * gs, pts[i].y - 3 * gs, q.c, lw, target); pxLine(pts[i].x + s2 * 6 * gs, pts[i].y - 3 * gs, pts[i].x + s2 * 3 * gs, pts[i].y + gs, q.c, lw, target); }
      }
      if (!q.bloom) continue;
      const still = target && !BAKE_T, tn = target && BAKE_T ? BAKE_T : now, tip = pts[pts.length - 1], age = still ? 9 : (tn - q.bloom) / 1000, open = Math.min(1, age / 0.8) * (still ? 1 : 0.62 + 0.38 * Math.sin(tn / 1000 * 1.1 + q.ph));
      const P = PAT[q.pat], lean = FX.sun ? Math.atan2(FX.sun.y - tip.y, FX.sun.x - tip.x) + Math.PI / 2 : 0;
      for (let k = 0; k < q.petals; k++) {
        const a = lean + k * Math.PI * 2 / q.petals, cx = tip.x + Math.cos(a) * q.r * 0.62 * open, cy = tip.y + Math.sin(a) * q.r * 0.62 * open, pr = q.r * 0.5 * (0.5 + 0.5 * open);
        pxDisc(cx, cy, pr + 1, 1, target); pxDisc(cx, cy, pr, q.c2, target, (X, Y) => P[(Y & 7) * 8 + (X & 7)] ? q.c2 : 0);
      }
      pxDisc(tip.x, tip.y, q.r * 0.28 + 1, 1, target); pxDisc(tip.x, tip.y, q.r * 0.28, 9, target);
    }
  }
  /* ---- Soleil mobile : les tiges poussent vers lui, les fleurs se tournent vers lui. */
  function sunCompose() {
    const S2 = FX.sun; if (!S2) return;
    pxDisc(S2.x, S2.y, 8, 1); pxDisc(S2.x, S2.y, 7, 9);
    for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4 + performance.now() / 4000; pxLine(S2.x + Math.cos(a) * 10, S2.y + Math.sin(a) * 10, S2.x + Math.cos(a) * 14, S2.y + Math.sin(a) * 14, k & 1 ? 8 : 1, 1); }
  }

  /* ---- Secoueur : on saisit une forme et on la secoue. Chaque à-coup en détache des spores, qui
     rebondissent sur le dessin ; là où elles s'arrêtent germe une miniature de la forme. */
  function shakerStart(d) {
    const q = shapeAt(d, true); if (!q) return false;
    drag = { kind: "fx", sub: "shaker", d: d, last: d, t: performance.now(), sp: 0, vx: 0, vy: 0, q: q, ox: q.x - d.x, oy: q.y - d.y, pvx: 0, pvy: 0 };
    FX.live.push(Object.assign(q, { type: "held" }));
    return true;
  }
  function shakerMove(a, d) {
    const q = drag.q; q.x = d.x + drag.ox; q.y = d.y + drag.oy;
    const acc = Math.hypot(drag.vx - drag.pvx, drag.vy - drag.pvy); drag.pvx = drag.vx; drag.pvy = drag.vy;
    if (acc > 260 && FX.spores.length < 60) {                      // l'à-coup : des spores partent avec l'élan
      const n = Math.min(5, Math.floor(acc / 300) + 1);
      for (let k = 0; k < n; k++) { let c = 0; for (let tr = 0; tr < 12 && !c; tr++) c = q.data[Math.floor(Math.random() * q.data.length)]; if (!c) continue; FX.spores.push({ x: q.x + Math.random() * q.w, y: q.y + Math.random() * q.h, vx: drag.vx * 0.5 + (Math.random() - 0.5) * 160, vy: drag.vy * 0.5 - Math.random() * 120, c: c, life: 2 + Math.random() * 2, src: q }); }
    }
    if (Math.random() < Math.min(0.9, drag.sp * 0.6)) fxSnd("shake", d.x, d.y, Math.min(1, drag.sp / 2));
    render();
  }
  function sporesStep(dt, box) {
    for (const p of FX.spores) {
      p.life -= dt; p.vy += 500 * dt; let nx = p.x + p.vx * dt, ny = p.y + p.vy * dt;
      if (nx < box.x0 + 1 || nx > box.x1 - 2) { p.vx = -p.vx * 0.6; nx = p.x; }
      if (ny > box.y1 - 2) { p.vy = -p.vy * 0.5; p.vx *= 0.7; ny = box.y1 - 2; }
      const X = Math.round(nx), Y = Math.round(ny);
      if (inPage(X, Y) && doc[Y * DW + X]) { p.vx = -p.vx * 0.5; p.vy = -p.vy * 0.5; nx = p.x; ny = p.y; fxSnd("ping", p.x, p.y); }   // rebond sur le dessin
      p.x = nx; p.y = ny;
      if (p.life <= 0 || (Math.hypot(p.vx, p.vy) < 25 && p.life < 2)) { p.dead = true; FX.sprouts.push({ x: p.x, y: p.y, src: p.src, g: 0 }); fxSnd("seed", p.x, p.y); }
    }
    FX.spores = FX.spores.filter(p => !p.dead);
    for (const g of FX.sprouts) { g.g += dt / 2.4; if (g.g >= 1) { sproutDraw(g, 1, doc); g.dead = true; fxSnd("bloom", g.x, g.y, 0.5); } }
    if (FX.sprouts.some(g => g.dead)) { FX.sprouts = FX.sprouts.filter(g => !g.dead); scheduleSave(); }
  }
  function sproutDraw(g, k, target) {                             // la miniature qui germe : la forme mère, au quart
    const q = g.src, sc = 0.28 * k, w = Math.max(1, Math.round(q.w * sc)), h = Math.max(1, Math.round(q.h * sc)), X0 = Math.round(g.x - w / 2), Y0 = Math.round(g.y - h);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const v = q.data[Math.min(q.h - 1, Math.floor(j / sc)) * q.w + Math.min(q.w - 1, Math.floor(i / sc))]; if (v) pxDot(X0 + i, Y0 + j, v, target === doc ? doc : null); }
  }

  /* ---- Métal liquide : des gouttes de mercure. Elles fusionnent en se touchant, et le pointeur les repousse. */
  function metalDrop(d) { FX.metal.push({ x: d.x, y: d.y, r: Math.max(3, LW()) * TK("drop", [0.6, 1, 1.9], "metal") * (0.8 + Math.random() * 0.4), vx: 0, vy: 0, c: ink, pat: topt("pat", "metal") === false ? 0 : pattern }); fxSnd("drop", d.x, d.y); fxKick(); }
  function metalStep(dt) {
    const B = FX.metal, m = FX.pm, held = drag && drag.sub === "metal";
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
      const a = B[i], b = B[j]; if (a.dead || b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
      if (d > a.r + b.r + 12) continue;
      const pull = 70 * dt / d; a.vx += dx * pull; a.vy += dy * pull; b.vx -= dx * pull; b.vy -= dy * pull;
      if (d < Math.max(a.r, b.r) * 0.5) { const wa = a.r * a.r, wb = b.r * b.r; a.x = (a.x * wa + b.x * wb) / (wa + wb); a.y = (a.y * wa + b.y * wb) / (wa + wb); a.r = Math.sqrt(wa + wb); b.dead = true; fxSnd("bloup", a.x, a.y, Math.min(1, a.r / 30)); }
    }
    for (const q of B) {
      const dx = q.x - m.x, dy = q.y - m.y, d = Math.hypot(dx, dy) || 0.01;
      if (!held && d < q.r + 22) { const f = (q.r + 22 - d) * 14 * dt; q.vx += dx / d * f * 8; q.vy += dy / d * f * 8; }   // le pointeur repousse
      q.x = Math.max(q.r, Math.min(DW - q.r, q.x + q.vx * dt)); q.y = Math.max(q.r, Math.min(DH - q.r, q.y + q.vy * dt)); q.vx *= 0.9; q.vy *= 0.9;
    }
    FX.metal = B.filter(q => !q.dead);
  }
  function metalCompose(target) {
    const B = FX.metal; if (!B.length) return;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const q of B) { const mm = q.r * 2.4 + 3; x0 = Math.min(x0, q.x - mm); y0 = Math.min(y0, q.y - mm); x1 = Math.max(x1, q.x + mm); y1 = Math.max(y1, q.y + mm); }
    for (let Y = Math.max(0, Math.floor(y0)); Y <= Math.min(DH - 1, Math.ceil(y1)); Y++) for (let X = Math.max(0, Math.floor(x0)); X <= Math.min(DW - 1, Math.ceil(x1)); X++) {
      let f = 0, fa = 0, A = null;
      for (const q of B) { const dx = X - q.x, dy = Y - q.y, v = q.r * q.r / (dx * dx + dy * dy + 0.5); if (v < 0.02) continue; f += v; if (v > fa) { fa = v; A = q; } }
      if (f < 1 || !A) continue;
      /* chrome : ciel clair en haut, ligne d'horizon noire, sol gris qui s'éclaircit, tout en trame */
      const ny = (Y - A.y) / A.r, nx = (X - A.x) / A.r, th = bayer(X, Y);
      let c = f < 1.2 ? 1 : ny < -0.45 ? (th < 0.25 ? 4 : 0) : ny < -0.1 ? (th < (ny + 0.45) * 2.4 ? 3 : 4) : ny < 0.12 ? 1 : ny < 0.5 ? (th < 0.5 ? 2 : 3) : (th < 0.4 ? 3 : 4);
      if (nx < -0.35 && ny < -0.25 && ny > -0.6 && th < 0.7) c = 0;
      if (f >= 1.2) {                                             // sous le contour : la couleur et la trame choisies au moment de la goutte
        const k = A.c === undefined ? 1 : A.c;
        if (k > 1) c = c === 4 ? (th < 0.5 ? k : 0) : c === 3 ? k : c === 2 ? ((X + Y) & 1 ? k : 1) : c;     // les gris du chrome deviennent des teintes de la couleur ; blanc et noir restent
        if (c && A.pat && !PAT[A.pat][(Y & 7) * 8 + (X & 7)]) c = 0;                                          // la trame ajoure le métal
      }
      pxDot(X, Y, c, target);
    }
  }

  /* ---- Peinture alchimique. Moteur : la forme cliquée tourne sur place. Élastique : le trait se
     contracte dès qu'on le lâche. Chaud : une braise qui fait bouillir et s'évaporer l'encre humide. */
  function motorStamp(d) { const q = shapeAt(d, true); if (!q) return; q.type = "motor"; q.spd = 2.2 * TK("speed", [0.3, 1, 3.2], "motor") * (topt("dir", "motor") ? -1 : 1); q.t0 = performance.now(); q.turn = -1; FX.live.push(q); fxSnd("launch", d.x, d.y); fxKick(); render(); }
  function elasticEnd(dr) {
    if (!dr.pts || dr.pts.length < 3) return;
    doc.set(dr.snap);
    let cx = 0, cy = 0; for (const q of dr.pts) { cx += q.x; cy += q.y; } cx /= dr.pts.length; cy /= dr.pts.length;
    FX.live.push({ type: "elastic", pts: dr.pts, cx: cx, cy: cy, c: dr.c || 1, k: 1, v: 0, w: Math.max(2, PW()) }); fxSnd("rubber", cx, cy, 1); fxKick();
  }
  function elasticCompose(q, now, target) { const k = target && !BAKE_T ? 0.45 : q.k; for (let i = 1; i < q.pts.length; i++) pxLine(q.cx + (q.pts[i - 1].x - q.cx) * k, q.cy + (q.pts[i - 1].y - q.cy) * k, q.cx + (q.pts[i].x - q.cx) * k, q.cy + (q.pts[i].y - q.cy) * k, q.c, q.w || 3, target); }
  function hotMove(a, d) {
    if (!FX.hotAt || FX.hotAt.length !== DW * DH) FX.hotAt = new Uint8Array(DW * DH);
    const R = brushR();
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { if (i * i + j * j > R * R) continue; const X = d.x + i, Y = d.y + j; if (!inPage(X, Y)) continue; doc[Y * DW + X] = !pat(X, Y) ? 0 : 16 + rampFor(ink) * 8 + (((X + Y * 2 + drag.len) >> 1) & 7); FX.hotAt[Y * DW + X] = 1; }
    drag.len++;
    if (Math.random() < 0.3) fxSnd("fizz", d.x, d.y);
  }

  /* ---- Champ de force : autour du pointeur, l'image s'écarte comme des billes sous le doigt, puis
     revient avec un léger rebond. L'image n'est pas modifiée : c'est son affichage qui se déforme. */
  function pokesCompose(now) {
    const m = FX.pm, R = 54;
    if (tool === "repel" && mouse.in) { const L = FX.pokes[FX.pokes.length - 1]; if (!L || Math.hypot(L.x - m.x, L.y - m.y) > 10) { FX.pokes.push({ x: m.x, y: m.y, t: now }); if (FX.pokes.length > 10) FX.pokes.shift(); fxSnd("field", m.x, m.y); } else L.t = Math.max(L.t, now - 60); }
    FX.pokes = FX.pokes.filter(q => now - q.t < 2200);
    for (const q of FX.pokes) {
      const age = (now - q.t) / 1000, s2 = Math.exp(-2.4 * age) * Math.cos(6 * age);   // l'élasticité : elle dépasse sa place et revient
      if (Math.abs(s2) < 0.02) continue;
      const x0 = Math.max(0, Math.round(q.x) - R), y0 = Math.max(0, Math.round(q.y) - R), x1 = Math.min(DW - 1, Math.round(q.x) + R), y1 = Math.min(DH - 1, Math.round(q.y) + R), w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (w < 2 || h < 2) continue;
      const src = new Uint32Array(w * h); for (let y = 0; y < h; y++) src.set(docPx.subarray((y0 + y) * DW + x0, (y0 + y) * DW + x0 + w), y * w);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = x0 + x - q.x, dy = y0 + y - q.y, d = Math.hypot(dx, dy); if (d >= R || d < 0.5) continue;
        const f = (1 - d / R) * (1 - d / R) * 0.75 * s2, sx = Math.round(x - dx * f), sy = Math.round(y - dy * f);
        docPx[(y0 + y) * DW + x0 + x] = sx >= 0 && sy >= 0 && sx < w && sy < h ? src[sy * w + sx] : 0xffffffff;
      }
    }
  }
  /* ---- Accordéon : on tire une forme ; elle s'étire en tranches espacées, puis vibre quand on lâche. */
  function accStart(d) {
    const q = shapeAt(d, true); if (!q) return false;
    Object.assign(q, { type: "acc", s: 1, v: 0, target: 1, held: true, sign: 1 });
    FX.live.push(q); drag = { kind: "fx", sub: "accordion", a: d, d: d, last: d, t: performance.now(), sp: 0, vx: 0, vy: 0, q: q };
    return true;
  }
  function accCompose(q, now, target) {
    const s2 = q.s, T = 4;
    for (let i = 0; i < q.w; i++) { const X = q.x + Math.round(Math.floor(i / T) * T * s2) + (i % T); if (X < 0 || X >= DW) continue; for (let j = 0; j < q.h; j++) { const v = q.data[j * q.w + i]; if (v) pxDot(X, q.y + j, v, target); } }
  }
  /* ---- Rails : sur une grille de 12 points, chaque case se raccorde seule à ses voisines. */
  function railsDraw(cx, cy) {
    const T = 12, R = FX.rails, has = (a, b) => R.has(a + "," + b), x = cx * T, y = cy * T;
    if (!has(cx, cy)) return;
    let n = has(cx, cy - 1), s2 = has(cx, cy + 1), w = has(cx - 1, cy), e = has(cx + 1, cy);
    if (!n && !s2 && !w && !e) { w = e = true; }
    if ((w && !e && !n && !s2) || (e && !w && !n && !s2)) w = e = true;      // un bout de voie : droit
    if ((n && !s2 && !w && !e) || (s2 && !n && !w && !e)) n = s2 = true;
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) wp(x + i, y + j, 0);
    const tie = 6, rail = ink || 1;
    if (w || e) { const a = w ? 0 : 6, b = e ? T : 6; for (let i = a + 1; i < b; i += 4) for (let j = 2; j < 10; j++) wp(x + i, y + j, tie); }
    if (n || s2) { const a = n ? 0 : 6, b = s2 ? T : 6; for (let j = a + 1; j < b; j += 4) for (let i = 2; i < 10; i++) wp(x + i, y + j, tie); }
    if (w || e) { const a = w ? 0 : 3, b = e ? T : 9; for (let i = a; i < b; i++) { wp(x + i, y + 3, rail); wp(x + i, y + 8, rail); } }
    if (n || s2) { const a = n ? 0 : 3, b = s2 ? T : 9; for (let j = a; j < b; j++) { wp(x + 3, y + j, rail); wp(x + 8, y + j, rail); } }
  }
  function railsMove(a, d) {
    if (!FX.rails) FX.rails = new Set();
    const cx = Math.floor(d.x / 12), cy = Math.floor(d.y / 12), key = cx + "," + cy;
    if (FX.rails.has(key) && drag.lastCell === key) return;
    drag.lastCell = key;
    if (!FX.rails.has(key)) fxSnd("clack", d.x, d.y);
    FX.rails.add(key);
    for (const [i, j] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) railsDraw(cx + i, cy + j);
  }
  /* ---- Formes prédatrices : le rouge mange le jaune, le jaune boit le cyan, le cyan dissout le noir. */
  const PREY = { 7: 9, 9: 12, 12: 1 };
  function predStep() {
    const N = DW * DH;
    for (let k = 0; k < 5000; k++) {
      const i = Math.floor(Math.random() * N), c = doc[i], prey = PREY[c]; if (!prey) continue;
      const x = i % DW + Math.floor(Math.random() * 5) - 2, y = ((i / DW) | 0) + Math.floor(Math.random() * 5) - 2;
      if (inPage(x, y) && doc[y * DW + x] === prey) { doc[y * DW + x] = c; if (++FX.eaten > 180) { FX.eaten = 0; fxSnd("burp", x, y, c / 15); } }
    }
  }


  /* ================================================================== *
   *  Lot « fractures et volumes ».
   * ================================================================== */
  /* Pose un bitmap tourné (et aplati selon sx, sy) : chaque point d'arrivée va chercher son point de
     départ, donc aucun trou, et aucun lissage. put(X, Y, v) écrit. */
  function rotBlit(q, cx, cy, an, sx, sy, put) {
    if (Math.abs(sx) < 0.06 || Math.abs(sy) < 0.06) return;
    const c = Math.cos(an), n = Math.sin(an), R = Math.ceil(Math.hypot(q.w * sx, q.h * sy) / 2) + 1;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const u = Math.floor((dx * c + dy * n) / sx + q.w / 2), v = Math.floor((-dx * n + dy * c) / sy + q.h / 2);
      if (u < 0 || v < 0 || u >= q.w || v >= q.h) continue;
      const val = q.data[v * q.w + u]; if (val) put(Math.round(cx) + dx, Math.round(cy) + dy, val);
    }
  }
  /* ---- Marteau de verre : des failles partent du point d'impact (cellules de Voronoï) ; chaque éclat
     devient un corps rigide qui tombe, tourne, heurte les autres et se pose. Un nouveau coup les recasse. */
  function hammerHit(d) {
    pushUndo();
    const sites = [{ x: d.x, y: d.y }], n = 13;
    for (let k = 1; k < n; k++) { const a = Math.random() * 6.283, r = (18 + Math.pow(Math.random(), 1.6) * 300) * Math.max(0.35, Math.min(2.5, Math.sqrt(PW() / 4))); sites.push({ x: d.x + Math.cos(a) * r, y: d.y + Math.sin(a) * r }); }
    const own = new Uint8Array(DW * DH), box = sites.map(() => ({ x0: 1e9, y0: 1e9, x1: -1, y1: -1 }));
    for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) {
      if (!doc[y * DW + x]) continue;
      let best = 0, bd = 1e18; for (let k = 0; k < n; k++) { const dx = x - sites[k].x, dy = y - sites[k].y, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = k; } }
      own[y * DW + x] = best + 1; const b = box[best]; if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
    }
    for (let k = 0; k < n; k++) {
      const b = box[k]; if (b.x1 < 0) continue;
      const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1, data = new Uint8Array(w * h);
      for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (own[y * DW + x] === k + 1) { data[(y - b.y0) * w + x - b.x0] = doc[y * DW + x]; doc[y * DW + x] = 0; }
      const cx = b.x0 + w / 2, cy = b.y0 + h / 2, dx = cx - d.x, dy = cy - d.y, dist = Math.hypot(dx, dy) || 1, f = 260 / (1 + dist / 120);
      FX.shards.push({ data: data, w: w, h: h, x: cx, y: cy, vx: dx / dist * f + (Math.random() - 0.5) * 60, vy: dy / dist * f - 80, a: 0, va: (Math.random() - 0.5) * 4, r: Math.min(w, h) * 0.42 + 2, age: 0, rest: 0 });
    }
    FX.rings.push({ x: d.x, y: d.y, r: 4, life: 0.25 });
    fxSnd("glass", d.x, d.y); fxKick();
  }
  function shardsStep(dt, box) {
    const S2 = FX.shards;
    for (const q of S2) {
      q.age += dt; q.vy += 620 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.a += q.va * dt;
      const hw = Math.min(q.w, q.h) / 2;
      if (q.x < box.x0 + hw) { q.x = box.x0 + hw; q.vx = Math.abs(q.vx) * 0.5; q.va = -q.va * 0.6; }
      if (q.x > box.x1 - hw) { q.x = box.x1 - hw; q.vx = -Math.abs(q.vx) * 0.5; q.va = -q.va * 0.6; }
      if (q.y > box.y1 - hw) { q.y = box.y1 - hw; if (q.vy > 90) fxSnd("clink", q.x, q.y, Math.min(1, q.vy / 500)); q.vy = -q.vy * 0.35; q.vx *= 0.7; q.va *= 0.6; if (Math.abs(q.vy) < 40) { q.vy = 0; q.rest += dt + 0.03; } }
    }
    for (let i = 0; i < S2.length; i++) for (let j = i + 1; j < S2.length; j++) {          // chocs entre éclats, approchés par des disques
      const a = S2[i], b = S2[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01, min = a.r + b.r;
      if (d >= min) continue;
      const nx = dx / d, ny = dy / d, push = (min - d) / 2; a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny; if (rel < 0) { const imp = -1.3 * rel / 2; a.vx -= imp * nx; a.vy -= imp * ny; b.vx += imp * nx; b.vy += imp * ny; a.va += (Math.random() - 0.5); b.va += (Math.random() - 0.5); if (rel < -120) fxSnd("clink", a.x, a.y, Math.min(1, -rel / 500)); }
    }
    for (const q of S2) if (q.rest > 0.45 || q.age > 8) { rotBlit(q, q.x, q.y, q.a, 1, 1, (X, Y, v) => wr(X, Y, v)); q.dead = true; }
    if (S2.some(q => q.dead)) { FX.shards = S2.filter(q => !q.dead); scheduleSave(); }
  }

  /* ---- Croissance corallienne : un contour fermé qui s'allonge sans jamais se recouper. Chaque nœud est
     attiré par ses voisins et repoussé par tous les autres ; les segments trop longs se divisent. */
  function coralStart(d) {
    const nodes = []; for (let k = 0; k < 18; k++) nodes.push({ x: d.x + Math.cos(k / 18 * 6.283) * 8, y: d.y + Math.sin(k / 18 * 6.283) * 8 });
    FX.coral = { nodes: nodes, c: ink || 1, pat: pattern, snap: doc.slice(), tick: 0 };
  }
  function coralStep() {
    const C = FX.coral, N = C.nodes, n = N.length, R = 9;
    const fx2 = new Float32Array(n), fy2 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = N[i], p = N[(i + n - 1) % n], q = N[(i + 1) % n];
      fx2[i] += ((p.x + q.x) / 2 - a.x) * 0.5; fy2[i] += ((p.y + q.y) / 2 - a.y) * 0.5;
      for (let j = i + 1; j < n; j++) { const b = N[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy; if (d2 > R * R || d2 < 0.01) continue; const d = Math.sqrt(d2), f = (R - d) / d * 0.5; fx2[i] += dx * f; fy2[i] += dy * f; fx2[j] -= dx * f; fy2[j] -= dy * f; }
    }
    for (let i = 0; i < n; i++) { N[i].x = Math.max(2, Math.min(DW - 3, N[i].x + Math.max(-1.5, Math.min(1.5, fx2[i])))); N[i].y = Math.max(2, Math.min(DH - 3, N[i].y + Math.max(-1.5, Math.min(1.5, fy2[i])))); }
    if (n < 640) for (let i = N.length - 1; i >= 0; i--) { const a = N[i], b = N[(i + 1) % N.length]; if (Math.hypot(a.x - b.x, a.y - b.y) > 4.5 || Math.random() < 0.012) N.splice(i + 1, 0, { x: (a.x + b.x) / 2 + (Math.random() - 0.5), y: (a.y + b.y) / 2 + (Math.random() - 0.5) }); }
    /* dessin : on repart de la feuille d'origine, on remplit le contour de la trame, on trace le bord */
    doc.set(C.snap);
    let y0 = DH, y1 = 0; for (const q of N) { y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    const P = PAT[C.pat];
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(DH - 1, Math.ceil(y1)); y++) {
      const xs = [];
      for (let i = 0, m = N.length; i < m; i++) { const a = N[i], b = N[(i + 1) % m]; if ((a.y <= y) !== (b.y <= y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y)); }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k])); x <= Math.min(DW - 1, Math.floor(xs[k + 1])); x++) doc[y * DW + x] = P[(y & 7) * 8 + (x & 7)] ? C.c : 0;
    }
    for (let i = 0, m = N.length; i < m; i++) { const a = N[i], b = N[(i + 1) % m]; bline(a.x, a.y, b.x, b.y, C.c === 1 ? 1 : 1, 1); }
    if (++C.tick % 14 === 0) fxSnd("hum", N[0].x, N[0].y, Math.min(1, N.length / 640));
  }

  /* ---- Tour de potier : le profil gauche de la forme tourne autour de son bord droit et devient un
     volume, ombré en trame de Bayer comme un cylindre éclairé de gauche. */
  function latheTurn(d) {
    pushUndo();
    const q = shapeAt(d, true); if (!q) { undoStack.pop(); return; }
    let c = 1; for (const v of q.data) if (v) { c = v; break; }
    const ax = q.x + q.w;                                          // l'axe : le bord droit du profil
    for (let j = 0; j < q.h; j++) {
      let first = -1; for (let i = 0; i < q.w; i++) if (q.data[j * q.w + i]) { first = i; break; }
      if (first < 0) continue;
      const r = q.w - first, Y = q.y + j;
      for (let dx = -r; dx <= r; dx++) {
        const u = dx / (r + 0.5), z = Math.sqrt(Math.max(0, 1 - u * u)), light = 0.5 + 0.5 * (-u * 0.6 + z * 0.8), X = ax + dx, th = bayer(X, Y);
        wp(X, Y, Math.abs(u) > 0.94 ? 1 : light > 0.9 && th < (light - 0.9) * 8 ? 0 : th < (0.62 - light) * 1.5 ? 1 : c);
      }
    }
    fxSnd("lathe", d.x, d.y); scheduleSave(); render();
  }
  /* ---- Extrudeur : la forme prend de l'épaisseur, comme une pile de calques. On tire pour choisir la
     direction et la profondeur ; la tranche reçoit la trame courante, plus ou moins dense selon son angle. */
  function extrudeDraw(q, target) {
    const dx = q.ex || 0, dy = q.ey || 0, n = Math.max(1, Math.round(Math.hypot(dx, dy))), an = Math.atan2(dy, dx);
    const dens = 0.3 + 0.45 * (0.5 + 0.5 * Math.cos(an - 0.8)), P = PAT[pattern], solid = pattern === 0;
    for (let k = n; k >= 1; k--) {
      const ox = Math.round(dx * k / n), oy = Math.round(dy * k / n);
      for (let j = 0; j < q.h; j++) for (let i = 0; i < q.w; i++) { if (!q.data[j * q.w + i]) continue; const X = q.x + i + ox, Y = q.y + j + oy; pxDot(X, Y, (solid ? bayer(X, Y) < dens : P[(Y & 7) * 8 + (X & 7)]) ? 1 : q.data[j * q.w + i], target); }
    }
    for (let j = 0; j < q.h; j++) for (let i = 0; i < q.w; i++) { const v = q.data[j * q.w + i]; if (!v) continue; const edge = i === 0 || j === 0 || i === q.w - 1 || j === q.h - 1 || !q.data[j * q.w + i - 1] || !q.data[j * q.w + i + 1] || !q.data[(j - 1) * q.w + i] || !q.data[(j + 1) * q.w + i]; pxDot(q.x + i, q.y + j, edge ? 1 : v, target); }
  }
  /* ---- Origami : la partie de la forme située à droite du pli se rabat par-dessus, en perspective
     (elle se resserre en largeur et s'ouvre en hauteur vers son bord libre). On lâche : elle retombe. */
  function foldDraw(q, target) {
    const fx3 = Math.max(4, Math.min(q.w - 4, q.fx)), th = q.th || 0, cs = Math.cos(th), sn = Math.sin(th);
    for (let j = 0; j < q.h; j++) for (let i = 0; i < fx3; i++) { const v = q.data[j * q.w + i]; if (v) pxDot(q.x + i, q.y + j, v, target); }      // la partie fixe
    const pw = q.w - fx3, W = Math.max(1, Math.round(pw * Math.abs(cs)));
    for (let a = 0; a < W; a++) {
      const u = (a + 0.5) / W, si = fx3 + Math.min(pw - 1, Math.floor(u * pw)), X = q.x + fx3 + (cs >= 0 ? a : -a - 1), sc = 1 + 0.3 * sn * u, H = Math.round(q.h * sc), Y0 = q.y + Math.round((q.h - H) / 2 - sn * u * 10);
      for (let b = 0; b < H; b++) { const v = q.data[Math.min(q.h - 1, Math.floor(b / sc)) * q.w + si]; if (!v) continue; const Y = Y0 + b; pxDot(X, Y, cs < 0 && bayer(X, Y) < 0.5 ? 4 : cs < 0 ? 0 : (bayer(X, Y) < sn * 0.35 ? 1 : v), target); }   // rabattue : on voit le dos du papier
      if (a === W - 1 || a === 0) for (let b = 0; b < H; b++) pxDot(X, Y0 + b, 1, target);
    }
  }
  /* ---- Pinceau découpé 3D : un clic sur une forme en fait un pinceau. On peint avec ; il tourne le long
     du trait autour des axes choisis au clavier (X, Y, Z), et C fait défiler ses couleurs. N : nouveau pinceau. */
  /* La forme capturée garde sa taille à l'épaisseur du moment ; changer l'épaisseur ensuite la grossit ou la réduit d'autant. */
  function customScale() { const q = FX.cbrush, m = Math.max(q.w, q.h); return Math.max(4 / m, Math.min(500 / m, PW() / (q.pw0 || PW()))); }
  function customStamp(d, len) {
    const q = FX.cbrush, m = FX.cb, t = len / 46, k = customScale();
    rotBlit(q, d.x, d.y, m.rz ? t : 0, k * (m.ry ? Math.cos(t * 1.3) : 1), k * (m.rx ? Math.cos(t * 0.9 + 0.6) : 1), (X, Y, v) => wr(X, Y, m.cyc ? (FX.useRamp ? 184 : 16 + 4 * 8) + ((((len >> 2) + X + Y) >> 1) & 7) : v));
  }
  function customMove(a, d) {
    if (!FX.cbrush) return;
    const n = Math.max(1, Math.round(Math.hypot(d.x - a.x, d.y - a.y))), step = Math.max(2, Math.round(Math.min(FX.cbrush.w, FX.cbrush.h) * customScale() / 7));
    for (let k = 1; k <= n; k++) { drag.len++; if (drag.len % step === 0) customStamp({ x: Math.round(a.x + (d.x - a.x) * k / n), y: Math.round(a.y + (d.y - a.y) * k / n) }, drag.len); }
    if (Math.random() < 0.3) fxSnd("stamp", d.x, d.y);
  }
  function customKey(e) {
    const k = e.key.toLowerCase(), m = FX.cb;
    if (k === "x") m.rx = !m.rx; else if (k === "y") m.ry = !m.ry; else if (k === "z") m.rz = !m.rz; else if (k === "c") m.cyc = !m.cyc; else if (k === "n") FX.cbrush = null; else return false;
    uiSnd("item", "xyzcn".indexOf(k)); render(); return true;
  }

  /* ---- Éditeur de rampe : huit cases à remplir avec les couleurs de la palette, et une vitesse. */
  const RD = { on: false, slot: 0 };
  function rampRect() { return { x: Math.round((SW - 360) / 2), y: Math.round((SH - 190) / 2), w: 360, h: 190 }; }
  function rampSave() { try { localStorage.setItem("colorpaint.ramp", JSON.stringify({ c: FX.ramp, hz: FX.rampHz, use: FX.useRamp })); } catch (e) {} }
  try { const o = JSON.parse(localStorage.getItem("colorpaint.ramp") || "null"); if (o && o.c && o.c.length === 8) { FX.ramp = o.c.map(v => v & 15); FX.rampHz = o.hz || 10; FX.useRamp = !!o.use; } } catch (e) {}
  function rampClick(p) {
    const r = rampRect(), x = p.x - r.x, y = p.y - r.y;
    if (y >= 36 && y < 53 && x >= 20 && x < 20 + 8 * 20) RD.slot = Math.floor((x - 20) / 20);
    else if (y >= 78 && y < 95 && x >= 20 && x < 20 + 16 * 20) { FX.ramp[RD.slot] = Math.floor((x - 20) / 20); RD.slot = (RD.slot + 1) % 8; uiSnd("item", RD.slot); }
    else if (y >= 108 && y < 126) { [4, 10, 20].forEach((v, i) => { if (x >= 86 + i * 78 && x < 160 + i * 78) FX.rampHz = v; }); }
    else if (y >= 130 && y < 148 && x >= 16 && x < 300) FX.useRamp = !FX.useRamp;
    else if (y >= 158 && y < 180 && x >= 270 && x < 340) { RD.on = false; }
    rampSave(); fxKick(); render();
  }
  function drawRampDialog() {
    const r = rampRect(), T = (str, x, y) => blit(ctx, textBmp(str, "Chicago", 12, false, false), r.x + x, r.y + y);
    ctx.fillStyle = "#000"; for (let j = 0; j < r.h; j += 2) for (let i = 2; i < r.w + 2; i += 2) ctx.fillRect(r.x + i, r.y + j + 2, 1, 1);
    ctx.fillStyle = "#fff"; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#000"; ctx.fillRect(r.x, r.y, r.w, 1); ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1); ctx.fillRect(r.x, r.y, 1, r.h); ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
    ctx.fillRect(r.x + 3, r.y + 3, r.w - 6, 2); ctx.fillRect(r.x + 3, r.y + r.h - 5, r.w - 6, 2); ctx.fillRect(r.x + 3, r.y + 3, 2, r.h - 6); ctx.fillRect(r.x + r.w - 5, r.y + 3, 2, r.h - 6);
    T("Color ramp : pick a box, then a color", 16, 13);
    const cells = (x0, y0, n, col, sel) => { ctx.fillStyle = "#000"; ctx.fillRect(r.x + x0 - 1, r.y + y0 - 1, n * 20 + 1, 18); for (let i = 0; i < n; i++) { ctx.fillStyle = PALETTE[col(i)]; ctx.fillRect(r.x + x0 + i * 20, r.y + y0, 19, 16); if (i === sel) { ctx.fillStyle = "#fff"; ctx.fillRect(r.x + x0 + i * 20 + 1, r.y + y0 + 1, 17, 2); ctx.fillRect(r.x + x0 + i * 20 + 1, r.y + y0 + 13, 17, 2); ctx.fillRect(r.x + x0 + i * 20 + 1, r.y + y0 + 1, 2, 14); ctx.fillRect(r.x + x0 + i * 20 + 16, r.y + y0 + 1, 2, 14); ctx.fillStyle = "#000"; ctx.fillRect(r.x + x0 + i * 20 + 3, r.y + y0 + 3, 13, 1); ctx.fillRect(r.x + x0 + i * 20 + 3, r.y + y0 + 12, 13, 1); ctx.fillRect(r.x + x0 + i * 20 + 3, r.y + y0 + 3, 1, 10); ctx.fillRect(r.x + x0 + i * 20 + 15, r.y + y0 + 3, 1, 10); } } ctx.fillStyle = "#000"; };
    cells(20, 36, 8, i => FX.ramp[i], RD.slot);
    /* l'aperçu : la rampe qui tourne */
    const ph = Math.floor(FX.cycT / 1000 * FX.rampHz);
    for (let i = 0; i < 64; i++) { ctx.fillStyle = PALETTE[FX.ramp[(((Math.floor(i / 2) - ph) % 8) + 8) % 8]]; ctx.fillRect(r.x + 200 + i * 2, r.y + 36, 2, 16); }
    ctx.fillStyle = "#000"; ctx.fillRect(r.x + 199, r.y + 35, 130, 1); ctx.fillRect(r.x + 199, r.y + 52, 130, 1); ctx.fillRect(r.x + 199, r.y + 35, 1, 18); ctx.fillRect(r.x + 328, r.y + 35, 1, 18);
    cells(20, 78, 16, i => i, -1);
    const radio = (x, y, on) => { const X = r.x + x, Y = r.y + y; ctx.fillStyle = "#000"; ctx.fillRect(X + 3, Y, 6, 12); ctx.fillRect(X, Y + 3, 12, 6); ctx.fillRect(X + 1, Y + 1, 10, 10); ctx.fillStyle = "#fff"; ctx.fillRect(X + 3, Y + 1, 6, 10); ctx.fillRect(X + 1, Y + 3, 10, 6); ctx.fillRect(X + 2, Y + 2, 8, 8); if (on) { ctx.fillStyle = "#000"; ctx.fillRect(X + 4, Y + 3, 4, 6); ctx.fillRect(X + 3, Y + 4, 6, 4); } ctx.fillStyle = "#000"; };
    T("Speed", 20, 109); [["Slow", 4], ["Medium", 10], ["Fast", 20]].forEach((q, i) => { radio(86 + i * 78, 110, FX.rampHz === q[1]); T(q[0], 102 + i * 78, 109); });
    ctx.fillStyle = "#000"; ctx.fillRect(r.x + 20, r.y + 132, 12, 12); ctx.fillStyle = "#fff"; ctx.fillRect(r.x + 21, r.y + 133, 10, 10); ctx.fillStyle = "#000";
    if (FX.useRamp) for (let k = 0; k < 10; k++) { ctx.fillRect(r.x + 21 + k, r.y + 133 + k, 1, 1); ctx.fillRect(r.x + 30 - k, r.y + 133 + k, 1, 1); }
    T("Use this ramp for the cycling tools", 40, 131);
    const bx = r.x + 270, by = r.y + 158; ctx.fillRect(bx - 3, by - 2, 76, 26); ctx.fillStyle = "#fff"; ctx.fillRect(bx - 1, by, 72, 22); ctx.fillStyle = "#000"; ctx.fillRect(bx + 1, by, 68, 22); ctx.fillRect(bx, by + 1, 70, 20); ctx.fillStyle = "#fff"; ctx.fillRect(bx + 1, by + 1, 68, 20); ctx.fillStyle = "#000"; const tb = textBmp("Done", "Chicago", 12, false, false); blit(ctx, tb, bx + 35 - (tb.w >> 1), by + 4);
  }

  /* ---- Encre humide. Elle ne rentre pas dans la feuille : chaque point est une particule qui
     tombe selon la gravité du volant, glisse sur ce qui est sec (le dessin du calque actif fait
     barrage) et s'accumule. Les encres ont une densité : une lourde traverse une légère, qui
     remonte. Le séchoir les fixe, et elles deviennent à leur tour un mur. */
  const DENS = [0, 3, 3, 2, 1, 2, 3, 2, 2, 1, 2, 3, 1, 3, 3, 3];                   // 1 : légère (jaune, cyan, gris clair) ; 3 : lourde (noir, bleu, magenta…)
  const DIR8 = [[0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1]];  // de « bas », en tournant vers la droite
  const WET_MAX = 70000;
  function wetInit() { if (!FX.wetAt || FX.wetAt.length !== DW * DH) { FX.wetAt = new Uint8Array(DW * DH); FX.wetIdx = new Int32Array(DW * DH); FX.parts = []; } }
  function wetAdd(x, y, c) {
    if (!inPage(x, y)) return;
    const k = y * DW + x;
    if (doc[k] || FX.wetAt[k]) return;
    if (FX.parts.length >= WET_MAX) wetDry(() => true, 2000);    // trop d'encre : la plus ancienne sèche
    FX.wetAt[k] = c; FX.parts.push(k); FX.wetIdx[k] = FX.parts.length;
  }
  function wetMove(a, d) {
    wetInit();
    const R = LW(), c = ink || 1, n = Math.max(1, Math.ceil(Math.hypot(d.x - a.x, d.y - a.y) / 2));
    for (let q = 0; q <= n; q++) { const x = Math.round(a.x + (d.x - a.x) * q / n), y = Math.round(a.y + (d.y - a.y) * q / n); for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) if (i * i + j * j <= R * R) wetAdd(x + i, y + j, c); }
    if (Math.random() < 0.3) fxSnd("pour", d.x, d.y);
    fxKick();
  }
  /* Sèche les particules choisies (au plus max, en partant des plus anciennes) : elles entrent dans la feuille. */
  function wetDry(test, max) {
    if (!FX.wetAt) return 0;
    const keep = []; let n = 0;
    for (const k of FX.parts) {
      if (k < 0) continue;
      if ((max === undefined || n < max) && test(k % DW, (k / DW) | 0)) { doc[k] = FX.wetAt[k]; FX.wetAt[k] = 0; FX.wetIdx[k] = 0; n++; }
      else keep.push(k);
    }
    FX.parts = keep; for (let i = 0; i < keep.length; i++) FX.wetIdx[keep[i]] = i + 1;
    return n;
  }
  function dryerMove(a, d) {
    const R = brushR() + 6;
    if (wetDry((x, y) => (x - d.x) * (x - d.x) + (y - d.y) * (y - d.y) <= R * R)) fxSnd("dry", d.x, d.y);
    else if (Math.random() < 0.2) fxSnd("roll", d.x, d.y);
  }
  function wetStep() {
    const P = FX.parts, W = FX.wetAt, I = FX.wetIdx; if (!P.length) return;
    const a = ((FX.grav % 360) + 360) % 360 / 45, lo = Math.floor(a) % 8, fr = a - Math.floor(a);
    let moved = 0, gone = 0;
    const H = FX.hotAt && FX.hotAt.length === DW * DH ? FX.hotAt : null, N2 = DW * DH;
    const free = (k) => !doc[k] && !W[k];
    for (let pass = 0; pass < 2; pass++) for (let i = P.length - 1; i >= 0; i--) {
      const k = P[i]; if (k < 0) continue;
      const x = k % DW, y = (k / DW) | 0, c = W[k];
      if (H && pass === 0 && Math.random() < 0.12 && (H[k + DW] || H[k - 1] || H[k + 1] || H[Math.min(N2 - 1, k + 2 * DW)] || H[Math.min(N2 - 1, k + 3 * DW)])) { W[k] = 0; I[k] = 0; P[i] = -1; gone++; if (Math.random() < 0.3) { puff(x, y); fxSnd("fizz", x, y); } continue; }   // sur la braise : elle bout et s'évapore
      const d0 = (lo + (Math.random() < fr ? 1 : 0)) % 8, side = Math.random() < 0.5 ? 1 : 7;
      let done = false;
      for (const t of [d0, (d0 + side) % 8, (d0 + 8 - side) % 8, (d0 + side * 2) % 8, (d0 + 16 - side * 2) % 8]) {
        const nx = x + DIR8[t][0], ny = y + DIR8[t][1];
        if (nx < 0 || ny < 0 || nx >= DW || ny >= DH) continue;
        const nk = ny * DW + nx;
        if (free(nk)) { W[k] = 0; I[k] = 0; W[nk] = c; I[nk] = i + 1; P[i] = nk; moved++; done = true; break; }
        /* plus lourde que l'encre qui est dessous : elles échangent leurs places (seulement vers le bas) */
        if (t === d0 && W[nk] && W[nk] < 16 && c < 16 && DENS[W[nk]] < DENS[c] && Math.random() < 0.5) {
          const j = I[nk] - 1, oc = W[nk];
          W[nk] = c; W[k] = oc; P[i] = nk; P[j] = k; I[nk] = i + 1; I[k] = j + 1; moved++; done = true; break;
        }
      }
      if (done) continue;
    }
    if (gone) { FX.parts = P.filter(k => k >= 0); for (let i = 0; i < FX.parts.length; i++) I[FX.parts[i]] = i + 1; moved += gone; }
    FX.moving = moved;
    if (moved > 40 && Math.random() < Math.min(0.6, moved / 4000 + 0.05)) { const k = P[Math.floor(Math.random() * P.length)]; fxSnd("trickle", k % DW, (k / DW) | 0, Math.min(1, moved / 6000)); }
  }
  function wetCompose() { const P = FX.parts, W = FX.wetAt; for (let i = 0; i < P.length; i++) docPx[P[i]] = PAL32[W[P[i]]]; }
  /* Le volant d'inclinaison : un cadran sous la palette de gauche. L'aiguille montre le « bas ». */
  const DIAL = { x: 41, y: 286, r: 22, box: 26 };                  // le cadran tient dans une case carrée, de la largeur de la palette d'outils
  function drawDial() {
    const cx = DIAL.x, cy = DIAL.y, r = DIAL.r, B = DIAL.box;
    ctx.fillStyle = "#000"; ctx.fillRect(cx - B, cy - B, B * 2 + 1, B * 2 + 1); ctx.fillStyle = "#fff"; ctx.fillRect(cx - B + 1, cy - B + 1, B * 2 - 1, B * 2 - 1);   // la case : filet noir, fond blanc, comme les outils
    ctx.fillStyle = "#000";
    for (let t = 0; t < 24; t++) { const an = t * Math.PI / 12, L = t % 6 === 0 ? 5 : t % 3 === 0 ? 3 : 1; for (let q = 0; q < L; q++) ctx.fillRect(Math.round(cx + Math.sin(an) * (r - 1 - q)), Math.round(cy + Math.cos(an) * (r - 1 - q)), 1, 1); }
    const an = FX.grav * Math.PI / 180, sx = Math.sin(an), sy = Math.cos(an);
    for (let q = -6; q <= r - 7; q++) { ctx.fillRect(Math.round(cx + sx * q), Math.round(cy + sy * q), 1, 1); if (q > 0) ctx.fillRect(Math.round(cx + sx * q + sy * 0.5), Math.round(cy + sy * q - sx * 0.5), 1, 1); }
    for (let q = 0; q < 6; q++) for (let w = -q; w <= q; w++) ctx.fillRect(Math.round(cx + sx * (r - 7 - q) + sy * w * 0.7), Math.round(cy + sy * (r - 7 - q) - sx * w * 0.7), 1, 1);   // pointe
    ctx.fillStyle = "#fff"; ctx.fillRect(cx - 1, cy - 1, 3, 3); ctx.fillStyle = "#000"; ctx.fillRect(cx, cy, 1, 1);
  }
  function dialSet(p) {
    const dx = p.x - DIAL.x, dy = p.y - DIAL.y;
    const g = Math.hypot(dx, dy) < 5 ? 0 : ((Math.round(Math.atan2(dx, dy) * 180 / Math.PI / 15) * 15) + 360) % 360;   // crans de 15° ; le centre remet d'aplomb
    if (g !== FX.grav) { FX.grav = g; uiSnd("tilt", g / 15); fxKick(); render(); }
  }

  /* ---- Rouleau de Bayer : ne dépose rien ; à chaque passage, ce qui est dessous perd la moitié de
     ses points (plein, puis damier 50 %, 25 %, 12,5 %). Les trames s'emboîtent : rien ne revient. */
  function bayerMove(a, d) {
    if (!FX.thin || FX.thin.length !== DW * DH) { FX.thin = new Uint8Array(DW * DH); FX.thinId = new Uint16Array(DW * DH); }
    const R = brushR(), id = drag.id;
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      if (i * i + j * j > R * R) continue;
      const X = d.x + i, Y = d.y + j; if (!inPage(X, Y)) continue;
      const k = Y * DW + X;
      if (!doc[k] || FX.thinId[k] === id || FX.thin[k] >= 3) continue;            // une seule fois par geste
      FX.thinId[k] = id; const L = ++FX.thin[k];
      const keep = L === 1 ? ((X + Y) & 1) === 0 : L === 2 ? (X & 1) === 0 && (Y & 1) === 0 : (X & 3) === 0 && (Y & 1) === 0;
      if (!keep) wr(X, Y, 0);
    }
    if (Math.random() < 0.3) fxSnd("roll", d.x, d.y);
  }
  /* ---- Mélangeur optique : sur une frontière entre deux couleurs, il pose leur damier, sans
     jamais inventer une troisième couleur. Il lit l'image telle qu'elle était au début du geste. */
  function blendMove(a, d) {
    const R = brushR(), src = drag.snap, cnt = new Uint16Array(NPAL);
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      if (i * i + j * j > R * R) continue;
      const X = d.x + i, Y = d.y + j; if (!inPage(X, Y)) continue;
      cnt.fill(0);
      for (let v = -3; v <= 3; v++) for (let u = -3; u <= 3; u++) { const x2 = X + u, y2 = Y + v; if (inPage(x2, y2)) cnt[src[y2 * DW + x2]]++; }
      let A = 0, B = -1;
      for (let c = 1; c < NPAL; c++) if (cnt[c] > cnt[A]) A = c;
      for (let c = 0; c < NPAL; c++) if (c !== A && cnt[c] > 0 && (B < 0 || cnt[c] > cnt[B])) B = c;
      if (B < 0 || cnt[B] < 6) continue;                                          // pas de frontière ici
      wr(X, Y, ((X + Y) & 1) ? Math.max(A, B) : Math.min(A, B));
    }
    if (Math.random() < 0.3) fxSnd("mix", d.x, d.y);
  }
  /* ---- Peigne à trames : seules les lignes impaires glissent, d'un point par pas, dans le sens du geste. */
  function combMove(a, d) {
    drag.acc = (drag.acc || 0) + (d.x - a.x);
    const R = brushR() + 3;
    while (Math.abs(drag.acc) >= 2) {
      const dir = drag.acc > 0 ? 1 : -1; drag.acc -= dir * 2;
      for (let j = -R; j <= R; j++) {
        const Y = d.y + j; if (Y < 0 || Y >= DH || !(Y & 1)) continue;
        const h = Math.floor(Math.sqrt(R * R - j * j)), xa = Math.max(0, d.x - h), xb = Math.min(DW - 1, d.x + h);
        if (dir > 0) for (let X = xb; X > xa; X--) doc[Y * DW + X] = doc[Y * DW + X - 1];
        else for (let X = xa; X < xb; X++) doc[Y * DW + X] = doc[Y * DW + X + 1];
      }
      fxSnd("comb", d.x, d.y);
    }
  }
  /* ---- Vagues : sous le pinceau, chaque ligne glisse à l'horizontale selon une sinusoïde. */
  function wavesMove(a, d) {
    const R = brushR() + 4, src = drag.snap;
    for (let j = -R; j <= R; j++) {
      const Y = d.y + j; if (Y < 0 || Y >= DH) continue;
      const off = Math.round(Math.sin(Y / 5 + drag.ph) * 4), h = Math.floor(Math.sqrt(R * R - j * j));
      for (let X = Math.max(0, d.x - h); X <= Math.min(DW - 1, d.x + h); X++) { const sx = X - off; doc[Y * DW + X] = sx >= 0 && sx < DW ? src[Y * DW + sx] : 0; }
    }
    if (Math.random() < 0.25) fxSnd("wave", d.x, d.y);
  }

  /* ---- Levure : un trait fin, qui se met à lever une seconde après le geste. Il gonfle, cloque,
     quadruple de volume, puis se fige. */
  const yeastScale = () => Math.max(0.4, Math.min(10, PW() / 4));  // la pâte lève jusqu'à deux fois et demie l'épaisseur courante environ (plafonnée)
  function yeastEnd(dr) {
    if (!dr.pts || dr.pts.length < 2) return;
    FX.dough.push({ pts: dr.pts.map(q => ({ x: q.x, y: q.y, k: 0.6 + Math.random() * 0.8 })), c: dr.c || 1, t: -1, r: 1, s: yeastScale() });
    fxKick();
  }
  function doughStep(dt) {
    for (const g of FX.dough) {
      g.t += dt; if (g.t < 0) continue;
      const gs = g.s || 1;
      g.r = (1 + Math.min(1, g.t / 3.2) * 4.2) * gs;                              // de 2 à 10 points de large environ, fois l'échelle
      const hop = Math.max(1, Math.floor(g.r / 5));                               // grosse pâte : inutile de repeindre chaque point
      const last = g.pts.length - 1;
      for (let pi = 0; pi <= last; pi = pi === last ? last + 1 : Math.min(last, pi + hop)) {   // toujours le dernier point
        const q = g.pts[pi], r = g.r * (hop > 1 ? 0.85 + (q.k - 1) * 0.35 : q.k), R = Math.ceil(r);
        for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { const dd = i * i + j * j; if (dd <= r * r) wp(q.x + i, q.y + j, dd > (r - 1.2) * (r - 1.2) && r > 2.5 ? 1 : g.c); }
      }
      if (Math.random() < dt * 9 && g.r > 2.2 * gs) {                                  // une cloque : un rond tramé qui perce la pâte
        const q = g.pts[Math.floor(Math.random() * g.pts.length)], br = 1 + Math.random() * g.r * 0.45, cx = q.x + Math.round((Math.random() - 0.5) * g.r), cy = q.y + Math.round((Math.random() - 0.5) * g.r);
        const BR = Math.max(2, Math.ceil(br)); for (let j = -BR; j <= BR; j++) for (let i = -BR; i <= BR; i++) if (i * i + j * j <= br * br && inPage(cx + i, cy + j) && doc[(cy + j) * DW + cx + i] === g.c) wr(cx + i, cy + j, ((cx + i + cy + j) & 1) ? 0 : g.c);
        fxSnd("rise", q.x, q.y);
      }
      if (g.t > 3.4) g.dead = true;
    }
    if (FX.dough.some(g => g.dead)) { FX.dough = FX.dough.filter(g => !g.dead); scheduleSave(); }
  }

  /* ---- Boule de démolition : on tire en arrière comme un lance-pierre, on lâche. La bille rebondit
     sur les bords ; tout ce qu'elle touche de peint tombe en briques de 8 × 8, trame comprise. */
  function ballEnd(dr) {
    const dx = dr.a.x - dr.d.x, dy = dr.a.y - dr.d.y;
    if (Math.hypot(dx, dy) < 4) return;
    pushUndo();
    FX.wreck.push({ x: dr.d.x, y: dr.d.y, vx: dx * 7, vy: dy * 7, r: TK("size", [3, 5, 12], "ball"), life: 7, hits: 0 });
    fxSnd("launch", dr.d.x, dr.d.y); fxKick();
  }
  function wreckStep(dt, box) {
    for (const b of FX.wreck) {
      b.life -= dt; b.vy += 260 * dt;
      const steps = Math.max(1, Math.ceil(Math.hypot(b.vx, b.vy) * dt / 3));
      for (let s2 = 0; s2 < steps; s2++) {
        b.x += b.vx * dt / steps; b.y += b.vy * dt / steps;
        let wall = false;
        if (b.x < box.x0 + b.r) { b.x = box.x0 + b.r; b.vx = Math.abs(b.vx) * 0.9; wall = true; }
        if (b.x > box.x1 - b.r - 1) { b.x = box.x1 - b.r - 1; b.vx = -Math.abs(b.vx) * 0.9; wall = true; }
        if (b.y < box.y0 + b.r) { b.y = box.y0 + b.r; b.vy = Math.abs(b.vy) * 0.9; wall = true; }
        if (b.y > box.y1 - b.r - 1) { b.y = box.y1 - b.r - 1; b.vy = -Math.abs(b.vy) * 0.86; wall = true; }
        if (wall) { b.hits++; fxSnd("ping", b.x, b.y); }
        const X = Math.round(b.x), Y = Math.round(b.y); let touch = false;
        for (let j = -b.r; j <= b.r && !touch; j += 2) for (let i = -b.r; i <= b.r; i += 2) if (inPage(X + i, Y + j) && doc[(Y + j) * DW + X + i]) { touch = true; break; }
        if (touch) {
          shatter(X - 10, Y - 10, X + 10, Y + 10, () => true, X - b.vx * 0.02, Y - b.vy * 0.02, 90, 60);
          b.vx *= 0.93; b.vy *= 0.93; fxSnd("smash", b.x, b.y);
        }
      }
      if (b.life <= 0 || b.hits > 16 || Math.hypot(b.vx, b.vy) < 25) b.dead = true;
    }
    FX.wreck = FX.wreck.filter(b => !b.dead);
  }

  /* ---- Guillotine : un trait à travers la feuille ; ce qui est au-dessus glisse le long de la pente,
     comme une plaque, jusqu'à buter contre le bord. */
  function sliceEnd(dr) {
    const ax = dr.a.x, ay = dr.a.y, bx = dr.d.x, by = dr.d.y, L = Math.hypot(bx - ax, by - ay);
    if (L < 12) return;
    pushUndo();
    const ux = (bx - ax) / L, uy = (by - ay) / L;                                  // le bloc glisse dans le sens du geste, le long de la faille
    const data = new Uint8Array(DW * DH); let x0 = DW, y0 = DH, x1 = -1, y1 = -1;
    for (let y = 0; y < DH; y++) for (let x = 0; x < DW; x++) {
      const side = (bx - ax) * (y - ay) - (by - ay) * (x - ax), up = (bx - ax) > 0 ? side < 0 : (bx - ax) < 0 ? side > 0 : x < ax;   // « au-dessus » du trait (à gauche s'il est vertical)
      if (!up) continue;
      const k = y * DW + x, v = doc[k];
      if (v) { data[k] = v; doc[k] = 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return;
    const c = document.createElement("canvas"); c.width = x1 - x0 + 1; c.height = y1 - y0 + 1;
    const g = c.getContext("2d"), im = g.createImageData(c.width, c.height), p32 = new Uint32Array(im.data.buffer);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const v = data[y * DW + x]; if (v) p32[(y - y0) * c.width + x - x0] = PAL32[v]; }
    g.putImageData(im, 0, 0);
    FX.plates.push({ data: data, c: c, x0: x0, y0: y0, x1: x1, y1: y1, ux: ux, uy: uy, s: 0, D: Math.max(14, Math.min(220, L * 0.3)) * TK("slip", [0.4, 1, 2.2], "slice") * (0.75 + Math.random() * 0.5) });   // glissement : proportionnel à la longueur du trait, avec une part de hasard
    fxSnd("slide", ax, ay); fxKick();
  }
  function platesStep(dt, box) {
    for (const q of FX.plates) {
      const step = Math.max(24 * dt, (q.D - q.s) * (1 - Math.exp(-dt * 4.5)));    // part vite, freine, puis s'arrête tout seul
      q.v = step / Math.max(0.001, dt); q.s = Math.min(q.D, q.s + step);
      const ox = Math.round(q.ux * q.s), oy = Math.round(q.uy * q.s);
      if (q.s >= q.D) {                                                            // fin du glissement : le bloc rentre dans le dessin, ce qui sort de la feuille est perdu
        for (let y = q.y0; y <= q.y1; y++) for (let x = q.x0; x <= q.x1; x++) { const v = q.data[y * DW + x]; if (v && inPage(x + ox, y + oy)) doc[(y + oy) * DW + x + ox] = v; }
        q.dead = true; fxSnd("thud", q.x1 + ox, q.y1 + oy, Math.min(1, q.v / 500)); scheduleSave();
      } else if (Math.random() < 0.2) fxSnd("grind", q.x0 + ox, q.y0 + oy);
      q.ox = ox; q.oy = oy;
    }
    FX.plates = FX.plates.filter(q => !q.dead);
  }

  /* ---- Pompe à vélo : on clique sur un aplat et on tient. La forme enfle point par point ; son
     volume est rendu par des anneaux de trame de Bayer (bord sombre, corps de couleur, reflet blanc).
     Trop gonflée, elle éclate en lambeaux. */
  function pumpStart(d) {
    const rg = region(d.x, d.y, 60000);
    if (!rg) return false;
    const mask = new Uint8Array(DW * DH); for (const i of rg.list) mask[i] = 1;
    FX.pump = { mask: mask, c: rg.c, x0: rg.x0, y0: rg.y0, x1: rg.x1, y1: rg.y1, area0: rg.list.length, area: rg.list.length, next: 0, steps: 0, res: topt("resist", "pump") === undefined ? 1 : topt("resist", "pump") };   // résistance choisie au moment où l'on commence à gonfler
    return true;
  }
  function pumpStep(t) {
    const P = FX.pump; if (!P || t < P.next) return;
    P.next = t + 75; P.steps++;
    const m = P.mask, add = [];
    for (let y = Math.max(0, P.y0 - 1); y <= Math.min(DH - 1, P.y1 + 1); y++) for (let x = Math.max(0, P.x0 - 1); x <= Math.min(DW - 1, P.x1 + 1); x++) {
      const k = y * DW + x; if (m[k]) continue;
      if ((x > 0 && m[k - 1]) || (x < DW - 1 && m[k + 1]) || (y > 0 && m[k - DW]) || (y < DH - 1 && m[k + DW])) { if (((x + y + P.steps) % 3) !== 0 || P.steps % 2) add.push(k); }
    }
    for (const k of add) { m[k] = 1; const x = k % DW, y = (k / DW) | 0; if (x < P.x0) P.x0 = x; if (x > P.x1) P.x1 = x; if (y < P.y0) P.y0 = y; if (y > P.y1) P.y1 = y; }
    P.area += add.length;
    /* carte de distance au bord (deux passes), puis ombrage */
    const w = P.x1 - P.x0 + 1, h = P.y1 - P.y0 + 1, D = new Uint16Array(w * h); let dmax = 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = y * w + x; if (!m[(y + P.y0) * DW + x + P.x0]) { D[k] = 0; continue; } D[k] = Math.min(x > 0 ? D[k - 1] + 1 : 1, y > 0 ? D[k - w] + 1 : 1); }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) { const k = y * w + x; if (!D[k]) continue; D[k] = Math.min(D[k], x < w - 1 ? D[k + 1] + 1 : 1, y < h - 1 ? D[k + w] + 1 : 1); if (D[k] > dmax) dmax = D[k]; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dd = D[y * w + x]; if (!dd) continue;
      const X = x + P.x0, Y = y + P.y0, tt = dd / dmax, th = bayer(X, Y);
      const glint = tt - ((x / w - 0.32) * (x / w - 0.32) + (y / h - 0.3) * (y / h - 0.3)) * 2.2;       // le reflet, en haut à gauche du sommet
      doc[Y * DW + X] = dd <= 1 ? 1 : glint > 0.62 && th < (glint - 0.62) * 3.5 ? 0 : th < (0.5 - tt) * 0.95 ? 1 : P.c;
    }
    const tension = P.area / P.area0;
    fxSnd("pump", (P.x0 + P.x1) / 2, (P.y0 + P.y1) / 2, Math.min(1, (tension - 1) / 5));
    if (!P.d0) P.d0 = dmax;
    const rk = [0.45, 1, 2.4, 1e9][P.res], big = w > DW * (P.res >= 2 ? 0.96 : 0.8) || h > DH * (P.res >= 2 ? 0.96 : 0.8);
    if (P.res === 3) { if (big) { FX.pump = null; drag = null; scheduleSave(); } }                // increvable : elle s'arrête de gonfler quand elle remplit la feuille
    else if (tension > 1 + 4 * rk || dmax > P.d0 * (1 + 0.9 * rk) + 10 * rk || big) {              // trop : elle éclate
      const cx = (P.x0 + P.x1) / 2, cy = (P.y0 + P.y1) / 2;
      shatter(P.x0, P.y0, P.x1, P.y1, (X, Y) => m[Y * DW + X] === 1, cx, cy, 420, 120);
      FX.rings.push({ x: cx, y: cy, r: 4, life: 0.25 });
      fxSnd("pop", cx, cy); FX.pump = null; drag = null; scheduleSave();
    }
  }

  /* ---- Gouttes amibes : des gouttes gélatineuses, vivantes quelques secondes. À moins de 15 points
     l'une de l'autre, elles s'étirent, se rejoignent et fusionnent ; deux couleurs donnent un damier. */
  function blobField(x0, y0, w, h, put) {
    const B = FX.blobs;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const X = x0 + x, Y = y0 + y; let f = 0, fa = 0, fb = 0, A = null, Bb = null;
      for (const q of B) { const dx = X - q.x, dy = Y - q.y, v = q.r * q.r / (dx * dx + dy * dy + 0.5); if (v < 0.02) continue; f += v; if (v > fa) { fb = fa; Bb = A; fa = v; A = q; } else if (v > fb) { fb = v; Bb = q; } }
      if (f < 1 || !A) continue;
      let c = A.c;
      if (A.c2) c = ((X + Y) & 1) ? A.c : A.c2;
      else if (Bb && Bb.c !== A.c && fb > fa * 0.3) c = ((X + Y) & 1) ? A.c : Bb.c;
      put(X, Y, f < 1.18 ? 1 : c);                                                 // un liseré noir, comme une membrane
    }
  }
  function blobBox() { let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const q of FX.blobs) { const m = q.r * 2.4 + 4; x0 = Math.min(x0, q.x - m); y0 = Math.min(y0, q.y - m); x1 = Math.max(x1, q.x + m); y1 = Math.max(y1, q.y + m); } return { x0: Math.max(0, Math.floor(x0)), y0: Math.max(0, Math.floor(y0)), x1: Math.min(DW - 1, Math.ceil(x1)), y1: Math.min(DH - 1, Math.ceil(y1)) }; }
  function blobsBake() { if (!FX.blobs.length) return; const b = blobBox(); blobField(b.x0, b.y0, b.x1 - b.x0 + 1, b.y1 - b.y0 + 1, (X, Y, c) => wp(X, Y, c)); FX.blobs = []; scheduleSave(); }
  function blobsStep(dt) {
    const B = FX.blobs; let busy = false;
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
      const a = B[i], b = B[j]; if (a.dead || b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
      if (d > a.r + b.r + 15) continue;
      busy = true;
      const pull = 55 * dt / d; a.vx += dx * pull; a.vy += dy * pull; b.vx -= dx * pull; b.vy -= dy * pull;
      if (d < Math.max(a.r, b.r) * 0.55) {                                         // fusion
        const wa = a.r * a.r, wb = b.r * b.r;
        a.x = (a.x * wa + b.x * wb) / (wa + wb); a.y = (a.y * wa + b.y * wb) / (wa + wb); a.r = Math.sqrt(wa + wb);
        if (b.c !== a.c && !a.c2) a.c2 = b.c;
        a.vx = a.vy = 0; b.dead = true; a.age = 0;
        fxSnd("bloup", a.x, a.y, Math.min(1, a.r / 30));
      }
    }
    for (const q of B) { q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= 0.9; q.vy *= 0.9; q.age += dt; }
    FX.blobs = B.filter(q => !q.dead);
    if (FX.blobs.length && !busy && FX.blobs.every(q => q.age > 3) && !(drag && drag.sub === "amoeba")) blobsBake();   // plus rien ne bouge : elles se figent
    if (FX.blobs.length > 46) blobsBake();
  }
  function amoebaDrop(d) { FX.blobs.push({ x: d.x, y: d.y, r: Math.max(3, LW()) * TK("drop", [0.6, 1, 1.9], "amoeba") * (0.8 + Math.random() * 0.4), c: ink || 1, c2: 0, vx: 0, vy: 0, age: 0 }); fxSnd("drop", d.x, d.y); fxKick(); }
  function amoebaMove(a, d) { drag.acc = (drag.acc || 0) + Math.hypot(d.x - a.x, d.y - a.y); if (drag.acc > 22) { drag.acc = 0; amoebaDrop(d); } }

  /* ---- Cœur battant : posé sur une forme, il la détache de la feuille et la fait pulser, 15 % plus
     grande sur le temps. Chaque cœur a son tempo : à plusieurs, ils battent en polyrythmie. */
  function heartStamp(d) {
    pushUndo();
    const rg = shapeAt(d, true);
    if (!rg) return;
    FX.hearts.push({ x: rg.x, y: rg.y, w: rg.w, h: rg.h, data: rg.data, bpm: [84, 126, 168, 112][FX.hearts.length % 4], t0: performance.now(), beat: -1 });
    fxKick(); render();
  }
  function heartsCompose(now, target) {                                  // dessinés dans l'image composée : l'écran, l'export et le zoom les voient
    for (const q of FX.hearts) {
      const ph = ((now - q.t0) * q.bpm / 60000), n = Math.floor(ph), f = ph - n;
      if (!target && n !== q.beat) { q.beat = n; fxSnd("beat", q.x + q.w / 2, q.y + q.h / 2, q.bpm / 168); }
      const sc = 1 + 0.15 * (f < 0.1 ? f / 0.1 : Math.max(0, 1 - (f - 0.1) / 0.35)) - 0.05 * Math.max(0, 1 - Math.abs(f - 0.6) / 0.15);
      const cx = q.x + q.w / 2, cy = q.y + q.h / 2, W = Math.ceil(q.w * sc), H = Math.ceil(q.h * sc), X0 = Math.round(cx - W / 2), Y0 = Math.round(cy - H / 2);
      for (let j = 0; j < H; j++) { const Y = Y0 + j; if (Y < 0 || Y >= DH) continue; const sy = Math.min(q.h - 1, Math.floor(j / sc)); for (let i = 0; i < W; i++) { const X = X0 + i; if (X < 0 || X >= DW) continue; const v = q.data[sy * q.w + Math.min(q.w - 1, Math.floor(i / sc))]; if (v) { if (target) target[Y * DW + X] = v; else docPx[Y * DW + X] = PAL32[v]; } } }
    }
  }
  function heartsBake(target) { if (BAKE_T) { heartsCompose(BAKE_T, target); return; } for (const q of FX.hearts) for (let j = 0; j < q.h; j++) for (let i = 0; i < q.w; i++) { const v = q.data[j * q.w + i], X = q.x + i, Y = q.y + j; if (v && inPage(X, Y)) target[Y * DW + X] = v; } }
  /* Fixateur : tout ce qui vit (cœurs, amibes, pâte) rentre dans la feuille et ne bouge plus. */
  function liveFix() { pushUndo(); liveBake(doc); FX.live = []; FX.grid = null; FX.typing = null; FX.plants = []; FX.metal = []; FX.sun = null; FX.spores = []; FX.shards = []; wetDry(() => true); heartsBake(doc); FX.hearts = []; blobsBake(); FX.dough = []; uiSnd("layer", 0); scheduleSave(); render(); }

  /* ---- Cycles de couleurs. */
  /* Barre d'espace : tout ce qui bouge s'arrête, pour de bon. Ce qui vit est posé dans la feuille
     là où il se trouve, ce qui vole ou tombe est déposé sur place, les mèches s'éteignent, les
     croissances cessent et les couleurs animées redeviennent des couleurs fixes. Un seul Annuler
     rend le dessin d'avant. */
  /* Clear sans sélection : la page redevient blanche. Tous les calques sont vidés, les textes
     posés disparaissent, et tout ce qui bougeait est retiré. Annuler rend le dessin. */
  function clearPage() {
    textCommit(); pushUndo();
    for (const l of LAYERS) l.data.fill(0);
    textLayers.length = 0; selectedText = null; renderTextLayers();
    FX.live = []; FX.grid = null; FX.typing = null; FX.plants = []; FX.metal = []; FX.sun = null; FX.spores = []; FX.shards = []; FX.hearts = []; FX.blobs = []; FX.dough = [];
    FX.frags = []; FX.plates = []; FX.balls = []; FX.sky = []; FX.drips = []; FX.bombs = []; FX.rings = []; FX.drops = []; FX.acid = []; FX.runs = []; FX.melt = []; FX.bubbles = []; FX.sprouts = []; FX.pokes = [];
    FX.wreck = []; FX.pump = null; FX.coral = null; FX.replay = null; FX.reveal = 0; FX.emit = 0; FX.rails = null; FX.parts = [];
    if (FX.wetAt) FX.wetAt.fill(0); if (FX.wetIdx) FX.wetIdx.fill(0); if (FX.wet) FX.wet.fill(0); if (FX.hotAt) FX.hotAt.fill(0);
    LT.on = false; drag = null; polygonPoints = null;
    uiSnd("layer", 2); scheduleSave(); render();
  }
  function freezeAll() {
    BAKE_T = LIVE_NOW || performance.now();                      // ce qui est animé se fige à l'instant affiché, pas à sa position de départ
    try { liveFix(); } finally { BAKE_T = 0; }                   // (empile l'annulation) formes vivantes, plantes, métal, encre humide, cœurs, amibes, pâte
    for (const f of FX.frags) if (!f.dead) fragStamp(f);         // éclats en vol : posés où ils sont
    for (const q of FX.plates) if (!q.dead) { const ox = q.ox || 0, oy = q.oy || 0; for (let y = q.y0; y <= q.y1; y++) for (let x = q.x0; x <= q.x1; x++) { const v = q.data[y * DW + x]; if (v && inPage(x + ox, y + oy)) doc[(y + oy) * DW + x + ox] = v; } }
    for (const b of FX.balls) if (!b.dead) { const X = Math.round(b.x), Y = Math.round(b.y); for (let j = -b.r; j <= b.r; j++) for (let i = -b.r; i <= b.r; i++) if (i * i + j * j <= b.r * b.r) wp(X + i, Y + j, b.c); }
    FX.frags = []; FX.plates = []; FX.balls = []; FX.sky = []; FX.drips = []; FX.bombs = []; FX.rings = []; FX.drops = []; FX.acid = []; FX.runs = []; FX.melt = []; FX.bubbles = []; FX.sprouts = []; FX.pokes = [];
    FX.wreck = []; FX.pump = null; FX.coral = null; FX.replay = null; FX.reveal = 0; FX.pred = false; FX.storm = false; FX.boil = false; FX.emit = 0;
    for (let i = 0; i < doc.length; i++) { const v = doc[i]; if (v >= 56 && v < 184) doc[i] = (v - 56) >> 3; else if (v >= 16 && v < CUSTOM0) { const c = PAL32[v]; doc[i] = nearestColor(c & 255, (c >> 8) & 255, (c >> 16) & 255); } }   // couleurs animées : figées telles qu'on les voit
    if (FX.hotAt) FX.hotAt.fill(0);
    drag = null; uiSnd("layer", 1); scheduleSave(); render();
  }
  function cycleFill(d) {                                         // remplissage animé : des ondes partent du point cliqué
    const rg = region(d.x, d.y, 400000); if (!rg) return;
    pushUndo();
    const base = FX.useRamp ? 184 : 16 + (rg.c < 16 ? rampFor(ink === 1 ? rg.c : ink) : 4) * 8;
    for (const i of rg.list) doc[i] = base + ((Math.floor(Math.hypot(i % DW - d.x, ((i / DW) | 0) - d.y) / 3) % 8 + 8) % 8);
    fxSnd("mode", d.x, d.y); scheduleSave(); render();
  }
  function cycleCmd(name) {
    if (name === "all") {                                         // toute l'image s'anime : un reflet traverse chaque couleur en diagonale
      pushUndo();
      for (let i = 0; i < doc.length; i++) { const v = doc[i]; if (v > 0 && v < 16) doc[i] = 56 + v * 8 + ((((i % DW) + ((i / DW) | 0)) >> 2) & 7); }
    } else if (name === "freeze") {                               // retour à des couleurs fixes, telles qu'on les voit à cet instant
      pushUndo();
      for (let i = 0; i < doc.length; i++) { const v = doc[i]; if (v >= 56 && v < 184) doc[i] = (v - 56) >> 3; else if (v >= 16 && v < CUSTOM0) { const c = PAL32[v]; doc[i] = nearestColor(c & 255, (c >> 8) & 255, (c >> 16) & 255); } }
    } else if (name === "fast") FX.cycSpeed = Math.min(4, FX.cycSpeed * 2);
    else if (name === "slow") FX.cycSpeed = Math.max(0.25, FX.cycSpeed / 2);
    else if (name === "rev") FX.cycDir = -FX.cycDir;
    else if (name === "pause") FX.cycPause = !FX.cycPause;
    else if (name === "boil") FX.boil = !FX.boil;
    else if (name === "storm") { FX.storm = !FX.storm; FX.stormNext = 0; }
    else if (name === "replay") { if (FX.rec.length) { FX.replay = { i: 0, next: 0, frames: FX.rec.concat([rle(flatten())]) }; } }
    else if (name === "dissolve") FX.reveal = 0.0001;
    uiSnd("choose", 0); scheduleSave(); fxKick(); render();
  }
  function flatten() { const f = new Uint8Array(DW * DH); for (const l of LAYERS) if (l.visible) { const d = l.data; for (let i = 0; i < f.length; i++) if (d[i]) f[i] = d[i]; } return f; }
  /* Le film du dessin : une image compressée avant chaque action, pour pouvoir le rejouer. */
  function record() {
    if (FX.replay) return;
    FX.rec.push(rle(flatten()));
    if (FX.rec.length > 360) FX.rec = FX.rec.filter((f, i) => i % 2 === 0);       // trop long : on garde une image sur deux
  }

  /* ---- Dynamite */
  function explode(b) {
    pushUndo();
    /* Le trou n'est jamais deux fois le même : taille tirée au sort, bord déformé par quelques ondes, pointes
       qui partent en étoile, grain sur le bord, et quelques éclats arrachés autour. */
    const T = 8, box = fxBox(), R0 = (44 + Math.random() * 50) * Math.max(0.45, Math.min(2.2, Math.sqrt(PW() / 4))), rnd = Math.random;   // l'épaisseur donne la force de l'explosion
    const waves = [2, 3, 5, 8, 13].map(k => ({ k: k, a: (0.05 + rnd() * 0.22) / Math.sqrt(k / 2), p: rnd() * 6.283 }));
    const spikes = []; for (let i = 0, n = 2 + Math.floor(rnd() * 6); i < n; i++) spikes.push({ an: rnd() * 6.283, w: 0.05 + rnd() * 0.16, h: 0.25 + rnd() * 0.75 });
    const sats = []; for (let i = 0, n = 3 + Math.floor(rnd() * 8); i < n; i++) { const an = rnd() * 6.283, q = R0 * (0.95 + rnd() * 0.85); sats.push({ x: b.x + Math.cos(an) * q, y: b.y + Math.sin(an) * q, r: 2 + rnd() * rnd() * 12 }); }
    const edge = an => { let r = 1; for (const w of waves) r += w.a * Math.sin(w.k * an + w.p); for (const q of spikes) { let da = Math.abs(an - q.an) % 6.283; if (da > 3.1416) da = 6.283 - da; if (da < q.w) r += q.h * (1 - da / q.w); } return R0 * Math.max(0.35, r); };
    const inHole = (X, Y) => {
      const dx = X - b.x, dy = Y - b.y, d = Math.hypot(dx, dy);
      if (d <= edge(Math.atan2(dy, dx) + 3.1416) + (((X * 73856093) ^ (Y * 19349663)) >>> 0) % 7 - 3) return true;      // grain de trois points sur le bord
      for (const q of sats) if ((X - q.x) * (X - q.x) + (Y - q.y) * (Y - q.y) <= q.r * q.r) return true;
      return false;
    };
    const R = Math.ceil(R0 * 2.2) + 16;
    for (let ty = Math.floor((b.y - R) / T) * T; ty < b.y + R; ty += T) for (let tx = Math.floor((b.x - R) / T) * T; tx < b.x + R; tx += T) {
      const data = new Uint8Array(T * T); let any = 0;
      for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
        const X = tx + i, Y = ty + j;
        if (X < 0 || Y < 0 || X >= DW || Y >= DH || !inHole(X, Y)) continue;
        const v = doc[Y * DW + X];
        if (v) { data[j * T + i] = v; doc[Y * DW + X] = 0; any = 1; }
      }
      if (!any) continue;
      const c = document.createElement("canvas"); c.width = c.height = T;
      const g = c.getContext("2d"), im = g.createImageData(T, T), p32 = new Uint32Array(im.data.buffer);
      for (let k = 0; k < T * T; k++) p32[k] = data[k] ? PAL32[data[k]] : 0;
      g.putImageData(im, 0, 0);
      const dx = tx + T / 2 - b.x, dy = ty + T / 2 - b.y, d = Math.hypot(dx, dy) || 1, f = Math.max(0, 1 - d / (R0 * 1.3)) * 520 + 140;
      FX.frags.push({ x: tx, y: ty, vx: dx / d * f + (Math.random() - 0.5) * 90, vy: dy / d * f - 160 + (Math.random() - 0.5) * 90, data: data, c: c, T: T, age: 0, rest: 0 });
    }
    FX.rings.push({ x: b.x, y: b.y, r: 4, life: 0.28 });
    fxSnd("boom", b.x, b.y);
  }
  function fragStamp(f) {
    const X0 = Math.round(f.x); let Y0 = Math.round(f.y);
    /* Les éclats s'entassent : tant que la place est déjà prise aux deux tiers, celui-ci se pose plus haut. */
    for (let up = 0; up < 30; up++) {
      let n = 0;
      for (let j = 0; j < f.T; j++) for (let i = 0; i < f.T; i++) { const X = X0 + i, Y = Y0 + j; if (X >= 0 && Y >= 0 && X < DW && Y < DH && doc[Y * DW + X]) n++; }
      if (n < f.T * f.T * 0.66) break;
      Y0 -= 3;
    }
    for (let j = 0; j < f.T; j++) for (let i = 0; i < f.T; i++) {
      const v = f.data[j * f.T + i], X = X0 + i, Y = Y0 + j;
      if (v && X >= 0 && Y >= 0 && X < DW && Y < DH) doc[Y * DW + X] = v;
    }
  }

  /* ---- Acide */
  function acidBite(x, y, r) {
    let n = 0; const rr = r ? r * r : 5, R = r ? Math.ceil(r) : 2;
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      if (i * i + j * j > rr) continue;
      const X = x + i, Y = y + j;
      if (X < 0 || Y < 0 || X >= DW || Y >= DH) continue;
      if (doc[Y * DW + X]) { doc[Y * DW + X] = 0; n++; }
    }
    return n;
  }
  /* ---- Acide : un dissolvant. Là où il passe, la peinture se défait pendant une à deux secondes : les bords
     partent d'abord, des trous s'ouvrent au hasard, et un peu de couleur dissoute coule en filets qui
     s'éclaircissent. Pas de gouttes ni de bulles. La zone attaquée suit l'épaisseur. */
  function acidSpot(x, y) {
    const R = Math.max(3, Math.min(90, LW() * 1.3)), A = FX.acid || (FX.acid = []);
    if (A.length > 400) A.shift();
    A.push({ x: x + (Math.random() - 0.5) * R * 0.6, y: y + (Math.random() - 0.5) * R * 0.6, r: R * (0.6 + Math.random() * 0.8), life: 0.9 + Math.random() * 1.5, k: 0.5 + Math.random() });
    if (Math.random() < 0.25) fxSnd("fizz", x, y);
    fxKick();
  }
  function acidMove(a, d) {
    drag.acc = (drag.acc || 0) + Math.hypot(d.x - a.x, d.y - a.y);
    const gap = Math.max(3, LW() * 0.7);
    if (drag.acc >= gap) { drag.acc = 0; acidSpot(d.x, d.y); }
  }
  function acidStep(dt) {
    const A = FX.acid || (FX.acid = []), Rn = FX.runs || (FX.runs = []);
    for (const a of A) {
      a.life -= dt;
      for (let k = 0, n = Math.min(900, Math.ceil(a.r * a.r * dt * 9 * a.k)); k < n; k++) {
        const an = Math.random() * 6.283, q = a.r * Math.pow(Math.random(), 0.7), X = Math.round(a.x + Math.cos(an) * q), Y = Math.round(a.y + Math.sin(an) * q * 0.9);
        if (X < 1 || Y < 1 || X >= DW - 1 || Y >= DH - 1) continue;
        const i = Y * DW + X, v = doc[i];
        if (!v) continue;
        const edge = !doc[i - 1] || !doc[i + 1] || !doc[i - DW] || !doc[i + DW];   // un bord nu se dissout plus vite que le plein
        if (!edge && Math.random() > 0.22) continue;
        wr(X, Y, 0);
        if (Rn.length < 500 && Math.random() < 0.035) Rn.push({ x: X, y: Y, c: v, len: 3 + Math.random() * Math.random() * (14 + a.r * 2.5), n: 0, acc: 0, sp: 25 + Math.random() * 60 });
      }
    }
    for (const r of Rn) {                                          // les filets de couleur dissoute : ils descendent en s'éclaircissant
      r.acc += r.sp * dt;
      while (r.acc >= 1 && r.n < r.len) {
        r.acc -= 1; r.n++; r.y++;
        if (Math.random() < 0.14) r.x += Math.random() < 0.5 ? -1 : 1;
        if (!inPage(r.x, r.y)) { r.n = r.len; break; }
        if (Math.random() < 1 - r.n / r.len) wr(r.x, r.y, r.c);
      }
    }
    if (A.some(a => a.life <= 0) || Rn.some(r => r.n >= r.len)) { FX.acid = A.filter(a => a.life > 0); FX.runs = Rn.filter(r => r.n < r.len); if (!FX.acid.length && !FX.runs.length) scheduleSave(); }
  }
  function puff(x, y) { FX.bubbles.push({ x: x, y: y, r: 1 + Math.random() * 1.5, vy: -18 - Math.random() * 34, ph: Math.random() * 6, life: 1.2 + Math.random() * 1.6 }); }

  /* ---- Peinture qui coule */
  function dripFree(x, y, w) {
    if (y >= DH || x < 0 || x + w > DW) return false;
    for (let i = 0; i < w; i++) { const k = y * DW + x + i; if (doc[k] && !FX.wet[k]) return false; }
    return true;
  }
  function dripSpan(d) {                                         // la coulure s'effile quand la peinture s'épuise
    const w = d.vol < 26 ? Math.max(1, Math.round(d.w * Math.max(0, d.vol) / 26)) : d.w;
    return [d.x + ((d.w - w) >> 1), w];
  }
  function dripPaint(d) {
    const [x0, w] = dripSpan(d);
    for (let i = 0; i < w; i++) { const X = x0 + i; if (X >= 0 && X < DW && d.y >= 0 && d.y < DH) { doc[d.y * DW + X] = d.color; FX.wet[d.y * DW + X] = 1; } }
    d.vol--;
  }
  function dripStep(d) {                                         // un point de descente ; faux quand la coulure s'arrête
    const w = d.w;
    if (dripFree(d.x, d.y + 1, w)) { d.y++; d.slide = 0; if (d.hit) d.hit = 2; }
    else {
      if (!d.hit) { d.hit = 1; fxSnd("plop", d.x, d.y); }
      if (dripFree(d.x + d.dir, d.y + 1, w)) { d.x += d.dir; d.y++; }
      else if (dripFree(d.x - d.dir, d.y + 1, w)) { d.dir = -d.dir; d.x += d.dir; d.y++; }
      else if (d.slide < 46 && dripFree(d.x + d.dir, d.y, w)) { d.x += d.dir; d.slide++; d.vol--; }   // elle longe l'obstacle
      else if (d.slide < 46 && dripFree(d.x - d.dir, d.y, w)) { d.dir = -d.dir; d.x += d.dir; d.slide++; d.vol--; }
      else return false;
    }
    dripPaint(d);
    return d.vol > 0 && d.y < DH - 1;
  }
  function dripEnd(d) {                                          // la goutte qui pend au bout, à la largeur de la coulure
    const [x0, w] = dripSpan(d), cx = x0 + (w - 1) / 2, cy = d.y + 0.5, rx = w / 2 + 1, ry = Math.max(2, w * 0.5 + 1);
    for (let j = -Math.ceil(ry); j <= Math.ceil(ry) + 1; j++) for (let i = -Math.ceil(rx) - 1; i <= Math.ceil(rx) + 1; i++) {
      const X = Math.round(cx + i), Y = d.y + j, ex = (X - cx) / rx, ey = (Y - cy) / ry;
      if (ex * ex + ey * ey > 1.15) continue;
      if (X >= 0 && Y >= 0 && X < DW && Y < DH && (!doc[Y * DW + X] || FX.wet[Y * DW + X])) { doc[Y * DW + X] = d.color; FX.wet[Y * DW + X] = 1; }
    }
  }

  /* ================================================================== *
   *  Quatre pinceaux joueurs : ligne molle, chenille, glitch, ruban de papier.
   *  Tous suivent l'épaisseur, la couleur, la trame et le dégradé ; la ligne
   *  molle et la chenille vivent quelques secondes, et la barre d'espace les
   *  fige telles qu'on les voit.
   * ================================================================== */
  /* ---- Ligne molle : un boudin élastique. Des renflements tirés au sort, des ondes qui courent le long
     du trait et le font onduler ; quand on lâche, tout s'amortit comme un ressort, puis se pose. */
  const JELLY_REST = 2600;
  function jellyStart(d) {
    const q = { type: "jelly", pts: [{ x: d.x, y: d.y, s: Math.random() }], c: ink || 1, g: GRAD.on, pat: topt("pat", "jelly") === false ? 0 : pattern, base: Math.max(2, PW() * 0.9),
      ph1: Math.random() * 6.283, ph2: Math.random() * 6.283, t0: performance.now(), end: 0, k: TK("wobble", [0.45, 1, 1.9], "jelly") };
    FX.live.push(q); drag.q = q;
  }
  function jellyMove(a, d) {
    const q = drag.q, p = q.pts[q.pts.length - 1];
    if (Math.hypot(d.x - p.x, d.y - p.y) < Math.max(2, q.base / 3) || q.pts.length >= 900) return;
    q.pts.push({ x: d.x, y: d.y, s: Math.max(0, Math.min(1, p.s + (Math.random() - 0.5) * 0.55)) });   // le renflement varie en douceur d'un point au suivant
    if (q.pts.length % 9 === 0) fxSnd("rubber", d.x, d.y, 0.3 + 0.5 * Math.random());
  }
  function jellyCompose(q, now, target) {
    const t = (now - q.t0) / 1000, A = q.end ? Math.exp(-Math.max(0, now - q.end) / 1000 * 1.7) : 1, n = q.pts.length, P = PAT[q.pat || 0];
    for (let i = 0; i < n; i++) {
      const p = q.pts[i], pv = q.pts[Math.max(0, i - 1)], nx = q.pts[Math.min(n - 1, i + 1)], tx = nx.x - pv.x, ty = nx.y - pv.y, L = Math.hypot(tx, ty) || 1;
      const wob = q.base * 0.55 * q.k * A * Math.sin(i * 0.16 - t * 7 + q.ph1);                                  // l'onde qui fait onduler le trait
      const r = Math.max(1, q.base / 2 * (0.5 + 1.25 * p.s + q.k * A * (0.4 * Math.sin(i * 0.22 + q.ph2 - t * 5) + 0.25 * Math.sin(i * 0.06 + t * 3))));   // renflement fixe + respiration
      pxDisc(p.x - ty / L * wob, p.y + tx / L * wob, r, q.c, target, (X, Y) => P[(Y & 7) * 8 + (X & 7)] ? (q.g ? gradInk(X, Y) : q.c) : 0);
    }
  }
  /* ---- Chenille : une file de boules qui suit le geste, puis continue seule. Ce que sa tête traverse
     est mangé (effacé) et lui donne sa couleur, qui descend ensuite d'anneau en anneau. */
  function wormStart(d) {
    const n = [5, 9, 16][topt("len", "worm")], q = { type: "worm", r: Math.max(3, Math.round(PW() * 0.9)), n: n, trail: [{ x: d.x, y: d.y }], cols: new Array(n).fill(ink || 1), x: d.x, y: d.y, an: -1.57, turn: 0, ph: Math.random() * 6.283,
      held: true, life: (7 + Math.random() * 5) * TK("life", [0.45, 1, 2.6], "worm"), tick: 0, bite: 0 };
    FX.live.push(q); drag.q = q;
  }
  function wormHead(q, x, y) {
    const dx = x - q.x, dy = y - q.y, L = Math.hypot(dx, dy);
    if (L < 0.5) return;
    q.an = Math.atan2(dy, dx);
    for (let k = 1, m = Math.ceil(L); k <= m; k++) q.trail.push({ x: q.x + dx * k / m, y: q.y + dy * k / m });
    q.x = x; q.y = y;
    const max = Math.ceil(q.n * q.r * 1.5) + 6; if (q.trail.length > max) q.trail.splice(0, q.trail.length - max);
    const X0 = Math.round(x), Y0 = Math.round(y), R = q.r; let food = 0;
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { if (i * i + j * j > R * R) continue; const X = X0 + i, Y = Y0 + j; if (!inPage(X, Y)) continue; const v = doc[Y * DW + X]; if (v) { if (!food) food = v; wr(X, Y, 0); } }
    if (food) { q.cols[0] = food; const now = performance.now(); if (now > q.bite) { q.bite = now + 160; fxSnd("bloup", x, y, 0.35); } }
  }
  function wormMove(a, d) { wormHead(drag.q, d.x, d.y); }
  function wormsStep(dt, t) {
    let done = false;
    for (const q of FX.live) {
      if (q.type !== "worm") continue;
      q.tick += dt; if (q.tick > 0.11) { q.tick = 0; for (let i = q.n - 1; i > 0; i--) q.cols[i] = q.cols[i - 1]; }   // la couleur avalée descend le long du corps
      if (q.held) continue;
      q.life -= dt;
      q.turn = q.turn * 0.94 + (Math.random() - 0.5) * 1.1; q.an += (q.turn + Math.sin(t / 420 + q.ph) * 1.3) * dt;
      const sp = 38 + q.r * 5; let nx = q.x + Math.cos(q.an) * sp * dt, ny = q.y + Math.sin(q.an) * sp * dt;
      if (nx < q.r || nx > DW - 1 - q.r) { q.an = Math.PI - q.an; nx = Math.max(q.r, Math.min(DW - 1 - q.r, nx)); }     // elle fait demi-tour au bord de la feuille
      if (ny < q.r || ny > DH - 1 - q.r) { q.an = -q.an; ny = Math.max(q.r, Math.min(DH - 1 - q.r, ny)); }
      wormHead(q, nx, ny);
      if (q.life <= 0) { wormCompose(q, t, doc); q.dead = true; done = true; fxSnd("plip", q.x, q.y); }
    }
    for (const q of FX.live) if (q.type === "jelly" && q.end && t - q.end > JELLY_REST) { jellyCompose(q, q.end + JELLY_REST, doc); q.dead = true; done = true; }
    if (done) { FX.live = FX.live.filter(q => !q.dead); scheduleSave(); render(); }
  }
  function wormCompose(q, now, target) {
    const T = q.trail, last = T.length - 1, R = q.r;
    for (let i = q.n - 1; i >= 0; i--) {
      const p = T[Math.max(0, last - Math.round(i * R * 1.4))], r = Math.max(2, R * (1 - 0.3 * i / q.n)), hop = Math.sin(now / 90 - i * 0.9) * Math.min(2, R * 0.15);
      const x = p.x, y = p.y + hop;
      if (i) { const lg = Math.max(1, Math.round(r * 0.35)), sw = Math.sin(now / 70 + i * 1.7) * r * 0.3; pxLine(x - r * 0.5 + sw, y + r, x - r * 0.5 + sw, y + r + lg + 1, 1, 1, target); pxLine(x + r * 0.5 - sw, y + r, x + r * 0.5 - sw, y + r + lg + 1, 1, 1, target); }   // les pattes
      pxDisc(x, y, r + 1, 1, target); pxDisc(x, y, r, q.cols[i] || 1, target);
      if (r > 3) pxDisc(x - r * 0.35, y - r * 0.35, Math.max(1, r * 0.22), 0, target);                           // un reflet
    }
    const h = T[last], c = Math.cos(q.an), s2 = Math.sin(q.an), er = Math.max(1, R * 0.3);
    for (const sd of [-1, 1]) {
      const ex = h.x + c * R * 0.35 - s2 * sd * R * 0.45, ey = h.y + s2 * R * 0.35 + c * sd * R * 0.45;
      pxDisc(ex, ey, er + 1, 1, target); pxDisc(ex, ey, er, 0, target); pxDot(Math.round(ex + c * er * 0.5), Math.round(ey + s2 * er * 0.5), 1, target);
      pxLine(h.x - s2 * sd * R * 0.5, h.y + c * sd * R * 0.5, h.x + c * R * 1.5 - s2 * sd * R * 0.9, h.y + s2 * R * 1.5 + c * sd * R * 0.9, 1, 1, target);   // les antennes
    }
  }
  /* ---- Pinceau barbelé : un fil massif hérissé de triangles pointus, de part et d'autre du trait,
     de longueurs et d'inclinaisons tirées au sort. */
  function triFill(ax, ay, bx, by, cx, cy, c) {
    const x0 = Math.floor(Math.min(ax, bx, cx)), x1 = Math.ceil(Math.max(ax, bx, cx)), y0 = Math.floor(Math.min(ay, by, cy)), y1 = Math.ceil(Math.max(ay, by, cy)), ar = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (!ar || (x1 - x0) * (y1 - y0) > 400000) return;
    for (let Y = y0; Y <= y1; Y++) for (let X = x0; X <= x1; X++) {
      const w0 = ((bx - ax) * (Y - ay) - (by - ay) * (X - ax)) / ar, w1 = ((cx - bx) * (Y - by) - (cy - by) * (X - bx)) / ar, w2 = ((ax - cx) * (Y - cy) - (ay - cy) * (X - cx)) / ar;
      if (w0 >= -0.02 && w1 >= -0.02 && w2 >= -0.02) wp(X, Y, c);
    }
  }
  function spikeMove(a, d) {
    const w = PW(), c = ink || 1, dx = d.x - a.x, dy = d.y - a.y, L = Math.hypot(dx, dy) || 1, tx = dx / L, ty = dy / L;
    bline(a.x, a.y, d.x, d.y, c, Math.max(1, w));
    const gap = Math.max(2, w * 0.5) * TK("dens", [1.9, 1, 0.5], "spike"), len = TK("len", [0.55, 1, 1.9], "spike");
    drag.acc = (drag.acc === undefined ? gap : drag.acc) + L;
    for (let guard = 0; drag.acc >= gap && guard < 60; guard++) {
      drag.acc -= gap;
      const back = Math.min(L, drag.acc), px = d.x - tx * back, py = d.y - ty * back;
      drag.side = Math.random() < 0.8 ? -(drag.side || 1) : (drag.side || 1);                       // presque toujours de l'autre côté : le fil est hérissé des deux bords
      const sd = drag.side, an = Math.atan2(-tx * sd, ty * sd) + (Math.random() - 0.5) * 1.3;      // la normale, inclinée au hasard
      const h = (w * (1.1 + Math.random() * Math.random() * 3.4) + 3) * len, b = Math.max(1.5, w * (0.35 + Math.random() * 0.55));
      const ox = px + ty * sd * w * 0.3, oy = py - tx * sd * w * 0.3;                              // la base, sur le bord du fil
      triFill(ox - tx * b, oy - ty * b, ox + tx * b, oy + ty * b, ox + Math.cos(an) * h, oy + Math.sin(an) * h, c);
      if (Math.random() < 0.2) fxSnd("clack", px, py);
    }
  }
  /* ---- Envol : chaque forme que le pointeur touche se détache de la feuille et s'envole. Elle monte de plus en
     plus vite en se balançant et en penchant un peu, puis quitte la page par le haut. L'épaisseur donne la
     vigueur de l'envol. La barre d'espace la pose là où elle est. */
  function flyGrab(d) {
    if (FX.live.length > 60) return;
    const q = shapeAt(d, true); if (!q) return;
    const v = Math.max(0.5, Math.min(3, Math.sqrt(PW() / 4)));
    q.type = "fly"; q.cx = q.x + q.w / 2; q.cy = q.y + q.h / 2; q.x0 = q.cx; q.vy = -(8 + Math.random() * 14) * v; q.acc = (55 + Math.random() * 50) * v * TK("lift", [0.4, 1, 2.4], "fly");
    q.sw = (6 + Math.random() * 18) * TK("sway", [0, 1, 2.6], "fly"); q.fr = 0.8 + Math.random() * 1.4; q.ph = Math.random() * 6.283; q.age = 0; q.tilt = (0.08 + Math.random() * 0.2) * TK("sway", [0, 1, 2.2], "fly");
    FX.live.push(q); fxSnd("launch", d.x, d.y); fxKick();
  }
  function flyMove(a, d) { flyGrab(d); }
  function flyStep(dt) {
    let gone = false;
    for (const q of FX.live) {
      if (q.type !== "fly") continue;
      q.age += dt; q.vy -= q.acc * dt; q.cy += q.vy * dt;
      q.cx = q.x0 + Math.sin(q.age * q.fr * 2 + q.ph) * q.sw * Math.min(1, q.age);
      if (q.cy + Math.hypot(q.w, q.h) / 2 < -4) { q.dead = true; gone = true; }                               // sortie par le haut : elle est partie
    }
    if (gone) { FX.live = FX.live.filter(q => !q.dead); scheduleSave(); }
  }
  function flyCompose(q, now, target) {
    const an = Math.cos(q.age * q.fr * 2 + q.ph) * q.tilt * Math.min(1, q.age);
    rotBlit(q, q.cx, q.cy, an, 1, 1, (X, Y, v) => pxDot(X, Y, v, target));
  }
  /* ---- Pinceau fondant : tout ce qui est sous le pointeur se met à dégouliner. Chaque colonne de points glisse
     vers le bas d'une longueur tirée au sort (voisine de celle d'à côté, avec de temps en temps une longue
     coulure) ; le haut s'étire derrière elle. La largeur attaquée suit l'épaisseur. */
  function meltMove(a, d) {
    const R = Math.max(3, Math.min(120, PW())), M = FX.melt || (FX.melt = []), k = TK("run", [0.45, 1, 2.3], "melt");
    drag.acc = (drag.acc === undefined ? R : drag.acc) + Math.hypot(d.x - a.x, d.y - a.y);
    if (drag.acc < Math.max(2, R * 0.5)) return;
    drag.acc = 0;
    let nz = drag.nz === undefined ? Math.random() : drag.nz;
    const busy = new Set(M.map(m => m.x));
    for (let i = -R; i <= R; i++) {
      const X = d.x + i; if (X < 0 || X >= DW) continue;
      const hgt = Math.round(Math.sqrt(R * R - i * i)), ya = Math.max(0, d.y - hgt), yb = Math.min(DH - 1, d.y + hgt);
      let any = false; for (let Y = ya; Y <= yb; Y++) if (doc[Y * DW + X]) { any = true; break; }
      if (!any) continue;
      nz = Math.max(0, Math.min(1, nz + (Math.random() - 0.5) * 0.5));                                   // la longueur varie en douceur d'une colonne à l'autre
      if (busy.has(X)) continue;                                                                         // cette colonne coule déjà : on ne l'empile pas
      const D = Math.round((1 + nz * R * 0.9 + (Math.random() < 0.06 ? Math.random() * R * 3 : 0)) * k * (0.5 + 0.5 * hgt / R));
      if (D > 0 && M.length < 2500) { M.push({ x: X, ya: ya, yb: yb, D: D, n: 0, acc: 0, sp: 30 + Math.random() * 70 }); busy.add(X); }
    }
    drag.nz = nz;
    if (Math.random() < 0.3) fxSnd("drip", d.x, d.y);
    fxKick();
  }
  function meltStep(dt) {
    const M = FX.melt; let done = false;
    for (const m of M) {
      m.acc += m.sp * dt;
      while (m.acc >= 1 && m.n < m.D) {
        m.acc -= 1; m.n++;
        const end = m.yb + m.n; if (end >= DH) { m.n = m.D; break; }
        for (let Y = end; Y > m.ya; Y--) wr(m.x, Y, doc[(Y - 1) * DW + m.x]);                             // la colonne descend d'un point ; son sommet s'étire
      }
      if (m.n >= m.D) done = true;
    }
    if (done) { FX.melt = M.filter(m => m.n < m.D); if (!FX.melt.length) scheduleSave(); }
  }
  /* ---- Pinceau glitch : sous le pinceau, l'image se décale en bandes horizontales (elles tournent sur
     elles-mêmes : rien n'est perdu), avec des répliques rouge et cyan décalées de quelques points. */
  function glitchMove(a, d) {
    drag.acc = (drag.acc || 0) + Math.hypot(d.x - a.x, d.y - a.y);
    if (drag.acc < 5) return;
    drag.acc = 0;
    const R = Math.max(6, LW() * 2), k = TK("amount", [0.45, 1, 2.2], "glitch"), ghost = topt("ghost", "glitch");
    for (let y = d.y - R; y < d.y + R;) {
      const bh = 1 + Math.floor(Math.random() * Math.max(2, R / 3));
      if (Math.random() < 0.6) {
        const W = Math.round(R * (1.5 + Math.random() * 2.5)), x0 = Math.max(0, d.x - W), w = Math.min(DW, d.x + W) - x0, off = Math.round((Math.random() - 0.5) * 2 * R * 0.9 * k), gap = 2 + Math.floor(Math.random() * 3);
        if (w > 4 && off) for (let Y = Math.max(0, y); Y < Math.min(DH, y + bh); Y++) {
          const row = doc.slice(Y * DW + x0, Y * DW + x0 + w), out = new Uint8Array(w);
          for (let i = 0; i < w; i++) out[(((i + off) % w) + w) % w] = row[i];
          if (ghost) for (let i = 0; i < w; i++) if (!out[i]) { if (i >= gap && out[i - gap] && out[i - gap] !== 7 && out[i - gap] !== 12) out[i] = 7; else if (i + gap < w && out[i + gap] && out[i + gap] !== 7 && out[i + gap] !== 12) out[i] = 12; }   // la réplique rouge à droite, la cyan à gauche
          for (let i = 0; i < w; i++) wr(x0 + i, Y, out[i]);
        }
      }
      y += bh;
    }
    if (Math.random() < 0.35) fxSnd("grind", d.x, d.y);
  }
  /* ---- Ruban de papier : plié en accordéon, il se déroule derrière le geste. Une face est en couleur
     pleine, l'autre dans la trame choisie ; chaque pli porte son filet noir et son ombre. */
  function ribbonMove(a, d) {
    const rb = drag.rb || (drag.rb = { x: a.x, y: a.y, k: 0, pl: null, pr: null });
    const W = Math.max(6, PW() * 2.5), F = Math.max(5, W * TK("fold", [0.32, 0.55, 0.95], "ribbon")), c = ink || 1;
    for (let guard = 0; guard < 40; guard++) {
      const dx = d.x - rb.x, dy = d.y - rb.y, L = Math.hypot(dx, dy);
      if (L < F) break;
      const tx = dx / L, ty = dy / L, nx = -ty, ny = tx, cx = rb.x + tx * F, cy = rb.y + ty * F, sk = F * 0.38 * (rb.k & 1 ? 1 : -1);
      if (!rb.pl) { rb.pl = { x: rb.x + nx * W / 2, y: rb.y + ny * W / 2 }; rb.pr = { x: rb.x - nx * W / 2, y: rb.y - ny * W / 2 }; }
      const cl = { x: cx + nx * W / 2 + tx * sk, y: cy + ny * W / 2 + ty * sk }, cr = { x: cx - nx * W / 2 - tx * sk, y: cy - ny * W / 2 - ty * sk }, pl = rb.pl, pr = rb.pr;
      const U = Math.ceil(Math.max(Math.hypot(cl.x - pl.x, cl.y - pl.y), Math.hypot(cr.x - pr.x, cr.y - pr.y)) * 1.6) + 1, V = Math.ceil(W * 1.6) + 1, face = rb.k & 1, P = PAT[pattern];
      for (let iu = 0; iu <= U; iu++) for (let iv = 0; iv <= V; iv++) {
        const u = iu / U, v = iv / V, ax = pl.x + (cl.x - pl.x) * u, ay = pl.y + (cl.y - pl.y) * u, bx = pr.x + (cr.x - pr.x) * u, by = pr.y + (cr.y - pr.y) * u;
        const X = Math.round(ax + (bx - ax) * v), Y = Math.round(ay + (by - ay) * v);
        if (!inPage(X, Y)) continue;
        const kk = GRAD.on ? gradInk(X, Y) || 1 : c, edge = iv < 2 || iv > V - 2 || iu < 2, shade = u < 0.26;
        let col;
        if (edge) col = 1;
        else if (!face) col = shade && ((X + Y) & 1) === 0 ? 1 : kk;                                               // la face en couleur ; près du pli, l'ombre
        else { const on = pattern ? P[(Y & 7) * 8 + (X & 7)] : ((X + Y) & 1); col = shade && !(X & 1) && !(Y & 1) ? 1 : on ? kk : 0; }   // la face en trame
        wr(X, Y, col);
      }
      rb.pl = cl; rb.pr = cr; rb.x = cx; rb.y = cy; rb.k++;
      fxSnd("clack", cx, cy);
    }
  }

  /* ================================================================== *
   *  Module 3D. Six volumes de base. On clique au centre et on tire : la
   *  distance donne la taille, la direction du geste fait tourner le volume.
   *  Chaque point de l'image lance un rayon vers le volume (décrit par sa
   *  distance signée) ; l'éclairage devient une trame entre la couleur
   *  choisie, le papier (lumière) et le noir (ombre), puis passe par la
   *  trame choisie comme tout le reste. Contour : l'épaisseur courante.
   * ================================================================== */
  const S3D = {
    sphere: (x, y, z) => Math.hypot(x, y, z) - 1,
    cube: (x, y, z) => { const a = Math.abs(x) - 0.78, b = Math.abs(y) - 0.78, c = Math.abs(z) - 0.78; return Math.hypot(Math.max(a, 0), Math.max(b, 0), Math.max(c, 0)) + Math.min(Math.max(a, b, c), 0); },
    cylinder: (x, y, z) => { const a = Math.hypot(x, z) - 0.72, b = Math.abs(y) - 0.92; return Math.min(Math.max(a, b), 0) + Math.hypot(Math.max(a, 0), Math.max(b, 0)); },
    cone: (x, y, z) => Math.max(Math.hypot(x, z) * 0.9063 + (y - 0.95) * 0.4226, -0.95 - y),
    pyramid: (x, y, z) => Math.max(Math.abs(x) * 0.9063 + (y - 0.95) * 0.4226, Math.abs(z) * 0.9063 + (y - 0.95) * 0.4226, -0.95 - y),
    torus: (x, y, z) => Math.hypot(Math.hypot(x, z) - 0.7, y) - 0.3
  };
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function solid3d(kind, a, d) {
    const f = S3D[kind], dx = d.x - a.x, dy = d.y - a.y, L = Math.hypot(dx, dy);
    const R = L < 4 ? 40 : Math.max(8, Math.min(700, L)), yaw = L < 4 ? 0.6 : Math.atan2(dy, dx), pitch = [0.22, 0.55, 0.95][topt("tilt", kind)], lx = topt("light", kind) ? 0.45 : -0.45;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    /* vue → objet : on défait l'inclinaison (autour de x), puis la rotation (autour de y) */
    const toObj = (X, Y, Z) => { const y1 = Y * cp + Z * sp, z1 = -Y * sp + Z * cp; return [X * cy + z1 * sy, y1, -X * sy + z1 * cy]; };
    const dir = toObj(0, 0, -1), S = R / 1.5, N = 2 * Math.ceil(R) + 1, x0 = a.x - Math.ceil(R), y0 = a.y - Math.ceil(R);
    const hit = new Uint8Array(N * N), lum = new Float32Array(N * N), nrm = new Float32Array(N * N * 3), e = 0.004;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const X = (i - Math.ceil(R)) / S, Y = -(j - Math.ceil(R)) / S;
      if (X * X + Y * Y > 2.3) continue;
      const o = toObj(X, Y, 3);
      let t = 1.2, ok = false, px0 = 0, py0 = 0, pz0 = 0;
      for (let k = 0; k < 48 && t < 4.8; k++) {
        px0 = o[0] + dir[0] * t; py0 = o[1] + dir[1] * t; pz0 = o[2] + dir[2] * t;
        const dd = f(px0, py0, pz0);
        if (dd < 0.003) { ok = true; break; }
        t += dd;
      }
      if (!ok) continue;
      let nx = f(px0 + e, py0, pz0) - f(px0 - e, py0, pz0), ny = f(px0, py0 + e, pz0) - f(px0, py0 - e, pz0), nz = f(px0, py0, pz0 + e) - f(px0, py0, pz0 - e);
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      /* objet → vue, pour éclairer toujours du même côté : en haut à gauche, vers nous */
      const x1 = nx * cy - nz * sy, z1 = nx * sy + nz * cy, vy = ny * cp - z1 * sp, vz = ny * sp + z1 * cp, k = j * N + i;
      hit[k] = 1; nrm[k * 3] = x1; nrm[k * 3 + 1] = vy; nrm[k * 3 + 2] = vz;
      lum[k] = Math.max(0, Math.min(1, 0.12 + 0.88 * Math.max(0, lx * x1 + 0.62 * vy + 0.64 * vz)));
    }
    const edge = noOutline || !topt("edges", kind) ? 0 : Math.max(1, Math.min(PW(), Math.round(R / 5))), c = ink || 1, mono = c === 1;
    const out = (i, j) => i < 0 || j < 0 || i >= N || j >= N || !hit[j * N + i], shine = topt("shine", kind), shadeK = TK("shade", [0.45, 0.9, 1.5], kind);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i; if (!hit[k]) continue;
      const X = x0 + i, Y = y0 + j;
      let line = edge && (out(i - edge, j) || out(i + edge, j) || out(i, j - edge) || out(i, j + edge));
      if (!line && edge) for (const q of [k + 1, k + N]) if (q < N * N && hit[q] && nrm[k * 3] * nrm[q * 3] + nrm[k * 3 + 1] * nrm[q * 3 + 1] + nrm[k * 3 + 2] * nrm[q * 3 + 2] < 0.55) line = true;   // une arête
      if (line) { wr(X, Y, 1); continue; }
      const I = lum[k], b = (BAYER4[(Y & 3) * 4 + (X & 3)] + 0.5) / 16;
      let v = c;
      if (mono) v = b < I * 0.92 ? 0 : 1;
      else if (I > 0.6) v = shine && b < (I - 0.6) / 0.4 * 0.8 ? 0 : c;
      else if (I < 0.36) v = b < (0.36 - I) / 0.36 * shadeK ? 1 : c;
      wp(X, Y, v);
    }
  }

  function fxStart(d) {
    if (d.x < 0 || d.y < 0 || d.x >= DW || d.y >= DH) return;
    if (tool === "type") { liveStart(d); return; }
    if (tool === "heart") { heartStamp(d); return; }
    if (tool === "hammer") { hammerHit(d); return; }
    if (tool === "lathe") { latheTurn(d); return; }
    if (tool === "coral") { pushUndo(); coralStart(d); drag = { kind: "fx", sub: "coral", d: d, last: d, t: performance.now(), sp: 0, vx: 0, vy: 0 }; fxKick(); return; }
    if (tool === "extrude" || tool === "fold") {
      pushUndo(); const q = shapeAt(d, true); if (!q) { undoStack.pop(); return; }
      q.type = tool; q.ex = 0; q.ey = 0; q.fx = d.x - q.x; q.th = 0; FX.live.push(q);
      drag = { kind: "fx", sub: tool, a: d, d: d, last: d, t: performance.now(), sp: 0, vx: 0, vy: 0, q: q }; fxKick(); return;
    }
    if (tool === "custom" && !FX.cbrush) { const q = shapeAt(d, false); if (q) { q.pw0 = PW(); FX.cbrush = q; fxSnd("mode", d.x, d.y); render(); } return; }
    if (tool === "graft") { graftPlant(d); return; }
    if (tool === "sun") { FX.sun = { x: d.x, y: d.y }; drag = { kind: "fx", sub: "sun", d: d, last: d, t: performance.now(), sp: 0, vx: 0, vy: 0 }; fxSnd("bloom", d.x, d.y); fxKick(); return; }
    if (tool === "motor") { pushUndo(); motorStamp(d); return; }
    if (tool === "shaker") { pushUndo(); if (!shakerStart(d)) undoStack.pop(); fxKick(); return; }
    if (tool === "accordion") { pushUndo(); if (!accStart(d)) undoStack.pop(); fxKick(); return; }
    if (tool === "repel") return;
    if (tool === "blinds") { pushUndo(); blindsStamp(d); return; }
    if (tool === "moire") { moireStamp(d); return; }
    if (tool === "balloon") { balloonStart(d); return; }
    if (tool === "cfill") { cycleFill(d); return; }
    if (tool === "ball" || tool === "slice" || tool === "grid") { drag = { kind: "fx", sub: tool, a: d, d: d, last: d, t: performance.now(), sp: 0, vx: 0, vy: 0 }; fxKick(); return; }
    if (tool === "pump") { if (!region(d.x, d.y, 60000)) return; pushUndo(); pumpStart(d); drag = { kind: "fx", sub: tool, d: d, last: d, t: performance.now(), sp: 0, vx: 0, vy: 0 }; fxKick(); return; }
    if (tool === "dynamite") { FX.bombs.push({ x: d.x, y: d.y, fuse: TK("fuse", [0.35, 1.1, 3.2], "dynamite"), tick: 0 }); fxSnd("fuse", d.x, d.y); fxKick(); return; }
    pushUndo();
    drag = { kind: "fx", sub: tool, d: d, last: d, len: 0, t: performance.now(), sp: 0, vx: 0, vy: 0, c: ink };
    if (tool === "leaky" || tool === "frizzy" || tool === "web") wp(d.x, d.y, ink);
    if (tool === "leaky") { drag.len0 = d; leakyBlot(d.x, d.y, leakyBase() * (0.8 + Math.random() * 0.5)); }   // la plume se pose : une goutte
    drag.id = FX.stroke = (FX.stroke % 65000) + 1; drag.ph = Math.random() * 6.28;
    if (tool === "blend" || tool === "waves") drag.snap = doc.slice();
    if (tool === "yeast") { drag.pts = [{ x: d.x, y: d.y }]; wp(d.x, d.y, ink); }
    if (tool === "fly") flyGrab(d);
    if (tool === "jelly") jellyStart(d);
    if (tool === "worm") { wormStart(d); wormHead(drag.q, d.x + 0.6, d.y); }
    if (tool === "glitch" || tool === "ribbon") drag.a = d;
    if (tool === "elastic") { drag.pts = [{ x: d.x, y: d.y }]; drag.snap = doc.slice(); }
    if (S3D[tool]) { drag.a = d; drag.snap = doc.slice(); solid3d(tool, d, d); }
    if (tool === "metal") metalDrop(d);
    if (tool === "rails") railsMove(d, d);
    if (tool === "hot") hotMove(d, d);
    if (tool === "amoeba") amoebaDrop(d);
    if (tool === "bayer") bayerMove(d, d);
    if (tool === "wet") wetMove(d, d);
    if (tool === "cycle") cycleDab(d.x, d.y, 0);
    if (tool === "wild") wildStart(d);
    if (tool === "drip" && !FX.wet) FX.wet = new Uint8Array(DW * DH);
    FX.emit = 0;
    fxKick(); render();
  }
  function fxMove(d) {
    if (drag.sub === "cycle") {
      const a = drag.last, n = Math.max(Math.abs(d.x - a.x), Math.abs(d.y - a.y));
      for (let k = 1; k <= n; k++) cycleDab(Math.round(a.x + (d.x - a.x) * k / n), Math.round(a.y + (d.y - a.y) * k / n), ++drag.len);
      render();
    }
    if (drag.sub === "wild") wildMove(d);
    const a = drag.last, now = performance.now(), dtm = Math.max(4, now - drag.t), dist = Math.hypot(d.x - a.x, d.y - a.y);
    drag.sp += (dist / dtm - drag.sp) * 0.4;                     // vitesse du geste, en points par milliseconde
    drag.vx += ((d.x - a.x) / dtm * 1000 - drag.vx) * 0.5; drag.vy += ((d.y - a.y) / dtm * 1000 - drag.vy) * 0.5;
    drag.t = now;
    if (drag.sub === "sun") { FX.sun = { x: d.x, y: d.y }; }
    if (drag.sub === "extrude") { const ex = d.x - drag.a.x, ey = d.y - drag.a.y, L = Math.hypot(ex, ey) || 1, mx = 56 * TK("depth", [0.45, 1, 2.4], "extrude"), k = Math.min(1, mx / L); drag.q.ex = ex * k; drag.q.ey = ey * k; if (Math.random() < 0.2) fxSnd("pump", d.x, d.y, Math.min(1, L / mx)); }
    if (drag.sub === "fold") { const q = drag.q, pw = Math.max(4, q.w - q.fx); q.th = Math.max(0, Math.min(Math.PI, (drag.a.x - d.x) / pw * Math.PI)); if (Math.random() < 0.2) fxSnd("roll", d.x, d.y); }
    if (drag.sub === "shaker") { drag.last = drag.d = d; shakerMove(a, d); return; }
    if (drag.sub === "accordion") { drag.q.target = Math.max(0.35, Math.min(3.5, 1 + (d.x - drag.a.x) / Math.max(20, drag.q.w))); }
    if (drag.sub === "elastic" && dist > 0) { bline(a.x, a.y, d.x, d.y, drag.c, Math.max(2, PW())); const q = drag.pts[drag.pts.length - 1]; if (Math.hypot(d.x - q.x, d.y - q.y) >= 3) drag.pts.push({ x: d.x, y: d.y }); render(); }
    if (S3D[drag.sub] && dist > 0) { doc.set(drag.snap); solid3d(drag.sub, drag.a, d); if (Math.random() < 0.15) fxSnd("pump", d.x, d.y, Math.min(1, Math.hypot(d.x - drag.a.x, d.y - drag.a.y) / 200)); render(); }
    if (drag.sub === "metal") { drag.acc = (drag.acc || 0) + dist; if (drag.acc > 26) { drag.acc = 0; metalDrop(d); } }
    if (drag.sub === "yeast" && dist > 0) { bline(a.x, a.y, d.x, d.y, drag.c, Math.max(1, Math.round(2 * yeastScale()))); const q = drag.pts[drag.pts.length - 1]; if (Math.hypot(d.x - q.x, d.y - q.y) >= 2) drag.pts.push({ x: d.x, y: d.y }); render(); }
    const fn = { fly: flyMove, melt: meltMove, acid: acidMove, spike: spikeMove, jelly: jellyMove, worm: wormMove, glitch: glitchMove, ribbon: ribbonMove, custom: customMove, rails: railsMove, hot: hotMove, wet: wetMove, dryer: dryerMove, bayer: bayerMove, blend: blendMove, comb: combMove, waves: wavesMove, amoeba: amoebaMove, leaky: leakyMove, frizzy: frizzyMove, tree: treeMove, alpha: alphaMove, web: webMove, paste: pasteMove, hose: hoseMove }[drag.sub];
    if (fn && dist > 0) {
      fn(a, d, drag.sp);
      render();
    }
    drag.last = drag.d = d;
  }
  function fxStep(t, dt) {
    const box = fxBox();
    /* le robinet : tant que le bouton est tenu, l'outil lâche ses gouttes */
    if (drag && drag.kind === "fx" && t > FX.emit) {
      const d = drag.d;
      if (drag.sub === "acid" && d.x >= 0 && d.x < DW && d.y >= 0 && d.y < DH) {
        FX.emit = t + 110;                                         // tenu sur place, le dissolvant continue d'agir
        acidSpot(d.x, d.y);
      } else if (drag.sub === "drip" && d.x >= 0 && d.x < DW && d.y >= 0 && d.y < DH) {
        FX.emit = t + 95;
        if (!FX.wet) FX.wet = new Uint8Array(DW * DH);
        const pw = PW(), dw = Math.max(1, Math.min(160, Math.round(pw * (0.45 + Math.random() * 0.4))));   // largeur de la coulure : environ la moitié de l'épaisseur courante
        const nd = { x: d.x - (dw >> 1) + Math.round((Math.random() - 0.5) * Math.max(12, pw * 1.5)), y: d.y, w: dw, vol: (70 + Math.random() * 230) * (0.8 + Math.min(4, pw / 20)), dir: Math.random() < 0.5 ? -1 : 1, slide: 0, color: ink, age: 0, hit: 0 };
        dripPaint(nd); FX.drips.push(nd);
        fxSnd("drip", d.x, d.y);
      }
    }
    if (drag && drag.kind === "fx" && drag.sub === "balls" && t > FX.emit) { FX.emit = t + 140; ballThrow(drag.d, drag.vx, drag.vy); drag.vx *= 0.6; drag.vy *= 0.6; }
    if (drag && drag.kind === "fx" && drag.sub === "leaky" && t - drag.t > 160 && t > FX.emit) { FX.emit = t + 220; drag.pool = Math.min(8 + PW() * 2, (drag.pool || leakyBase()) + 1 + PW() * 0.15); leakyBlot(drag.d.x, drag.d.y, drag.pool); }   // immobile : la tache grossit
    if (FX.balls.length) ballsStep(dt, box);
    { const m = pointerDoc(), pm = FX.pm; pm.vx += ((m.x - pm.x) / Math.max(0.004, dt) - pm.vx) * 0.5; pm.vy += ((m.y - pm.y) / Math.max(0.004, dt) - pm.vy) * 0.5; pm.x = m.x; pm.y = m.y; }
    if (FX.shards.length) shardsStep(dt, box);
    if (FX.coral && drag && drag.sub === "coral") coralStep();
    if (FX.plants.length) plantsStep(t, dt);
    if (FX.metal.length) metalStep(dt);
    if (FX.spores.length || FX.sprouts.length) sporesStep(dt, box);
    if (FX.pred) predStep();
    for (const q of FX.live) {
      if (q.type === "elastic") { q.v += ((0.45 - q.k) * 90 - q.v * 5) * dt; q.k += q.v * dt; if (Math.abs(q.v) < 0.02 && Math.abs(q.k - 0.45) < 0.01) { elasticCompose(q, 0, doc); q.dead = true; scheduleSave(); } }
      if (q.type === "acc") { const pv = q.v; q.v += ((q.target - q.s) * (q.held ? 220 : 120) - q.v * (q.held ? 22 : 3.2)) * dt; q.s += q.v * dt; if (!q.held) { if ((pv >= 0) !== (q.v >= 0) && Math.abs(q.s - q.target) > 0.02) fxSnd("twang", q.x, q.y, Math.min(1, 1 / q.s)); if (Math.abs(q.v) < 0.03 && Math.abs(q.s - q.target) < 0.01) { q.s = q.target; accCompose(q, 0, doc); q.dead = true; scheduleSave(); } } }
    }
    if (FX.live.some(q => q.dead)) FX.live = FX.live.filter(q => !q.dead);
    if (FX.storm && t > FX.stormNext) { FX.stormNext = t + 2857; strobe(t); }       // deux mesures à 168
    if (FX.parts.length) wetStep();
    if (drag && drag.kind === "fx" && drag.sub === "wet" && t > FX.emit) { FX.emit = t + 40; wetMove(drag.d, drag.d); }   // le pinceau tenu immobile continue de couler
    if (FX.wreck.length) wreckStep(dt, box);
    if (FX.plates.length) platesStep(dt, box);
    if (FX.live.length) { wormsStep(dt, t); flyStep(dt); }
    if ((FX.acid && FX.acid.length) || (FX.runs && FX.runs.length)) acidStep(dt);
    if (FX.melt && FX.melt.length) meltStep(dt);
    if (FX.dough.length) doughStep(dt);
    if (FX.blobs.length) blobsStep(dt);
    if (FX.pump) pumpStep(t);
    if (FX.reveal > 0) { FX.reveal += dt / 2.6; if (Math.random() < 0.3) fxSnd("web", view.x + Math.random() * 300, view.y + (1 - FX.reveal) * 300); if (FX.reveal >= 1) FX.reveal = 0; }
    if (FX.replay && t > FX.replay.next) {                        // le film : douze images par seconde, une note par image
      const R = FX.replay;
      if (R.i >= R.frames.length) FX.replay = null;
      else { R.cur = unrle(R.frames[R.i], DW * DH); R.next = t + 85; fxSnd("spit", view.x + (R.i / R.frames.length) * VIEW.w / zoom, view.y + (1 - R.i / R.frames.length) * VIEW.h / zoom); R.i++; }
    }
    weatherStep(dt, box, t);
    for (const b of FX.bombs) { b.fuse -= dt; b.tick -= dt; if (b.tick <= 0 && b.fuse > 0) { b.tick = Math.max(0.06, b.fuse * 0.22); fxSnd("tick", b.x, b.y); } if (b.fuse <= 0) explode(b); }
    FX.bombs = FX.bombs.filter(b => b.fuse > 0);
    for (const r of FX.rings) { r.r += 420 * dt; r.life -= dt; }
    FX.rings = FX.rings.filter(r => r.life > 0);
    /* éclats : gravité, rebonds sur les quatre bords de la fenêtre, puis ils se posent et rentrent dans le dessin */
    let landed = false;
    for (const f of FX.frags) {
      f.age += dt; f.vy += 900 * dt; f.x += f.vx * dt; f.y += f.vy * dt;
      let hit = 0;
      if (f.x < box.x0) { f.x = box.x0; hit = Math.abs(f.vx); f.vx = -f.vx * 0.66; }
      if (f.x > box.x1 - f.T) { f.x = box.x1 - f.T; hit = Math.abs(f.vx); f.vx = -f.vx * 0.66; }
      if (f.y < box.y0) { f.y = box.y0; hit = Math.abs(f.vy); f.vy = -f.vy * 0.66; }
      if (f.y > box.y1 - f.T) {
        f.y = box.y1 - f.T; hit = Math.max(hit, Math.abs(f.vy));
        f.vy = -f.vy * 0.6; f.vx *= 0.8;
        if (Math.abs(f.vy) < 45) { f.vy = 0; f.rest += dt + 0.05; }
      }
      if (hit > 130) fxSnd("bounce", f.x, f.y);
      if (f.rest > 0.25 || f.age > 7) { fragStamp(f); f.dead = true; landed = true; }
    }
    if (landed) { FX.frags = FX.frags.filter(f => !f.dead); if (!FX.frags.length) scheduleSave(); }
    /* acide */
    for (const a of FX.drops) {
      a.vy = Math.min(300, a.vy + 520 * dt); a.fy += a.vy * dt;
      while (a.y < Math.floor(a.fy) && a.power > 0) {
        a.y++;
        if (a.y >= box.y1) { a.power = 0; break; }
        const n = acidBite(a.x, a.y, a.r);
        if (n) { a.power -= n * 0.45; a.vy *= 0.5; a.fy = a.y; if (Math.random() < 0.55) puff(a.x + Math.round((Math.random() - 0.5) * 4), a.y - 1); fxSnd("fizz", a.x, a.y); break; }
      }
      if (a.power <= 0 && a.y < box.y1) { puff(a.x, a.y); puff(a.x + 1, a.y - 2); }
    }
    FX.drops = FX.drops.filter(a => a.power > 0);
    for (const u of FX.bubbles) { u.life -= dt; u.y += u.vy * dt; u.ph += dt * 5; u.r += dt * 0.9; if (u.y < box.y0 - 6) u.life = 0; }
    FX.bubbles = FX.bubbles.filter(u => u.life > 0);
    /* coulures : elles accélèrent, puis ralentissent quand la peinture s'épuise */
    for (const d of FX.drips) {
      d.age += dt;
      let n = d.vol < 30 ? (Math.random() < 0.5 ? 1 : 0) : Math.min(4, 1 + Math.floor(d.age * 5));
      while (n-- > 0 && !d.dead) if (!dripStep(d)) { dripEnd(d); d.dead = true; fxSnd("plip", d.x, d.y); }
    }
    FX.drips = FX.drips.filter(d => !d.dead);
    if (FX.live.length || FX.grid || FX.storm || t < FX.strobeUntil || FX.plants.length || FX.metal.length || FX.spores.length || FX.sprouts.length || FX.pred || FX.sun || tool === "repel" || FX.pokes.length || FX.shards.length || RD.on || (drag && drag.sub === "coral")) return true;
    if (FX.parts.length && (FX.moving > 0 || (drag && drag.sub === "wet"))) return true;
    if (FX.wreck.length || FX.plates.length || FX.dough.length || FX.blobs.length || FX.hearts.length || FX.pump || FX.boil || FX.replay || FX.reveal > 0 || (drag && drag.kind === "fx" && (drag.sub === "ball" || drag.sub === "slice" || drag.sub === "pump"))) return true;
    return !!((FX.melt && FX.melt.length) || (FX.acid && FX.acid.length) || (FX.runs && FX.runs.length) || LT.on || FX.bombs.length || FX.frags.length || FX.rings.length || FX.drops.length || FX.bubbles.length || FX.drips.length || FX.balls.length || FX.sky.length || (drag && drag.kind === "fx" && ["acid", "drip", "balls", "rain", "snow", "leaky"].includes(drag.sub)));
  }
  /* Tout ce qui vole, par-dessus la feuille et rogné à la fenêtre. */
  function fxDraw() {
    const z = zoom, X = x => VIEW.x + (x - view.x) * z, Y = y => VIEW.y + (y - view.y) * z, R = (x, y, w, h, c) => { ctx.fillStyle = c; ctx.fillRect(X(x), Y(y), w * z, h * z); };
    ctx.save();
    ctx.beginPath(); ctx.rect(VIEW.x, VIEW.y, VIEW.w, VIEW.h); ctx.clip();
    ctx.imageSmoothingEnabled = false;
    if (LT.on && Math.floor(performance.now() / 280) % 2 === 0) R(LT.x, LT.y - 12, 1, 15, PALETTE[RAINBOW[Math.floor(performance.now() / 280 / 2) % 7]]);   // le point d'insertion change de couleur
    for (const q of FX.plates) ctx.drawImage(q.c, X(q.x0 + (q.ox || 0)), Y(q.y0 + (q.oy || 0)), q.c.width * z, q.c.height * z);
    if (FX.blobs.length) { const bb = blobBox(); blobField(bb.x0, bb.y0, bb.x1 - bb.x0 + 1, bb.y1 - bb.y0 + 1, (bx, by, c) => R(bx, by, 1, 1, PALETTE[c] || "#000")); }
    for (const b of FX.wreck) { for (let j = -b.r; j <= b.r; j++) for (let i = -b.r; i <= b.r; i++) { const dd = i * i + j * j; if (dd <= b.r * b.r + 2) R(Math.round(b.x) + i, Math.round(b.y) + j, 1, 1, dd > (b.r - 1.5) * (b.r - 1.5) || ((i + j) & 1 && i + j > 1) ? "#000" : i + j < -3 ? "#fff" : "#808080"); } }
    if (drag && drag.kind === "fx" && (drag.sub === "ball" || drag.sub === "slice" || drag.sub === "grid")) {
      const A = drag.a, D = drag.d, n = Math.max(Math.abs(D.x - A.x), Math.abs(D.y - A.y)) || 1;
      for (let k = 0; k <= n; k++) if (drag.sub === "ball" || (k >> 2) & 1) R(Math.round(A.x + (D.x - A.x) * k / n), Math.round(A.y + (D.y - A.y) * k / n), 1, 1, "#000");
      if (drag.sub === "ball") { R(D.x - 4, D.y - 3, 9, 7, "#000"); R(D.x - 3, D.y - 4, 7, 9, "#000"); R(D.x - 3, D.y - 3, 7, 7, "#808080"); R(D.x - 2, D.y - 2, 2, 2, "#fff"); R(A.x - 1, A.y - 1, 3, 3, "#000"); }
    }
    for (const b of FX.balls) {                                  // une vraie boule : disque noir, disque de couleur, reflet en haut à gauche
      const bx = Math.round(b.x), by = Math.round(b.y), disc = (r, col) => { for (let j = -r; j <= r; j++) { const h = Math.floor(Math.sqrt(r * r - j * j + r * 0.8)); R(bx - h, by + j, h * 2 + 1, 1, col); } };
      disc(b.r, "#000"); if (b.r > 1) disc(b.r - 1, PALETTE[b.c] || "#000");
      const hl = Math.max(1, Math.round(b.r / 4)), ho = Math.round(b.r * 0.38); R(bx - ho - (hl >> 1), by - ho - (hl >> 1), hl, hl, "#fff");
    }
    for (const p of FX.sky) { if (p.snow) { R(Math.round(p.x), Math.round(p.y), 2, 1, PALETTE[p.c]); R(Math.round(p.x), Math.round(p.y) - 1, 1, 1, PALETTE[p.c]); } else for (let k = 0; k < 6; k++) R(Math.round(p.x + k * 0.33), Math.round(p.y) - k, 1, 1, PALETTE[p.c]); }
    for (const f of FX.frags) ctx.drawImage(f.c, X(Math.round(f.x)), Y(Math.round(f.y)), f.T * z, f.T * z);
    for (const b of FX.bombs) {
      R(b.x - 3, b.y - 5, 7, 13, "#000"); R(b.x - 2, b.y - 4, 5, 11, "#dd0806"); R(b.x - 2, b.y - 1, 5, 1, "#fff"); R(b.x - 2, b.y + 3, 5, 1, "#fff");
      const L = Math.ceil(b.fuse * 6);                           // la mèche raccourcit
      for (let k = 0; k < L; k++) R(b.x + (k >> 1), b.y - 6 - k, 1, 1, "#000");
      const s = Math.floor(performance.now() / 50) % 3, sx = b.x + (L >> 1), sy = b.y - 6 - L;
      R(sx - 1, sy, 3, 1, s ? "#fcf305" : "#fff"); R(sx, sy - 1, 1, 3, s ? "#ff6402" : "#fcf305");
      if (s === 2) { R(sx - 2, sy - 2, 1, 1, "#ff6402"); R(sx + 2, sy - 1, 1, 1, "#fcf305"); }
    }
    for (const r of FX.rings) {                                  // l'onde de choc, en points
      const n = Math.max(12, Math.floor(r.r * 1.2));
      for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2; R(Math.round(r.x + Math.cos(a) * r.r), Math.round(r.y + Math.sin(a) * r.r), 2, 2, k & 1 ? "#000" : "#fcf305"); }
    }
    for (const a of FX.drops) { R(a.x, a.y - 2, 1, 1, "#1fb714"); R(a.x - 1, a.y - 1, 3, 2, "#39ff14"); R(a.x, a.y + 1, 1, 1, "#39ff14"); }
    ctx.fillStyle = "#000";
    for (const u of FX.bubbles) {                                // fumée : disques en damier 1 bit
      const cx = Math.round(u.x + Math.sin(u.ph) * 2), cy = Math.round(u.y), r = Math.round(u.r);
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
        const d2 = i * i + j * j;
        if (d2 > r * r + 1) continue;
        if (((cx + i + cy + j) & 1) === 0) ctx.fillRect(X(cx + i), Y(cy + j), z, z);
      }
    }
    ctx.restore();
    ctx.fillStyle = "#000";
  }
  /* Les quatre cases, dans la barre de menus, entre « Style » et le nuancier. */
  function fxCellAt(p) {
    if (PALS.on) return palAt(p);
    const c = Math.floor((p.x - FXCELL.x) / FXCELL.w), r = Math.floor((p.y - FXCELL.y) / FXCELL.h), k = r * 2 + c;
    if (c >= 0 && c < 2 && r === FXROWS) { fxScroll(c ? 1 : -1); return null; }      // les deux flèches, sous la grille
    return c >= 0 && c < 2 && r >= 0 && r < FXROWS && k + FX.scroll * 2 < FX_ALL.length ? FX_ALL[k + FX.scroll * 2] : null;
  }
  /* Icônes : dessinées point par point, en noir, blanc et trames, dans une case 25 × 21. */
  /* Les pictogrammes sont composés point par point : on ne le fait qu'une fois par état, puis on recolle l'image. */
  const ICON_CACHE = new Map(); let ICX = null;
  function fxIcon(t, x, y, k0) {
    const key = t + k0 + (t === "drip" || t === "wet" ? ink : "");   // ces deux-là portent la couleur courante
    let c = ICON_CACHE.get(key);
    if (!c) {
      c = document.createElement("canvas"); c.width = 27; c.height = 23;
      ICX = c.getContext("2d"); try { fxIconDraw(t, 1, 1, k0); } finally { ICX = null; }
      if (ICON_CACHE.size > 600) ICON_CACHE.clear();
      ICON_CACHE.set(key, c);
    }
    ctx.drawImage(c, x - 1, y - 1);
  }
  function fxIconDraw(t, x, y, k0) {
    /* Style MacPaint : un seul bit. Chaque couleur d'accent devient du noir, du blanc ou une
       trame (75 %, 50 %, 25 %) selon sa clarté. k0 est l'encre de la case (blanche si elle est choisie). */
    const paper = k0 === "#000" ? "#fff" : "#000";
    const tone = c => { if (c === k0) return 4; let h = c.slice(1); if (h.length === 3) h = h.replace(/./g, "$&$&"); const L = (parseInt(h.slice(0, 2), 16) * 0.3 + parseInt(h.slice(2, 4), 16) * 0.59 + parseInt(h.slice(4, 6), 16) * 0.11) / 255; return L > 0.93 ? 0 : L > 0.72 ? 1 : L > 0.45 ? 2 : L > 0.2 ? 3 : 4; };
    const dot = (X, Y, t) => { const on = t === 4 || (t === 3 && !((X & 1) && (Y & 1))) || (t === 2 && ((X + Y) & 1) === 0) || (t === 1 && !(X & 1) && !(Y & 1)); const g = ICX || ctx; g.fillStyle = on ? k0 : paper; g.fillRect(x + X, y + Y, 1, 1); };
    const r = (a, b, w, h, c) => { const t = tone(c); a = Math.round(a); b = Math.round(b); for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) dot(a + i, b + j, t); };
    const ln = (x0, y0, x1, y1, c) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1, t = Math.min(4, tone(c) + 2) || 0; for (let i = 0; i <= n; i++) dot(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), tone(c) === 0 ? 0 : t); };
    if (t === "wild") { r(7, 3, 1, 5, "#dd0806"); r(5, 5, 5, 1, "#dd0806"); r(6, 4, 3, 3, "#fcf305"); r(14, 4, 4, 1, "#0000d4"); r(13, 5, 6, 4, "#02abea"); r(14, 9, 4, 1, "#0000d4"); for (let i = 0; i < 5; i++) r(9 - i, 12 + i, 1 + i * 2, 1, "#1fb714"); r(16, 13, 3, 3, "#f20884"); r(4, 11, 1, 1, k0); r(20, 17, 1, 1, k0); }
    else if (t === "type") { r(7, 4, 3, 1, "#dd0806"); r(6, 5, 5, 1, "#dd0806"); r(5, 6, 2, 10, "#dd0806"); r(10, 6, 2, 10, "#dd0806"); r(7, 10, 3, 2, "#dd0806"); r(15, 11, 4, 1, "#0000d4"); r(18, 12, 1, 5, "#0000d4"); r(15, 13, 3, 1, "#0000d4"); r(14, 14, 1, 2, "#0000d4"); r(15, 16, 3, 1, "#0000d4"); r(16, 3, 1, 5, "#1fb714"); r(14, 5, 5, 1, "#1fb714"); }
    else if (t === "alpha") { ln(4, 14, 7, 6, k0); ln(7, 6, 10, 14, k0); r(6, 11, 4, 1, k0); r(12, 8, 1, 7, "#dd0806"); r(13, 8, 3, 1, "#dd0806"); r(13, 11, 3, 1, "#dd0806"); r(13, 14, 3, 1, "#dd0806"); r(16, 9, 1, 2, "#dd0806"); r(16, 12, 1, 2, "#dd0806"); r(19, 10, 3, 1, "#0000d4"); r(18, 11, 1, 3, "#0000d4"); r(19, 14, 3, 1, "#0000d4"); }
    else if (t === "leaky") { ln(18, 3, 10, 11, k0); ln(19, 4, 11, 12, k0); r(9, 12, 2, 2, k0); r(5, 14, 7, 4, k0); r(4, 15, 9, 2, k0); r(3, 12, 1, 1, k0); r(14, 17, 2, 1, k0); r(15, 14, 1, 1, k0); }
    else if (t === "frizzy") { ln(4, 15, 20, 6, k0); for (const [a, b, c, d] of [[7, 13, 5, 8], [9, 12, 11, 17], [12, 10, 10, 5], [14, 9, 17, 14], [17, 8, 16, 3], [19, 7, 21, 11]]) ln(a, b, c, d, "#0000d4"); }
    else if (t === "tree") { r(11, 9, 2, 9, "#562c05"); ln(12, 12, 7, 8, "#562c05"); ln(12, 10, 17, 6, "#562c05"); ln(7, 8, 5, 5, "#562c05"); ln(17, 6, 19, 3, "#562c05"); for (const [a, b] of [[4, 4], [8, 6], [16, 4], [20, 2], [12, 7], [19, 7]]) r(a, b, 2, 2, "#1fb714"); }
    else if (t === "web") { for (const [a, b] of [[12, 3], [20, 7], [20, 15], [12, 18], [4, 15], [4, 7]]) ln(12, 10, a, b, k0); const q = [[12, 6], [16, 8], [16, 13], [12, 15], [8, 13], [8, 8]]; q.forEach((v, i) => ln(v[0], v[1], q[(i + 1) % 6][0], q[(i + 1) % 6][1], k0)); }
    else if (t === "paste") { r(3, 12, 9, 6, k0); r(4, 13, 7, 4, "#fff"); r(12, 14, 2, 2, k0); r(6, 13, 2, 4, "#dd0806"); for (let i = 0; i < 7; i++) { r(14 + i, 10 - (i > 3 ? i - 3 : 0), 1, 5, k0); r(14 + i, 11 - (i > 3 ? i - 3 : 0), 1, 3, i % 3 === 0 ? "#02abea" : i % 3 === 1 ? "#fff" : "#dd0806"); } }
    else if (t === "hose") { r(3, 14, 8, 3, k0); r(11, 13, 2, 5, k0); r(15, 5, 3, 3, "#ff6402"); r(19, 10, 3, 3, "#808080"); r(15, 12, 4, 4, k0); r(16, 13, 2, 2, "#fff"); r(17, 14, 1, 1, k0); r(19, 3, 3, 3, "#fcf305"); r(14, 9, 1, 1, k0); }
    else if (t === "cycle") { r(11, 3, 3, 7, k0); r(8, 10, 9, 1, k0); ["#dd0806", "#ff6402", "#fcf305", "#1fb714", "#02abea", "#0000d4", "#4600a5", "#f20884", "#dd0806"].forEach((c, i) => r(8 + i, 11, 1, 5 + (i % 2), c)); }
    else if (t === "balls") { for (const [a, b, c] of [[5, 13, "#02abea"], [12, 5, "#dd0806"], [18, 12, "#fcf305"]]) { r(a, b - 1, 3, 5, k0); r(a - 1, b, 5, 3, k0); r(a, b, 3, 3, c); } ln(3, 9, 6, 11, k0); ln(15, 8, 17, 10, k0); r(9, 17, 1, 1, k0); r(11, 16, 1, 1, k0); }
    else if (t === "rain") { r(6, 4, 12, 4, k0); r(4, 6, 16, 3, k0); r(7, 5, 10, 3, "#c0c0c0"); for (const a of [6, 10, 14, 18]) ln(a, 11, a - 2, 16, "#0000d4"); }
    else if (t === "snow") { r(6, 4, 12, 4, k0); r(4, 6, 16, 3, k0); r(7, 5, 10, 3, "#fff"); for (const [a, b] of [[6, 12], [11, 14], [16, 11], [19, 15], [8, 17], [14, 17]]) { r(a, b, 1, 1, "#02abea"); r(a - 1, b, 3, 1, "#02abea"); r(a, b - 1, 1, 3, "#02abea"); } }
    else if (t === "drip") { const c = PALETTE[ink === 0 ? 1 : ink]; r(4, 3, 17, 4, c); r(5, 7, 3, 9, c); r(10, 7, 3, 4, c); r(14, 7, 3, 11, c); r(18, 7, 2, 6, c); r(5, 16, 3, 1, c); }
    else if (t === "acid") { for (let i = 0; i < 8; i++) r(17 - i, 3 + i, 2, 2, k0); r(18, 2, 4, 4, k0); r(9, 12, 1, 1, "#39ff14"); r(8, 13, 3, 3, "#39ff14"); r(9, 16, 1, 1, "#39ff14"); r(6, 18, 1, 1, "#39ff14"); r(12, 18, 1, 1, "#39ff14"); }
    else if (t === "hammer") { r(5, 4, 10, 5, k0); r(6, 5, 8, 3, "#c0c0c0"); ln(11, 9, 17, 17, k0); ln(12, 9, 18, 17, k0); ln(3, 14, 9, 12, "#02abea"); ln(9, 12, 7, 18, "#02abea"); ln(9, 12, 14, 15, "#02abea"); ln(3, 18, 6, 15, "#02abea"); }
    else if (t === "coral") { let px2 = 12, py2 = 10; for (let q = 0; q < 40; q++) { const a = q / 40 * 6.283, rr = 5 + 2.5 * Math.sin(a * 6) + 1.2 * Math.sin(a * 11); const nx = 12 + Math.round(Math.cos(a) * rr * 1.3), ny = 10 + Math.round(Math.sin(a) * rr); if (q) ln(px2, py2, nx, ny, "#ff6402"); px2 = nx; py2 = ny; } r(11, 9, 3, 3, "#f20884"); }
    else if (t === "custom") { r(4, 4, 8, 8, "#dd0806"); r(4, 4, 8, 1, k0); r(4, 11, 8, 1, k0); r(4, 4, 1, 8, k0); r(11, 4, 1, 8, k0); for (let q = 0; q < 5; q++) { r(12 + q * 2, 9 + q, 6 - q, 7 - q, q & 1 ? "#fcf305" : "#02abea"); } ln(13, 4, 20, 4, k0); ln(18, 2, 20, 4, k0); ln(18, 6, 20, 4, k0); }
    else if (t === "extrude") { for (let q = 5; q >= 1; q--) r(5 + q, 4 + q, 9, 8, q & 1 ? k0 : "#808080"); r(5, 4, 9, 8, "#fcf305"); r(5, 4, 9, 1, k0); r(5, 11, 9, 1, k0); r(5, 4, 1, 8, k0); r(13, 4, 1, 8, k0); }
    else if (t === "spike") { ln(3, 15, 21, 7, k0); ln(3, 16, 21, 8, k0); ln(3, 14, 21, 6, k0); for (const [a, b, c, d] of [[6, 13, 3, 6], [10, 12, 12, 19], [13, 10, 12, 2], [16, 9, 20, 16], [19, 7, 21, 1], [8, 13, 5, 19]]) { ln(a, b, c, d, k0); ln(a + 1, b, c, d, k0); ln(a + 2, b, c, d, k0); } }
    else if (t === "jelly") { for (const [a, b, w] of [[3, 14, 3], [6, 12, 5], [10, 10, 4], [13, 7, 7], [18, 6, 3]]) { r(a, b, w, w, k0); } r(14, 8, 2, 2, "#fff"); }
    else if (t === "worm") { for (let i = 0; i < 4; i++) { const a = 2 + i * 5, b = 11 - (i & 1) * 2; r(a + 1, b, 4, 6, k0); r(a, b + 1, 6, 4, k0); if (i < 3) r(a + 1, b + 1, 4, 4, i & 1 ? "#1fb714" : "#fcf305"); r(a + 2, b + 6, 1, 2, k0); } r(18, 10, 1, 1, "#fff"); r(20, 10, 1, 1, "#fff"); ln(19, 8, 21, 5, k0); }
    else if (t === "fly") { r(9, 9, 7, 6, k0); r(10, 10, 5, 4, "#02abea"); ln(4, 8, 8, 10, k0); ln(4, 12, 8, 11, k0); ln(20, 8, 16, 10, k0); ln(20, 12, 16, 11, k0); ln(12, 3, 12, 6, k0); ln(10, 5, 12, 3, k0); ln(14, 5, 12, 3, k0); r(11, 17, 1, 2, "#808080"); r(13, 18, 1, 2, "#808080"); }
    else if (t === "melt") { r(4, 3, 16, 5, k0); for (const [a, b] of [[4, 6], [7, 11], [10, 4], [13, 14], [16, 7], [19, 3]]) { r(a, 8, 2, b, k0); r(a, 8 + b, 2, 1, "#808080"); } r(13, 21 - 1, 2, 1, k0); }
    else if (t === "glitch") { r(5, 3, 13, 3, k0); r(9, 6, 13, 3, k0); r(2, 9, 13, 3, k0); r(7, 12, 13, 3, k0); r(4, 15, 13, 3, k0); r(18, 3, 2, 3, "#dd0806"); r(5, 6, 3, 3, "#02abea"); r(15, 9, 3, 3, "#dd0806"); r(3, 12, 3, 3, "#02abea"); }
    else if (t === "ribbon") { for (let i = 0; i < 4; i++) { const a = 3 + i * 5; for (let j = 0; j < 9; j++) r(a + (i & 1 ? 4 - (j >> 1) : j >> 1), 6 + j, 5, 1, i & 1 ? "#02abea" : k0); ln(a + (i & 1 ? 4 : 0), 6, a + (i & 1 ? 0 : 4), 14, k0); } }
    else if (t === "lathe") { for (let j = 0; j < 14; j++) { const w2 = Math.round(3 + 3 * Math.sin(j / 2.2) + (j > 10 ? 3 : 0)); r(12 - w2, 4 + j, w2 * 2, 1, k0); r(12 - w2 + 1, 4 + j, Math.max(0, w2 - 1), 1, "#02abea"); r(12, 4 + j, Math.max(0, w2 - 1), 1, "#0000d4"); } ln(12, 2, 12, 19, k0); }
    else if (t === "fold") { r(4, 5, 9, 12, k0); r(5, 6, 8, 10, "#fff"); for (let j = 0; j < 12; j++) { const w2 = Math.round(7 - j * 0.3); r(13, 5 + j - Math.round(j * 0.15), w2, 1, j === 0 || j === 11 ? k0 : "#c0c0c0"); r(13 + w2, 5 + j - Math.round(j * 0.15), 1, 1, k0); } ln(13, 4, 13, 17, k0); }
    else if (t === "graft") { ln(12, 18, 12, 9, "#006411"); ln(13, 18, 13, 9, "#006411"); ln(12, 13, 8, 11, "#006411"); ln(13, 15, 17, 13, "#006411"); for (const [a, b] of [[12, 4], [8, 6], [16, 6], [9, 9], [15, 9]]) r(a - 1, b - 1, 4, 4, "#f20884"); r(11, 6, 3, 3, "#fcf305"); }
    else if (t === "sun") { for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) if (i * i + j * j <= 17) r(12 + i, 10 + j, 1, 1, i * i + j * j > 11 ? k0 : "#fcf305"); for (let q = 0; q < 8; q++) { const a = q * Math.PI / 4; ln(12 + Math.round(Math.cos(a) * 6), 10 + Math.round(Math.sin(a) * 6), 12 + Math.round(Math.cos(a) * 9), 10 + Math.round(Math.sin(a) * 9), q & 1 ? "#ff6402" : k0); } }
    else if (t === "shaker") { r(8, 5, 9, 8, "#02abea"); r(8, 5, 9, 1, k0); r(8, 12, 9, 1, k0); r(8, 5, 1, 8, k0); r(16, 5, 1, 8, k0); ln(4, 7, 6, 9, k0); ln(4, 11, 6, 9, k0); ln(20, 7, 18, 9, k0); ln(20, 11, 18, 9, k0); for (const [a, b] of [[6, 16], [11, 17], [16, 15], [20, 17], [3, 14]]) r(a, b, 2, 2, "#02abea"); }
    else if (t === "metal") { for (let j = -6; j <= 6; j++) for (let i = -8; i <= 8; i++) { const dd = i * i / 64 + j * j / 36; if (dd <= 1) r(12 + i, 10 + j, 1, 1, dd > 0.75 ? k0 : j < -3 ? "#fff" : j < 0 ? "#c0c0c0" : j < 2 ? k0 : "#808080"); } r(8, 6, 3, 1, "#fff"); }
    else if (t === "motor") { for (let q = 0; q < 8; q++) { const a = q * Math.PI / 4; r(12 + Math.round(Math.cos(a) * 7) - 1, 10 + Math.round(Math.sin(a) * 7) - 1, 3, 3, k0); } for (let j = -5; j <= 5; j++) for (let i = -5; i <= 5; i++) { const dd = i * i + j * j; if (dd <= 26) r(12 + i, 10 + j, 1, 1, dd < 5 ? "#fff" : k0); } }
    else if (t === "elastic") { ln(3, 6, 8, 14, "#dd0806"); ln(8, 14, 12, 6, "#dd0806"); ln(12, 6, 16, 14, "#dd0806"); ln(16, 14, 21, 6, "#dd0806"); ln(3, 7, 8, 15, "#dd0806"); ln(8, 15, 12, 7, "#dd0806"); ln(12, 7, 16, 15, "#dd0806"); ln(16, 15, 21, 7, "#dd0806"); r(2, 4, 3, 3, k0); r(20, 4, 3, 3, k0); }
    else if (t === "hot") { for (const [a, b, h2, c] of [[6, 8, 9, "#dd0806"], [10, 4, 13, "#ff6402"], [14, 7, 10, "#dd0806"], [8, 11, 6, "#fcf305"], [12, 9, 8, "#fcf305"]]) r(a, b, 4, h2, c); r(4, 17, 16, 2, k0); }
    else if (t === "repel") { for (let j = 0; j < 5; j++) for (let i = 0; i < 6; i++) { const X = 4 + i * 3, Y = 4 + j * 3, dx = X - 12, dy = Y - 10, d = Math.hypot(dx, dy) || 1, f = d < 7 ? (7 - d) * 0.45 : 0; r(Math.round(X + dx / d * f), Math.round(Y + dy / d * f), 2, 2, d < 3 ? "#fff" : k0); } }
    else if (t === "accordion") { for (let i = 0; i < 6; i++) { r(3 + i * 3 + (i > 2 ? i - 2 : 0), 5, 2, 11, i & 1 ? "#0000d4" : "#02abea"); } ln(2, 18, 22, 18, k0); r(2, 17, 1, 3, k0); r(22, 17, 1, 3, k0); }
    else if (t === "rails") { for (let i = 0; i < 5; i++) r(4 + i * 4, 6, 2, 9, "#562c05"); r(2, 8, 21, 1, k0); r(2, 12, 21, 1, k0); }
    else if (t === "grid") { r(3, 3, 19, 15, k0); r(4, 4, 7, 9, "#dd0806"); r(12, 4, 9, 4, "#fff"); r(12, 9, 9, 8, "#fcf305"); r(4, 14, 7, 3, "#0000d4"); r(13, 5, 2, 2, k0); }
    else if (t === "blinds") { for (let j = 0; j < 7; j++) r(5 + (j & 1 ? 3 : -1) + (j === 3 ? 1 : 0), 3 + j * 2, 14, 2, j & 1 ? "#0000d4" : k0); }
    else if (t === "moire") { for (let i = 0; i < 7; i++) { ln(4 + i * 3, 3, 4 + i * 3, 17, k0); ln(3 + i * 3, 4, 7 + i * 3, 17, "#dd0806"); } }
    else if (t === "balloon") { for (let j = -6; j <= 6; j++) for (let i = -7; i <= 7; i++) { const dd = i * i / 49 + j * j / 36; if (dd <= 1) r(11 + i, 9 + j, 1, 1, dd > 0.72 ? k0 : "#f20884"); } r(7, 6, 2, 2, "#fff"); ln(11, 15, 13, 19, k0); r(9, 7, 1, 5, "#fff"); r(13, 7, 1, 5, "#fff"); r(10, 6, 3, 1, "#fff"); r(10, 9, 3, 1, "#fff"); }
    else if (t === "wet") { const c = PALETTE[ink === 0 ? 1 : ink]; r(11, 2, 3, 6, k0); r(9, 8, 7, 1, k0); r(10, 9, 5, 2, c); for (const [a, b] of [[12, 12], [10, 14], [14, 14], [8, 16], [12, 16], [16, 16], [6, 18], [10, 18], [14, 18], [18, 18]]) r(a, b, 2, 1, c); }
    else if (t === "dryer") { r(4, 5, 11, 7, k0); r(5, 6, 9, 5, "#fff"); r(15, 7, 5, 3, k0); r(7, 12, 4, 6, k0); r(8, 13, 2, 4, "#fff"); for (const b of [5, 8, 11]) ln(21, b, 23, b, "#dd0806"); r(7, 8, 3, 1, k0); }
    else if (t === "bayer") { r(4, 5, 12, 6, k0); r(5, 6, 10, 4, "#fff"); for (let i = 0; i < 5; i++) r(6 + i * 2, 6 + (i & 1) * 2, 1, 1, k0); r(16, 7, 3, 2, k0); r(18, 9, 2, 8, k0); for (let j = 0; j < 4; j++) for (let i = 0; i < 6; i++) if ((i + j) & 1) r(4 + i * 2, 13 + j, 1, 1, k0); }
    else if (t === "blend") { r(3, 5, 8, 11, "#dd0806"); r(14, 5, 8, 11, "#1fb714"); for (let j = 0; j < 11; j++) for (let i = 0; i < 6; i++) r(9 + i, 5 + j, 1, 1, (i + j) & 1 ? "#dd0806" : "#1fb714"); }
    else if (t === "comb") { r(4, 3, 17, 3, k0); for (let i = 0; i < 6; i++) r(5 + i * 3, 6, 1, 5, k0); for (let j = 0; j < 4; j++) for (let i = 0; i < 8; i++) r(4 + i * 2 + (j & 1) * (j > 1 ? 1 : 0) + (j === 3 ? 1 : 0), 13 + j, 1, 1, k0); }
    else if (t === "waves") { for (let j = 0; j < 4; j++) for (let i = 0; i < 18; i++) r(3 + i, 5 + j * 4 + Math.round(Math.sin(i / 2.2 + j) * 1.6), 1, 1, j & 1 ? "#02abea" : "#0000d4"); }
    else if (t === "yeast") { r(4, 14, 16, 3, "#90713a"); r(6, 10, 6, 5, "#90713a"); r(12, 8, 7, 7, "#90713a"); r(8, 11, 2, 2, "#fff"); r(14, 10, 3, 3, "#fff"); r(15, 11, 1, 1, "#90713a"); ln(5, 13, 6, 10, k0); ln(6, 9, 11, 9, k0); ln(12, 7, 18, 7, k0); ln(19, 8, 20, 14, k0); ln(4, 17, 20, 17, k0); }
    else if (t === "ball") { ln(4, 3, 12, 11, k0); r(3, 2, 3, 3, k0); for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) if (i * i + j * j <= 17) r(15 + i, 13 + j, 1, 1, i + j < -3 ? "#c0c0c0" : k0); r(4, 16, 3, 2, "#dd0806"); r(8, 17, 2, 2, "#dd0806"); }
    else if (t === "slice") { r(3, 10, 8, 7, "#02abea"); r(12, 5, 9, 7, "#02abea"); ln(2, 15, 22, 5, k0); ln(2, 16, 22, 6, "#fff"); r(11, 13, 9, 4, "#0000d4"); r(3, 5, 7, 3, "#0000d4"); }
    else if (t === "pump") { r(6, 3, 8, 2, k0); r(9, 5, 2, 5, k0); r(7, 10, 6, 8, k0); r(8, 11, 4, 6, "#fff"); ln(13, 16, 17, 16, k0); for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (i * i + j * j <= 10) r(19 + i, 9 + j, 1, 1, i * i + j * j > 6 ? k0 : i + j < -1 ? "#fff" : "#dd0806"); ln(19, 13, 18, 16, k0); }
    else if (t === "amoeba") { for (let j = -5; j <= 5; j++) for (let i = -9; i <= 9; i++) { const f = 22 / ((i + 4) * (i + 4) + j * j + 1) + 16 / ((i - 5) * (i - 5) + j * j + 1); if (f > 1) r(12 + i, 10 + j, 1, 1, f < 1.35 ? k0 : i < 0 ? "#1fb714" : i < 2 ? ((i + j) & 1 ? "#1fb714" : "#f20884") : "#f20884"); } }
    else if (t === "heart") { for (let j = 0; j < 10; j++) for (let i = -6; i <= 6; i++) { const a = Math.abs(i), y2 = j - 3; if ((a - 3) * (a - 3) + y2 * y2 <= 10 && y2 <= 0 || (y2 > 0 && a <= 6 - y2)) r(12 + i, 5 + j, 1, 1, "#dd0806"); } r(8, 6, 2, 2, "#fff"); ln(2, 17, 6, 17, k0); ln(6, 17, 8, 14, k0); ln(8, 14, 10, 19, k0); ln(10, 19, 12, 17, k0); ln(12, 17, 22, 17, k0); }
    else if (t === "cfill") { ["#dd0806", "#ff6402", "#fcf305", "#1fb714", "#02abea", "#0000d4", "#4600a5"].forEach((c, i) => { for (let j = -8; j <= 8; j++) for (let x2 = -9; x2 <= 9; x2++) { const d2 = Math.hypot(x2, j); if (d2 <= 8 - i * 1.15 && d2 > 8 - (i + 1) * 1.15) r(12 + x2, 10 + j, 1, 1, c); } }); }
    else if (t === "cube") { for (const [a, b, c, d] of [[12, 3, 5, 6], [12, 3, 19, 6], [5, 6, 12, 9], [19, 6, 12, 9], [5, 6, 5, 14], [19, 6, 19, 14], [12, 9, 12, 18], [5, 14, 12, 18], [19, 14, 12, 18]]) ln(a, b, c, d, k0); for (let j = 0; j < 8; j++) for (let i = 0; i < 6; i++) if ((i + j) & 1) r(13 + i, 10 + j - Math.round(i * 0.45), 1, 1, k0); }
    else if (t === "sphere") { for (let j = -7; j <= 7; j++) for (let i = -7; i <= 7; i++) { const dd = i * i + j * j; if (dd <= 52) { const sh = (i + 3) * (i + 3) + (j + 3) * (j + 3); if (dd > 40 || (sh > 60 && ((i + j) & 1)) || (sh > 95)) r(12 + i, 10 + j, 1, 1, k0); } } }
    else if (t === "cylinder") { for (let i = -6; i <= 6; i++) { const h2 = Math.round(Math.sqrt(36 - i * i) / 3); r(12 + i, 5 - h2, 1, 1, k0); r(12 + i, 5 + h2, 1, 1, k0); r(12 + i, 16 + h2, 1, 1, k0); } r(6, 5, 1, 12, k0); r(18, 5, 1, 12, k0); for (let j = 8; j < 17; j++) for (let i = 14; i < 18; i++) if ((i + j) & 1) r(i, j, 1, 1, k0); }
    else if (t === "cone") { ln(12, 2, 5, 16, k0); ln(12, 2, 19, 16, k0); for (let i = -7; i <= 7; i++) r(12 + i, 16 + Math.round(Math.sqrt(49 - i * i) / 3.5), 1, 1, k0); for (let j = 6; j < 17; j++) for (let i = 13; i < 12 + Math.round((j - 2) / 2); i++) if ((i + j) & 1) r(i, j, 1, 1, k0); }
    else if (t === "pyramid") { ln(11, 2, 3, 15, k0); ln(11, 2, 14, 18, k0); ln(11, 2, 21, 13, k0); ln(3, 15, 14, 18, k0); ln(14, 18, 21, 13, k0); for (let j = 5; j < 17; j++) for (let i = 13; i < 20; i++) if (((i + j) & 1) && i < 12 + (j - 2) * 0.62 && i > 11 + (j - 2) * 0.19) r(i, j, 1, 1, k0); }
    else if (t === "torus") { for (let j = -6; j <= 6; j++) for (let i = -9; i <= 9; i++) { const dd = i * i / 81 + j * j / 36, hole = i * i / 12 + (j + 1) * (j + 1) / 3; if (dd <= 1 && hole > 1 && (dd > 0.78 || hole < 1.9 || (j > 1 && ((i + j) & 1)))) r(12 + i, 10 + j, 1, 1, k0); } }
    else if (t === "dynamite") { r(9, 8, 8, 10, k0); r(10, 9, 6, 8, "#dd0806"); r(10, 11, 6, 1, "#fff"); r(10, 14, 6, 1, "#fff"); ln(13, 7, 16, 4, k0); r(17, 2, 1, 1, "#ff6402"); r(18, 3, 1, 1, "#fcf305"); r(16, 2, 1, 1, "#fcf305"); r(18, 1, 1, 1, "#ff6402"); }
  }
  function fxScroll(d) {
    const max = Math.max(0, Math.ceil(FX_ALL.length / 2) - FXROWS), v = Math.max(0, Math.min(max, FX.scroll + d));
    if (v !== FX.scroll) { FX.scroll = v; uiSnd("item", v); render(); }
  }
  function drawFxCells() {
    if (PALS.on) { drawPals(); return; }
    const W = 2 * FXCELL.w + 1, H = FXROWS * FXCELL.h + 1, max = Math.max(0, Math.ceil(FX_ALL.length / 2) - FXROWS);
    ctx.fillStyle = "#000"; ctx.fillRect(FXCELL.x - 2, FXCELL.y - 2, W + 4, H + 4 + 13);       // même cadre que la palette de gauche
    ctx.fillStyle = "#fff"; ctx.fillRect(FXCELL.x - 1, FXCELL.y - 1, W + 2, H + 2 + 13);
    ctx.fillStyle = "#000"; ctx.fillRect(FXCELL.x, FXCELL.y, W, H);
    for (let k = 0; k < FXROWS * 2; k++) {
      const x = FXCELL.x + (k % 2) * FXCELL.w + 1, y = FXCELL.y + (k >> 1) * FXCELL.h + 1, t = FX_ALL[k + FX.scroll * 2], on = t && tool === t;
      ctx.fillStyle = on ? "#000" : "#fff"; ctx.fillRect(x, y, 25, 21);
      if (t) fxIcon(t, x, y, on ? "#fff" : "#000");
    }
    /* deux flèches de défilement, comme celles des ascenseurs du Macintosh ; grisées en bout de course */
    const ay = FXCELL.y + H + 1;
    ctx.fillStyle = "#000"; ctx.fillRect(FXCELL.x + FXCELL.w, ay - 1, 1, 13); ctx.fillRect(FXCELL.x, ay - 1, W, 1);
    for (let c = 0; c < 2; c++) {
      const cx = FXCELL.x + c * FXCELL.w + 12, live = c ? FX.scroll < max : FX.scroll > 0;
      for (let q = 0; q < 5; q++) for (let i = -q; i <= q; i++) if (live || ((i + q) & 1) === 0) ctx.fillRect(cx + i, ay + (c ? 8 - q : 3 + q), 1, 1);
    }
    ctx.fillStyle = "#000";
  }



  /* ================================================================== *
   *  Page, zoom et calques.
   * ================================================================== */
  /* Change la taille de la page. Le dessin garde son coin haut gauche : ce qui dépasse est
     coupé, ce qui manque est du papier vide. (blank : on repart d'une page vide.) */
  function pageResize(w, h, blank) {
    textCommit(); selCommit();
    const ow = DW, oh = DH;
    for (const l of LAYERS) {
      const n = new Uint8Array(w * h);
      if (!blank) for (let y = 0; y < Math.min(h, oh); y++) n.set(l.data.subarray(y * ow, y * ow + Math.min(w, ow)), y * w);
      l.data = n;
    }
    DW = w; DH = h; doc = LAYERS[LA].data;
    docCanvas.width = textCanvas.width = w; docCanvas.height = textCanvas.height = h;
    docImg = dctx.createImageData(w, h); docPx = new Uint32Array(docImg.data.buffer);
    undoStack.length = redoStack.length = 0; sel = null; drag = null; polygonPoints = null; LT.on = false;
    FX.wet = null; FX.frags = []; FX.bombs = []; FX.drops = []; FX.acid = []; FX.runs = []; FX.melt = []; FX.drips = []; FX.balls = []; FX.sky = []; FX.bubbles = []; FX.wreck = []; FX.plates = []; FX.dough = []; FX.blobs = []; FX.hearts = []; FX.pump = null; FX.thin = null; FX.rec = []; FX.replay = null; FX.wetAt = null; FX.wetIdx = null; FX.parts = []; FX.live = []; FX.grid = null; FX.typing = null; FX.plants = []; FX.metal = []; FX.sun = null; FX.spores = []; FX.sprouts = []; FX.shards = []; FX.coral = null; FX.hotAt = null; FX.rails = null; FX.pokes = [];
    view.x = view.y = 0;
    renderTextLayers();
    zoom = 1; fatBits = false; clampView(); render();
  }
  function zoomSet(z, ax, ay) {                                  // (ax, ay) : le point de l'écran qui doit rester sous le pointeur
    z = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], z));
    if (ax === undefined) { ax = VIEW.x + VIEW.w / 2; ay = VIEW.y + VIEW.h / 2; }
    const dx = view.x + (ax - VIEW.x) / zoom, dy = view.y + (ay - VIEW.y) / zoom;
    zoom = z; fatBits = z >= 8;
    clampView();                                                 // la fenêtre utile change avec le zoom
    ax = Math.max(VIEW.x, Math.min(VIEW.x + VIEW.w, ax)); ay = Math.max(VIEW.y, Math.min(VIEW.y + VIEW.h, ay));
    view.x = Math.round(dx - (ax - VIEW.x) / zoom); view.y = Math.round(dy - (ay - VIEW.y) / zoom);
    clampView(); uiSnd("zoom", ZOOMS.indexOf(z)); render();
  }
  function zoomStep(dir, ax, ay) { const i = ZOOMS.indexOf(zoom), j = Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 3 : i) + dir)); if (ZOOMS[j] !== zoom) zoomSet(ZOOMS[j], ax, ay); }
  function zoomFit() { let z = ZOOMS[0]; for (const c of ZOOMS) if (DW * c <= WIN.w && DH * c <= WIN.h) z = c; zoom = z; fatBits = z >= 8; view.x = view.y = 0; clampView(); render(); }
  /* Dans la barre de titre, à droite : la taille de la page et l'échelle d'affichage. */
  function drawPageInfo() {
    const t = textBmp(DW + " x " + DH + "   " + (zoom * 100) + "%", "Geneva", 9, false, false), x = WIN.x + WIN.w - t.w - 12;
    ctx.fillStyle = "#fff"; ctx.fillRect(x - 5, 27, t.w + 9, 15); ctx.fillStyle = "#000";
    blit(ctx, t, x, 29);
  }
  /* Dialogue « Custom Size » : deux champs numériques, à la manière des dialogues du Macintosh. */
  const SZ = { on: false, w: "", h: "", f: 0 };
  function sizeRect() { return { x: Math.round((SW - 250) / 2), y: Math.round((SH - 130) / 2), w: 250, h: 130 }; }
  function sizeOpen() { SZ.on = true; SZ.w = String(DW); SZ.h = String(DH); SZ.f = 0; SZ.fresh = true; render(); }
  function sizeApply() {
    const w = Math.max(16, Math.min(PAGE_MAX, parseInt(SZ.w, 10) || DW)), h = Math.max(16, Math.min(PAGE_MAX, parseInt(SZ.h, 10) || DH));
    SZ.on = false;
    if (w !== DW || h !== DH) { pageResize(w, h); zoomFit(); scheduleSave(); }
    render();
  }
  function sizeKey(e) {
    const k = SZ.f ? "h" : "w";
    if (e.key === "Escape") SZ.on = false;
    else if (e.key === "Enter") { sizeApply(); return; }
    else if (e.key === "Tab") { SZ.f = 1 - SZ.f; SZ.fresh = true; }
    else if (e.key === "Backspace") { SZ[k] = SZ.fresh ? "" : SZ[k].slice(0, -1); SZ.fresh = false; }
    else if (/^[0-9]$/.test(e.key)) { SZ[k] = ((SZ.fresh ? "" : SZ[k]) + e.key).slice(0, 4); SZ.fresh = false; uiSnd("item", +e.key); }
    render();
  }
  function sizeClick(p) {
    const r = sizeRect();
    if (p.y >= r.y + 42 && p.y < r.y + 62) { if (p.x >= r.x + 70 && p.x < r.x + 120) { SZ.f = 0; SZ.fresh = true; } if (p.x >= r.x + 160 && p.x < r.x + 210) { SZ.f = 1; SZ.fresh = true; } }
    if (p.y >= r.y + 92 && p.y < r.y + 114) { if (p.x >= r.x + 160 && p.x < r.x + 230) { sizeApply(); return; } if (p.x >= r.x + 70 && p.x < r.x + 140) SZ.on = false; }
    render();
  }
  function drawSize() {
    const r = sizeRect(), T = (str, x, y) => blit(ctx, textBmp(str, "Chicago", 12, false, false), r.x + x, r.y + y);
    ctx.fillStyle = "#000"; for (let j = 0; j < r.h; j += 2) for (let i = 2; i < r.w + 2; i += 2) ctx.fillRect(r.x + i, r.y + j + 2, 1, 1);
    ctx.fillStyle = "#fff"; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = "#000"; ctx.fillRect(r.x, r.y, r.w, 1); ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1); ctx.fillRect(r.x, r.y, 1, r.h); ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
    ctx.fillRect(r.x + 3, r.y + 3, r.w - 6, 2); ctx.fillRect(r.x + 3, r.y + r.h - 5, r.w - 6, 2); ctx.fillRect(r.x + 3, r.y + 3, 2, r.h - 6); ctx.fillRect(r.x + r.w - 5, r.y + 3, 2, r.h - 6);
    T("Page size in pixels (16 to " + PAGE_MAX + ")", 16, 16);
    T("W", 50, 45); T("H", 142, 45);
    for (let f = 0; f < 2; f++) {
      const x = r.x + (f ? 160 : 70), y = r.y + 42, on = SZ.f === f, str = f ? SZ.h : SZ.w;
      ctx.fillStyle = "#000"; ctx.fillRect(x, y, 50, 20); ctx.fillStyle = on && SZ.fresh ? "#000" : "#fff"; ctx.fillRect(x + 1, y + 1, 48, 18);
      const tb = textBmp(str || " ", "Chicago", 12, false, false);
      ctx.fillStyle = on && SZ.fresh ? "#fff" : "#000"; for (let b = 0; b < tb.h; b++) for (let a = 0; a < tb.w; a++) if (tb.bits[b * tb.w + a]) ctx.fillRect(x + 6 + a, y + 3 + b, 1, 1);
      if (on && !SZ.fresh && Math.floor(Date.now() / 500) % 2 === 0) { ctx.fillStyle = "#000"; ctx.fillRect(x + 7 + (str ? tb.w : 0), y + 4, 1, 12); }
    }
    ctx.fillStyle = "#000";
    const btn = (x, label, def) => { const bx = r.x + x, by = r.y + 92; ctx.fillStyle = "#000"; if (def) { ctx.fillRect(bx - 3, by - 2, 76, 26); ctx.fillStyle = "#fff"; ctx.fillRect(bx - 1, by, 72, 22); ctx.fillStyle = "#000"; } ctx.fillRect(bx + 1, by, 68, 22); ctx.fillRect(bx, by + 1, 70, 20); ctx.fillStyle = "#fff"; ctx.fillRect(bx + 1, by + 1, 68, 20); ctx.fillStyle = "#000"; const tb = textBmp(label, "Chicago", 12, false, false); blit(ctx, tb, bx + 35 - (tb.w >> 1), by + 4); };
    btn(70, "Cancel", false); btn(160, "OK", true);
  }

  /* Réglages d'un outil : boîte 1984, cases à cocher et choix en pavés ; tout s'applique aussitôt. */
  function toolTitle(t) { return FX_NAMES[t] || t.replace(/Fill$/, " (filled)").replace(/^./, c => c.toUpperCase()); }
  function toolOptsLayout() {
    const list = toptList(TO.tool), rows = [];
    let w = 280; for (const o of list) if (o[2]) w = Math.max(w, 140 + 24 + o[2].reduce((a, lab) => a + textWidth(lab, "Chicago", 12) + 18, 0));
    const h = 54 + list.length * 22 + 44, x = Math.round((SW - w) / 2), y = Math.round((SH - h) / 2);
    list.forEach(function (o, k) {
      const ry = y + 40 + k * 22, row = { o: o, y: ry, hits: [] };
      if (!o[2]) row.hits.push({ x: x + 18, y: ry, w: 220, h: 18, v: null });
      else { let cx = x + 140; o[2].forEach(function (lab, v) { const bw = textWidth(lab, "Chicago", 12) + 14; row.hits.push({ x: cx, y: ry, w: bw, h: 18, v: v, lab: lab }); cx += bw + 4; }); }
      rows.push(row);
    });
    return { x: x, y: y, w: w, h: h, rows: rows, ok: { x: x + w - 90, y: y + h - 36, w: 70, h: 22 }, reset: { x: x + 20, y: y + h - 36, w: 70, h: 22 } };
  }
  function toolOptsOpen(t) { TO.on = true; TO.tool = t; uiSnd("item", 2); render(); }
  function toolOptsClick(p) {
    const L = toolOptsLayout(), inR = r => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
    if (inR(L.ok) || !inR(L)) { TO.on = false; render(); return; }
    if (inR(L.reset)) { delete TOPTS[TO.tool]; TOPTV++; try { localStorage.setItem("colorpaint.toolopts", JSON.stringify(TOPTS)); } catch (e) {} uiSnd("item", 0); render(); return; }
    for (const row of L.rows) for (const hit of row.hits) if (inR(hit)) { toptSet(TO.tool, row.o[0], hit.v === null ? !topt(row.o[0], TO.tool) : hit.v); uiSnd("item", 1); }
    render();
  }
  function drawToolOpts() {
    const L = toolOptsLayout(), T = (str, x, y, inv) => { const b = textBmp(str, "Chicago", 12, false, false); ctx.fillStyle = inv ? "#fff" : "#000"; for (let j = 0; j < b.h; j++) for (let i = 0; i < b.w; i++) if (b.bits[j * b.w + i]) ctx.fillRect(x + i, y + j, 1, 1); ctx.fillStyle = "#000"; };
    ctx.fillStyle = "#000"; for (let j = 0; j < L.h; j += 2) for (let i = 2; i < L.w + 2; i += 2) ctx.fillRect(L.x + i, L.y + j + 2, 1, 1);
    ctx.fillStyle = "#fff"; ctx.fillRect(L.x, L.y, L.w, L.h);
    ctx.fillStyle = "#000"; ctx.fillRect(L.x, L.y, L.w, 1); ctx.fillRect(L.x, L.y + L.h - 1, L.w, 1); ctx.fillRect(L.x, L.y, 1, L.h); ctx.fillRect(L.x + L.w - 1, L.y, 1, L.h);
    ctx.fillRect(L.x + 3, L.y + 3, L.w - 6, 2); ctx.fillRect(L.x + 3, L.y + L.h - 5, L.w - 6, 2); ctx.fillRect(L.x + 3, L.y + 3, 2, L.h - 6); ctx.fillRect(L.x + L.w - 5, L.y + 3, 2, L.h - 6);
    T(toolTitle(TO.tool) + " options", L.x + 18, L.y + 14);
    ctx.fillRect(L.x + 18, L.y + 32, L.w - 36, 1);
    for (const row of L.rows) {
      const o = row.o, cur = topt(o[0], TO.tool);
      if (!o[2]) {
        ctx.fillRect(L.x + 18, row.y + 2, 12, 12); ctx.fillStyle = "#fff"; ctx.fillRect(L.x + 19, row.y + 3, 10, 10); ctx.fillStyle = "#000";
        if (cur) for (let q = 0; q < 10; q++) { ctx.fillRect(L.x + 19 + q, row.y + 3 + q, 1, 1); ctx.fillRect(L.x + 28 - q, row.y + 3 + q, 1, 1); }
        T(o[1], L.x + 38, row.y + 1);
      } else {
        T(o[1], L.x + 18, row.y + 1);
        for (const hit of row.hits) { const on = cur === hit.v; ctx.fillStyle = "#000"; ctx.fillRect(hit.x, hit.y, hit.w, hit.h); if (!on) { ctx.fillStyle = "#fff"; ctx.fillRect(hit.x + 1, hit.y + 1, hit.w - 2, hit.h - 2); } T(hit.lab, hit.x + 7, hit.y + 2, on); }
      }
    }
    const btn = (r, label, def) => { ctx.fillStyle = "#000"; if (def) { ctx.fillRect(r.x - 3, r.y - 2, r.w + 6, r.h + 4); ctx.fillStyle = "#fff"; ctx.fillRect(r.x - 1, r.y, r.w + 2, r.h); ctx.fillStyle = "#000"; } ctx.fillRect(r.x + 1, r.y, r.w - 2, r.h); ctx.fillRect(r.x, r.y + 1, r.w, r.h - 2); ctx.fillStyle = "#fff"; ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2); ctx.fillStyle = "#000"; const tb = textBmp(label, "Chicago", 12, false, false); blit(ctx, tb, r.x + (r.w >> 1) - (tb.w >> 1), r.y + 4); };
    btn(L.reset, "Reset", false); btn(L.ok, "OK", true);
  }
  function toolCellAt(p) {                                       // l'outil sous le pointeur, dans l'une ou l'autre palette (sans rien déclencher)
    const cell = cellAt(p); if (cell) return cell.tool;
    if (PALS.on) return palAt(p);
    const c = Math.floor((p.x - FXCELL.x) / FXCELL.w), r = Math.floor((p.y - FXCELL.y) / FXCELL.h), k = r * 2 + c + FX.scroll * 2;
    return c >= 0 && c < 2 && r >= 0 && r < FXROWS && k < FX_ALL.length ? FX_ALL[k] : null;
  }

  function layerSelect(i) { textCommit(); selCommit(); wetDry(() => true); LA = i; doc = LAYERS[i].data; uiSnd("layer", i); render(); }
  function layersReset() {
    LAYERS.length = 0; layerSeq = 1;
    LAYERS.push({ name: "1", visible: true, data: new Uint8Array(DW * DH) });
    LA = 0; doc = LAYERS[0].data; undoStack.length = redoStack.length = 0;
  }
  function layerCmd(name) {
    textCommit(); selCommit(); if (name !== "eye") wetDry(() => true);
    const L = LAYERS[LA];
    if (name === "new" || name === "dup") {
      if (LAYERS.length >= 8) return;
      LAYERS.splice(LA + 1, 0, { name: String(++layerSeq), visible: true, data: name === "dup" ? L.data.slice() : new Uint8Array(DW * DH) });
      LA++;
    } else if (name === "delete") { if (LAYERS.length < 2) return; LAYERS.splice(LA, 1); LA = Math.max(0, LA - 1); }
    else if (name === "up") { if (LA >= LAYERS.length - 1) return; LAYERS.splice(LA, 1); LAYERS.splice(++LA, 0, L); }
    else if (name === "down") { if (LA < 1) return; LAYERS.splice(LA, 1); LAYERS.splice(--LA, 0, L); }
    else if (name === "merge") {                                 // le calque actif descend dans celui du dessous
      if (LA < 1) return;
      const under = LAYERS[LA - 1].data; for (let i = 0; i < under.length; i++) if (L.data[i]) under[i] = L.data[i];
      LAYERS.splice(LA, 1); LA--;
    } else if (name === "flatten") {
      const flat = new Uint8Array(DW * DH);
      for (const l of LAYERS) if (l.visible) for (let i = 0; i < flat.length; i++) if (l.data[i]) flat[i] = l.data[i];
      LAYERS.length = 0; LAYERS.push({ name: String(++layerSeq), visible: true, data: flat }); LA = 0;
    } else if (name === "eye") L.visible = !L.visible;
    doc = LAYERS[LA].data;
    if (name !== "eye") undoStack.length = redoStack.length = 0;  // l'historique ne traverse pas un changement de pile
    uiSnd("layer", LA); scheduleSave(); render();
  }
  /* Panneau des calques, sous la palette de droite : le calque du dessus en haut. Chaque rangée :
     un œil (visible ou non), une vignette. Dessous, quatre boutons : nouveau, supprimer, monter, descendre. */
  const LPAN = { x: SW - 55, y: 238, w: 53, row: 18 };
  function drawLayers() {
    const X = LPAN.x, Y = LPAN.y, n = LAYERS.length, H = n * LPAN.row + 1;
    ctx.fillStyle = "#000"; ctx.fillRect(X - 2, Y - 15, LPAN.w + 4, 15);            // onglet du titre
    ctx.fillStyle = "#fff"; ctx.fillRect(X - 1, Y - 14, LPAN.w + 2, 13);
    blit(ctx, textBmp("Layers", "Geneva", 9, false, false), X + 11, Y - 13);
    ctx.fillStyle = "#000"; ctx.fillRect(X - 2, Y - 2, LPAN.w + 4, H + 19);
    ctx.fillStyle = "#fff"; ctx.fillRect(X - 1, Y - 1, LPAN.w + 2, H + 17);
    ctx.fillStyle = "#000"; ctx.fillRect(X, Y, LPAN.w, H);
    for (let r = 0; r < n; r++) {
      const i = n - 1 - r, l = LAYERS[i], y = Y + r * LPAN.row + 1, on = i === LA;
      ctx.fillStyle = "#fff"; ctx.fillRect(X + 1, y, 14, LPAN.row - 1);
      ctx.fillStyle = on ? "#000" : "#fff"; ctx.fillRect(X + 16, y, LPAN.w - 17, LPAN.row - 1);
      if (l.visible) { ctx.fillStyle = "#000"; ctx.fillRect(X + 5, y + 5, 6, 1); ctx.fillRect(X + 5, y + 11, 6, 1); ctx.fillRect(X + 3, y + 7, 1, 3); ctx.fillRect(X + 12, y + 7, 1, 3); ctx.fillRect(X + 4, y + 6, 1, 1); ctx.fillRect(X + 11, y + 6, 1, 1); ctx.fillRect(X + 4, y + 10, 1, 1); ctx.fillRect(X + 11, y + 10, 1, 1); ctx.fillRect(X + 7, y + 7, 2, 3); }
      /* vignette : un point sur k, sans lissage */
      const tw = 24, th = 13, tx = X + 19, ty = y + 2;
      ctx.fillStyle = "#fff"; ctx.fillRect(tx, ty, tw, th);
      for (let b = 0; b < th; b++) for (let a = 0; a < tw; a++) { const v = l.data[Math.floor((b + 0.5) / th * DH) * DW + Math.floor((a + 0.5) / tw * DW)]; if (v) { ctx.fillStyle = PALETTE[v] || "#000"; ctx.fillRect(tx + a, ty + b, 1, 1); } }
      blit(ctx, textBmp(l.name, "Geneva", 9, false, false), X + 45, y + 3);
      if (on) { ctx.fillStyle = "#fff"; const tb = textBmp(l.name, "Geneva", 9, false, false); for (let b = 0; b < tb.h; b++) for (let a = 0; a < tb.w; a++) if (tb.bits[b * tb.w + a]) ctx.fillRect(X + 45 + a, y + 3 + b, 1, 1); }
    }
    if (drag && drag.kind === "layer" && drag.moved) {             // calque attrapé : son contour suit le pointeur, un trait épais montre où il va tomber
      const r = n - 1 - drag.to, ly = drag.to > drag.from ? Y + r * LPAN.row : drag.to < drag.from ? Y + (r + 1) * LPAN.row : -1;
      if (ly >= 0) { ctx.fillStyle = "#fff"; ctx.fillRect(X, ly - 2, LPAN.w, 5); ctx.fillStyle = "#000"; ctx.fillRect(X, ly - 1, LPAN.w, 3); }
      const gy = Math.max(Y - 4, Math.min(Y + H - LPAN.row + 4, drag.py - (LPAN.row >> 1)));
      ctx.fillStyle = "#000";
      for (let a = 0; a < LPAN.w; a += 2) { ctx.fillRect(X + a, gy, 1, 1); ctx.fillRect(X + a, gy + LPAN.row, 1, 1); }
      for (let b = 0; b <= LPAN.row; b += 2) { ctx.fillRect(X, gy + b, 1, 1); ctx.fillRect(X + LPAN.w - 1, gy + b, 1, 1); }
    }
    const by = Y + H + 1;
    ["+", "-", "^", "v"].forEach(function (c, k) {
      const bx = X + k * 13 + (k ? 1 : 0);
      ctx.fillStyle = "#fff"; ctx.fillRect(bx + (k ? 0 : 0), by, k === 3 ? 13 : 12, 13);
      ctx.fillStyle = "#000";
      if (c === "+") { ctx.fillRect(bx + 3, by + 6, 7, 1); ctx.fillRect(bx + 6, by + 3, 1, 7); }
      else if (c === "-") ctx.fillRect(bx + 3, by + 6, 7, 1);
      else for (let q = 0; q < 4; q++) ctx.fillRect(bx + 6 - q, by + (c === "^" ? 4 + q : 9 - q), 1 + q * 2, 1);
    });
    ctx.fillStyle = "#000";
  }
  function layersClick(p) {
    const n = LAYERS.length, H = n * LPAN.row + 1;
    if (p.x < LPAN.x || p.x >= LPAN.x + LPAN.w || p.y < LPAN.y || p.y >= LPAN.y + H + 15) return false;
    if (p.y >= LPAN.y + H) { layerCmd(["new", "delete", "up", "down"][Math.min(3, Math.floor((p.x - LPAN.x) / 13))]); return true; }
    const i = n - 1 - Math.floor((p.y - LPAN.y) / LPAN.row);
    if (i < 0 || i >= n) return true;
    if (p.x < LPAN.x + 16) { const keep = LA; LA = i; layerCmd("eye"); LA = keep; doc = LAYERS[LA].data; render(); }
    else { layerSelect(i); if (n > 1) drag = { kind: "layer", from: i, to: i, y0: p.y, py: p.y, moved: false }; }   // on peut l'attraper pour le glisser au-dessus ou au-dessous des autres
    return true;
  }
  function layerDragMove(p) {
    const n = LAYERS.length;
    drag.py = p.y; if (Math.abs(p.y - drag.y0) > 3) drag.moved = true;
    drag.to = n - 1 - Math.max(0, Math.min(n - 1, Math.floor((p.y - LPAN.y) / LPAN.row)));
    render();
  }
  function layerDragEnd(dr) {
    if (dr.moved && dr.to !== dr.from && LAYERS[dr.from]) {
      const L = LAYERS[dr.from]; LAYERS.splice(dr.from, 1); LAYERS.splice(dr.to, 0, L);
      LA = dr.to; doc = LAYERS[LA].data; undoStack.length = redoStack.length = 0;   // comme les flèches : l'historique ne traverse pas un changement de pile
      uiSnd("layer", LA); scheduleSave();
    }
    render();
  }

  function setTool(t) {
    helpPage=null;
    textCommit();
    selCommit();
    if (t === "eraser") eraserSize = 8;
    LT.on = false; FX.typing = null;
    tool = t;
    fxKick();
    const row = FX_ALL.indexOf(t) >> 1;                          // l'outil choisi au menu doit se voir dans la palette
    if (FX_ALL.includes(t)) { if (row < FX.scroll) FX.scroll = row; if (row >= FX.scroll + FXROWS) FX.scroll = row - FXROWS + 1; }
    if (!touchMode) { selectSnd(t); kickToolBounce(t); }
    cv.style.cursor = t === "text" ? "text" : (t === "spray" ? "crosshair" : "crosshair");
    render();
  }

  /* ---------------------------------------------------------------- *
   *  16. Outils
   * ---------------------------------------------------------------- */
  function startTool(d, e) {
    strokeA = { x: d.x, y: d.y }; strokeB = strokeA;
    if (textState.active) textCommit();
    if (FX_ALL.includes(tool)) { fxStart(d); return; }
    if(tool==="hand") {drag={kind:"pan",x:mouse.x,y:mouse.y,vx:view.x,vy:view.y};return;}
    if(tool.startsWith("polygon")) {polygonClick(d);return;}
    if(tool.startsWith("freeform")) {loopSnd(tool);working=true;workTime=0;startAnim();pushUndo();drag={kind:"freeform",pts:[d],snap:doc.slice(),filled:tool.endsWith("Fill")};return;}


    if (tool === "marquee" || tool === "lasso") {
      if (sel && selContains(d.x, d.y)) {
        selLift();
        drag = { kind: "moveSel", ax: d.x, ay: d.y, selx: sel.x, sely: sel.y };
        return;
      }
      sel = null;
      if (tool === "marquee") {
        drag = { kind: "marquee", x0: d.x, y0: d.y };
      } else {
        drag = { kind: "lasso", pts: [d], snap: doc.slice() };
      }
      render();
      return;
    }

    if (tool === "text") {
      /* Calque de texte : cliquer un texte le sélectionne et le déplace ; un second
         clic sur le même texte le réédite ; cliquer ailleurs crée un nouveau texte. */
      const hit = textLayerAt(d.x, d.y);
      if (hit) {
        if (selectedText === hit.id) { editTextLayerById(hit.id); return; }
        selectedText = hit.id;
        drag = { kind: "moveText", id: hit.id, lx: hit.x, ly: hit.y, ax: d.x, ay: d.y, undoed: false };
        render(); return;
      }
      selectedText = null;
      textBegin(d.x, d.y); return;
    }

    if (tool === "bucket") {
      pushUndo();
      floodFill(d.x, d.y);
      cheer("fill");
      scheduleSave();
      render();
      return;
    }

    loopSnd(tool);
    working = true; workTime = 0;
    startAnim();
    pushUndo();
    drag = { kind: "paint", last: d, start: d, snap: doc.slice() };

    if (tool === "pencil") {drag.ink=doc[d.y*DW+d.x]===ink?0:1;stamp(d.x,d.y,PW(),drag.ink);}
    else if (tool === "eraser") eraseAt(d.x, d.y);
    else if (tool === "brush") brushAt(d.x, d.y);
    else if (tool === "spray") {
      sprayAt(d.x, d.y);
      sprayTimer = setInterval(function () { sprayAt(drag.last.x, drag.last.y); render(); }, 40);
    } else if (tool === "line" || tool === "rect" || tool === "rrect" || tool === "oval") {
      /* aperçu géré dans moveTool */
    }
    render();
  }

  /* Ultra-Violence : la gomme s'use. Elle perd un pixel de côté à chaque coup
     (de 8 à 2) et, une fois entamée, laisse des miettes. Reprendre la gomme
     dans la palette en donne une neuve. */
  let eraserSize = 8;
  function ultra() { return typeof Studio !== "undefined" && Studio.difficulty && Studio.difficulty.get() === 3; }
  function eraseAt(x, y) {
    const n = ultra() ? eraserSize : Math.max(2, PW()), o = Math.floor((n - 1) / 2);   // la gomme a l'épaisseur courante
    const round = topt("shape", "eraser") === 1 && !ultra(), rr = n / 2;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (!round || (i + 0.5 - rr) * (i + 0.5 - rr) + (j + 0.5 - rr) * (j + 0.5 - rr) <= rr * rr) px(x - o + i, y - o + j, 0);
    if (n < 8 && Math.random() < 0.035) {
      const cx = x - o - 2 + Math.floor(Math.random() * (n + 4)), cy = y - o - 2 + Math.floor(Math.random() * (n + 4));
      if (cx >= 0 && cy >= 0 && cx < DW && cy < DH && !doc[cy * DW + cx]) {
        px(cx, cy, 1); crumbs.push(cx, cy);                      // une miette, à chasser en soufflant dans le micro
        if (Studio.traps && Studio.traps.crumbs) Studio.traps.crumbs(blowCrumbs);
      }
    }
  }
  const crumbs = [];
  function blowCrumbs() {
    for (let i = 0; i < crumbs.length; i += 2) px(crumbs[i], crumbs[i + 1], 0);
    crumbs.length = 0;
    scheduleSave(); render();
  }

  /* Niveau 2 (Hey, Not Too Rough) : le pot de peinture est un vrai pot. Tant qu'il
     est l'outil choisi, pencher l'iPhone de plus de 22° renverse l'encre : elle
     envahit la feuille par le côté vers lequel on penche, d'autant plus vite que
     l'on penche. Un seul cran d'annulation pour tout le dégât. */
  let tiltRest = null, spill = 0, spillSide = "", spillSaved = false;
  window.addEventListener("deviceorientation", function (e) {
    const on = typeof Studio !== "undefined" && Studio.difficulty && Studio.difficulty.get() === 2 && tool === "bucket" && e.gamma !== null && e.beta !== null && documentOpen && !drag;
    if (!on) { tiltRest = null; spill = 0; spillSide = ""; spillSaved = false; return; }
    if (!tiltRest) { tiltRest = { b: e.beta, g: e.gamma }; return; }                 // position de repos : celle du moment où l'on prend le pot
    const dg = e.gamma - tiltRest.g, db = e.beta - tiltRest.b, lean = Math.max(Math.abs(dg), Math.abs(db));
    if (lean < 22) return;
    const side = Math.abs(dg) >= Math.abs(db) ? (dg > 0 ? "right" : "left") : (db > 0 ? "bottom" : "top");
    if (side !== spillSide) { spillSide = side; spill = 0; }
    if (!spillSaved) { pushUndo(); spillSaved = true; cheer("fill"); }
    const before = spill;
    spill = Math.min(1, spill + (lean - 22) * 0.00022);
    const across = side === "left" || side === "right", size = across ? DW : DH, a = Math.floor(before * size), z = Math.floor(spill * size);
    for (let k = a; k < z; k++) {
      // front irrégulier : l'encre coule, elle n'avance pas en ligne droite
      for (let j = 0; j < (across ? DH : DW); j++) {
        const reach = k + Math.round(Math.sin(j / 23) * 5 + Math.sin(j / 7) * 2);
        const pos = Math.max(0, Math.min(size - 1, reach));
        if (across) px(side === "right" ? DW - 1 - pos : pos, j, 1); else px(j, side === "bottom" ? DH - 1 - pos : pos, 1);
      }
    }
    if (z > a) { scheduleSave(); render(); }
  });

  function sprayAt(x, y) {
    const r = Math.max(2, PW() / 2 * TK("spread", [0.5, 1, 2.2], "spray")), dots = Math.max(2, Math.min(900, Math.round(r * r / 5 * [0.4, 1, 2.5][topt("dens", "spray")])));   // la bombe couvre un disque de l'épaisseur courante
    for (let n = 0; n < dots; n++) {
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r, X = Math.round(x + Math.cos(a) * d), Y = Math.round(y + Math.sin(a) * d);
      px(X, Y, pat(X, Y));                                       // la bombe suit la trame choisie
    }
  }

  function sprayPath(a, b) {
    // Deposit along skipped pointer positions, never restore a shape preview.
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(distance / 4);
    for (let i = 1; i <= steps; i++) {
      sprayAt(Math.round(a.x + (b.x - a.x) * i / steps),
              Math.round(a.y + (b.y - a.y) * i / steps));
    }
  }

  function moveTool(p, e) {
    const d = screenToDoc(p.x, p.y);
    strokeB = d;
    if (drag.kind === "dial") { dialSet(p); return; }
    if (drag.kind === "layer") { layerDragMove(p); return; }
    if (drag.kind === "penw") { setPen(penAt(p.x)); return; }
    if (drag.kind === "cw") { cwSet(p, drag.part); return; }
    if (drag.kind === "fx") { fxMove(d); return; }
    if(drag.kind==="pan") {view.x=Math.round(drag.vx-(p.x-drag.x)/zoom);view.y=Math.round(drag.vy-(p.y-drag.y)/zoom);clampView();render();return;}
    if(drag.kind==="freeform") {drag.pts.push(d);doc.set(drag.snap);paintClosed(drag.pts,drag.filled);render();return;}
    if (drag.kind === "scrollY") {
      const v = viewWH();
      const range = VIEW.h - Math.max(16, Math.round(VIEW.h * v.h / DH));
      view.y = Math.round(drag.v0 + (p.y - drag.y0) / Math.max(1, range) * (DH - v.h));
      clampView(); render(); return;
    }
    if (drag.kind === "scrollX") {
      const v = viewWH();
      const range = VIEW.w - Math.max(16, Math.round(VIEW.w * v.w / DW));
      view.x = Math.round(drag.v0 + (p.x - drag.x0) / Math.max(1, range) * (DW - v.w));
      clampView(); render(); return;
    }
    if (drag.kind === "marquee") {
      const x0 = Math.min(drag.x0, d.x), y0 = Math.min(drag.y0, d.y);
      const w = Math.abs(d.x - drag.x0) + 1, h = Math.abs(d.y - drag.y0) + 1;
      if (d.x < 0 || d.y < 0 || d.x >= DW || d.y >= DH) { /* garder */ }
      sel = { x: x0, y: y0, w: w, h: h, mask: null, data: null };
      render(); return;
    }
    if (drag.kind === "lasso") {
      const last = drag.pts[drag.pts.length - 1];
      if (d.x !== last.x || d.y !== last.y) drag.pts.push(d);
      render();
      return;
    }
    if (drag.kind === "moveSel") {
      sel.x = drag.selx + (d.x - drag.ax);
      sel.y = drag.sely + (d.y - drag.ay);
      render(); return;
    }
    if (drag.kind === "moveText") {
      if (!drag.undoed) { pushUndo(); drag.undoed = true; }
      const layer = textLayers.find(function (l) { return l.id === drag.id; });
      if (layer) { layer.x = drag.lx + (d.x - drag.ax); layer.y = drag.ly + (d.y - drag.ay); renderTextLayers(); }
      render(); return;
    }
    if (drag.kind === "paint") {
      const last = drag.last;
      if (tool === "pencil") line(last.x, last.y, d.x, d.y, PW(), drag.ink);
      else if (tool === "brush") brushPath(last, d);
      else if (tool === "eraser") erasePath(last, d);
      else if (tool === "spray") sprayPath(last, d);
      else {
        doc.set(drag.snap);
        const kind=tool.replace(/Fill$/, ""),filled=tool.endsWith("Fill");
        if (tool === "line") line(drag.start.x, drag.start.y, d.x, d.y, outlineWidth(), 1, true);   // le trait suit la trame choisie
        else if (kind === "rect") rectShape(drag.start.x, drag.start.y, d.x, d.y, outlineWidth(), filled);
        else if (kind === "rrect") rrectShape(drag.start.x, drag.start.y, d.x, d.y, outlineWidth(), filled);
        else if (kind === "oval") ovalShape(drag.start.x, drag.start.y, d.x, d.y, outlineWidth(), filled);
      }
      drag.last = d;
      render();
    }
  }

  function brushPath(a, b) {
    let dx = Math.abs(b.x - a.x), dy = -Math.abs(b.y - a.y);
    const sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
    let err = dx + dy, x = a.x, y = a.y, n = 0;
    const every = Math.max(1, PW() >> 4) * TK("gap", [1, 1, 1], "brush") + Math.round(PW() * TK("gap", [0, 1.6, 4], "brush"));   // espacement : plein, pointillé, clairsemé             // brosse très large : une empreinte tous les k/8 points suffit
    for (;;) {
      if (n++ % every === 0 || (x === b.x && y === b.y)) brushAt(x, y);
      if (x === b.x && y === b.y) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }
  function erasePath(a, b) {
    let dx = Math.abs(b.x - a.x), dy = -Math.abs(b.y - a.y);
    const sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
    let err = dx + dy, x = a.x, y = a.y;
    for (;;) {
      eraseAt(x, y);
      if (x === b.x && y === b.y) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  function paintClosed(pts,filled) {
    if(pts.length<2)return;
    if(filled) {
      const minY=Math.max(0,Math.min(...pts.map(p=>p.y))),maxY=Math.min(DH-1,Math.max(...pts.map(p=>p.y)));
      for(let y=minY;y<=maxY;y++) {
        const hits=[];
        for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];if((a.y>y)!==(b.y>y))hits.push(a.x+(y-a.y)*(b.x-a.x)/(b.y-a.y));}
        hits.sort((a,b)=>a-b);for(let i=0;i+1<hits.length;i+=2)for(let x=Math.max(0,Math.ceil(hits[i]));x<=Math.min(DW-1,Math.floor(hits[i+1]));x++)px(x,y,pat(x,y));
      }
    }
    if(!noOutline)for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];line(a.x,a.y,b.x,b.y,outlineWidth(),1);}
  }
  function polygonClick(d) {
    if(!polygonPoints){tickSnd("vertex");kickCell(tool,-70,0);pushUndo();polygonPoints={pts:[d],base:doc.slice(),filled:tool.endsWith("Fill")};return;}
    const first=polygonPoints.pts[0],last=polygonPoints.pts[polygonPoints.pts.length-1];
    const finish=polygonPoints.pts.length>=3&&((Math.abs(d.x-first.x)+Math.abs(d.y-first.y)<6)||(Math.abs(d.x-last.x)+Math.abs(d.y-last.y)<3));
    if(!finish){polygonPoints.pts.push(d);tickSnd("vertex");kickCell(tool,-70,0);}
    doc.set(polygonPoints.base);paintClosed(polygonPoints.pts,polygonPoints.filled);render();
    if(finish){polygonPoints=null;scheduleSave();cheer("draw");}
  }
  function drawPageOverview() {
    fill(VIEW.x,VIEW.y,VIEW.w,VIEW.h,"#fff");ctx.imageSmoothingEnabled=false;
    const k=Math.min((VIEW.w-8)/DW,(VIEW.h-8)/DH);
    ctx.drawImage(docCanvas,VIEW.x+Math.floor((VIEW.w-DW*k)/2),VIEW.y+4,Math.floor(DW*k),Math.floor(DH*k));
  }

  function endTool() {
    if (sprayTimer) { clearInterval(sprayTimer); sprayTimer = null; }
    if (!drag) return;
    if (drag.kind === "dial") { drag = null; return; }
    if (drag.kind === "layer") { const dr = drag; drag = null; layerDragEnd(dr); return; }
    if (drag.kind === "fx") { const dr = drag; drag = null; if (dr.sub === "yeast") yeastEnd(dr); if (dr.sub === "leaky") leakyEnd(dr); if (dr.sub === "jelly") dr.q.end = performance.now(); if (dr.sub === "worm") dr.q.held = false; if (dr.sub === "ball") ballEnd(dr); if (dr.sub === "slice") sliceEnd(dr); if (dr.sub === "grid") gridEnd(dr); if (dr.sub === "elastic") elasticEnd(dr); if (S3D[dr.sub]) scheduleSave();
      if (dr.sub === "coral") { FX.coral = null; }
      if (dr.sub === "extrude" || dr.sub === "fold") { const q = dr.q; FX.live = FX.live.filter(o => o !== q); if (dr.sub === "extrude") extrudeDraw(q, doc); else { if (q.th > Math.PI / 2) q.th = Math.PI; else q.th = 0; foldDraw(q, doc); fxSnd("thud", q.x, q.y, 0.6); } }
      if (dr.sub === "accordion") { dr.q.held = false; fxSnd("twang", dr.q.x, dr.q.y, Math.min(1, 1 / dr.q.s)); }
      if (dr.sub === "shaker") { const q = dr.q; FX.live = FX.live.filter(o => o !== q); for (let j = 0; j < q.h; j++) for (let i = 0; i < q.w; i++) { const v = q.data[j * q.w + i]; if (v) wr(q.x + i, q.y + j, v); } } if (dr.sub === "pump") FX.pump = null; scheduleSave(); render(); return; }
    if (drag.kind === "lasso") {
      sel = lassoToSelection(drag.pts);
      doc.set(drag.snap);
    }
    if (drag.kind === "marquee" && sel && (sel.w < 2 || sel.h < 2)) sel = null;
    if (drag.kind === "moveSel") selCommit();
    if (drag.kind === "paint" || drag.kind === "freeform") {
      loopStopSnd();
      working = false;
      if (drag.kind === "paint" && (tool === "line" || tool === "rect" || tool === "rrect" || tool === "oval")) tickSnd("shape");
      if (tool === "eraser" && ultra()) eraserSize = Math.max(2, eraserSize - 1);
      const ends = strokeA && strokeB ? { a: strokeA, b: strokeB } : null;
      if (undoArmed && ends && lastEnds) {
        undoArmed = false;
        const near = function (p, q) { return Math.hypot(p.x - q.x, p.y - q.y) < 30; };
        if (near(ends.a, lastEnds.b) && near(ends.b, lastEnds.a)) {       // bien retracé : le trait de contrôle et le trait visé disparaissent
          drag = null; lastEnds = null;
          undo(); undo();
          return;
        }
        if (Studio.traps && Studio.traps.note) Studio.traps.note("Raté : ce n’était pas le même trait. Il reste là, lui aussi.");
      }
      lastEnds = ends;
      cheer(tool === "eraser" ? "erase" : "draw");
    }
    drag = null;
    scheduleSave();
    render();
  }

  function lassoToSelection(pts) {
    if (!pts || pts.length < 3) return null;
    let x0 = DW, y0 = DH, x1 = 0, y1 = 0;
    for (let i = 0; i < pts.length; i++) {
      x0 = Math.min(x0, pts[i].x); y0 = Math.min(y0, pts[i].y);
      x1 = Math.max(x1, pts[i].x); y1 = Math.max(y1, pts[i].y);
    }
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(DW - 1, x1); y1 = Math.min(DH - 1, y1);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w < 2 || h < 2) return null;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const xs = [];
      for (let k = 0; k < pts.length; k++) {
        const a = pts[k], b = pts[(k + 1) % pts.length];
        if ((a.y <= y0 + y) !== (b.y <= y0 + y))
          xs.push(a.x + ((y0 + y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
      xs.sort(function (a, b) { return a - b; });
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.ceil(xs[k]); x <= Math.floor(xs[k + 1]); x++) {
          const mx = x - x0;
          if (mx >= 0 && mx < w) mask[y * w + mx] = 1;
        }
    }
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      let dx = Math.abs(b.x - a.x), dy = -Math.abs(b.y - a.y);
      const sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
      let err = dx + dy, x = a.x, y = a.y;
      for (;;) {
        const mx = x - x0, my = y - y0;
        if (mx >= 0 && my >= 0 && mx < w && my < h) mask[my * w + mx] = 1;
        if (x === b.x && y === b.y) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
      }
    }
    return { x: x0, y: y0, w: w, h: h, mask: mask, data: null };
  }

  /* ---------------------------------------------------------------- *
   *  17. Clavier
   * ---------------------------------------------------------------- */
  window.addEventListener("keydown", function (e) {
    if (e.target && e.target.closest && e.target.closest("[data-macpaint-controls]")) return;
    const meta = e.metaKey || e.ctrlKey;
    if (RD.on) { if (e.key === "Escape" || e.key === "Enter") RD.on = false; render(); e.preventDefault(); return; }
    if (GD.on) { if (e.key === "Escape") GD.on = false; else if (e.key === "Enter") gifStart(); render(); e.preventDefault(); return; }
    if (SZ.on) { sizeKey(e); e.preventDefault(); return; }
    if (TO.on) { if (e.key === "Escape" || e.key === "Enter") { TO.on = false; render(); } e.preventDefault(); return; }
    if (CW.on) { if (e.key === "Escape") { CW.on = false; render(); } e.preventDefault(); return; }

    if (dialog) {
      if (e.key === "Escape") { closeDialog(); e.preventDefault(); }
      else if (e.key === "Enter") {
        const b = dialog.buttons && dialog.buttons.find(function (x) { return x.def; });
        closeDialog();
        if (b && b.cmd && b.cmd !== "close") cmd(b.cmd);
        e.preventDefault();
      }
      return;
    }

    if(e.key==="Enter"&&polygonPoints){paintClosed(polygonPoints.pts,polygonPoints.filled);polygonPoints=null;scheduleSave();render();return;}
    if (e.key === "Escape") {
      if(polygonPoints){doc.set(polygonPoints.base);polygonPoints=null;render();return;}
      if (menuOpen >= 0) { menuOpen = -1; render(); }
      else if (textState.active) textCommit();
      else if (sel) { sel = null; render(); }
      e.preventDefault();
      return;
    }

    if (meta && !e.altKey) {
      const k = e.key.toLowerCase();
      if(textState.active) {
        const styleKey={p:"plain",b:"bold",i:"italic",u:"underline",o:"outline",s:"shadow"};
        const alignKey={l:"left",m:"middle",r:"right"};
        if(styleKey[k]) {cmd("style:"+styleKey[k]);e.preventDefault();return;}
        if(alignKey[k]) {cmd("align:"+alignKey[k]);e.preventDefault();return;}
      }
      if(k==="e"){cmd("trace");e.preventDefault();return;}
      if (k === "z") { e.shiftKey ? redo() : undo(); e.preventDefault(); return; }
      if (k === "x") { doCut(); e.preventDefault(); return; }
      if (k === "c") { doCopy(); e.preventDefault(); return; }
      if (k === "v") { doPaste(); e.preventDefault(); return; }
      if (k === "s") { cmd("save"); e.preventDefault(); return; }
      if (k === "o") { cmd("open"); e.preventDefault(); return; }
      if (k === "n") { cmd("new"); e.preventDefault(); return; }
      if (k === "p") { cmd("print"); e.preventDefault(); return; }
      if (k === "i") { cmd("invert"); e.preventDefault(); return; }
      if (k === "b") { cmd("fatbits"); e.preventDefault(); return; }
      if (k === "a") { sel = { x: 0, y: 0, w: DW, h: DH, mask: null, data: null }; render(); e.preventDefault(); return; }
    }

    if (tool === "type" && LT.on && !meta && liveKey(e)) { e.preventDefault(); return; }
    if (FX.typing && tool === "balloon" && !meta && balloonKey(e)) { e.preventDefault(); return; }
    if (tool === "custom" && !meta && customKey(e)) { e.preventDefault(); return; }
    if (FX.grid && tool === "grid" && !meta && e.key.length === 1 && e.key !== " " && gridLetter(e.key)) { e.preventDefault(); return; }
    if (e.key === " " && !meta && !textState.active && !(tool === "type" && LT.on) && !(FX.typing && tool === "balloon")) { freezeAll(); e.preventDefault(); return; }   // barre d'espace : tout se fige
    if (textState.active) {
      if (e.key === "Backspace") { textBackspace(); e.preventDefault(); return; }
      if (e.key === "Enter") {
        textState.lines.splice(textState.li + 1, 0, textState.lines[textState.li].slice(textState.ci));
        textState.lines[textState.li] = textState.lines[textState.li].slice(0, textState.ci);
        textState.li++; textState.ci = 0;
        textRender(); e.preventDefault(); return;
      }
      if (e.key === "ArrowLeft" && textState.ci > 0) { textState.ci--; render(); e.preventDefault(); return; }
      if (e.key === "ArrowRight" && textState.ci < textState.lines[textState.li].length) { textState.ci++; render(); e.preventDefault(); return; }
      if (e.key.length === 1) { textInsert(e.key); e.preventDefault(); return; }
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      if (sel) { cmd("clearSel"); e.preventDefault(); }
      return;
    }

    if (!meta && (e.key === "+" || e.key === "=")) { zoomStep(1); e.preventDefault(); return; }
    if (!meta && e.key === "-") { zoomStep(-1); e.preventDefault(); return; }
    if (!meta && e.key === "1") { zoomSet(1); e.preventDefault(); return; }
    if (!meta && e.key === "0") { zoomFit(); e.preventDefault(); return; }
    const step = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowLeft") { view.x -= step; clampView(); render(); e.preventDefault(); }
    if (e.key === "ArrowRight") { view.x += step; clampView(); render(); e.preventDefault(); }
    if (e.key === "ArrowUp") { view.y -= step; clampView(); render(); e.preventDefault(); }
    if (e.key === "ArrowDown") { view.y += step; clampView(); render(); e.preventDefault(); }
  });

  /* ---------------------------------------------------------------- *
   *  18. Dialogues : clics
   * ---------------------------------------------------------------- */
  function dialogClick(p) {
    const d = dialog;
    if (!d._rect) return;
    /* zones spéciales (grille de motif, formes de brosse) */
    if (d._hits) {
      for (let i = 0; i < d._hits.length; i++) {
        const h = d._hits[i];
        if (p.x >= h.x && p.x < h.x + h.w && p.y >= h.y && p.y < h.y + h.h) { h.act(); return; }
      }
    }
    if (d.buttons) {
      for (let i = 0; i < d.buttons.length; i++) {
        const b = d.buttons[i];
        if (b._rect && p.x >= b._rect.x && p.x < b._rect.x + b._rect.w && p.y >= b._rect.y && p.y < b._rect.y + b._rect.h) {
          if (b.cmd === "close") closeDialog();
          else { const c = b.cmd; closeDialog(); cmd(c); }
          return;
        }
      }
    }
  }

  /* dessin des contenus spécifiques des dialogues */
  const _drawDialog = drawDialog;
  drawDialog = function () {
    _drawDialog();
    const d = dialog;
    if (!d._rect) return;
    const x0 = d._rect.x, y0 = d._rect.y;

    if (d.brushes) {
      const sw = 56, sh = 40, gap = 8;
      const total = 4 * sw + 3 * gap;
      const bx = x0 + Math.round((d._rect.w - total) / 2), by = y0 + 44;
      d._hits = [];
      for (let i = 0; i < BRUSHES.length; i++) {
        const cx = bx + (i % 4) * (sw + gap), cy = by + Math.floor(i / 4) * (sh + gap);
        fill(cx, cy, sw, sh, i === brushShape ? "#000" : "#fff");
        const b = BRUSHES[i];
        const s = 3;
        const ox = cx + Math.round((sw - b.w * s) / 2), oy = cy + Math.round((sh - b.h * s) / 2);
        ctx.fillStyle = i === brushShape ? ACCENT : "#000";
        for (let y = 0; y < b.h; y++)
          for (let x = 0; x < b.w; x++)
            if (b.bits[y * b.w + x] === "1") ctx.fillRect(ox + x * s, oy + y * s, s, s);
        if (i !== brushShape) { ctx.strokeStyle = "#000"; ctx.strokeRect(cx + 0.5, cy + 0.5, sw - 1, sh - 1); }
        d._hits.push({ x: cx, y: cy, w: sw, h: sh, act: (function (k) { return function () { brushShape = k; closeDialog(); }; })(i) });
      }
    }

    if (d.pattern) {
      const cell = 15, gx = x0 + 22, gy = y0 + 58;
      d._hits = [];
      for (let i = 0; i < 8; i++)
        for (let j = 0; j < 8; j++) {
          const on = PAT[pattern][i * 8 + j];
          fill(gx + j * cell, gy + i * cell, cell, cell, on ? "#000" : "#fff");
          ctx.strokeStyle = "#000";
          ctx.strokeRect(gx + j * cell + 0.5, gy + i * cell + 0.5, cell - 1, cell - 1);
          d._hits.push({
            x: gx + j * cell, y: gy + i * cell, w: cell, h: cell,
            act: (function (k) { return function () { PAT[pattern][k] ^= 1; render(); }; })(i * 8 + j)
          });
        }

      /* aperçu répété 8 × 8 */
      const pv = 96, px0 = x0 + d._rect.w - pv - 22, py0 = gy;
      for (let y = 0; y < pv; y++)
        for (let x = 0; x < pv; x++)
          if (PAT[pattern][(y & 7) * 8 + (x & 7)]) ctx.fillRect(px0 + x, py0 + y, 1, 1);
      ctx.strokeStyle = "#000";
      ctx.strokeRect(px0 - 0.5, py0 - 0.5, pv, pv);

      /* bibliothèque de trames classiques */
      drawText("Classic patterns", gx, y0 + 218, "Geneva", 10);
      const lc = 17, lx = gx, ly = y0 + 228;
      for (let i = 0; i < PAT_LIB.length; i++) {
        const cx = lx + (i % 10) * lc, cy = ly + Math.floor(i / 10) * lc;
        const p = hexToPat(PAT_LIB[i][1]);
        fill(cx, cy, 16, 16, "#fff");
        ctx.fillStyle = "#000";
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++)
            if (p[y * 8 + x]) ctx.fillRect(cx + x * 2, cy + y * 2, 2, 2);
        let same = true;
        for (let k = 0; k < 64; k++) if (p[k] !== PAT[pattern][k]) { same = false; break; }
        ctx.strokeStyle = same ? ACCENT : "#000";
        ctx.strokeRect(cx - 0.5, cy - 0.5, 17, 17);
        d._hits.push({
          x: cx, y: cy, w: 16, h: 16,
          act: (function (k) { return function () { PAT[pattern].set(hexToPat(PAT_LIB[k][1])); render(); }; })(i)
        });
      }
    }
  };

  /* ---------------------------------------------------------------- *
   *  19. Import / export
   * ---------------------------------------------------------------- */
  document.getElementById("file").addEventListener("change", function (e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = function () {
      const im = new Image();
      im.onload = function () { importImage(im); };
      im.onerror = function () {
        openDialog({ w: 320, h: 100, lines: ["This file is not a readable image."], buttons: [{ label: "OK", cmd: "close", def: true }] });
      };
      im.src = String(reader.result);
    };
    reader.readAsDataURL(f);
  });

  function importImage(im) {
    documentOpen=true;helpPage=null;showPage=false;
    const c = document.createElement("canvas");
    c.width = DW; c.height = DH;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, DW, DH);
    const k = Math.min(DW / im.width, DH / im.height);
    const w = im.width * k, h = im.height * k;
    g.drawImage(im, (DW - w) / 2, (DH - h) / 2, w, h);
    const d = g.getImageData(0, 0, DW, DH).data;
    const v = new Float32Array(DW * DH * 3);
    for (let i = 0; i < DW * DH; i++) { v[i * 3] = d[i * 4]; v[i * 3 + 1] = d[i * 4 + 1]; v[i * 3 + 2] = d[i * 4 + 2]; }
    pushUndo();
    /* Diffusion d'erreur de Floyd-Steinberg, vers les seize couleurs de la palette. */
    const spread = function (j, er, eg, eb, k) { v[j * 3] += er * k; v[j * 3 + 1] += eg * k; v[j * 3 + 2] += eb * k; };
    for (let y = 0; y < DH; y++)
      for (let x = 0; x < DW; x++) {
        const i = y * DW + x, r = v[i * 3], g2 = v[i * 3 + 1], b2 = v[i * 3 + 2];
        const n = nearestColor(r, g2, b2), c = PAL_RGB[n];
        doc[i] = n;
        const er = r - c[0], eg = g2 - c[1], eb = b2 - c[2];
        if (x + 1 < DW) spread(i + 1, er, eg, eb, 7 / 16);
        if (y + 1 < DH) {
          if (x > 0) spread(i + DW - 1, er, eg, eb, 3 / 16);
          spread(i + DW, er, eg, eb, 5 / 16);
          if (x + 1 < DW) spread(i + DW + 1, er, eg, eb, 1 / 16);
        }
      }
    scheduleSave();
    render();
  }

  /* ---------------------------------------------------------------- *
   *  20. Démarrage
   * ---------------------------------------------------------------- */
  const TOOLS = CLASSIC.tools.map(c=>c.tool);

  function fit() {
    if (touchMode) { fitDpr = window.devicePixelRatio || 1; return; }
    /* L'application occupe toute la fenêtre du navigateur. Un point de l'écran simulé vaut
       toujours un nombre entier de pixels de matériel, puissance de deux (1, 2, 4…) : aucun
       lissage. On prend le facteur de la densité de l'écran, tant qu'il reste 640 × 480 points. */
    const dpr = window.devicePixelRatio || 1;
    const dw = Math.floor(window.innerWidth * dpr), dh = Math.floor(window.innerHeight * dpr);
    let k = 1;
    while (k * 2 <= 8 && dw / (k * 2) >= 700 && dh / (k * 2) >= 480 && k * 2 <= Math.max(1, Math.round(dpr))) k *= 2;
    /* Grande interface : le plus fort grossissement entier (jusqu'au double) qui laisse encore 700 × 480 points à
       l'écran simulé. Un nombre entier de pixels de matériel par point : toujours aucun lissage. */
    FX.bigGain = 1;
    if (FX.bigUI) for (let kk = Math.min(8, k * 2); kk > k; kk--) if (dw / kk >= 700 && dh / kk >= 480) { FX.bigGain = kk / k; k = kk; break; }
    SW = Math.max(700, Math.floor(dw / k)); SH = Math.max(480, Math.floor(dh / k));
    DX = SW - OW - 52 - (palsLayout() - 1) * 58; DY = SH - OH;
    cv.width = SW; cv.height = SH; ctx.imageSmoothingEnabled = false;
    cv.style.width = (SW * k / dpr).toFixed(4) + "px"; cv.style.height = (SH * k / dpr).toFixed(4) + "px";
    cv.style.transform = ""; cv.style.left = "0px"; cv.style.top = "0px";
    cv.style.cursor = tool === "text" ? "text" : "crosshair";
    /* tout ce qui dépend de la taille de l'écran */
    WIN.w = 416 + DX; WIN.h = 240 + DY;
    SWATCH.y = 300 + DY; FXCELL.x = SW - 55; LPAN.x = SW - 55;
    FXROWS = Math.max(4, Math.min(Math.ceil(FX_ALL.length / 2), Math.floor((SH - 27 - 13 - 34 - 8 * LPAN.row - 20 - 52) / FXCELL.h)));
    LPAN.y = FXCELL.y + FXROWS * FXCELL.h + 34;
    if (PALS.on) { LPAN.x = PALS.lx; LPAN.y = PALS.ly; }
    if (layersLeft()) { LPAN.x = 15; LPAN.y = 336; }                // à gauche : même largeur que la palette d'outils, sous la boussole
    FX.scroll = Math.max(0, Math.min(FX.scroll, Math.ceil(FX_ALL.length / 2) - FXROWS));
    buildChrome();
    clampView();
    fitDpr = dpr;
    render();
  }

  /* Le facteur peut changer sans redimensionnement : zoom du navigateur,
     passage d'un écran à l'autre. On surveille la densité. */
  let fitDpr = 0;

  function boot() {
    fit();
    window.addEventListener("resize", fit);
    /* On arrive toujours sur une planche vierge : le dessin précédent n'est plus rechargé.
       Sur un écran assez grand, la page fait 1024 × 768 points ; sinon 640 × 480. */
    if (!touchMode && WIN.w >= 1000 && WIN.h >= 620) pageResize(1024, 768, true);
    render();
    setInterval(function () {
      if ((window.devicePixelRatio || 1) !== fitDpr) fit();
      if (sel || textState.active || menuOpen >= 0 || fatBits) render();
    }, 180);

    // All FONT strikes are synchronous data; no system font or font network lookup.

  }

  /* Public bridge shared by the classic and touch shells. No duplicate paint engine. */
  let touchCheckpoint = null, textCheckpoint = null;
  function cloneSelection(s) {
    return s ? { ...s, mask:s.mask?s.mask.slice():null, data:s.data?s.data.slice():null } : null;
  }
  function checkpoint() {
    return { pixels:doc.slice(), selection:cloneSelection(sel), undo:undoStack.slice(), redo:redoStack.slice(),
      polygon:polygonPoints?{...polygonPoints,pts:polygonPoints.pts.map(p=>({...p}))}:null,
      layers:layerSnapshot(), selectedText:selectedText,
      view:{...view},zoom:zoom };
  }
  function restoreCheckpoint(c) {
    doc.set(c.pixels);sel=cloneSelection(c.selection);polygonPoints=c.polygon;
    undoStack.splice(0,undoStack.length,...c.undo);redoStack.splice(0,redoStack.length,...c.redo);
    restoreLayers(c.layers);selectedText=c.selectedText;renderTextLayers();
    view.x=c.view.x;view.y=c.view.y;zoom=c.zoom;
    textState.active=false;textState.base=null;scheduleSave();render();
  }
  function pointForTouch(x,y) {
    if(!Number.isFinite(x)||!Number.isFinite(y))throw new TypeError("Invalid drawing coordinates");
    return {x:Math.round(x),y:Math.round(y)};
  }
  const publicAPI = {
    about:ABOUT,
    drawWindowTitle(target,width){
      const b=textBmp('untitled','Chicago',12,false,false),left=Math.floor((width-b.adv)/2);
      target.fillStyle='#fff';target.fillRect(0,0,width,19);
      target.fillStyle='#000';target.fillRect(0,18,width,1);
      for(let y=4;y<=14;y+=2)target.fillRect(2,y,width-4,1);
      target.fillStyle='#fff';target.fillRect(8,3,13,13);target.fillRect(left-5,2,b.adv+10,15);
      target.fillStyle='#000';target.fillRect(9,4,11,1);target.fillRect(9,14,11,1);target.fillRect(9,4,1,11);target.fillRect(19,4,1,11);
      for(let y=0;y<b.h;y++)for(let x=0;x<b.w;x++)if(b.bits[y*b.w+x])target.fillRect(left-b.pad+x,14-b.asc+y,1,1);
    },
    width:DW,height:DH,tools:Object.freeze(TOOLS.slice()),
    fonts:Object.freeze(FONTS.map(f=>f.name)),sizes:Object.freeze(SIZES.slice()),
    brushes:Object.freeze(BRUSHES.map(b=>Object.freeze({...b}))),
    subscribe(fn){changeListeners.add(fn);return ()=>changeListeners.delete(fn);},
    state(){return {tool,pattern,width:outlineWidth(),font:fontName,size:fontSize,styles:[...styles],alignment,
      brush:brushShape,mirror,canUndo:undoStack.length>0,canRedo:redoStack.length>0,canPaste:!!clipboard,
      documentOpen,textActive:textState.active,caret:textState.active?textCaretPos():null,
      textLayers:textLayers.length,selectedText,penWhite:inkWhite(),
      selection:sel?{x:sel.x,y:sel.y,w:sel.w,h:sel.h}:null,polygonPoints:polygonPoints?polygonPoints.pts.length:0,dialog};},
    hasInk(){return doc.some(v=>v===1) || textLayers.length>0;},
    setTool(name){if(!TOOLS.includes(name))throw new RangeError("Unknown tool");setTool(name);},
    setPattern(i){if(!Number.isInteger(i)||!PAT[i])throw new RangeError("Unknown pattern");pattern=i;render();},
    pattern(i=pattern){if(!PAT[i])throw new RangeError("Unknown pattern");return PAT[i].slice();},
    setPatternPixel(x,y,on){if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||x>7||y<0||y>7)throw new RangeError("Invalid pattern cell");PAT[pattern][y*8+x]=on?1:0;render();},
    setWidth(w){if(w===0){noOutline=true;render();return;}if(!Number.isInteger(w)||w<1||w>PEN_MAX)throw new RangeError("Invalid width");penW=w;noOutline=false;render();},
    setBrush(i){if(!Number.isInteger(i)||!BRUSHES[i])throw new RangeError("Invalid brush");brushShape=i;render();},
    setMirror(i){if(!Number.isInteger(i)||i<0||i>3)throw new RangeError("Invalid mirror");mirror=i;render();},
    command(name){
      const commands=['new','open','revert','close','cut','copy','paste','clearSel','invert','fill','trace','fliph','flipv','rotate','resetpatterns'];
      const font=name.startsWith('font:')&&FONTS.some(f=>f.name===name.slice(5));
      const size=name.startsWith('size:')&&SIZES.includes(Number(name.slice(5)));
      const face=name.startsWith('style:')&&['plain','bold','italic','underline','outline','shadow'].includes(name.slice(6));
      const align=name.startsWith('align:')&&['left','middle','right'].includes(name.slice(6));
      if(!commands.includes(name)&&!font&&!size&&!face&&!align)throw new RangeError("Unsupported command");
      cmd(name);
    },
    undo(){requestUndo();},redo(){redo();},
    beginStroke(x,y,options={}){
      textCommit();touchCheckpoint=checkpoint();const d=pointForTouch(x,y);
      mouse.x=VIEW.x+(d.x-view.x)*zoom;mouse.y=VIEW.y+(d.y-view.y)*zoom;
      startTool(d,options);
    },
    moveStroke(x,y,options={}){
      if(!drag)return;const d=pointForTouch(x,y);
      const p={x:VIEW.x+(d.x-view.x)*zoom,y:VIEW.y+(d.y-view.y)*zoom};
      mouse.x=p.x;mouse.y=p.y;moveTool(p,options);
    },
    endStroke(){endTool();touchCheckpoint=null;},
    cancelStroke(){const c=touchCheckpoint;touchCheckpoint=null;endTool();if(c)restoreCheckpoint(c);},
    finishPolygon(){if(!polygonPoints||polygonPoints.pts.length<3)return false;paintClosed(polygonPoints.pts,polygonPoints.filled);polygonPoints=null;scheduleSave();render();return true;},
    clearSelection(){selCommit();sel=null;render();},
    beginText(x,y){textCommit();textCheckpoint=checkpoint();const d=pointForTouch(x,y);textBegin(d.x,d.y);},
    setText(value){if(!textState.active)return;const lines=String(value).slice(0,2000).replace(/\r\n?/g,'\n').split('\n');textState.lines=lines;textState.li=lines.length-1;textState.ci=lines[textState.li].length;textRender();},
    commitText(){textCommit();textCheckpoint=null;},
    cancelText(){const c=textCheckpoint;textCheckpoint=null;textState.active=false;textState.base=null;if(c)restoreCheckpoint(c);},
    /* Texte en bitmap d'origine (pour dessiner les fenêtres en vrais pixels). */
    bitmapText(value,family,size,bold){const b=textBmp(String(value),family||'Chicago',size||12,!!bold,false);return {bits:b.bits,w:b.w,h:b.h,pad:b.pad,asc:b.asc,adv:b.adv,lineHeight:b.lineHeight};},
    measureText(value){const b=textBmp(String(value),fontName,fontSize,styles.has('bold'),styles.has('italic'));return {width:b.adv,ascent:b.asc,lineHeight:b.lineHeight};},
    drawDocument(target,x,y,scale){
      syncDoc();target.imageSmoothingEnabled=false;target.drawImage(docCanvas,x,y,DW*scale,DH*scale);target.drawImage(textCanvas,x,y,DW*scale,DH*scale);
      if(sel&&sel.data){
        floatCanvas.width=sel.w;floatCanvas.height=sel.h;const im=fctx.createImageData(sel.w,sel.h),p=new Uint32Array(im.data.buffer);
        for(let i=0;i<p.length;i++)p[i]=sel.mask&&!sel.mask[i]?0:PAL32[sel.data[i]];
        fctx.putImageData(im,0,0);target.drawImage(floatCanvas,x+sel.x*scale,y+sel.y*scale,sel.w*scale,sel.h*scale);
      }
    },
    exportPNG(){textCommit();selCommit();syncDoc();const c=document.createElement('canvas');c.width=DW;c.height=DH;const g=c.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(docCanvas,0,0);g.drawImage(textCanvas,0,0);return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('PNG export failed')),'image/png'));},
    /* Calques de texte : sélection, déplacement, réédition, suppression. */
    textLayers(){return textLayers.map(cloneTextLayer);},
    textLayerAt(x,y){const d=pointForTouch(x,y);const l=textLayerAt(d.x,d.y);return l?l.id:null;},
    textLayerBounds(id){const l=textLayers.find(function(t){return t.id===id;});return l?textLayerBounds(l):null;},
    selectText(id){selectedText=id;render();},
    clearTextSelection(){selectedText=null;render();},
    moveTextLayer(id,x,y){const d=pointForTouch(x,y);const l=textLayers.find(function(t){return t.id===id;});if(!l)return false;l.x=d.x;l.y=d.y;renderTextLayers();scheduleSave();render();return true;},
    beginTextMove(id){const l=textLayers.find(function(t){return t.id===id;});if(!l)return null;pushUndo();return {x:l.x,y:l.y};},
    deleteTextLayer(id){const i=textLayers.findIndex(function(t){return t.id===id;});if(i<0)return false;pushUndo();textLayers.splice(i,1);selectedText=null;renderTextLayers();scheduleSave();render();return true;},
    editTextLayer(id){return editTextLayerById(id);},
  };
  /* Mise au point : MacPaint.mischief(60) saute directement à ce nombre de
     gestes (0 remet tout en place) ; sans argument, renvoie l'état. */
  publicAPI.mischief = function (n) {
    if (n !== undefined && MOT && !touchMode) {
      legoReset();
      for (let i = 0; i < n; i++) {
        mischief++;
        const level = Studio.difficulty.levelFor(mischief);
        if (level !== legoLevel) { legoLevel = level; if (level >= 3) legoRearrange(); else if (level === 2) { swapCells(); swapCells(); } }
      }
      startAnim();
    }
    return { gestes: mischief, palier: legoLevel, disposition: legoLayout };
  };
  publicAPI.avalanche = function (n) { physAvalanche(n === undefined ? 20 : n); return Object.keys(bodies).length; };
  publicAPI.layout = function (i) { if (MOT && !touchMode && LEGO_LAYOUTS[i]) legoSetLayout(i); return legoLayout; };
  /* On arrive toujours sur une page blanche : le dessin précédent n'est pas rechargé à l'ouverture. */
  publicAPI.inspect = function () { return { layers: LAYERS.map(l => ({ name: l.name, visible: l.visible, ink: l.data.reduce((n, v) => n + (v ? 1 : 0), 0) })), active: LA, screen: { w: SW, h: SH }, win: { x: WIN.x, y: WIN.y, w: WIN.w, h: WIN.h }, page: { w: DW, h: DH }, zoom: zoom, view: { x: view.x, y: view.y }, tool: tool }; };
  publicAPI.run = function (name) { cmd(name); };
  publicAPI.gif = function (mode, secs, scale) { GD.mode = mode; GD.secs = secs || 2; GD.scale = scale || 1; gifStart(); return FX.gifLast; };
  window.MacPaint = Object.freeze(publicAPI);

  boot();

  /* accès de mise au point (console) */
  window.__mp = {
    MENUS: MENUS,
    TOOLS: TOOLS, FONTS:FONTS, SIZES:SIZES, PAT:PAT, VIEW:VIEW,
    cmd:cmd,textBmp:textBmp,fit:fit,
    get documentOpen(){return documentOpen;},get dialog(){return dialog;},get selection(){return sel;},get textActive(){return textState.active;},
    get pattern(){return pattern;},get lineWidth(){return [1,2,4,8].indexOf(penW);},get penWidth(){return penW;},
    resetForTest(){if(sprayTimer)clearInterval(sprayTimer);drag=null;sel=null;dialog=null;menuOpen=-1;menuHover=-1;menuTrack=false;documentOpen=true;polygonPoints=null;helpPage=null;textState.active=false;textLayers.length=0;selectedText=null;view.x=view.y=0;zoom=1;fatBits=false;showPage=false;doc.fill(0);undoStack.length=redoStack.length=0;pattern=0;lineWidth=0;noOutline=false;fontName="Geneva";fontSize=12;style="plain";styles.clear();alignment="left";tool="brush";renderTextLayers();render();},
    get menuOpen() { return menuOpen; },
    get tool() { return tool; },
    get zoom() { return zoom; },
    get view() { return { x: view.x, y: view.y }; },
    get doc() { return doc; }, get layers() { return LAYERS.map(l => ({ name: l.name, visible: l.visible })); }, get page() { return { w: DW, h: DH }; },
    docCanvas: docCanvas,
    dctx: dctx,
    render: render,
    undo: undo,
    undoLen: function () { return undoStack.length; }
  };
})();
