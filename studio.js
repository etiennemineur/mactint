/* ColorPaint — studio.js
 * La musique de l'application. Aucun fichier son : tout est synthétisé en direct
 * (Web Audio), et rien ne joue tant que l'utilisateur ne fait rien. Chaque action
 * est une note ; les notes sont calées sur une grille de doubles croches, dans la
 * gamme de la couleur courante, si bien que dessiner revient à jouer.
 *
 *   - la hauteur du pointeur dans la fenêtre donne la hauteur de la note ;
 *   - sa position horizontale place le son entre gauche et droite ;
 *   - sa vitesse donne la force ;
 *   - l'outil choisit l'instrument, la couleur choisit la gamme ;
 *   - à la fin d'un geste, la dernière note rebondit comme une balle.
 */
(function () {
  'use strict';

  const BPM = 168, STEP = 60 / BPM / 4;                     // une double croche
  const STORE = 'colorpaint.sound';
  let enabled = true;
  try { enabled = localStorage.getItem(STORE) !== '0'; } catch (e) {}

  let ac = null, master = null, echoIn = null, noiseBuf = null;
  function audio() {
    if (ac) { if (ac.state === 'suspended') ac.resume(); return ac; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.16;
    master = ac.createGain(); master.gain.value = enabled ? 0.55 : 0;
    master.connect(comp); comp.connect(ac.destination);
    /* Écho ping-pong, croche pointée : c'est lui qui fait rebondir les notes d'un côté à l'autre. */
    echoIn = ac.createGain();
    const dl = ac.createDelay(1), dr = ac.createDelay(1), fb = ac.createGain(), lp = ac.createBiquadFilter();
    const pl = ac.createStereoPanner(), pr = ac.createStereoPanner();
    dl.delayTime.value = STEP * 3; dr.delayTime.value = STEP * 3; fb.gain.value = 0.34;
    lp.type = 'lowpass'; lp.frequency.value = 2600; pl.pan.value = -0.7; pr.pan.value = 0.7;
    echoIn.connect(dl); dl.connect(pl); pl.connect(master);
    dl.connect(dr); dr.connect(pr); pr.connect(master);
    dr.connect(lp); lp.connect(fb); fb.connect(dl);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return ac;
  }

  /* ---------------------------------------------------------------- *
   *  Gammes : une par couleur (index de la palette, 1 à 15).
   * ---------------------------------------------------------------- */
  const MAJ = [0, 2, 4, 7, 9], MIN = [0, 3, 5, 7, 10], LYD = [0, 2, 4, 6, 9], PHR = [0, 1, 5, 7, 10];
  const KEYS = [null,
    [57, MIN],   //  1 noir        la mineur
    [50, MIN],   //  2 gris foncé  ré mineur
    [52, MIN],   //  3 gris        mi mineur
    [55, MAJ],   //  4 gris clair  sol majeur
    [53, MAJ],   //  5 beige       fa majeur
    [48, MIN],   //  6 brun        do mineur
    [52, PHR],   //  7 rouge       mi phrygien
    [50, MAJ],   //  8 orange      ré majeur
    [48, MAJ],   //  9 jaune       do majeur
    [55, MAJ],   // 10 vert        sol majeur
    [47, MIN],   // 11 vert foncé  si mineur
    [53, LYD],   // 12 cyan        fa lydien
    [46, MAJ],   // 13 bleu        si bémol majeur
    [54, MIN],   // 14 violet      fa dièse mineur
    [51, MAJ]];  // 15 magenta     mi bémol majeur
  let key = KEYS[1];
  const midi = deg => key[0] + key[1][((deg % 5) + 5) % 5] + 12 * Math.floor(deg / 5);
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);

  /* ---------------------------------------------------------------- *
   *  Instruments. Tous : (instant, note MIDI, force 0–1, panoramique −1…1).
   * ---------------------------------------------------------------- */
  function out(t, pan, send) {
    const p = ac.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0));
    p.connect(master);
    if (send) { const s = ac.createGain(); s.gain.value = send; p.connect(s); s.connect(echoIn); }
    return p;
  }
  function env(t, peak, attack, decay) {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }
  /* Le « boing » : une note qui part trop haut et retombe sur sa hauteur, avec un léger ressort. */
  function boing(t, m, vel, pan) {
    const f = hz(m), o = ac.createOscillator(), o2 = ac.createOscillator(), g = env(t, 0.5 * vel, 0.004, 0.32);
    o.type = 'sine'; o2.type = 'triangle';
    for (const x of [o, o2]) {
      x.frequency.setValueAtTime(f * 1.9, t);
      x.frequency.exponentialRampToValueAtTime(f * 0.94, t + 0.07);
      x.frequency.exponentialRampToValueAtTime(f * 1.03, t + 0.13);
      x.frequency.exponentialRampToValueAtTime(f, t + 0.2);
      x.connect(g); x.start(t); x.stop(t + 0.4);
    }
    g.connect(out(t, pan, 0.25));
  }
  function pluck(t, m, vel, pan, bright) {
    const o = ac.createOscillator(), lp = ac.createBiquadFilter(), g = env(t, 0.22 * vel, 0.002, 0.14);
    o.type = 'square'; o.frequency.setValueAtTime(hz(m), t);
    lp.type = 'lowpass'; lp.Q.value = 6;
    lp.frequency.setValueAtTime(600 + 5200 * (bright === undefined ? vel : bright), t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.14);
    o.connect(lp); lp.connect(g); g.connect(out(t, pan, 0.3)); o.start(t); o.stop(t + 0.2);
  }
  function bell(t, m, vel, pan) {
    const f = hz(m), c = ac.createOscillator(), mod = ac.createOscillator(), mg = ac.createGain(), g = env(t, 0.26 * vel, 0.003, 0.7);
    mod.frequency.value = f * 3.5; mg.gain.setValueAtTime(f * 2.2, t); mg.gain.exponentialRampToValueAtTime(1, t + 0.35);
    c.frequency.value = f; mod.connect(mg); mg.connect(c.frequency);
    c.connect(g); g.connect(out(t, pan, 0.4)); c.start(t); mod.start(t); c.stop(t + 0.8); mod.stop(t + 0.8);
  }
  /* Synthèse FM douce, pour tout ce qui pousse. */
  function fm(t, m, vel, pan) {
    const f = hz(m), c = ac.createOscillator(), mod = ac.createOscillator(), mg = ac.createGain(), g = env(t, 0.3 * vel, 0.01, 0.9);
    mod.frequency.value = f * 2; mg.gain.setValueAtTime(f * 1.4, t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + 0.5);
    c.frequency.value = f; mod.connect(mg); mg.connect(c.frequency);
    c.connect(g); g.connect(out(t, pan, 0.5)); c.start(t); mod.start(t); c.stop(t + 1); mod.stop(t + 1);
  }
  function bass(t, m, vel, pan) {
    const o = ac.createOscillator(), lp = ac.createBiquadFilter(), g = env(t, 0.42 * vel, 0.004, 0.2);
    o.type = 'sawtooth'; o.frequency.setValueAtTime(hz(m) * 1.5, t); o.frequency.exponentialRampToValueAtTime(hz(m), t + 0.05);
    lp.type = 'lowpass'; lp.Q.value = 9; lp.frequency.setValueAtTime(1800, t); lp.frequency.exponentialRampToValueAtTime(180, t + 0.18);
    o.connect(lp); lp.connect(g); g.connect(out(t, pan * 0.3, 0.08)); o.start(t); o.stop(t + 0.26);
  }
  function kick(t, vel) {
    const o = ac.createOscillator(), g = env(t, 0.9 * vel, 0.002, 0.2);
    o.frequency.setValueAtTime(170, t); o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.25);
  }
  function tom(t, m, vel, pan) {
    const o = ac.createOscillator(), g = env(t, 0.5 * vel, 0.002, 0.16);
    o.frequency.setValueAtTime(hz(m) * 1.6, t); o.frequency.exponentialRampToValueAtTime(hz(m), t + 0.09);
    o.connect(g); g.connect(out(t, pan, 0.15)); o.start(t); o.stop(t + 0.22);
  }
  function noise(t, vel, pan, type, f0, f1, dur, send) {
    const n = ac.createBufferSource(), flt = ac.createBiquadFilter(), g = env(t, vel, 0.002, dur);
    n.buffer = noiseBuf; n.loop = true;
    flt.type = type; flt.Q.value = type === 'bandpass' ? 3 : 0.7;
    flt.frequency.setValueAtTime(f0, t); flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
    n.connect(flt); flt.connect(g); g.connect(out(t, pan, send || 0)); n.start(t, Math.random() * 0.5); n.stop(t + dur + 0.05);
  }
  function snare(t, vel, pan) {
    noise(t, 0.42 * vel, pan || 0, 'bandpass', 2400, 1500, 0.11, 0.18);
    const o = ac.createOscillator(), g = env(t, 0.3 * vel, 0.001, 0.07);
    o.type = 'triangle'; o.frequency.setValueAtTime(330, t); o.frequency.exponentialRampToValueAtTime(170, t + 0.05);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.1);
  }
  /* Basse « reese » : deux dents de scie désaccordées, filtre qui se referme. */
  function reese(t, m, vel, dur) {
    const lp = ac.createBiquadFilter(), g = env(t, 0.34 * vel, 0.008, dur || 0.3);
    lp.type = 'lowpass'; lp.Q.value = 7; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(140, t + (dur || 0.3));
    for (const det of [-14, 14]) { const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(m); o.detune.value = det; o.connect(lp); o.start(t); o.stop(t + (dur || 0.3) + 0.1); }
    const sub = ac.createOscillator(); sub.frequency.value = hz(m) / 2; sub.connect(g); sub.start(t); sub.stop(t + (dur || 0.3) + 0.1);
    lp.connect(g); g.connect(master);
  }
  /* Le rythme cassé (jungle) : il ne joue que pendant qu'un geste avance, calé sur la grille
     commune. Geste lent : grosse caisse et caisse claire. Geste vif : charleston, notes
     fantômes, et roulements de caisse claire en triples croches. */
  const BREAK_K = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0], BREAK_S = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0], BREAK_G = [0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 1];
  function drums(t, k, speed, pan) {
    if (BREAK_K[k]) kick(t, 0.85);
    if (BREAK_S[k]) snare(t, 0.9, 0);
    if (speed > 0.02 && BREAK_G[k] && Math.random() < 0.75) snare(t, 0.3, pan * 0.5);
    if (speed > 0.012 && (k % 2 === 0 || Math.random() < 0.4)) hat(t, k % 4 === 2 ? 0.8 : 0.45, -pan * 0.6, k % 8 === 6);
    if (speed > 0.06 && k % 4 === 3) { snare(t + STEP / 2, 0.35, pan); if (Math.random() < 0.5) kick(t + STEP / 2, 0.5); }
    if (speed > 0.1 && k >= 12) for (let i = 1; i < 4; i++) snare(t + i * STEP / 4, 0.25 + i * 0.08, pan);   // roulement
  }
  const hat = (t, vel, pan, open) => noise(t, 0.16 * vel, pan, 'highpass', 7000, 9000, open ? 0.14 : 0.035, 0.1);
  const swoosh = (t, vel, pan, up) => noise(t, 0.3 * vel, pan, 'bandpass', up ? 400 : 3200, up ? 3200 : 400, 0.2, 0.3);
  function stab(t, degs, vel, pan) {
    const lp = ac.createBiquadFilter(), g = env(t, 0.16 * vel, 0.006, 0.4);
    lp.type = 'lowpass'; lp.Q.value = 4; lp.frequency.setValueAtTime(3600, t); lp.frequency.exponentialRampToValueAtTime(500, t + 0.35);
    for (const d of degs) for (const det of [-6, 6]) {
      const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = hz(midi(d)); o.detune.value = det;
      o.connect(lp); o.start(t); o.stop(t + 0.5);
    }
    lp.connect(g); g.connect(out(t, pan, 0.45));
  }
  /* La balle : la même note relancée à intervalles de plus en plus courts, de moins en moins fort. */
  /* ---------------------------------------------------------------- *
   *  Une voix par outil, une couleur sonore par famille. On doit pouvoir
   *  reconnaître à l'oreille le type d'outil :
   *    - outils classiques : des « boing » et des glissés, ronds et rebondis ;
   *    - Draw    : des lames frappées (xylophone, marimba, kalimba, verre) ;
   *    - Effects : des percussions sèches et très rythmées (bois, conga, cloche, puce) ;
   *    - Life    : des bulles et des balles qui rebondissent, doux ;
   *    - Cycle   : des arpèges de puce 8 bits ;
   *    - 3D      : des sons graves et larges, avec beaucoup d'écho.
   *  Dans une famille, chaque outil a sa façon de fabriquer le son, son
   *  registre et son propre rythme (une figure sur seize doubles croches).
   * ---------------------------------------------------------------- */
  const CATS = {
    classic: ['brush', 'pencil', 'spray', 'eraser', 'line', 'rect', 'rectFill', 'rrect', 'rrectFill', 'oval', 'ovalFill', 'polygon', 'polygonFill', 'freeform', 'freeformFill', 'lasso', 'marquee', 'grabber', 'text', 'bucket'],
    draw: ['wild', 'leaky', 'frizzy', 'web', 'tree', 'paste', 'hose', 'rails', 'wet', 'drip', 'hot', 'yeast', 'type', 'alpha', 'balloon', 'custom', 'extrude', 'lathe', 'fold', 'jelly', 'ribbon', 'spike'],
    effects: ['bayer', 'blend', 'comb', 'waves', 'dryer', 'grid', 'blinds', 'moire', 'accordion', 'acid', 'dynamite', 'hammer', 'ball', 'slice', 'glitch', 'melt'],
    life: ['balls', 'rain', 'snow', 'pump', 'amoeba', 'heart', 'metal', 'graft', 'sun', 'coral', 'shaker', 'motor', 'elastic', 'repel', 'worm', 'fly'],
    cycle: ['cycle', 'cfill'],
    solid: ['cube', 'sphere', 'cylinder', 'cone', 'pyramid', 'torus']
  };
  const POOLS = { classic: [0, 10, 19, 5, 1, 6, 18, 2], draw: [12, 13, 14, 21, 1, 2, 11, 6], effects: [15, 16, 17, 7, 9, 8, 5, 4], life: [18, 20, 19, 0, 10, 13, 3], cycle: [7, 14], solid: [22, 23, 3, 21, 11, 2] };
  const PULSES = { classic: [8, 6, 5, 7], draw: [5, 6, 7, 4, 8], effects: [7, 9, 11, 5, 10, 6], life: [3, 5, 4, 6], cycle: [8, 6], solid: [2, 3, 4, 3] };   // combien de coups par mesure
  const SENDS = { classic: 0.25, draw: 0.3, effects: 0.12, life: 0.38, cycle: 0.3, solid: 0.55 };
  const VOICE_ORDER = [].concat(CATS.classic, CATS.draw, CATS.effects, CATS.life, CATS.cycle, CATS.solid);
  const VOICES = {};
  const catOf = tool => { for (const c in CATS) if (CATS[c].includes(tool)) return c; return 'draw'; };
  function voiceIndex(tool) {
    const i = VOICE_ORDER.indexOf(tool);
    if (i >= 0) return i;
    let h = 0; for (let k = 0; k < tool.length; k++) h = (h * 31 + tool.charCodeAt(k)) >>> 0;
    return VOICE_ORDER.length + h % 97;
  }
  /* Deux outils ne partagent jamais le même moteur dans le même registre : les registres sont distribués une fois
     pour toutes, dans l'ordre des familles. */
  const REG = {}, REG_USED = {};
  function registerFor(tool, eng, ci, base) {
    if (REG[tool] !== undefined) return REG[tool];
    const order = [[0, 12, -12, 24], [12, 0, 24, -12], [-12, 0, 12, 24], [0, -12, 12, 24]][ci % 4].map(v => v + base);
    let o = order.find(v => !REG_USED[eng + ':' + v]); if (o === undefined) o = order[0];
    REG_USED[eng + ':' + o] = 1;
    return REG[tool] = o;
  }
  let BEND = 0;                                              // glissé de la note en cours, en demi-tons (le geste monte ou descend)
  function voiceFor(tool) {
    tool = String(tool || 'brush');
    if (VOICES[tool]) return VOICES[tool];
    if (!voiceFor.ready) { voiceFor.ready = true; VOICE_ORDER.forEach(voiceFor); }   // tous les outils connus d'abord, pour que la distribution ne dépende pas de l'ordre d'utilisation
    const cat = catOf(tool), pool = POOLS[cat], ci = Math.max(0, CATS[cat].indexOf(tool));
    let h = 2166136261; for (let k = 0; k < tool.length; k++) h = Math.imul(h ^ tool.charCodeAt(k), 16777619) >>> 0;
    const r = k => ((h >>> (k * 5)) & 31) / 31;              // cinq nombres fixes par outil
    /* Pour que deux outils ne se ressemblent pas : chaque outil d'une famille a son propre moteur (les moteurs de la
       famille d'abord, puis tous les autres), son registre, sa façon d'attaquer la note et sa couleur de filtre. */
    const wide = pool.concat([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].filter(e => !pool.includes(e)).sort((a, b) => ((a * 7 + cat.length * 5) % 24) - ((b * 7 + cat.length * 5) % 24)));
    const eng = wide[ci % wide.length], lap = Math.floor(ci / pool.length);
    const oct = registerFor(tool, eng, ci, cat === 'solid' ? -12 : 0);
    const art = cat === 'classic' ? [0, 0, 1, 0, 2][ci % 5] : [0, 3, 1, 5, 2, 4, 0, 6][(ci + (cat === 'effects' ? 3 : cat === 'life' ? 5 : 0)) % 8];   // 0 simple, 1 fla, 2 octave doublée, 3 arpège montant, 4 arpège descendant, 5 roulement, 6 quinte tenue
    const tint = [0, 1, 0, 2, 3, 0, 4, 1][(ci * 5 + cat.length) % 8];   // 0 nu, 1 sourd, 2 mince, 3 nasillard, 4 téléphone
    const dec = (0.1 + r(0) * 0.45) * (1 + lap * 0.3), ratio = [1.5, 2, 2.5, 3, 3.5, 4.5, 5, 7][Math.min(7, Math.floor(r(1) * 8))];
    const send = SENDS[cat] + r(3) * 0.12, bright = 0.3 + r(4) * 0.7, vib = 4 + r(2) * 6;
    const play = (o, t, d) => { o.start(t); o.stop(t + d + 0.08); };
    const core = function (t, m, vel, pan, bend) {
      const f = Math.max(45, Math.min(4200, hz(m + oct))), dst0 = out(t, pan, send), bk = Math.pow(2, (bend === undefined ? BEND : bend) / 12);
      let dst = dst0;
      if (tint) {                                              // la couleur de l'outil : un filtre entre l'instrument et la sortie
        const q = ac.createBiquadFilter();
        if (tint === 1) { q.type = 'lowpass'; q.frequency.value = Math.min(9000, f * (2.2 + bright * 2)); q.Q.value = 0.7; }
        else if (tint === 2) { q.type = 'highpass'; q.frequency.value = Math.min(6000, f * (1.6 + bright)); q.Q.value = 0.7; }
        else if (tint === 3) { q.type = 'bandpass'; q.frequency.value = Math.min(7000, f * (2.5 + bright * 2)); q.Q.value = 2.5; }
        else { q.type = 'bandpass'; q.frequency.value = 1700 + bright * 900; q.Q.value = 1.2; }
        q.connect(dst0); dst = q;
      }
      /* un oscillateur : s'il n'a pas son propre glissé, il suit celui du geste */
      const O = (type, fq, at, own) => { const o = ac.createOscillator(); o.type = type; o.frequency.setValueAtTime(fq, at); if (!own && bk !== 1) o.frequency.exponentialRampToValueAtTime(fq * bk, at + 0.16); return o; };
      const mix = (parts, g, d) => parts.forEach(function (q) { const o = O('sine', f * q[0], t), a = ac.createGain(); a.gain.setValueAtTime(q[1], t); if (q[2]) a.gain.exponentialRampToValueAtTime(0.001, t + q[2]); o.connect(a); a.connect(g); play(o, t, d); });
      if (eng === 0) {                                         // boing : part trop haut et retombe
        const d = dec + 0.15, o = O('sine', f * (1.4 + bright), t, true), g = env(t, 0.5 * vel, 0.004, d);
        o.frequency.exponentialRampToValueAtTime(f * 0.95, t + 0.07); o.frequency.exponentialRampToValueAtTime(f * bk, t + 0.18);
        o.connect(g); g.connect(dst); play(o, t, d);
      } else if (eng === 1) {                                  // corde pincée : carré filtré
        const o = O('square', f, t), lp = ac.createBiquadFilter(), g = env(t, 0.22 * vel, 0.002, dec);
        lp.type = 'lowpass'; lp.Q.value = 3 + r(2) * 9; lp.frequency.setValueAtTime(600 + 5200 * bright, t); lp.frequency.exponentialRampToValueAtTime(300, t + dec);
        o.connect(lp); lp.connect(g); g.connect(dst); play(o, t, dec);
      } else if (eng === 2 || eng === 3) {                     // cloche (2) ou nappe (3) en modulation de fréquence
        const soft = eng === 3, d = dec + (soft ? 0.5 : 0.3), c = O('sine', f, t), mod = O('sine', f * (soft ? ratio / 2 : ratio), t), mg = ac.createGain(), g = env(t, 0.26 * vel, soft ? 0.02 : 0.003, d);
        mg.gain.setValueAtTime(f * (0.8 + 2 * bright), t); mg.gain.exponentialRampToValueAtTime(Math.max(1, f * 0.04), t + d * 0.6);
        mod.connect(mg); mg.connect(c.frequency); c.connect(g); g.connect(dst); play(c, t, d); play(mod, t, d);
      } else if (eng === 4) {                                  // dent de scie, filtre qui se referme
        const d = dec + 0.1, o = O('sawtooth', f, t), lp = ac.createBiquadFilter(), g = env(t, 0.3 * vel, 0.004, d);
        lp.type = 'lowpass'; lp.Q.value = 9; lp.frequency.setValueAtTime(900 + 3000 * bright, t); lp.frequency.exponentialRampToValueAtTime(160, t + d);
        o.connect(lp); lp.connect(g); g.connect(dst); play(o, t, d);
      } else if (eng === 5) {                                  // tambour accordé
        const d = dec + 0.06, o = O('sine', f * (1.3 + bright), t, true), g = env(t, 0.5 * vel, 0.002, d);
        o.frequency.exponentialRampToValueAtTime(f * bk, t + 0.09); o.connect(g); g.connect(dst); play(o, t, d);
      } else if (eng === 6) {                                  // flûte : triangle et vibrato
        const d = dec + 0.25, o = O('triangle', f, t), l = O('sine', vib, t, true), lg = ac.createGain(), g = env(t, 0.34 * vel, 0.02, d);
        lg.gain.value = f * 0.02; l.connect(lg); lg.connect(o.frequency); o.connect(g); g.connect(dst); play(o, t, d); play(l, t, d);
      } else if (eng === 7) {                                  // puce 8 bits : la note saute d'une octave à l'autre
        const d = dec + 0.08, o = O('square', f, t, true), g = env(t, 0.13 * vel, 0.002, d), hop = 0.025 + r(2) * 0.04;
        for (let k = 1; k * hop < d; k++) o.frequency.setValueAtTime((k % 2 ? f * (ratio > 3 ? 1.5 : 2) : f) * Math.pow(bk, k * hop / d), t + k * hop);
        o.connect(g); g.connect(dst); play(o, t, d);
      } else if (eng === 8) {                                  // souffle accordé : du bruit dans un filtre étroit
        const d = dec + 0.12, n = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = env(t, 1.6 * vel, 0.004, d);
        n.buffer = noiseBuf; n.loop = true; bp.type = 'bandpass'; bp.Q.value = 18 + bright * 22; bp.frequency.setValueAtTime(f * 2, t); bp.frequency.exponentialRampToValueAtTime(f * 2 * bk, t + d);
        n.connect(bp); bp.connect(g); g.connect(dst); n.start(t, Math.random() * 0.5); n.stop(t + d + 0.08);
      } else if (eng === 9) {                                  // métal : deux carrés qui ne s'accordent pas
        const o = O('square', f, t), o2 = O('square', f * ratio * 0.71, t), hp = ac.createBiquadFilter(), g = env(t, 0.1 * vel, 0.002, dec + 0.1);
        hp.type = 'highpass'; hp.frequency.value = 500 + 900 * bright; o.connect(hp); o2.connect(hp); hp.connect(g); g.connect(dst); play(o, t, dec + 0.1); play(o2, t, dec + 0.1);
      } else if (eng === 10) {                                 // glissé : la note monte jusqu'à sa hauteur
        const d = dec + 0.12, g = env(t, 0.36 * vel, 0.006, d);
        for (const ty of ['sine', 'triangle']) { const x = O(ty, f * 0.5, t, true); x.frequency.exponentialRampToValueAtTime(f * bk, t + 0.05 + dec * 0.3); x.connect(g); play(x, t, d); }
        g.connect(dst);
      } else if (eng === 11) {                                 // orgue : trois harmoniques
        const d = dec + 0.2, g = env(t, 0.22 * vel, 0.01, d);
        mix([[1, 1], [2, 0.5 * bright], [ratio > 3 ? 4 : 3, 0.3]], g, d); g.connect(dst);
      } else if (eng === 12) {                                 // xylophone : lame sèche et claire
        const d = 0.12 + dec * 0.5, g = env(t, 0.45 * vel, 0.001, d);
        mix([[1, 1], [4, 0.35, 0.05], [9.2, 0.12, 0.02]], g, d); g.connect(dst);
      } else if (eng === 13) {                                 // marimba : lame ronde, plus longue
        const d = 0.3 + dec, g = env(t, 0.5 * vel, 0.002, d);
        mix([[1, 1], [3.93, 0.22, 0.07], [0.5, 0.3]], g, d); g.connect(dst);
      } else if (eng === 14) {                                 // kalimba : lamelle pincée
        const d = dec + 0.3, c = O('sine', f, t), mod = O('sine', f * 6.27, t), mg = ac.createGain(), g = env(t, 0.34 * vel, 0.001, d);
        mg.gain.setValueAtTime(f * 1.6, t); mg.gain.exponentialRampToValueAtTime(1, t + 0.05);
        mod.connect(mg); mg.connect(c.frequency); c.connect(g); g.connect(dst); play(c, t, d); play(mod, t, d);
      } else if (eng === 15) {                                 // bloc de bois : très court
        const d = 0.05 + dec * 0.1, o = O('sine', f * 2.2, t, true), bp = ac.createBiquadFilter(), g = env(t, 0.7 * vel, 0.001, d);
        o.frequency.exponentialRampToValueAtTime(f * 1.7 * bk, t + 0.02); bp.type = 'bandpass'; bp.Q.value = 3; bp.frequency.value = f * 2;
        o.connect(bp); bp.connect(g); g.connect(dst); play(o, t, d);
      } else if (eng === 16) {                                 // conga : peau et claque
        const d = 0.12 + dec * 0.4, o = O('sine', f * 1.5, t, true), g = env(t, 0.55 * vel, 0.001, d);
        o.frequency.exponentialRampToValueAtTime(f * bk, t + 0.04); o.connect(g); g.connect(dst); play(o, t, d);
        noise(t, 0.2 * vel, pan, 'bandpass', 1800, 900, 0.03, 0.05);
      } else if (eng === 17) {                                 // cloche de vache
        const d = 0.1 + dec * 0.4, o = O('square', f, t), o2 = O('square', f * 1.504, t), bp = ac.createBiquadFilter(), g = env(t, 0.16 * vel, 0.001, d);
        bp.type = 'bandpass'; bp.Q.value = 4; bp.frequency.value = f * 2; o.connect(bp); o2.connect(bp); bp.connect(g); g.connect(dst); play(o, t, d); play(o2, t, d);
      } else if (eng === 18) {                                 // bulle : un petit « bloup » qui monte
        const d = 0.12 + dec * 0.2, o = O('sine', f * 0.6, t, true), g = env(t, 0.45 * vel, 0.006, d);
        o.frequency.exponentialRampToValueAtTime(f * 1.5 * bk, t + 0.09); o.connect(g); g.connect(dst); play(o, t, d);
      } else if (eng === 19) {                                 // ressort : la note tremble puis se calme
        const d = dec + 0.35, o = O('sine', f, t), l = O('sine', 11 + r(2) * 5, t, true), lg = ac.createGain(), g = env(t, 0.4 * vel, 0.004, d);
        lg.gain.setValueAtTime(f * 0.07, t); lg.gain.exponentialRampToValueAtTime(f * 0.002, t + d * 0.8);
        l.connect(lg); lg.connect(o.frequency); o.connect(g); g.connect(dst); play(o, t, d); play(l, t, d);
      } else if (eng === 20) {                                 // balle qui rebondit : des coups de plus en plus rapprochés
        let at = t, gap = 0.085 + r(2) * 0.03, a = 0.45 * vel;
        for (let k = 0; k < 5 && a > 0.03; k++) {
          const o = O('sine', f * 1.3, at, true), g = env(at, a, 0.002, 0.07);
          o.frequency.exponentialRampToValueAtTime(f * Math.pow(bk, k / 4), at + 0.03); o.connect(g); g.connect(dst); play(o, at, 0.07);
          at += gap; gap *= 0.72; a *= 0.66;
        }
      } else if (eng === 21) {                                 // verre : clair et long
        const d = dec + 0.8, g = env(t, 0.22 * vel, 0.002, d);
        mix([[1, 1], [2.76, 0.3, d * 0.5], [5.4, 0.1, d * 0.25]], g, d); g.connect(dst);
      } else if (eng === 22) {                                 // nappe : deux triangles désaccordés, attaque lente
        const d = dec + 0.9, lp = ac.createBiquadFilter(), g = env(t, 0.26 * vel, 0.06, d);
        lp.type = 'lowpass'; lp.frequency.value = 900 + 1500 * bright;
        for (const k of [0.994, 1.006]) { const o = O('triangle', f * k, t); o.connect(lp); play(o, t, d); }
        lp.connect(g); g.connect(dst);
      } else {                                                 // grave : une basse ronde et son petit clic
        const d = dec + 0.4, o = O('sine', Math.max(40, f / 2), t), g = env(t, 0.6 * vel, 0.004, d), c = O('square', f * 2, t, true), cg = env(t, 0.08 * vel, 0.001, 0.012);
        o.connect(g); g.connect(dst); play(o, t, d); c.connect(cg); cg.connect(dst); play(c, t, 0.02);
      }
    };
    /* la façon d'attaquer la note, propre à l'outil */
    const fn = function (t, m, vel, pan, bend) {
      if (art === 0) core(t, m, vel, pan, bend);
      else if (art === 1) { core(t, m, vel, pan, bend); core(t + 0.04, m + 7, vel * 0.5, -(pan || 0), bend); }                       // fla : un second coup, plus doux, à la quinte
      else if (art === 2) { core(t, m, vel * 0.8, pan, bend); core(t, m + 12, vel * 0.45, pan, bend); }                             // l'octave en même temps
      else if (art === 3) { [0, 4, 7].forEach((d, i) => core(t + i * 0.05, m + d, vel * (0.85 - i * 0.2), pan, bend)); }               // arpège montant
      else if (art === 4) { [12, 7, 0].forEach((d, i) => core(t + i * 0.05, m + d, vel * (0.85 - i * 0.2), pan, bend)); }              // arpège descendant
      else if (art === 5) { for (let i = 0; i < 3; i++) core(t + i * 0.032, m, vel * (0.8 - i * 0.22), pan, bend); }                   // roulement de trois coups
      else { core(t, m, vel * 0.75, pan, bend); core(t, m + 7, vel * 0.4, pan, bend); }                                             // la quinte en même temps
    };
    fn.kit = cat === 'classic' ? 0 : [0, 1, 2, 3, 0, 4, 1, 2][(ci * 3 + cat.length) % 8];   // batterie : 0 complète, 1 aucune, 2 grosse caisse seule, 3 cymbales seules, 4 clairsemée
    fn.sig = [eng, oct, art, tint, fn.kit];
    /* son rythme : une figure régulière de n coups sur seize pas, décalée selon l'outil */
    const pulses = PULSES[cat][ci % PULSES[cat].length], rot = Math.floor(r(1) * 16);
    fn.pat = []; for (let k = 0; k < 16; k++) fn.pat.push(((k + rot) * pulses) % 16 < pulses);
    fn.cat = cat;
    return VOICES[tool] = fn;
  }

  function bounce(fn, t, m, vel, pan, first) {
    let gap = first || STEP * 2, at = t, v = vel;
    for (let i = 0; i < 7 && v > 0.05; i++) {
      at += gap; gap *= 0.68; v *= 0.7;
      fn(at, m + (i % 2 ? 0 : 12), v, pan);
    }
  }

  /* ---------------------------------------------------------------- *
   *  Grille. Elle se recale sur la première action après un silence : le
   *  premier son part donc sans retard, et la suite reste en mesure.
   * ---------------------------------------------------------------- */
  let origin = 0, lastAction = -10, step = 0;
  function instant() {                                       // maintenant, en recalant la grille si l'on sort d'un silence
    const now = ac.currentTime;
    if (now - lastAction > STEP * 8) { origin = now; step = 0; }
    lastAction = now;
    return now + 0.005;
  }
  function onGrid() {                                        // la prochaine double croche
    const now = ac.currentTime;
    if (now - lastAction > STEP * 8) { origin = now; step = 0; lastAction = now; return now + 0.005; }
    lastAction = now;
    return origin + Math.ceil((now - origin) / STEP - 0.25) * STEP + 0.005;
  }
  const ready = () => enabled && audio();

  /* ---------------------------------------------------------------- *
   *  Le geste : tant que le pointeur avance, l'outil joue en mesure.
   * ---------------------------------------------------------------- */
  const TOOLS = ['lasso', 'marquee', 'grabber', 'text', 'bucket', 'spray', 'brush', 'pencil', 'line', 'eraser',
    'rect', 'rectFill', 'rrect', 'rrectFill', 'oval', 'ovalFill', 'freeform', 'freeformFill', 'polygon', 'polygonFill'];
  const family = t => /^(rect|rrect|oval|line|polygon)/.test(t) ? 'shape' : /^(lasso|marquee|freeform)/.test(t) ? 'loop' : t;
  const LOONY = { custom: [boing, 0, 2], rails: [tom, -12, 2], hot: [pluck, 12, 1], elastic: [boing, 0, 2], bayer: [pluck, 0, 2], blend: [bell, 0, 2], comb: [pluck, 12, 1], waves: [boing, 0, 2], amoeba: [tom, -12, 2], yeast: [bass, -12, 4], leaky: [bass, -12, 4], frizzy: [pluck, 12, 1], tree: [bell, 0, 2], web: [pluck, 0, 1], paste: [boing, 0, 2], hose: [tom, -12, 2] };
  const G = { on: false, tool: 'brush', x: 0.5, y: 0.5, sx: 0.5, sy: 0.5, moved: 0, timer: 0, next: 0, n: 0, lastDeg: 5, lastPan: 0, fn: boing };
  const degAt = y => Math.round((1 - Math.max(0, Math.min(1, y))) * 13);      // presque trois octaves, l'aigu en haut
  const panAt = x => Math.max(-1, Math.min(1, x * 1.6 - 0.8));

  function gestureNote(t, first) {
    /* Le geste : la hauteur du pointeur donne la note ; monter ou descendre ajoute des degrés
       dans le même sens (la mélodie grimpe quand la main grimpe) et fait glisser chaque note ;
       un demi-tour franc déclenche un rebond. */
    const up = G.up || 0;
    G.run = Math.max(-5, Math.min(5, (G.run || 0) * 0.75 + Math.max(-2, Math.min(2, up * 70))));
    BEND = first ? 0 : Math.max(-5, Math.min(5, up * 220));
    const fam = family(G.tool), deg = degAt(G.y) + Math.round(G.run), pan = panAt(G.x), n = G.n;
    const vel = first ? 0.9 : Math.max(0.35, Math.min(1, 0.3 + G.moved * 9));
    const inst = voiceFor(G.tool);                           // la voix propre à l'outil
    let fn = inst, m = midi(deg);
    if (fam === 'brush') {
      if (n % 2 === 0 || G.moved > 0.05) inst(t, m, vel, pan);
      if (n % 4 === 0) bass(t, midi(deg % 5) - 12, 0.8, pan);
    } else if (fam === 'pencil') {
      inst(t, m + 12, vel, pan);
    } else if (fam === 'spray') {
      hat(t, 0.5 + vel * 0.5, pan, n % 4 === 2);
      if (n % 2 === 0) inst(t, m + 12, vel * 0.7, pan);
    } else if (fam === 'eraser') {
      if (n % 2 === 0) { swoosh(t, vel, pan, false); inst(t, midi(deg) - 12, vel * 0.7, pan); }
    } else if (fam === 'shape') {
      /* Arpège entre le point de départ et le pointeur : plus la forme est grande, plus il est large. */
      const a = degAt(G.sy), span = Math.abs(deg - a), k = span ? n % (span + 1) : 0;
      m = midi(a + (deg >= a ? k : -k));
      inst(t, m, vel, panAt(G.sx + (G.x - G.sx) * (span ? k / span : 0)));
      if (n % 4 === 0) bass(t, midi(Math.min(a, deg) % 5) - 12, 0.7, 0);
    } else if (fam === 'loop') {
      if (n % 2 === 0) inst(t, m, vel * 0.8, pan);
    } else if (fam === 'grabber') {
      if (n % 2 === 0) inst(t, m - 12, vel * 0.6, pan);
    } else if (fam === 'wild') {
      /* Le pinceau vivant : basse reese syncopée, et une voix qui change d'instrument au hasard. */
      const k = G.k;
      fn = boing;
      if (k === 0 || k === 3 || k === 6 || k === 10 || k === 13) reese(t, midi(deg % 5 + (k === 6 ? 2 : 0)) - 24, 0.9, STEP * (k === 10 ? 4 : 2));
      const v = [boing, pluck, bell, tom][Math.floor(Math.random() * 4)];
      if (Math.random() < 0.45 + G.moved * 4) v(t, m + (Math.random() < 0.3 ? 12 : 0), vel * 0.7, pan);
      if (k % 8 === 4 && Math.random() < 0.5) stab(t, [deg % 5 + 5, deg % 5 + 7, deg % 5 + 9], 0.5, -pan);
    } else if (fam === 'cycle') {
      /* L'encre qui ne sèche pas : un arpège qui tourne en boucle, comme la palette. */
      inst(t, midi(deg + [0, 2, 4, 2][n % 4]) + 12, vel * 0.8, Math.sin(n * 0.8) * 0.8);
      if (n % 4 === 0) inst(t, m - 12, 0.5, -pan);
    } else {
      /* Outils spéciaux : la famille donne le caractère, l'outil son rythme. Un geste rapide joue aussi entre les coups. */
      const cat = inst.cat, hit = first || inst.pat[G.k] || G.moved > 0.07;
      if (hit) {
        if (cat === 'life') { inst(t, m, vel * 0.75, pan); if (G.k % 4 === 2) inst(t + STEP / 2, m + 12, vel * 0.35, -pan); }                 // doux, et ça rebondit
        else if (cat === 'effects') { inst(t, m, vel * 0.85, pan); if (G.k % 8 === 4 || G.moved > 0.1) inst(t + STEP / 2, m, vel * 0.45, pan); }   // sec, serré
        else if (cat === 'solid') { inst(t, m, vel * 0.8, pan * 0.4); if (G.k % 8 === 0) inst(t, m + 7, vel * 0.35, -pan); }                   // grave, avec sa quinte
        else inst(t, m + (fam === 'frizzy' ? [0, 12, 7][Math.floor(Math.random() * 3)] : 0), vel * 0.8, pan);
      }
      if (fam === 'leaky' && G.k % 8 === 0) reese(t, midi(deg % 5) - 24, 0.8, STEP * 4);
      if (/^(acid|drip|dynamite|rain|snow|pump|ball|slice|heart|cfill|grid|blinds|moire|balloon|graft|sun|shaker|motor|repel|accordion|metal|hammer|coral|lathe|extrude|fold)$/.test(fam)) fn = null;   // pas de rebond final : leurs effets ont déjà leurs bruits
    }
    if (G.turn && !first) { G.turn = false; bounce(inst, t, m, 0.4, -pan, STEP); }      // demi-tour : la note rebondit de l'autre côté
    BEND = 0;
    G.lastDeg = deg; G.lastPan = pan; G.fn = fn; G.lastM = m;
  }
  function pump() {
    if (!G.on || !ac) { clearInterval(G.timer); G.timer = 0; return; }
    while (G.next < ac.currentTime + 0.06) {
      if ((G.moved > 0.004 || G.hold) && G.next > ac.currentTime - 0.02) {
        G.n++; G.k = ((Math.round((G.next - origin) / STEP) % 16) + 16) % 16;
        const cat = voiceFor(G.tool).cat, kit = voiceFor(G.tool).kit, sp = G.hold ? 0.015 : G.moved, pn = panAt(G.x);
        if (kit === 1) { /* aucune batterie : l'outil joue seul */ }
        else if (kit === 2) { if (G.k % 4 === 0) kick(G.next, G.k % 8 === 0 ? 0.8 : 0.5); }
        else if (kit === 3) { if (sp > 0.008 && (G.k % 2 === 0 || Math.random() < 0.3)) hat(G.next, G.k % 4 === 2 ? 0.8 : 0.45, -pn * 0.6, G.k % 8 === 6); }
        else if (kit === 4) { if (G.k % 8 === 0) kick(G.next, 0.7); if (G.k % 16 === 12) snare(G.next, 0.6, 0); }
        else if (cat === 'life' || cat === 'solid') { if (G.k % 8 === 0) kick(G.next, 0.45); if (G.k % 4 === 2 && G.moved > 0.012) hat(G.next, 0.4, -panAt(G.x) * 0.6, false); }   // batterie légère : ces familles restent douces
        else drums(G.next, G.k, G.hold ? 0.015 : G.moved, panAt(G.x));
        G.up = -(G.dy || 0); G.dy = 0;
        gestureNote(G.next, false); lastAction = ac.currentTime;
      }
      G.moved = 0;
      G.next += STEP;
    }
  }
  function gesture(phase, x, y, tool) {
    if (phase === 'move') {
      if (G.on) {
        const dx = x - G.x, dy = y - G.y, d = Math.hypot(dx, dy);
        G.moved += d; G.dy = (G.dy || 0) + dy;
        if (d > 0.006) { const a = Math.atan2(dy, dx); if (G.ang !== undefined) { let q = Math.abs(a - G.ang); if (q > Math.PI) q = 2 * Math.PI - q; if (q > 2) G.turn = true; } G.ang = a; }
        G.x = x; G.y = y;
      }
      return;
    }
    if (!ready()) return;
    if (phase === 'down') {
      const t = instant();
      G.on = true; G.tool = tool; G.k = 0; G.hold = /^(acid|drip|balls|rain|snow|pump|wet)$/.test(tool); G.x = G.sx = x; G.y = G.sy = y; G.moved = 0; G.n = 0; G.dy = 0; G.up = 0; G.run = 0; G.turn = false; G.ang = undefined;
      if (!/^(text|bucket|acid|drip|dynamite|rain|snow|pump|ball|slice|heart|cfill|grid|blinds|moire|balloon|graft|sun|shaker|motor|repel|accordion|metal|hammer|coral|lathe|extrude|fold)$/.test(tool)) kick(t, 0.8);
      gestureNote(t, true);
      G.next = origin + (Math.floor((t - origin) / STEP) + 1) * STEP;
      if (!G.timer) G.timer = setInterval(pump, 25);
      return;
    }
    if (phase === 'up' && G.on) {
      G.on = false;
      const t = onGrid(), fam = family(G.tool);
      if (fam === 'shape') stab(t, [degAt(G.sy), degAt(G.sy) + 2, degAt(y) + 4], 0.9, panAt(x));
      if (fam !== 'bucket' && fam !== 'text' && G.fn) bounce(G.fn, t, G.lastM || midi(G.lastDeg), 0.6, G.lastPan);
    }
  }

  /* ---------------------------------------------------------------- *
   *  Les actions ponctuelles.
   * ---------------------------------------------------------------- */
  function run(fn, degs, t, gap, vel, pan) { degs.forEach((d, i) => fn(t + i * gap, midi(d), vel, pan === undefined ? (i / Math.max(1, degs.length - 1)) * 1.2 - 0.6 : pan)); }
  function select(tool) {                                    // chaque outil a ses deux notes
    if (!ready()) return;
    const i = voiceIndex(String(tool)), t = instant(), d = 2 + (i % 10), v = voiceFor(tool);   // deux notes, dans la voix de l'outil
    tom(t, midi(d % 5) - 12, 0.6, 0);
    v(t, midi(d), 0.8, -0.3); v(t + STEP * 2, midi(d + 2 + (i % 3)), 0.7, 0.3);
  }
  function color(i) {                                        // nouvelle couleur, nouvelle gamme : on l'entend monter
    key = KEYS[i] || KEYS[1];
    if (!ready()) return;
    const t = instant();
    bass(t, midi(0) - 12, 0.9, 0);
    run(boing, [0, 2, 4, 5, 7], t, STEP, 0.7);
    bounce(bell, t + STEP * 4, midi(7), 0.5, 0.4);
  }
  function cheer(kind) {
    if (kind === 'draw' || kind === 'level' || !ready()) return;
    const t = onGrid();
    if (kind === 'fill') {                                   // le pot de peinture : la couleur monte et déborde
      kick(t, 0.9); swoosh(t, 0.7, 0, true);
      run(pluck, [0, 2, 4, 5, 7, 9, 10, 12], t, STEP / 2, 0.8);
      bounce(boing, t + STEP * 4, midi(12), 0.7, 0.2, STEP * 2);
    } else if (kind === 'undo') { run(boing, [7, 5, 3], t, STEP, 0.7); swoosh(t, 0.4, 0, false); }
    else if (kind === 'redo') { run(boing, [3, 5, 7], t, STEP, 0.7); swoosh(t, 0.4, 0, true); }
    else if (kind === 'new') { swoosh(t, 0.9, 0, true); kick(t + STEP * 2, 0.9); stab(t + STEP * 2, [0, 2, 4, 7], 0.9, 0); }
    else if (kind === 'save') { run(bell, [0, 2, 4, 7], t, STEP * 2, 0.8); stab(t + STEP * 8, [0, 2, 4], 0.7, 0); }
    else if (kind === 'text') { bell(t, midi(7), 0.7, 0); }
    else boing(t, midi(5), 0.6, 0);
  }
  let walk = 5;
  function tick(kind) {
    if (!ready()) return;
    if (kind === 'type') {                                   // la frappe se promène dans la gamme
      walk = Math.max(0, Math.min(13, walk + [-2, -1, 1, 1, 2][Math.floor(Math.random() * 5)]));
      pluck(instant(), midi(walk) + 12, 0.7, (walk - 6) / 9, 0.6);
    } else if (kind === 'vertex') { const t = instant(); bell(t, midi(degAt(G.y)), 0.8, panAt(G.x)); tom(t, midi(0) - 12, 0.5, 0); }
    else pluck(instant(), midi(5), 0.6, 0);
  }
  const now0 = () => instant();
  function ui(kind, n) {
    if (!ready()) return;
    n = n | 0;
    if (kind === 'menu') { const t = instant(); hat(t, 0.8, 0, true); boing(t, midi(n + 3), 0.5, n / 3 - 1); }
    else if (kind === 'item') pluck(instant(), midi(12 - (n % 13)) + 12, 0.35, 0, 0.3);
    else if (kind === 'tilt') { const t = now0(); pluck(t, midi(n % 14) + 12, 0.6, Math.sin(n / 24 * 6.28) * 0.8, 1); tom(t, midi(n % 5) - 12, 0.4, 0); }   // un cran du volant
    else if (kind === 'zoom') { const t = instant(); run(pluck, [n * 3, n * 3 + 2], t, STEP / 2, 0.5, 0); }
    else if (kind === 'layer') { const t = instant(); bell(t, midi(2 + n * 2), 0.6, n / 4 - 0.8); tom(t, midi(n % 5) - 12, 0.5, 0); }
    else if (kind === 'choose') { const t = instant(); run(boing, [4, 7], t, STEP, 0.7, 0); }
    else if (kind === 'pattern') { const t = instant(); pluck(t, midi(n % 19 % 14) + (n >= 19 ? 12 : 0), 0.8, (n % 19) / 9 - 1, 0.3 + (n % 7) / 10); hat(t, 0.5, 0, false); }
    else if (kind === 'width') { const t = instant(); tom(t, midi(4 - n) - 12, 0.9, 0); bounce(tom, t, midi(4 - n) - 12, 0.5, 0, STEP * 2); }
  }
  /* Les outils bizarres. Leurs évènements arrivent en rafale : chaque sorte a son débit maximal. */
  const fxLast = {}, FX_GAP = { clink: 0.04, hum: 0.2, seed: 0.05, grow: 0.08, bloom: 0.12, shake: 0.03, field: 0.07, twang: 0.07, clack: 0.06, burp: 0.15, phase: 0.25, moire: 1.2, chord: 0.5, rubber: 0.09, strobe: 0.08, pour: 0.12, trickle: 0.035, dry: 0.09, roll: 0.07, mix: 0.1, comb: 0.05, wave: 0.12, rise: 0.05, smash: 0.06, grind: 0.1, pump: 0.05, bloup: 0.06, beat: 0.04, blot: 0.09, zap: 0.05, branch: 0.12, web: 0.08, squirt: 0.12, spit: 0.07, ping: 0.04, flake: 0.1, stamp: 0.08, mode: 0.2, tick: 0.05, bounce: 0.045, drop: 0.11, fizz: 0.06, drip: 0.12, plop: 0.05, plip: 0.05 };
  function fx(kind, x, y, v) {
    if (!ready()) return;
    const now = ac.currentTime;
    if (FX_GAP[kind] && now - (fxLast[kind] || -1) < FX_GAP[kind]) return;
    fxLast[kind] = now;
    const pan = panAt(x), deg = degAt(y);
    if (kind === 'fuse') { const t = instant(); noise(t, 0.2, pan, 'highpass', 5000, 9000, 0.9, 0.1); }
    else if (kind === 'tick') pluck(now + 0.005, midi(12) + 12, 0.5, pan, 1);
    else if (kind === 'boom') {
      const t = instant();
      kick(t, 1); kick(t + 0.03, 0.8);
      noise(t, 0.7, 0, 'lowpass', 4200, 120, 0.7, 0.4);
      stab(t, [0, 1, 3, 6], 1, 0);
      run(boing, [12, 9, 7, 4, 2, 0], t + STEP, STEP, 0.6);
    }
    else if (kind === 'bounce') tom(now + 0.005, midi(deg), 0.55, pan);        // chaque éclat qui tape un bord
    else if (kind === 'drop') { const o = now + 0.005; pluck(o, midi(deg + 5) + 12, 0.45, pan, 0.9); }
    else if (kind === 'fizz') { noise(now + 0.005, 0.11, pan, 'highpass', 6500, 11000, 0.07, 0.2); if (Math.random() < 0.3) bell(now + 0.01, midi(deg + 7) + 12, 0.2, pan); }
    else if (kind === 'drip') bass(onGrid(), midi(deg % 5), 0.6, pan);
    else if (kind === 'stamp') { const t = onGrid(); [boing, bell, tom][Math.floor(Math.random() * 3)](t, midi(deg + 3), 0.7, pan); }
    else if (kind === 'mode') { const t = onGrid(); swoosh(t, 0.35, pan, true); run(pluck, [deg, deg + 2, deg + 4], t, STEP / 2, 0.5, pan); }
    else if (kind === 'phase') {                                 // persiennes : un souffle balayé par un filtre, comme un phaser
      const t = now + 0.005, n = ac.createBufferSource(), f = ac.createBiquadFilter(), g = env(t, 0.14, 0.05, 0.6);
      n.buffer = noiseBuf; n.loop = true; f.type = 'bandpass'; f.Q.value = 9;
      f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(3600, t + 0.3); f.frequency.exponentialRampToValueAtTime(500, t + 0.65);
      n.connect(f); f.connect(g); g.connect(out(t, pan, 0.3)); n.start(t); n.stop(t + 0.7);
      pluck(t, midi(deg) + 12, 0.3, -pan, 0.5);
    }
    else if (kind === 'moire') {                                 // deux dents de scie à peine désaccordées : on entend le battement
      const t = now + 0.005, g = env(t, 0.1, 0.6, 2), lp = ac.createBiquadFilter(), f = hz(midi(deg % 5) - 12);
      lp.type = 'lowpass'; lp.frequency.value = 900;
      [[0, -0.6], [0.7 + (v || 0) * 2, 0.6]].forEach(q => { const o = ac.createOscillator(), p = ac.createStereoPanner(); o.type = 'sawtooth'; o.frequency.value = f + q[0]; p.pan.value = q[1]; o.connect(p); p.connect(lp); o.start(t); o.stop(t + 2.8); });
      lp.connect(g); g.connect(master);
    }
    else if (kind === 'chord') { const t = onGrid(), w = Math.round((v || 0) * 6); stab(t, [0, 2 + (w >> 1), 4 + w, 7 + w], 0.55, 0); bass(t, midi(0) - 12, 0.6, 0); }   // plus les cases sont inégales, plus l'accord s'ouvre
    else if (kind === 'cut') { const t = instant(); noise(t, 0.3, pan, 'highpass', 3000, 8000, 0.05, 0.2); pluck(t, midi(deg) + 12, 0.7, pan, 1); }
    else if (kind === 'rubber') {                                // caoutchouc frotté : grave, court, qui couine un peu
      const t = now + 0.005, o = ac.createOscillator(), f = ac.createBiquadFilter(), g = env(t, 0.3 + (v || 0) * 0.3, 0.01, 0.16), f0 = 90 + (v || 0) * 140;
      o.type = 'sawtooth'; o.frequency.setValueAtTime(f0, t); o.frequency.linearRampToValueAtTime(f0 * 1.5, t + 0.07); o.frequency.linearRampToValueAtTime(f0 * 0.8, t + 0.16);
      f.type = 'bandpass'; f.Q.value = 5; f.frequency.value = f0 * 4;
      o.connect(f); f.connect(g); g.connect(out(t, pan, 0.1)); o.start(t); o.stop(t + 0.2);
    }
    else if (kind === 'strobe') { const t = now + 0.005; snare(t, 1, 0); noise(t, 0.5, 0, 'highpass', 6000, 12000, 0.09, 0.3); kick(t, 0.9); }
    else if (kind === 'glass') { const t = instant(); noise(t, 0.8, 0, 'highpass', 3000, 9000, 0.12, 0.4); kick(t, 0.8); [14, 16, 18, 21, 23].forEach((d2, i) => bell(t + i * 0.035, midi(d2) + 12, 0.5, (i - 2) / 2.5)); }   // le verre : un souffle aigu et une grappe de cloches
    else if (kind === 'clink') { const t = now + 0.005; bell(t, midi(deg + 9) + 12, 0.25 + (v || 0) * 0.4, pan); noise(t, 0.06, pan, 'highpass', 7000, 11000, 0.02, 0.2); }
    else if (kind === 'hum') { const t = now + 0.005, f = hz(midi(0) - 24) * (1 + (v || 0) * 0.5), g = env(t, 0.16, 0.08, 0.3), lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 300 + (v || 0) * 900; [0, 3].forEach(dt2 => { const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f + dt2; o.connect(lp); o.start(t); o.stop(t + 0.45); }); lp.connect(g); g.connect(out(t, pan, 0.2)); }   // bourdonnement, plus aigu à mesure que le contour s'allonge
    else if (kind === 'lathe') { const t = instant(); run(fm, [0, 2, 4, 7, 9, 12], t, STEP / 2, 0.5); noise(t, 0.2, 0, 'bandpass', 600, 2400, 0.4, 0.2); }
    else if (kind === 'seed') pluck(now + 0.005, midi(deg) + 24, 0.4, pan, 1);
    else if (kind === 'grow') fm(now + 0.005, midi(deg + 2), 0.25, pan);
    else if (kind === 'bloom') { const t = onGrid(), u = v === undefined ? 1 : v; [0, 2, 4, 7].forEach((d2, i) => fm(t + i * STEP * 0.75, midi(deg % 5 + 5 + d2), 0.4 * u, pan * (i & 1 ? -1 : 1))); }   // arpège pentatonique très doux
    else if (kind === 'shake') { const t = now + 0.005; noise(t, 0.1 + (v || 0) * 0.25, pan, 'highpass', 6000 + Math.random() * 3000, 9000, 0.03, 0.1); if (Math.random() < 0.3) pluck(t, midi(12) + 24, 0.2, -pan, 1); }   // maracas, d'autant plus serrées qu'on secoue fort
    else if (kind === 'field') { const t = now + 0.005; fm(t, midi(deg), 0.3, pan); }
    else if (kind === 'twang') { const t = now + 0.005, f = hz(midi(Math.round((v || 0.5) * 12))); const o = ac.createOscillator(), lp = ac.createBiquadFilter(), g = env(t, 0.3, 0.002, 0.5); o.type = 'sawtooth'; o.frequency.setValueAtTime(f * 1.02, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.08); lp.type = 'lowpass'; lp.frequency.setValueAtTime(4000, t); lp.frequency.exponentialRampToValueAtTime(500, t + 0.4); o.connect(lp); lp.connect(g); g.connect(out(t, pan, 0.3)); o.start(t); o.stop(t + 0.6); }   // corde de guitare
    else if (kind === 'clack') { const t = now + 0.005; noise(t, 0.2, pan, 'bandpass', 1900, 1200, 0.03, 0.1); tom(t, midi(deg % 5) - 12, 0.4, pan); tom(t + STEP / 2, midi(deg % 5) - 12, 0.25, pan); }
    else if (kind === 'burp') { const t = now + 0.005, o = ac.createOscillator(), g = env(t, 0.25, 0.005, 0.14); o.type = 'square'; o.frequency.setValueAtTime(90 + (v || 0.5) * 80, t); o.frequency.exponentialRampToValueAtTime(50, t + 0.06); o.frequency.exponentialRampToValueAtTime(120, t + 0.12); o.connect(g); g.connect(out(t, pan, 0.1)); o.start(t); o.stop(t + 0.16); }   // petit rot 8 bits
    else if (kind === 'pour') bass(onGrid(), midi(deg % 5) - 12, 0.5, pan);
    else if (kind === 'trickle') { const t = now + 0.005; pluck(t, midi(deg + Math.floor(Math.random() * 5)) + 12, 0.18 + (v || 0) * 0.3, pan, 0.4 + Math.random() * 0.6); if (Math.random() < 0.3) noise(t, 0.05, -pan, 'highpass', 5000, 9000, 0.03, 0.2); }   // ruissellement : des grains de notes, plus serrés quand tout coule
    else if (kind === 'dry') { const t = now + 0.005; noise(t, 0.18, pan, 'highpass', 2500, 7000, 0.18, 0.1); bell(t, midi(deg + 4) + 12, 0.25, pan); }
    else if (kind === 'roll') noise(now + 0.005, 0.1, pan, 'bandpass', 1800, 900, 0.06, 0.2);
    else if (kind === 'mix') bell(onGrid(), midi(deg + 2) + 12, 0.3, pan);
    else if (kind === 'comb') pluck(now + 0.005, midi(deg + Math.floor(Math.random() * 3)) + 12, 0.45, pan, 0.8);        // une dent du peigne, une corde pincée
    else if (kind === 'wave') { const t = now + 0.005, o = ac.createOscillator(), g = env(t, 0.16, 0.02, 0.25); o.frequency.setValueAtTime(hz(midi(deg)), t); o.frequency.linearRampToValueAtTime(hz(midi(deg + 2)), t + 0.12); o.frequency.linearRampToValueAtTime(hz(midi(deg)), t + 0.25); o.connect(g); g.connect(out(t, pan, 0.3)); o.start(t); o.stop(t + 0.3); }
    else if (kind === 'rise') { const t = now + 0.005, o = ac.createOscillator(), g = env(t, 0.3, 0.004, 0.07); o.frequency.setValueAtTime(70 + Math.random() * 90, t); o.frequency.exponentialRampToValueAtTime(160 + Math.random() * 120, t + 0.06); o.connect(g); g.connect(out(t, pan, 0.1)); o.start(t); o.stop(t + 0.1); }   // une bulle grave qui crève
    else if (kind === 'launch') { const t = instant(); swoosh(t, 0.8, pan, true); boing(t, midi(deg) - 12, 0.9, pan); }
    else if (kind === 'smash') { const t = now + 0.005; noise(t, 0.3, pan, 'bandpass', 2600, 700, 0.09, 0.2); tom(t, midi(deg % 5) - 12, 0.6, pan); }
    else if (kind === 'slide') { const t = instant(); noise(t, 0.25, pan, 'lowpass', 300, 1400, 0.9, 0.1); }
    else if (kind === 'grind') noise(now + 0.005, 0.1, pan, 'bandpass', 500, 300, 0.08, 0);
    else if (kind === 'thud') { const t = now + 0.005; kick(t, 1); kick(t + 0.04, 0.7 * (v || 0.5)); noise(t, 0.5, pan, 'lowpass', 500, 80, 0.3, 0.2); reese(t, midi(0) - 24, 0.9, 0.5); }
    else if (kind === 'pump') {                                  // le caoutchouc qui se tend : un souffle filtré de plus en plus aigu
      const t = now + 0.005, f = 300 + (v || 0) * 3200;
      noise(t, 0.16 + (v || 0) * 0.14, pan, 'bandpass', f, f * 1.25, 0.06, 0.05);
      if (Math.random() < 0.2) pluck(t, midi(Math.round((v || 0) * 13)) + 12, 0.3, pan, 1);
    }
    else if (kind === 'pop') { const t = now + 0.005; noise(t, 1, 0, 'highpass', 900, 5000, 0.05, 0.3); kick(t, 1); run(boing, [12, 9, 7, 4], t + STEP, STEP, 0.5); }
    else if (kind === 'bloup') {                                 // goutte d'eau : un filtre résonnant qui plonge, une sinusoïde qui remonte
      const t = now + 0.005, o = ac.createOscillator(), g = env(t, 0.5, 0.004, 0.16), f0 = 900 - (v || 0.3) * 600;
      o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * 0.35, t + 0.05); o.frequency.exponentialRampToValueAtTime(f0 * 1.6, t + 0.15);
      o.connect(g); g.connect(out(t, pan, 0.35)); o.start(t); o.stop(t + 0.2);
    }
    else if (kind === 'beat') { const t = now + 0.005, o = ac.createOscillator(), g = env(t, 0.8, 0.002, 0.3); o.frequency.setValueAtTime(130 * (0.7 + (v || 1) * 0.5), t); o.frequency.exponentialRampToValueAtTime(42, t + 0.14); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.35); }   // grosse caisse façon boîte à rythmes
    else if (kind === 'blot') { const t = now + 0.005; boing(t, midi(deg % 5) - 12, 0.8, pan); noise(t, 0.2, pan, 'lowpass', 900, 200, 0.12, 0.2); }
    else if (kind === 'zap') { const t = now + 0.005; pluck(t, midi(deg + 7) + 24, 0.4, pan, 1); noise(t, 0.08, -pan, 'highpass', 8000, 12000, 0.03, 0.3); }
    else if (kind === 'branch') { const t = onGrid(); run(bell, [deg, deg + 2, deg + 4, deg + 7], t, STEP / 2, 0.55, pan); }
    else if (kind === 'web') pluck(onGrid(), midi(deg + [0, 2, 4][Math.floor(Math.random() * 3)]) + 12, 0.4, pan, 0.6);
    else if (kind === 'squirt') { const t = now + 0.005; boing(t, midi(deg + 2), 0.5, pan); }
    else if (kind === 'spit') { const t = onGrid(); [tom, pluck, boing][Math.floor(Math.random() * 3)](t, midi(deg), 0.6, pan); }
    else if (kind === 'ping') { const t = now + 0.005; bell(t, midi(deg), 0.6, pan); }                       // ricochet d'une bille
    else if (kind === 'flake') bell(onGrid(), midi(deg + 5) + 12, 0.25, pan);
    else if (kind === 'plop') boing(now + 0.005, midi(deg), 0.55, pan);
    else if (kind === 'plip') { const t = now + 0.005; pluck(t, midi(deg) + 12, 0.5, pan, 0.4); bounce(pluck, t, midi(deg) + 12, 0.35, pan, STEP); }
  }
  /* Typo vivante. La même lettre donne toujours la même note : un mot devient un motif, et le
     retaper le rejoue. Le corps de la lettre choisit l'instrument et l'octave (les énormes
     sont graves et lourdes), et chaque frappe fait avancer d'un pas le rythme cassé. */
  let typed = 0;
  function typing(kind, ch, size, x, y) {
    if (!ready()) return;
    const t = onGrid(), pan = panAt(x), k = typed++ % 16;
    if (kind === 'space') { drums(t, k, 0.03, pan); hat(t, 0.9, pan, true); return; }
    if (kind === 'enter') { for (let i = 0; i < 4; i++) snare(t + i * STEP / 2, 0.4 + i * 0.15, pan); kick(t + STEP * 2, 1); reese(t + STEP * 2, midi(0) - 24, 1, STEP * 4); typed = 0; return; }
    if (kind === 'back') { swoosh(t, 0.5, pan, false); boing(t, midi(2), 0.5, pan); typed = Math.max(0, typed - 2); return; }
    drums(t, k, 0.03, pan);
    const code = (ch || 'a').toLowerCase().charCodeAt(0), deg = (code * 7) % 13, m = midi(deg);
    if (size >= 72) { reese(t, midi(deg % 5) - 24, 1, STEP * 3); boing(t, m - 12, 1, pan); kick(t, 0.9); }
    else if (size >= 36) { boing(t, m, 0.85, pan); if (k % 4 === 0) bass(t, midi(deg % 5) - 12, 0.8, pan); }
    else if (size >= 18) { [pluck, bell][code % 2](t, m + 12, 0.75, pan); }
    else { pluck(t, m + 24, 0.6, pan, 1); pluck(t + STEP / 2, m + 24, 0.3, -pan, 1); }
    if (ch !== ch.toLowerCase()) stab(t, [deg % 5 + 5, deg % 5 + 7], 0.4, -pan);     // les capitales ajoutent un accord
  }
  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(STORE, enabled ? '1' : '0'); } catch (e) {}
    if (master) master.gain.setTargetAtTime(enabled ? 0.55 : 0, ac.currentTime, 0.03);
    if (enabled && audio()) { const t = instant(); run(boing, [0, 4, 7], t, STEP, 0.7); }
  }
  const nop = function () {};

  /* Le moteur de dessin (hérité de la version classique) attend cet objet. */
  window.Studio = Object.freeze({
    audio: Object.freeze({ signature: function (tool) { return voiceFor(tool).sig.concat([voiceFor(tool).pat.filter(Boolean).length]); }, select, loop: nop, loopStop: nop, cheer, tick, motion: nop, stop: nop, gesture, ui, color, fx, typing,
      setEnabled, isEnabled: () => enabled, energy: () => 0, CATEGORIES: Object.freeze({}) }),
    on: nop,
    difficulty: Object.freeze({ classic: () => true, get: () => 0, started: () => false, frenzy: () => false, ramp: () => 0, levelFor: () => 0 })
  });
})();
