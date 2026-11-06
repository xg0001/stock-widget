/* ============================================================
 * 萌宠交易所 —— 真实猫咪图片 + 服装 / 光效 / 专属动作
 * 宠物本体：assets/pets/{id}.png（AI 生成 3D 猫咪，已去背 + 归一化正方构图）
 * 服装：SVG 叠加层，按 100x100 坐标定位（头 y≈20 / 眼 y≈44 / 颈 y≈64）
 * 光效：环绕猫咪的旋转光环（aura SVG，绘制在 .pet-aura 上）
 * 动作：通用动画（CSS keyframes，装备后作用在 .pet-inner 上）；每只猫有独立默认动作，商城动作按猫付费额外增加
 * ============================================================ */
(function () {
  const PET_IMAGE_DIR = 'assets/pets/';

  // ---------- 颜色工具：让服装/光环跟随猫咪毛色，融为一体 ----------
  function hexToRgb(h) { h = (h || '#888888').replace('#', ''); if (h.length === 3) h = h.split('').map(c => c + c).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgbToHex(r, g, b) { const f = x => ('0' + Math.max(0, Math.min(255, Math.round(x))).toString(16)).slice(-2); return '#' + f(r) + f(g) + f(b); }
  function mix(hex, target, amt) { const a = hexToRgb(hex), b = hexToRgb(target); return rgbToHex(a[0] + (b[0] - a[0]) * amt, a[1] + (b[1] - a[1]) * amt, a[2] + (b[2] - a[2]) * amt); }
  function lighten(hex, amt) { return mix(hex, '#ffffff', amt); }
  function darken(hex, amt) { return mix(hex, '#000000', amt); }
  // 依据猫色生成一套协调配色：base 主色 / light 高光 / dark 描边 / accent 点缀
  function petColors(pet) {
    const base = (pet && pet.color) || '#9aa7b5';
    return { base, light: lighten(base, 0.42), dark: darken(base, 0.34), accent: lighten(base, 0.72) };
  }

  // ---------- 品种差异化参数：让 17 只猫各有真实辨识度 ----------
  // ear 耳朵形状 / tail 尾巴形状 / eye 瞳色 / belly 肚皮色 / paw 爪色 / pattern 花纹
  const BREED = {
    cat:     { ear: 'pointy', tail: 'long',    eye: '#3aa06a', belly: '#ffe2bd', paw: '#f4a23b' },
    shiba:   { ear: 'pointy', tail: 'curl',    eye: '#3a7d5a', belly: '#e3eaf2', paw: '#9aa7b5' },
    bear:    { ear: 'pointy', tail: 'long',    eye: '#9fe07a', belly: '#3a3f48', paw: '#2b2f38' },
    bunny:   { ear: 'pointy', tail: 'short',   eye: '#5aa7ff', belly: '#ffffff', paw: '#eef1f5' },
    penguin: { ear: 'pointy', tail: 'short',   eye: '#2a2a2a', belly: '#ffffff', paw: '#ffffff', pattern: 'patch' },
    golden:  { ear: 'pointy', tail: 'fluffy',  eye: '#cf9a2e', belly: '#fff1d4', paw: '#e8b563' },
    silver:  { ear: 'pointy', tail: 'fluffy',  eye: '#6f8fb0', belly: '#eef2f7', paw: '#c3ccd6' },
    american:{ ear: 'pointy', tail: 'long',    eye: '#3a7d5a', belly: '#e8edf2', paw: '#b9bfc9', pattern: 'tabby' },
    ragdoll: { ear: 'pointy', tail: 'fluffy',  eye: '#4a90e2', belly: '#ffffff', paw: '#efe9f2' },
    beerus:  { ear: 'pointy', tail: 'long',    eye: '#ffd24a', belly: '#c3b2e6', paw: '#7b5bd6', pattern: 'patch' },
    pink:    { ear: 'round',  tail: 'fluffy',  eye: '#ff7eb6', belly: '#fff0f6', paw: '#ff9ecb' },
    maine:   { ear: 'pointy', tail: 'long',    eye: '#ffcf5c', belly: '#ecd6bd', paw: '#a9763f', pattern: 'tabby' },
    persian: { ear: 'round',  tail: 'fluffy',  eye: '#7a5a3a', belly: '#ffffff', paw: '#f0e2cf' },
    fox:     { ear: 'pointy', tail: 'fluffy',  eye: '#ff9a4d', belly: '#ffffff', paw: '#ff9a4d' },
    dino:    { ear: 'pointy', tail: 'long',    eye: '#ff5a3c', belly: '#d4efce', paw: '#6fcf6f' },
    lucky:   { ear: 'pointy', tail: 'curl',    eye: '#caa94a', belly: '#fff3d0', paw: '#d9a441' },
    astro:   { ear: 'round',  tail: 'fluffy',  eye: '#7fd4ff', belly: '#eef6ff', paw: '#cfe0f5' },
  };
  // 新增向量猫品种（用于 svg:true 宠物）
  Object.assign(BREED, {
    munch:   { ear: 'pointy', tail: 'long',    eye: '#9fe07a', belly: '#3a3f48', paw: '#2b2f38', pattern: 'patch' },
    sphi:    { ear: 'pointy', tail: 'short',   eye: '#ffb0c8', belly: '#f3e3d6', paw: '#e7c9b0' },
    norwe:   { ear: 'pointy', tail: 'long',    eye: '#3a7d5a', belly: '#d8c9a8', paw: '#9a6b3f', pattern: 'tabby' },
    scott:   { ear: 'round',  tail: 'fluffy',  eye: '#6f8fb0', belly: '#eef2f7', paw: '#b9bdc6' },
    beng:    { ear: 'pointy', tail: 'long',    eye: '#caa94a', belly: '#ffe9c4', paw: '#d9a441', pattern: 'tabby' },
    siam:    { ear: 'pointy', tail: 'long',    eye: '#4a90e2', belly: '#fff3e0', paw: '#e8d8c0', pattern: 'patch' },
    kami:    { ear: 'pointy', tail: 'fluffy',  eye: '#ffd24a', belly: '#fff3c4', paw: '#ffd24a', pattern: 'patch' },
  });
  // 新增第三批品种（用于 svg:true 宠物，矢量造型，零素材成本）
  Object.assign(BREED, {
    russian: { ear: 'pointy', tail: 'long',    eye: '#3aa06a', belly: '#e3eaf2', paw: '#9aa7b5' },
    abyss:   { ear: 'pointy', tail: 'long',    eye: '#cf9a2e', belly: '#fff1d4', paw: '#e8b563', pattern: 'tabby' },
    birman:  { ear: 'pointy', tail: 'fluffy',  eye: '#4a90e2', belly: '#ffffff', paw: '#efe9f2' },
    turkish: { ear: 'pointy', tail: 'long',    eye: '#5aa7ff', belly: '#ffffff', paw: '#eef1f5' },
    exotic:  { ear: 'round',  tail: 'fluffy',  eye: '#7a5a3a', belly: '#ffffff', paw: '#f0e2cf' },
    cali:    { ear: 'pointy', tail: 'long',    eye: '#3a7d5a', belly: '#e8edf2', paw: '#b9bfc9', pattern: 'tabby' },
  });

  // ---------- 组装一只可拆分的「活体矢量猫」 ----------
  // 头 / 耳 / 眼 / 身体 / 尾巴 / 爪 均为独立 <g>，可在 CSS 中各自做呼吸/摆尾/眨眼/挥爪，彻底告别「塑料手办感」
  function buildCatSVG(pet) {
    const br = BREED[pet.id] || {};
    const base = (pet && pet.color) || '#9aa7b5';
    const c = petColors(pet);
    const outline = c.dark;
    const ear = br.ear || 'pointy';
    const tail = br.tail || 'long';
    const eye = br.eye || '#3a3a3a';
    const belly = (br.belly !== undefined) ? br.belly : lighten(base, 0.5);
    const paw = (br.paw !== undefined) ? br.paw : base;
    const pat = br.pattern || null;

    // 耳朵
    let ears;
    if (ear === 'round') {
      ears = `
        <g class="cat-ears">
          <circle class="cat-ear-l" cx="33" cy="13" r="9.5" fill="${base}" stroke="${outline}" stroke-width="1.6"/>
          <circle cx="33" cy="14" r="4.6" fill="#ff9bb0"/>
          <circle class="cat-ear-r" cx="67" cy="13" r="9.5" fill="${base}" stroke="${outline}" stroke-width="1.6"/>
          <circle cx="67" cy="14" r="4.6" fill="#ff9bb0"/>
        </g>`;
    } else {
      ears = `
        <g class="cat-ears">
          <path class="cat-ear-l" d="M34 21 L22 1 L48 13 Z" fill="${base}" stroke="${outline}" stroke-width="1.6" stroke-linejoin="round"/>
          <path d="M35 18 L27 6 L45 13 Z" fill="#ff9bb0"/>
          <path class="cat-ear-r" d="M66 21 L78 1 L52 13 Z" fill="${base}" stroke="${outline}" stroke-width="1.6" stroke-linejoin="round"/>
          <path d="M65 18 L73 6 L55 13 Z" fill="#ff9bb0"/>
        </g>`;
    }

    // 尾巴（base 在左下，向斜上翘起）
    const tw = (tail === 'fluffy') ? 9 : (tail === 'short') ? 6 : 7;
    let tailPaths;
    if (tail === 'curl') {
      tailPaths = `<path d="M66 84 Q93 92 84 68 Q80 52 93 49" fill="none" stroke="${outline}" stroke-width="${tw + 2}" stroke-linecap="round"/>
        <path d="M66 84 Q93 92 84 68 Q80 52 93 49" fill="none" stroke="${base}" stroke-width="${tw}" stroke-linecap="round"/>`;
    } else if (tail === 'short') {
      tailPaths = `<path d="M64 86 Q81 90 83 76" fill="none" stroke="${outline}" stroke-width="${tw + 2}" stroke-linecap="round"/>
        <path d="M64 86 Q81 90 83 76" fill="none" stroke="${base}" stroke-width="${tw}" stroke-linecap="round"/>`;
    } else if (tail === 'fluffy') {
      tailPaths = `<path d="M66 84 Q89 80 88 56" fill="none" stroke="${outline}" stroke-width="${tw + 2}" stroke-linecap="round"/>
        <path d="M66 84 Q89 80 88 56" fill="none" stroke="${base}" stroke-width="${tw}" stroke-linecap="round"/>
        <circle cx="88" cy="54" r="${tw / 2 + 2.5}" fill="${base}" stroke="${outline}" stroke-width="1.4"/>`;
    } else { // long
      tailPaths = `<path d="M67 84 Q91 82 90 53" fill="none" stroke="${outline}" stroke-width="${tw + 2}" stroke-linecap="round"/>
        <path d="M67 84 Q91 82 90 53" fill="none" stroke="${base}" stroke-width="${tw}" stroke-linecap="round"/>`;
    }

    // 花纹
    let pattern = '';
    if (pat === 'tabby') {
      pattern = `
        <path d="M44 22 l3 7 M50 21 l0 8 M56 22 l-3 7" stroke="${outline}" stroke-width="1.6" stroke-linecap="round" opacity="0.55" fill="none"/>
        <path d="M38 70 q4 6 0 12 M50 72 q4 6 0 12 M62 70 q4 6 0 12" stroke="${outline}" stroke-width="1.6" stroke-linecap="round" opacity="0.4" fill="none"/>`;
    } else if (pat === 'patch') {
      pattern = `<path d="M50 54 q22 2 21 22 q-2 16 -22 18 q6 -22 1 -40 z" fill="${lighten(base, 0.4)}" opacity="0.85"/>
        <ellipse cx="62" cy="40" rx="9" ry="8" fill="${lighten(base, 0.4)}" opacity="0.7"/>`;
    }

    // 身体
    const body = `
      <g class="cat-body">
        <ellipse cx="50" cy="74" rx="23" ry="20" fill="${base}" stroke="${outline}" stroke-width="1.6"/>
        ${pattern}
        <ellipse cx="50" cy="80" rx="14" ry="12" fill="${belly}"/>
        <ellipse cx="43" cy="58" rx="10" ry="7" fill="${lighten(base, 0.2)}" opacity="0.5"/>
        <ellipse class="cat-paw-l" cx="41" cy="92" rx="5.2" ry="4" fill="${paw}" stroke="${outline}" stroke-width="1.2"/>
        <ellipse class="cat-paw-r" cx="59" cy="92" rx="5.2" ry="4" fill="${paw}" stroke="${outline}" stroke-width="1.2"/>
      </g>`;

    // 头 + 五官
    const head = `
      <g class="cat-head">
        ${ears}
        <circle cx="50" cy="33" r="21" fill="${base}" stroke="${outline}" stroke-width="1.6"/>
        <ellipse cx="43" cy="25" rx="9" ry="7" fill="${lighten(base, 0.24)}" opacity="0.5"/>
        <g class="cat-face">
          <g class="cat-eyes">
            <ellipse cx="41" cy="43" rx="6" ry="7" fill="#fff" stroke="${outline}" stroke-width="0.6"/>
            <ellipse cx="59" cy="43" rx="6" ry="7" fill="#fff" stroke="${outline}" stroke-width="0.6"/>
            <circle cx="42" cy="44" r="4.4" fill="${eye}"/>
            <circle cx="58" cy="44" r="4.4" fill="${eye}"/>
            <circle cx="40.4" cy="41.6" r="1.7" fill="#fff"/>
            <circle cx="56.4" cy="41.6" r="1.7" fill="#fff"/>
            <circle cx="43.6" cy="46" r="0.9" fill="#fff" opacity="0.7"/>
            <circle cx="59.6" cy="46" r="0.9" fill="#fff" opacity="0.7"/>
          </g>
          <path d="M50 49 l-3.2 3.2 h6.4 z" fill="#ff8fae"/>
          <path d="M50 52.5 q-4.5 4 -9 1 M50 52.5 q4.5 4 9 1" fill="none" stroke="${outline}" stroke-width="1.3" stroke-linecap="round"/>
          <g class="cat-whiskers" stroke="${lighten(outline, 0.45)}" stroke-width="0.8" opacity="0.7" stroke-linecap="round">
            <path d="M34 46 L19 43 M34 49 L19 50 M34 52 L20 57"/>
            <path d="M66 46 L81 43 M66 49 L81 50 M66 52 L80 57"/>
          </g>
        </g>
      </g>`;

    return `<svg class="pet-cat cat-${pet.id}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <g class="cat-tail">${tailPaths}</g>
      ${body}
      ${head}
    </svg>`;
  }

  // ---------- 服装叠加层（纯 SVG，叠在真实猫咪图片之上） ----------
  // 所有服装均按猫咪毛色着色（t = petColors），让装扮与猫咪融为一体、不再撞色
  const COSTUME_ART = {
    // 酷墨镜（猫脸弧度贴合：圆角镜框 + 鼻桥 + 猫色高光镜片）
    glasses: (t) => { const d = (t && t.dark) || '#1b1b1b', gl = (t && t.light) || '#6a6a78'; return { behind: false, svg: `
<rect x="28" y="40" width="19" height="12" rx="6" fill="${d}"/>
<rect x="53" y="40" width="19" height="12" rx="6" fill="${d}"/>
<path d="M47 44 Q50 42 53 44" stroke="${d}" stroke-width="2.2" fill="none" stroke-linecap="round"/>
<rect x="30" y="42" width="7" height="4" rx="2" fill="${gl}" opacity="0.85"/>
<rect x="55" y="42" width="7" height="4" rx="2" fill="${gl}" opacity="0.85"/>
<path d="M27 43 Q26 47 28 49" stroke="${d}" stroke-width="1.5" fill="none" stroke-linecap="round" opacity="0.6"/>
<path d="M73 43 Q74 47 72 49" stroke="${d}" stroke-width="1.5" fill="none" stroke-linecap="round" opacity="0.6"/>` }; },
    // 小皇冠（更小更贴合猫头，底部有软垫 + 宝石）
    crown: (t) => { const b = (t && t.base) || '#ffce3a', d = (t && t.dark) || '#e0a800', l = (t && t.light) || '#fff0b0'; return { behind: false, svg: `
<path d="M34 20 L31 9 L40 16 L50 7 L60 16 L69 9 L66 20 Z" fill="${b}" stroke="${d}" stroke-width="1.2" stroke-linejoin="round"/>
<circle cx="50" cy="11" r="1.8" fill="${l}"/>
<circle cx="37" cy="15" r="1.4" fill="${l}"/>
<circle cx="63" cy="15" r="1.4" fill="${l}"/>
<rect x="34" y="19" width="32" height="4" rx="2" fill="${b}" stroke="${d}" stroke-width="0.8"/>
<ellipse cx="50" cy="22" rx="16" ry="3" fill="${d}" opacity="0.25"/>` }; },
    // 蝴蝶结（加褶皱与阴影，更像系在猫耳间）
    bow: (t) => { const b = (t && t.base) || '#ff7eb6', l = (t && t.light) || '#ff9ecb', d = (t && t.dark) || '#e84f93'; return { behind: false, svg: `
<path d="M50 14 C41 6 30 8 33 16 C36 22 46 19 50 14 Z" fill="${b}"/>
<path d="M50 14 C59 6 70 8 67 16 C64 22 54 19 50 14 Z" fill="${b}"/>
<path d="M50 14 C41 6 30 8 33 16 C36 22 46 19 50 14 Z" fill="none" stroke="${l}" stroke-width="0.7"/>
<path d="M50 14 C59 6 70 8 67 16 C64 22 54 19 50 14 Z" fill="none" stroke="${l}" stroke-width="0.7"/>
<rect x="45" y="10" width="10" height="8" rx="3" fill="${d}"/>
<path d="M36 13 Q38 15 36 17" stroke="${d}" stroke-width="0.8" fill="none" opacity="0.5"/>
<path d="M64 13 Q62 15 64 17" stroke="${d}" stroke-width="0.8" fill="none" opacity="0.5"/>` }; },
    // 花环（猫色花瓣 + 花蕊）
    flower: (t) => { const b = (t && t.base) || '#ffd1e8', l = (t && t.light) || '#ffe6f2'; return { behind: false, svg: `
<g><circle cx="34" cy="18" r="3.2" fill="${b}"/><circle cx="34" cy="18" r="1.6" fill="#fff36b"/></g>
<g><circle cx="44" cy="9" r="3.2" fill="${b}"/><circle cx="44" cy="9" r="1.6" fill="#fff36b"/></g>
<g><circle cx="56" cy="9" r="3.2" fill="${b}"/><circle cx="56" cy="9" r="1.6" fill="#fff36b"/></g>
<g><circle cx="66" cy="18" r="3.2" fill="${b}"/><circle cx="66" cy="18" r="1.6" fill="#fff36b"/></g>
<g><circle cx="50" cy="5" r="3.2" fill="${l}"/><circle cx="50" cy="5" r="1.6" fill="#fff36b"/></g>` }; },
    // 天使光环（猫色光环）
    halo: (t) => { const b = (t && t.base) || '#ffe27a'; return { behind: false, svg: `
<ellipse cx="50" cy="8" rx="15" ry="4.5" fill="none" stroke="${b}" stroke-width="3" opacity="0.95" style="filter:drop-shadow(0 0 4px ${b})"/>` }; },
    // 围巾（环绕脖子 + 下垂末端 + 针织纹理）
    scarf: (t) => { const b = (t && t.base) || '#e23b3b', l = (t && t.light) || '#ff8a8a'; return { behind: false, svg: `
<path d="M32 61 Q50 72 68 61 L69 66 Q50 78 31 66 Z" fill="${b}"/>
<path d="M34 63 Q50 72 66 63" stroke="${l}" stroke-width="1.5" fill="none" opacity="0.7"/>
<path d="M58 68 L66 85 L60 87 L53 70 Z" fill="${b}"/>
<path d="M58 68 L66 85 L60 87 L53 70 Z" fill="none" stroke="${l}" stroke-width="0.8" opacity="0.6"/>
<line x1="57" y1="73" x2="63" y2="74" stroke="${l}" stroke-width="0.7" opacity="0.5"/>
<line x1="59" y1="78" x2="64" y2="79" stroke="${l}" stroke-width="0.7" opacity="0.5"/>
<line x1="61" y1="82" x2="65" y2="83" stroke="${l}" stroke-width="0.7" opacity="0.5"/>` }; },
    // 小毛衣（加圆领、袖口、下摆，更像真实针织）
    sweater: (t) => { const b = (t && t.base) || '#6fc6e6'; return { behind: false, svg: `
<path d="M35 55 Q50 50 65 55 L67 87 Q50 92 33 87 Z" fill="${b}"/>
<ellipse cx="50" cy="55" rx="15" ry="4" fill="#ffffff" opacity="0.9"/>
<path d="M35 55 Q50 61 65 55" fill="none" stroke="#ffffff" stroke-width="2.2"/>
<path d="M32 57 L25 70 L30 73 L36 60 Z" fill="${b}"/>
<path d="M68 57 L75 70 L70 73 L64 60 Z" fill="${b}"/>
<ellipse cx="28" cy="71" rx="4" ry="3" fill="#ffffff" opacity="0.85"/>
<ellipse cx="72" cy="71" rx="4" ry="3" fill="#ffffff" opacity="0.85"/>
<path d="M33 85 Q50 90 67 85" fill="none" stroke="#ffffff" stroke-width="1.8" opacity="0.8"/>
<circle cx="50" cy="70" r="2.6" fill="#ffffff"/>` }; },
    // 超人披风（加领口与飘动感，更像系在脖子上）
    cape: (t) => { const b = (t && t.base) || '#e23b3b', l = (t && t.light) || '#ff8a8a', d = (t && t.dark) || '#b01e1e'; return { behind: true, svg: `
<path d="M30 58 Q50 52 70 58 Q82 70 78 96 Q50 88 22 96 Q18 70 30 58 Z" fill="${b}"/>
<path d="M30 58 Q50 54 70 58 Q78 68 74 90 Q50 84 26 90 Q22 68 30 58 Z" fill="${l}" opacity="0.55"/>
<path d="M30 58 Q50 54 70 58 Q50 62 30 58" fill="${d}"/>
<path d="M74 62 Q78 75 76 88" stroke="${l}" stroke-width="1" fill="none" opacity="0.7"/>` }; },
    // 骑士盔甲（金属高光 + 肩甲 + 护心宝石，更有穿戴感）
    armor: (t) => { const gem = (t && t.base) || '#5b8def'; return { behind: false, svg: `
<defs><linearGradient id="armorShine" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#eef2f7"/><stop offset="50%" stop-color="#cfd8e3"/><stop offset="100%" stop-color="#a8b4c4"/></linearGradient></defs>
<path d="M33 54 Q50 49 67 54 L65 88 Q50 92 35 88 Z" fill="url(#armorShine)" stroke="#8a96a8" stroke-width="1.2"/>
<circle cx="32" cy="56" r="7" fill="url(#armorShine)" stroke="#8a96a8" stroke-width="1.2"/>
<circle cx="68" cy="56" r="7" fill="url(#armorShine)" stroke="#8a96a8" stroke-width="1.2"/>
<path d="M50 59 L46 77 L54 77 Z" fill="#b9c4d2" stroke="#8a96a8" stroke-width="1"/>
<circle cx="50" cy="72" r="3.5" fill="${gem}" stroke="#ffffff" stroke-width="0.8"/>
<path d="M34 54 Q50 50 66 54" stroke="#ffffff" stroke-width="1" fill="none" opacity="0.5"/>
<path d="M36 62 Q50 66 64 62" stroke="#8a96a8" stroke-width="0.8" fill="none" opacity="0.5"/>` }; },
  };

  // 新增服饰款式（合并进 COSTUME_ART）
  Object.assign(COSTUME_ART, {
    hat: (t) => { const b = (t && t.base) || '#3a3f4a', l = (t && t.light) || '#6a6f78', d = (t && t.dark) || '#222'; return { behind: false, svg: `
<ellipse cx="50" cy="20" rx="16" ry="3.5" fill="${d}"/>
<path d="M38 20 Q40 4 62 4 Q62 20 62 20 L38 20 Z" fill="${b}" stroke="${d}" stroke-width="1.2"/>
<rect x="44" y="11" width="12" height="4" rx="2" fill="${l}"/>` }; },
    scarf2: (t) => { const b = (t && t.base) || '#7fd4ff', l = (t && t.light) || '#bfeaff'; return { behind: false, svg: `
<path d="M30 60 Q50 70 70 60 Q72 66 68 70 Q50 80 32 70 Q28 66 30 60 Z" fill="${b}"/>
<circle cx="34" cy="63" r="4" fill="${l}"/><circle cx="44" cy="66" r="4" fill="${l}"/><circle cx="56" cy="66" r="4" fill="${l}"/><circle cx="66" cy="63" r="4" fill="${l}"/>
<path d="M56 68 Q62 82 58 90 Q54 84 52 70 Z" fill="${b}"/>` }; },
    belt: (t) => { const b = (t && t.base) || '#caa94a', l = (t && t.light) || '#ffe9a8', d = (t && t.dark) || '#a07e1e'; return { behind: false, svg: `
<path d="M30 74 Q50 82 70 74 L69 80 Q50 88 31 80 Z" fill="${d}"/>
<rect x="45" y="73" width="10" height="9" rx="2" fill="${b}" stroke="${l}" stroke-width="1"/>
<circle cx="50" cy="77.5" r="1.6" fill="${l}"/>` }; },
    wing: (t) => { const b = (t && t.base) || '#ffffff', l = (t && t.light) || '#eaf2ff', d = (t && t.dark) || '#c3ccd6'; return { behind: true, svg: `
<path d="M30 58 Q12 48 14 66 Q22 64 30 70 Q24 60 30 58 Z" fill="${b}" stroke="${d}" stroke-width="1"/>
<path d="M70 58 Q88 48 86 66 Q78 64 70 70 Q76 60 70 58 Z" fill="${b}" stroke="${d}" stroke-width="1"/>
<path d="M30 58 Q12 48 14 66" fill="none" stroke="${l}" stroke-width="0.8" opacity="0.7"/>
<path d="M70 58 Q88 48 86 66" fill="none" stroke="${l}" stroke-width="0.8" opacity="0.7"/>` }; },
    bell: (t) => { const b = (t && t.base) || '#ffce3a', d = (t && t.dark) || '#e0a800', l = (t && t.light) || '#fff0b0'; return { behind: false, svg: `
<path d="M32 58 Q50 66 68 58" stroke="${d}" stroke-width="3" fill="none" stroke-linecap="round"/>
<circle cx="50" cy="64" r="5" fill="${b}" stroke="${d}" stroke-width="1"/>
<path d="M47 64 h6" stroke="${d}" stroke-width="1"/>
<circle cx="50" cy="61" r="1.4" fill="${l}"/>` }; },
    mask: (t) => { const b = (t && t.base) || '#3a3f4a', l = (t && t.light) || '#6a6f78'; return { behind: false, svg: `
<path d="M30 42 Q50 38 70 42 Q70 48 50 49 Q30 48 30 42 Z" fill="${b}"/>
<circle cx="41" cy="44" r="6" fill="${l}" opacity="0.9"/><circle cx="59" cy="44" r="6" fill="${l}" opacity="0.9"/>
<path d="M30 44 Q24 44 20 48" stroke="${b}" stroke-width="2" fill="none"/>` }; },
  });
  // 第三批服饰（继续扩充装扮库，全部 SVG 叠加，按猫色着色）
  Object.assign(COSTUME_ART, {
    tiara: (t) => { const b = (t && t.base) || '#bfeaff', d = (t && t.dark) || '#7fd4ff'; return { behind: false, svg: `
<path d="M36 18 L38 8 L44 14 L50 6 L56 14 L62 8 L64 18 Z" fill="${b}" stroke="${d}" stroke-width="1" stroke-linejoin="round"/>
<circle cx="50" cy="11" r="2" fill="#ffffff"/>
<circle cx="42" cy="15" r="1.6" fill="#ffffff"/>
<circle cx="58" cy="15" r="1.6" fill="#ffffff"/>
<rect x="36" y="17" width="28" height="3.5" rx="1.8" fill="${b}" stroke="${d}" stroke-width="0.6"/>` }; },
    horn: (t) => { const b = (t && t.base) || '#c0392b', d = (t && t.dark) || '#922b21'; return { behind: false, svg: `
<path d="M38 16 Q34 4 42 8 Q40 14 45 16 Z" fill="${b}" stroke="${d}" stroke-width="1" stroke-linejoin="round"/>
<path d="M62 16 Q66 4 58 8 Q60 14 55 16 Z" fill="${b}" stroke="${d}" stroke-width="1" stroke-linejoin="round"/>` }; },
    roundglasses: (t) => { const d = (t && t.dark) || '#2b2f38', gl = (t && t.light) || '#9fa8b5'; return { behind: false, svg: `
<circle cx="41" cy="43" r="8" fill="none" stroke="${d}" stroke-width="2.4"/>
<circle cx="59" cy="43" r="8" fill="none" stroke="${d}" stroke-width="2.4"/>
<path d="M49 43 Q50 41 51 43" stroke="${d}" stroke-width="2" fill="none"/>
<circle cx="39" cy="41" r="2" fill="${gl}" opacity="0.6"/>
<circle cx="57" cy="41" r="2" fill="${gl}" opacity="0.6"/>` }; },
    beret: (t) => { const b = (t && t.base) || '#4a505c', d = (t && t.dark) || '#2b2f38'; return { behind: false, svg: `
<ellipse cx="50" cy="16" rx="17" ry="8" fill="${b}"/>
<ellipse cx="50" cy="14" rx="17" ry="7" fill="${d}"/>
<circle cx="50" cy="9" r="1.6" fill="#1b1b1b"/>
<path d="M33 16 Q50 22 67 16" stroke="#1b1b1b" stroke-width="1" fill="none" opacity="0.5"/>` }; },
    ribbon: (t) => { const b = (t && t.base) || '#ff7eb6', d = (t && t.dark) || '#e84f93'; return { behind: false, svg: `
<path d="M50 6 C44 0 36 2 39 9 C42 14 48 11 50 7 Z" fill="${b}"/>
<path d="M50 6 C56 0 64 2 61 9 C58 14 52 11 50 7 Z" fill="${b}"/>
<circle cx="50" cy="8" r="2" fill="${d}"/>` }; },
    gemcollar: (t) => { const b = (t && t.base) || '#caa94a', l = (t && t.light) || '#ffe9a8', d = (t && t.dark) || '#a07e1e'; return { behind: false, svg: `
<path d="M34 60 Q50 67 66 60" stroke="${d}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
<circle cx="50" cy="64" r="3.4" fill="${b}" stroke="${l}" stroke-width="0.8"/>` }; },
    tshirt: (t) => { const b = (t && t.base) || '#ff9ecb', l = (t && t.light) || '#ffd6e6'; return { behind: false, svg: `
<path d="M36 55 Q50 50 64 55 L66 87 Q50 92 34 87 Z" fill="${b}"/>
<ellipse cx="50" cy="55" rx="14" ry="3.5" fill="#ffffff" opacity="0.85"/>
<path d="M36 55 Q50 60 64 55" stroke="${l}" stroke-width="1.8" fill="none"/>` }; },
    hoodie: (t) => { const b = (t && t.base) || '#6a6f78', d = (t && t.dark) || '#565b64', l = (t && t.light) || '#7a7f88'; return { behind: false, svg: `
<path d="M40 55 Q50 45 60 55 Q50 52 40 55" fill="${l}"/>
<path d="M36 55 Q50 50 64 55 L67 88 Q50 93 33 88 Z" fill="${b}"/>
<rect x="40" y="70" width="20" height="11" rx="3" fill="${d}"/>
<path d="M36 55 Q50 60 64 55" stroke="${d}" stroke-width="1.5" fill="none"/>` }; },
    dress: (t) => { const b = (t && t.base) || '#ffd1e8', d = (t && t.dark) || '#ff7eb6'; return { behind: false, svg: `
<path d="M42 55 Q50 52 58 55 L66 88 Q50 94 34 88 Z" fill="${b}"/>
<path d="M42 55 Q50 58 58 55" stroke="${d}" stroke-width="1.5" fill="none"/>
<circle cx="50" cy="64" r="2" fill="${d}"/>
<circle cx="44" cy="74" r="1.6" fill="${d}"/><circle cx="56" cy="74" r="1.6" fill="${d}"/>` }; },
    wizard: (t) => { const b = (t && t.base) || '#4a2f73', l = (t && t.light) || '#6a4aa0', g = '#ffce3a'; return { behind: true, svg: `
<path d="M28 56 Q50 50 72 56 Q84 74 78 96 Q50 88 22 96 Q16 74 28 56 Z" fill="${b}"/>
<path d="M28 56 Q50 52 72 56 Q50 62 28 56" fill="${l}" opacity="0.5"/>
<circle cx="50" cy="66" r="3" fill="${g}"/>` }; },
    angelwing: (t) => { const b = (t && t.base) || '#ffffff', d = (t && t.dark) || '#c3ccd6'; return { behind: true, svg: `
<path d="M30 58 Q10 44 16 66 Q26 62 32 70 Q24 58 30 58 Z" fill="${b}" stroke="${d}" stroke-width="1"/>
<path d="M70 58 Q90 44 84 66 Q74 62 68 70 Q76 58 70 58 Z" fill="${b}" stroke="${d}" stroke-width="1"/>` }; },
  });

  // ---------- 环绕光效（特效款）：轻盈粒子流 + 脚底光环 ----------
  // style='particle'：花瓣 / 火星 / 爱心 从脚下向上飘（dir=rise）；雪花 / 星尘 / 冰晶 从头顶向下落（dir=fall）；双向飞舞（dir=mix）
  // style='ground'：脚底椭圆光环 + 向上扩散波纹，视觉重心在猫咪脚下，像 MOBA 游戏里的脚下光环
  // color 主色 / color2 辅助渐变 / glow 发光色 / count 粒子数 / speed 动画速度 / size 粒子大小 / shape 粒子形状 / intense 加强 / rainbow 彩虹
  // shape: petal(花瓣) snow(雪) heart(心) star(星) ember(火星) leaf(叶) coin(金币) bubble(泡) spark(星火)
  const AURA_ART = {
    // --- 粒子流 ---
    star:    { color: '#ffcf5c', color2: '#fff3c4', glow: '#ffb020', shape: 'star',  dir: 'fall', count: 11, speed: 6, size: 7, style: 'particle' },
    fire:    { color: '#ff7a3c', color2: '#ffd27a', glow: '#ff4326', shape: 'ember', dir: 'rise', count: 11, speed: 5, size: 7,  intense: true, style: 'particle' },
    ice:     { color: '#9fe3ff', color2: '#eafcff', glow: '#2bb7ff', shape: 'snow',  dir: 'fall', count: 12, speed: 7, size: 7, style: 'particle' },
    heart:   { color: '#ff5b9e', color2: '#ffd9ec', glow: '#ff5b9e', shape: 'heart', dir: 'rise', count: 9,  speed: 6, size: 8, style: 'particle' },
    coin:    { color: '#e0a800', color2: '#fff3c4', glow: '#e0a800', shape: 'coin',  dir: 'rise', count: 9,  speed: 5, size: 8, style: 'particle' },
    rainbow: { color: '#9ed8ff', color2: '#ffd6f0', glow: '#7b5bff', shape: 'spark', dir: 'mix',  count: 13, speed: 6, size: 7, rainbow: true, style: 'particle' },
    galaxy:  { color: '#b6e3ff', color2: '#e6d8ff', glow: '#7b5bff', shape: 'spark', dir: 'fall', count: 14, speed: 6, size: 7, intense: true, style: 'particle' },
    emerald: { color: '#19b36b', color2: '#e2fff0', glow: '#19b36b', shape: 'leaf',  dir: 'rise', count: 11, speed: 6, size: 8, style: 'particle' },
    ruby:    { color: '#ff1f4f', color2: '#ffd6df', glow: '#ff1f4f', shape: 'ember', dir: 'rise', count: 12, speed: 5, size: 7, intense: true, style: 'particle' },
    aurora:  { color: '#27d6a3', color2: '#c9f0ff', glow: '#27d6a3', shape: 'leaf',  dir: 'rise', count: 12, speed: 6, size: 8, style: 'particle' },
    sun:     { color: '#ff9d00', color2: '#fff4cf', glow: '#ff9d00', shape: 'star',  dir: 'rise', count: 12, speed: 5, size: 8, intense: true, style: 'particle' },
    moon:    { color: '#aab8ff', color2: '#ffffff', glow: '#8aa6ff', shape: 'snow',  dir: 'fall', count: 10, speed: 7, size: 7, style: 'particle' },
    ocean:   { color: '#1f9bff', color2: '#d9f2ff', glow: '#1f9bff', shape: 'bubble',dir: 'rise', count: 11, speed: 6, size: 8, style: 'particle' },
    crystal: { color: '#19c6ff', color2: '#e6ffff', glow: '#19c6ff', shape: 'snow',  dir: 'fall', count: 12, speed: 6, size: 7, intense: true, style: 'particle' },
    phoenix: { color: '#ff5a1f', color2: '#ffe0b0', glow: '#ff5a1f', shape: 'ember', dir: 'rise', count: 12, speed: 5, size: 7, intense: true, style: 'particle' },
    sakura:  { color: '#ff6fae', color2: '#ffe6f2', glow: '#ff6fae', shape: 'petal', dir: 'rise', count: 12, speed: 6, size: 9, style: 'particle' },
    // --- 脚底光环（扩散波纹） ---
    holy:      { color: '#ffdf7a', color2: '#fff9e6', glow: '#ffce3a', style: 'ground', count: 3, speed: 2.2, size: 11, intense: true },
    inferno:   { color: '#ff5a2a', color2: '#ffd27a', glow: '#ff4326', style: 'ground', count: 3, speed: 1.9, size: 12, intense: true },
    voidring:  { color: '#8b5bff', color2: '#e6d8ff', glow: '#7b5bff', style: 'ground', count: 4, speed: 2.4, size: 11, intense: true },
    frostring: { color: '#7fe3ff', color2: '#eafcff', glow: '#2bb7ff', style: 'ground', count: 4, speed: 2.6, size: 11 },
    stardust:  { color: '#7bc8ff', color2: '#e6f0ff', glow: '#5b8def', style: 'ground', count: 3, speed: 2.3, size: 10 },
    nature:    { color: '#2fd6a0', color2: '#e2fff0', glow: '#19b36b', style: 'ground', count: 3, speed: 2.5, size: 11 },
    ripple:    { color: '#1f9bff', color2: '#d9f2ff', glow: '#1f9bff', style: 'ground', count: 4, speed: 2.8, size: 10 },
    shadow:    { color: '#6a6f78', color2: '#c3c8d0', glow: '#3a3f4a', style: 'ground', count: 3, speed: 2.2, size: 11, intense: true },
    lovepool:  { color: '#ff7eb6', color2: '#ffe6f2', glow: '#ff5b9e', style: 'ground', count: 3, speed: 2.4, size: 10 },
    techring:  { color: '#00eaff', color2: '#e6ffff', glow: '#00c6d6', style: 'ground', count: 4, speed: 2.0, size: 12, intense: true },
  };
  // 新增光效款式（合并进 AURA_ART，丰富选择性）
  Object.assign(AURA_ART, {
    bloom:    { color: '#ff9ecb', color2: '#ffe6f2', glow: '#ff6fae', shape: 'petal', dir: 'rise', count: 12, speed: 6, size: 9, style: 'particle' },
    thunder:  { color: '#ffe14d', color2: '#fff7c0', glow: '#ffd000', shape: 'spark', dir: 'mix',  count: 13, speed: 5, size: 7, intense: true, style: 'particle' },
    wind:     { color: '#bfe9ff', color2: '#eafcff', glow: '#7fd4ff', shape: 'leaf',  dir: 'mix',  count: 12, speed: 6, size: 8, style: 'particle' },
    rose:     { color: '#ff7aa8', color2: '#ffd9e6', glow: '#ff5b9e', shape: 'petal', dir: 'fall', count: 12, speed: 6, size: 9, style: 'particle' },
    goldrain: { color: '#ffcf3a', color2: '#fff3c4', glow: '#e0a800', shape: 'coin',  dir: 'fall', count: 10, speed: 5, size: 8, style: 'particle' },
    blizzard: { color: '#dff3ff', color2: '#ffffff', glow: '#9fe3ff', shape: 'snow',  dir: 'fall', count: 14, speed: 7, size: 8, intense: true, style: 'particle' },
    neon:     { color: '#ff5bd0', color2: '#ffffff', glow: '#ff5bd0', shape: 'spark', dir: 'mix',  count: 13, speed: 6, size: 7, rainbow: true, style: 'particle' },
    void:     { color: '#9b6bff', color2: '#e6d8ff', glow: '#7b5bff', shape: 'spark', dir: 'fall', count: 14, speed: 6, size: 7, intense: true, style: 'particle' },
    frost:    { color: '#aef0ff', color2: '#eafcff', glow: '#2bb7ff', shape: 'snow',  dir: 'fall', count: 12, speed: 7, size: 7, style: 'particle' },
    lava:     { color: '#ff5a2a', color2: '#ffd27a', glow: '#ff4326', shape: 'ember', dir: 'rise', count: 12, speed: 5, size: 7, intense: true, style: 'particle' },
    spirit:   { color: '#b9ffd8', color2: '#eaffe8', glow: '#27d6a3', shape: 'spark', dir: 'mix',  count: 12, speed: 6, size: 7, style: 'particle' },
    dream:    { color: '#c9b8ff', color2: '#efeaff', glow: '#9b8bff', shape: 'bubble',dir: 'rise', count: 11, speed: 6, size: 8, style: 'particle' },
    candy:    { color: '#ff9ecb', color2: '#ffe6f2', glow: '#ff5b9e', shape: 'heart', dir: 'rise', count: 9,  speed: 6, size: 8, style: 'particle' },
    jade:     { color: '#2fd6a0', color2: '#e2fff0', glow: '#19b36b', shape: 'leaf',  dir: 'rise', count: 11, speed: 6, size: 8, style: 'particle' },
    // 更多脚底光环
    sanctum:  { color: '#ffffff', color2: '#fff9e6', glow: '#ffce3a', style: 'ground', count: 3, speed: 2.6, size: 12, intense: true },
    blood:    { color: '#ff1f4f', color2: '#ffd6df', glow: '#d60030', style: 'ground', count: 3, speed: 2.0, size: 11, intense: true },
    poison:   { color: '#a3e600', color2: '#f0ffd8', glow: '#7fc600', style: 'ground', count: 4, speed: 2.3, size: 11 },
    oceanring:{ color: '#00bfff', color2: '#d9f2ff', glow: '#1f9bff', style: 'ground', count: 4, speed: 2.7, size: 10 },
  });
  // 第三批光效（继续扩充特效库：粒子流 + 脚底光环）
  Object.assign(AURA_ART, {
    meteor:  { color: '#9fe0ff', color2: '#eafcff', glow: '#5bc8ff', shape: 'star',  dir: 'rise', count: 10, speed: 5, size: 7, intense: true, style: 'particle' },
    cloud:   { color: '#dfe9f5', color2: '#ffffff', glow: '#aab8c8', shape: 'bubble',dir: 'fall', count: 10, speed: 7, size: 9, style: 'particle' },
    diamond: { color: '#bfeaff', color2: '#ffffff', glow: '#7fd4ff', shape: 'spark', dir: 'mix',  count: 13, speed: 6, size: 7, intense: true, style: 'particle' },
    tulip:   { color: '#ff8fb0', color2: '#ffe6f0', glow: '#ff5b9e', shape: 'petal', dir: 'fall', count: 11, speed: 6, size: 8, style: 'particle' },
    autumn:  { color: '#e08a2e', color2: '#ffe0b0', glow: '#d2701e', shape: 'leaf',  dir: 'mix',  count: 12, speed: 6, size: 8, style: 'particle' },
    foam:    { color: '#bfe9ff', color2: '#eafcff', glow: '#7fd4ff', shape: 'bubble',dir: 'rise', count: 11, speed: 6, size: 8, style: 'particle' },
    sparkgold:{ color: '#ffce3a', color2: '#fff3c4', glow: '#e0a800', shape: 'spark', dir: 'mix',  count: 13, speed: 5, size: 7, rainbow: true, style: 'particle' },
    ghost:   { color: '#cfd8e3', color2: '#ffffff', glow: '#aab8c8', shape: 'bubble',dir: 'mix',  count: 10, speed: 6, size: 8, style: 'particle' },
    // 脚底光环
    goldring:   { color: '#ffce3a', color2: '#fff3c4', glow: '#e0a800', style: 'ground', count: 3, speed: 2.4, size: 11, intense: true },
    emeraldring:{ color: '#19b36b', color2: '#e2fff0', glow: '#19b36b', style: 'ground', count: 3, speed: 2.5, size: 11 },
    roseground: { color: '#ff7aa8', color2: '#ffd9e6', glow: '#ff5b9e', style: 'ground', count: 3, speed: 2.4, size: 10 },
    pearl:      { color: '#e6ecf2', color2: '#ffffff', glow: '#c3ccd6', style: 'ground', count: 3, speed: 2.6, size: 11 },
    magmaring:  { color: '#ff5a2a', color2: '#ffd27a', glow: '#ff4326', style: 'ground', count: 4, speed: 2.0, size: 12, intense: true },
    frostground:{ color: '#aef0ff', color2: '#eafcff', glow: '#2bb7ff', style: 'ground', count: 4, speed: 2.7, size: 10 },
    crimson:    { color: '#ff1f4f', color2: '#ffd6df', glow: '#d60030', style: 'ground', count: 3, speed: 2.1, size: 11, intense: true },
  });
  const AURA_RAINBOW = ['#ff6f9c','#ffb15b','#ffe66b','#7be08a','#5bc8ff','#9b8bff','#d68bff'];
  // 组装光效：粒子流 或 脚底光环+扩散波纹
  // mini=true 时（商城缩略图 / 宠物预览）减少粒子数/波纹数，进一步降低开销
  // catColor 传入时（实际装备在猫身上），把光环颜色向猫咪毛色 blending，让光效映衬猫咪、融为一体
  function buildAuraSVG(id, mini, catColor) {
    const c = AURA_ART[id]; if (!c) return '';
    let col = c.color, col2 = c.color2, glow = c.glow;
    if (catColor && !c.rainbow) {
      const amt = 0.55; // 保留约一半光环自身个性，同时明显带上猫色
      glow = mix(c.glow, catColor, amt);
      col  = lighten(mix(c.color, catColor, amt), 0.10);
      col2 = lighten(mix(c.color2, catColor, amt), 0.38);
    }
    const rb = c.rainbow ? ' afx-rainbow' : '';
    const it = c.intense ? ' afx-intense' : '';
    const style = c.style || 'particle';

    if (style === 'ground') {
      const waves = mini ? Math.max(2, Math.round(c.count * 0.6)) : c.count;
      const dur = (c.speed || 2.2).toFixed(2);
      const sz = (c.size || 11).toFixed(1);
      let waveParts = '';
      for (let i = 0; i < waves; i++) {
        const delay = (-i * (c.speed || 2.2) / waves).toFixed(2);
        waveParts += '<i class="afx-wave" style="--dur:' + dur + 's;--delay:' + delay + 's;--i:' + i + '"></i>';
      }
      return '<div class="aura3d aura-ground aura-' + id + it + '" style="--c:' + col + ';--c2:' + col2 + ';--g:' + glow + ';--sz:' + sz + 'px;">'
        + '<div class="afx-ground-base"></div>'
        + '<div class="afx-ground-ring"></div>'
        + '<div class="afx-diffusion">' + waveParts + '</div>'
        + '</div>';
    }

    const n = mini ? Math.max(4, Math.round(c.count * 0.5)) : c.count;
    const sc = 'afx-' + (c.shape || 'petal');
    let parts = '';
    for (let i = 0; i < n; i++) {
      const left  = (8 + Math.random() * 84).toFixed(1);
      const dur   = (c.speed * (0.75 + Math.random() * 0.5)).toFixed(2);
      const delay = (-Math.random() * c.speed * 2).toFixed(2);
      const sz    = (c.size * (0.7 + Math.random() * 0.7)).toFixed(1);
      const drift = ((Math.random() * 2 - 1) * 18).toFixed(1);
      const rot   = (Math.random() * 360).toFixed(0);
      const dir   = c.dir === 'mix' ? (i % 2 ? 'fall' : 'rise') : c.dir;
      let extra = '';
      if (c.rainbow) { const colr = AURA_RAINBOW[i % AURA_RAINBOW.length]; extra = '--c:' + colr + ';--c2:#ffffff;'; }
      parts += '<i class="afx ' + sc + ' afx-' + dir + '" style="--x:' + left + '%;--dur:' + dur + 's;--delay:' + delay + 's;--sz:' + sz + 'px;--drift:' + drift + 'px;--rot:' + rot + 'deg;' + extra + '"></i>';
    }
    return '<div class="aura3d aura-' + id + rb + it + '" style="--c:' + col + ';--c2:' + col2 + ';--g:' + glow + '">'
      + '<div class="afx-glow"></div>' + parts + '</div>';
  }

  // ---------- 目录数据 ----------
  // color：每只猫的代表毛色（用于服装/光环配色协调，让装扮与猫咪融为一体）
  const PETS = [
    // 默认免费 5 只
    { id: 'cat',     name: '橘喵',   tag: 'default', price: 0,   effect: null,      color: '#f4a23b', defaultAction: 'act-jump',    desc: '元气满满的橘座小猫' },
    { id: 'shiba',   name: '英短',   tag: 'default', price: 0,   effect: null,      color: '#9aa7b5', defaultAction: 'act-roll',    desc: '蓝灰英短圆脸萌物' },
    { id: 'bear',    name: '黑猫',   tag: 'default', price: 0,   effect: null,      color: '#2b2f38', defaultAction: 'act-sit',     desc: '神秘黑猫绿眼睛' },
    { id: 'bunny',   name: '白猫',   tag: 'default', price: 0,   effect: null,      color: '#eef1f5', defaultAction: 'act-peek',    desc: '雪白蓝眼小天使' },
    { id: 'penguin', name: '三花',   tag: 'default', price: 0,   effect: null,      color: '#d8c9a8', defaultAction: 'act-spin',    desc: '三花斑纹小可爱' },
    // 真实品种（积分商城）—— 每只付费宠物拥有唯一签名光环（effect 直接是 aura id，自动环绕展示，绝不撞车）
    { id: 'golden',  name: '金渐层', tag: 'shop', price: 120, effect: 'sun',     color: '#e8b563', defaultAction: 'act-dance',   desc: '金色英短贵气满满' },
    { id: 'silver',  name: '银渐层', tag: 'shop', price: 130, effect: 'moon',    color: '#c3ccd6', defaultAction: 'act-wave',    desc: '银蓝渐层优雅高贵' },
    { id: 'american',name: '美短',   tag: 'shop', price: 140, effect: 'emerald', color: '#b9bfc9', defaultAction: 'act-prowl',   desc: '银虎斑美短活力' },
    { id: 'ragdoll', name: '布偶',   tag: 'shop', price: 200, effect: 'aurora',  color: '#e9d9c4', defaultAction: 'act-stretch', desc: '蓝眼布偶小仙女' },
    { id: 'beerus',  name: '比鲁斯', tag: 'shop', price: 360, effect: 'galaxy',  color: '#7b5bd6', defaultAction: 'act-float',   desc: '龙珠破坏神降临' },
    { id: 'pink',    name: '粉粉',   tag: 'shop', price: 160, effect: 'heart',   color: '#ff9ecb', defaultAction: 'act-heart',   desc: '软萌粉红小公主' },
    { id: 'maine',   name: '缅因',   tag: 'shop', price: 300, effect: 'ruby',    color: '#a9763f', defaultAction: 'act-roar',    desc: '巨型缅因超霸气' },
    { id: 'persian', name: '波斯',   tag: 'shop', price: 320, effect: 'sakura',  color: '#f0e2cf', defaultAction: 'act-sleep',   desc: '扁脸波斯小贵族' },
    // 创意主题（积分商城）
    { id: 'fox',     name: '星狐',   tag: 'shop', price: 120, effect: 'rainbow', color: '#ff9a4d', defaultAction: 'act-twirl',   desc: '星光环绕的灵狐' },
    { id: 'dino',    name: '小火龙', tag: 'shop', price: 180, effect: 'fire',    color: '#6fcf6f', defaultAction: 'act-fire',    desc: '会喷小火花' },
    { id: 'lucky',   name: '招财喵', tag: 'shop', price: 260, effect: 'coin',    color: '#d9a441', defaultAction: 'act-coin',    desc: '吐金币的招财猫' },
    { id: 'astro',   name: '太空喵', tag: 'shop', price: 360, effect: 'crystal', color: '#cfe0f5', defaultAction: 'act-fly',     desc: '戴宇航头盔的喵' },
  ];

  PETS.push(
    { id: 'munch', name: '孟买', tag: 'shop', price: 300, effect: 'galaxy', color: '#3a3f4a', defaultAction: 'act-prowl', desc: '黑曜石般神秘' },
    { id: 'sphi', name: '斯芬克斯', tag: 'shop', price: 340, effect: 'crystal', color: '#e7c9b0', defaultAction: 'act-sit', desc: '无毛也超萌' },
    { id: 'norwe', name: '森林猫', tag: 'shop', price: 320, effect: 'aurora', color: '#9a6b3f', defaultAction: 'act-stretch', desc: '威风长毛' },
    { id: 'scott', name: '折耳猫', tag: 'shop', price: 280, effect: 'moon', color: '#b9bdc6', defaultAction: 'act-peek', desc: '软萌小折耳' },
    { id: 'beng', name: '豹猫', tag: 'shop', price: 360, effect: 'fire', color: '#d9a441', defaultAction: 'act-prowl', desc: '野性豹纹' },
    { id: 'siam', name: '暹罗', tag: 'shop', price: 300, effect: 'ice', color: '#e8d8c0', defaultAction: 'act-wave', desc: '重点色蓝眼' },
    { id: 'kami', name: '猫神', tag: 'shop', price: 999, effect: 'sun', color: '#ffd24a', defaultAction: 'act-float', desc: '金色神座降临（终极）' }
  );

  // 服装（普通款：头饰 / 衣服 / 盔甲）
  const COSTUMES = [
    { id: 'glasses', name: '酷墨镜',   cat: 'head',  price: 40,  desc: '瞬间变潮' },
    { id: 'crown',   name: '小皇冠',   cat: 'head',  price: 80,  desc: '尊贵加冕' },
    { id: 'bow',     name: '蝴蝶结',   cat: 'head',  price: 60,  desc: '甜美少女' },
    { id: 'flower',  name: '花环',     cat: 'head',  price: 90,  desc: '森系花冠' },
    { id: 'halo',    name: '天使光环', cat: 'head',  price: 120, desc: '头顶小光环' },
    { id: 'scarf',   name: '红围巾',   cat: 'body',  price: 60,  desc: '暖暖的' },
    { id: 'sweater', name: '小毛衣',   cat: 'body',  price: 100, desc: '针织小毛衣' },
    { id: 'cape',    name: '超人披风', cat: 'cloak', price: 150, desc: '披风飞行' },
    { id: 'armor',   name: '骑士盔甲', cat: 'armor', price: 220, desc: '银甲护体' },
  ];

  COSTUMES.push(
    { id: 'hat', name: '小礼帽', cat: 'head', price: 130, desc: '绅士小礼帽' },
    { id: 'scarf2', name: '毛绒围巾', cat: 'body', price: 90, desc: '软糯毛绒感' },
    { id: 'belt', name: '蝴蝶腰带', cat: 'body', price: 110, desc: '精致小腰带' },
    { id: 'wing', name: '小翅膀', cat: 'cloak', price: 160, desc: '背后小翅膀' },
    { id: 'bell', name: '铃铛项圈', cat: 'head', price: 70, desc: '叮叮当当' },
    { id: 'mask', name: '小眼罩', cat: 'head', price: 100, desc: '神秘小眼罩' }
  );

  COSTUMES.push(
    { id: 'tiara', name: '水晶皇冠', cat: 'head', price: 140, desc: '闪耀水晶小皇冠' },
    { id: 'horn', name: '小恶魔角', cat: 'head', price: 90, desc: '俏皮小犄角' },
    { id: 'roundglasses', name: '圆框眼镜', cat: 'head', price: 110, desc: '文艺圆眼镜' },
    { id: 'beret', name: '贝雷帽', cat: 'head', price: 120, desc: '法式贝雷帽' },
    { id: 'ribbon', name: '丝带发带', cat: 'head', price: 60, desc: '甜美丝带' },
    { id: 'gemcollar', name: '宝石项圈', cat: 'head', price: 100, desc: '镶宝石项圈' },
    { id: 'tshirt', name: '小T恤', cat: 'body', price: 90, desc: '清爽小T恤' },
    { id: 'hoodie', name: '连帽卫衣', cat: 'body', price: 130, desc: '街头连帽衫' },
    { id: 'dress', name: '蓬蓬裙', cat: 'body', price: 120, desc: '公主蓬蓬裙' },
    { id: 'wizard', name: '巫师斗篷', cat: 'cloak', price: 200, desc: '神秘巫师袍' },
    { id: 'angelwing', name: '天使羽翼', cat: 'cloak', price: 180, desc: '纯白小翅膀' }
  );

  // 光效（特效款：轻盈粒子流 + 脚底光环扩散波纹）
  // duration: 有效期（小时），购买后开始倒计时，过期自动失效，必须续购才能继续使用
  const AURAS = [
    // 粒子流
    { id: 'star',    name: '星河环',     price: 100, duration: 24, desc: '金色星尘从天飘落' },
    { id: 'ice',     name: '寒冰环',     price: 150, duration: 24, desc: '晶莹雪花轻轻下落' },
    { id: 'fire',    name: '烈焰环',     price: 160, duration: 48, desc: '炽热火星向上升腾（加强）' },
    { id: 'ocean',   name: '深海蓝环',   price: 170, duration: 24, desc: '幽蓝气泡缓缓上浮' },
    { id: 'emerald', name: '翡翠环',     price: 180, duration: 48, desc: '碧绿叶片向上飞舞' },
    { id: 'heart',   name: '爱心环',     price: 190, duration: 48, desc: '粉红爱心向上飘起' },
    { id: 'coin',    name: '金币环',     price: 210, duration: 48, desc: '金币向上翻飞招财' },
    { id: 'aurora',  name: '极光环',     price: 230, duration: 72, desc: '极地绿光叶片上扬' },
    { id: 'rainbow', name: '七彩霓虹环', price: 250, duration: 72, desc: '七彩星火上下飞舞' },
    { id: 'sakura',  name: '樱花环',     price: 260, duration: 72, desc: '粉樱花瓣脚下上飘' },
    { id: 'moon',    name: '皎月银环',   price: 280, duration: 72, desc: '清冷月华雪落' },
    { id: 'crystal', name: '冰晶环',     price: 300, duration: 72, desc: '璀璨冰晶飘落（加强）' },
    { id: 'sun',     name: '烈日金环',   price: 320, duration: 96, desc: '耀目金星上腾（加强）' },
    { id: 'ruby',    name: '赤焰红宝石环', price: 340, duration: 96, desc: '炽红火星升腾（加强）' },
    { id: 'phoenix', name: '不死鸟炎环', price: 360, duration: 96, desc: '浴火火星升腾（加强）' },
    { id: 'galaxy',  name: '银河环',     price: 400, duration: 168, desc: '梦幻星尘飘落（顶级加强）' },
    // 脚底光环 + 扩散波纹
    { id: 'holy',      name: '圣光脚底环', price: 120, duration: 48, desc: '金色光环自脚下扩散' },
    { id: 'inferno',   name: '炼狱脚底环', price: 180, duration: 48, desc: '烈焰波纹向外翻腾' },
    { id: 'frostring', name: '冰霜脚底环', price: 160, duration: 48, desc: '寒冰圆环脚下绽放' },
    { id: 'stardust',  name: '星尘脚底环', price: 200, duration: 72, desc: '星光涟漪向外扩散' },
    { id: 'nature',    name: '自然脚底环', price: 170, duration: 48, desc: '绿色光波向四周荡漾' },
    { id: 'ripple',    name: '水波脚底环', price: 190, duration: 72, desc: '水纹从脚下层层荡开' },
    { id: 'shadow',    name: '暗影脚底环', price: 220, duration: 72, desc: '暗紫色波纹悄然扩散' },
    { id: 'lovepool',  name: '甜心脚底环', price: 150, duration: 48, desc: '粉色爱心光波荡漾' },
    { id: 'techring',  name: '科技脚底环', price: 260, duration: 72, desc: '霓虹脉冲自脚下扫描' },
    { id: 'sanctum',   name: '圣殿脚底环', price: 300, duration: 96, desc: '圣洁光轮在脚下旋转' },
    { id: 'blood',     name: '血月脚底环', price: 240, duration: 72, desc: '猩红波纹向上翻涌' },
    { id: 'poison',    name: '毒雾脚底环', price: 180, duration: 48, desc: '毒绿光环腐蚀般扩散' },
    { id: 'oceanring', name: '深海脚底环', price: 210, duration: 72, desc: '海蓝圆环层层展开' },
    { id: 'voidring',  name: '虚空脚底环', price: 320, duration: 96, desc: '虚空之力在脚下扭曲' },
  ];

  AURAS.push(
    { id: 'bloom', name: '花绽环', price: 150, duration: 24, desc: '粉瓣轻轻上扬' },
    { id: 'thunder', name: '雷霆环', price: 240, duration: 72, desc: '电光星火上下飞舞' },
    { id: 'wind', name: '清风环', price: 170, duration: 48, desc: '绿叶随风飘旋' },
    { id: 'rose', name: '玫瑰环', price: 200, duration: 72, desc: '玫红花瓣缓缓下落' },
    { id: 'goldrain', name: '金沙环', price: 260, duration: 72, desc: '金沙如雨洒落' },
    { id: 'blizzard', name: '暴雪环', price: 300, duration: 96, desc: '漫天飞雪（加强）' },
    { id: 'neon', name: '霓虹环', price: 280, duration: 72, desc: '霓虹星火七彩' },
    { id: 'void', name: '虚空环', price: 340, duration: 96, desc: '幽紫星尘飘落（加强）' },
    { id: 'frost', name: '霜华环', price: 220, duration: 72, desc: '寒霜冰晶飘落' },
    { id: 'lava', name: '熔岩环', price: 320, duration: 96, desc: '炽熔岩浆升腾（加强）' },
    { id: 'spirit', name: '精灵环', price: 190, duration: 48, desc: '翠灵星火飞舞' },
    { id: 'dream', name: '梦境环', price: 230, duration: 72, desc: '梦幻气泡上浮' },
    { id: 'candy', name: '糖果环', price: 180, duration: 48, desc: '甜心泡泡上飘' },
    { id: 'jade', name: '碧玉环', price: 210, duration: 72, desc: '碧玉叶片上扬' }
  );

  AURAS.push(
    { id: 'meteor', name: '流星环', price: 220, duration: 72, desc: '蓝色流星向上陨落' },
    { id: 'cloud', name: '云朵环', price: 170, duration: 48, desc: '轻盈云朵缓缓飘落' },
    { id: 'diamond', name: '钻石环', price: 320, duration: 96, desc: '璀璨钻石星火（加强）' },
    { id: 'tulip', name: '郁金香环', price: 200, duration: 72, desc: '粉郁金香瓣下落' },
    { id: 'autumn', name: '落叶环', price: 180, duration: 48, desc: '金黄落叶随风旋' },
    { id: 'foam', name: '泡沫环', price: 190, duration: 72, desc: '清凉泡沫上浮' },
    { id: 'sparkgold', name: '流金环', price: 300, duration: 96, desc: '七彩金星火飞舞' },
    { id: 'ghost', name: '幽灵环', price: 160, duration: 48, desc: '缥缈幽灵泡泡' },
    { id: 'goldring', name: '黄金脚底环', price: 240, duration: 72, desc: '鎏金光轮脚下旋' },
    { id: 'emeraldring', name: '翡翠脚底环', price: 200, duration: 72, desc: '翠绿光波荡漾' },
    { id: 'roseground', name: '玫瑰脚底环', price: 180, duration: 48, desc: '玫瑰红光波荡漾' },
    { id: 'pearl', name: '珍珠脚底环', price: 220, duration: 72, desc: '温润珍珠光轮' },
    { id: 'magmaring', name: '熔岩脚底环', price: 300, duration: 96, desc: '熔岩波纹翻腾（加强）' },
    { id: 'frostground', name: '霜华脚底环', price: 260, duration: 72, desc: '霜华圆环绽放' },
    { id: 'crimson', name: '绯红脚底环', price: 260, duration: 72, desc: '绯红波纹翻涌（加强）' }
  );

  // 通用动作：所有猫咪都能使用；每只猫默认拥有一个独立动作（见 PETS.defaultAction），
  // 商城里的动作是「付费额外增加」给自己当前猫咪的（按猫分别记录所有权）。
  const ACTIONS = [
    { id: 'act-jump',    anim: 'jump',    name: '弹跳',   price: 60,  desc: '一蹦一蹦超开心' },
    { id: 'act-roll',    anim: 'roll',    name: '翻滚',   price: 70,  desc: '原地打个滚' },
    { id: 'act-sit',     anim: 'sit',     name: '端坐',   price: 60,  desc: '稳稳坐好卖萌' },
    { id: 'act-peek',    anim: 'peek',    name: '探头',   price: 60,  desc: '左看右看好奇' },
    { id: 'act-spin',    anim: 'spin',    name: '转圈',   price: 70,  desc: '原地转个圈' },
    { id: 'act-dance',   anim: 'dance',   name: '摇摆舞', price: 90,  desc: '金贵摇摆' },
    { id: 'act-wave',    anim: 'wave',    name: '招手',   price: 80,  desc: '优雅挥爪' },
    { id: 'act-prowl',   anim: 'prowl',   name: '潜行',   price: 90,  desc: '悄悄靠近猎物' },
    { id: 'act-stretch', anim: 'stretch', name: '伸懒腰', price: 110, desc: '软软伸个懒腰' },
    { id: 'act-float',   anim: 'float',   name: '悬浮',   price: 150, desc: '破坏神悬浮术' },
    { id: 'act-heart',   anim: 'heart',   name: '爱心跳', price: 120, desc: '粉红爱心砰砰跳' },
    { id: 'act-roar',    anim: 'roar',    name: '仰天长啸', price: 150, desc: '霸气一声吼' },
    { id: 'act-sleep',   anim: 'sleep',   name: '呼呼大睡', price: 120, desc: '贵族式午睡' },
    { id: 'act-twirl',   anim: 'twirl',   name: '星光旋', price: 90,  desc: '星光中旋转' },
    { id: 'act-fire',    anim: 'fire',    name: '喷火',   price: 100, desc: '小火苗喷一下' },
    { id: 'act-coin',    anim: 'coin',    name: '招财',   price: 120, desc: '摇身招财' },
    { id: 'act-fly',     anim: 'fly',     name: '太空飞', price: 160, desc: '失重漂浮' },
  ];

  ACTIONS.push(
    { id: 'act-twist', anim: 'twist', name: '扭扭乐', price: 80, desc: '左摇右摆俏皮' },
    { id: 'act-bow', anim: 'bow', name: '绅士鞠躬', price: 90, desc: '点头哈腰有礼' },
    { id: 'act-hi5', anim: 'hi5', name: '击掌', price: 90, desc: '左右挥爪击掌' },
    { id: 'act-skate', anim: 'skate', name: '滑步', price: 100, desc: '脚下生风滑起来' },
    { id: 'act-flip', anim: 'flip', name: '空翻', price: 130, desc: '原地翻个跟头' },
    { id: 'act-wiggle', anim: 'wiggle', name: '摇摆', price: 70, desc: '身体左右摇摆' },
    { id: 'act-purr', anim: 'purr', name: '呼噜颤', price: 70, desc: '满足地颤一颤' },
    { id: 'act-leap', anim: 'leap', name: '飞跃', price: 120, desc: '高高跃起' }
  );

  ACTIONS.push(
    { id: 'act-nod',   anim: 'nod',    name: '点头',   price: 70,  desc: '萌萌点头打招呼' },
    { id: 'act-shake', anim: 'shake',  name: '摇头',   price: 70,  desc: '左右摇摆脑袋' },
    { id: 'act-clap',  anim: 'clap',   name: '拍手',   price: 90,  desc: '开心拍拍手' },
    { id: 'act-yawn',  anim: 'yawn',   name: '打哈欠', price: 80,  desc: '困倦伸懒腰' },
    { id: 'act-run',   anim: 'run',    name: '原地跑', price: 110, desc: '哒哒哒跑起来' },
    { id: 'act-bounce',anim: 'bounce', name: '蹦跶',   price: 100, desc: '欢乐上下蹦' },
    { id: 'act-cheer', anim: 'cheer',  name: '欢呼',   price: 120, desc: '跳起欢呼' },
    { id: 'act-beg',   anim: 'beg',    name: '作揖',   price: 100, desc: '乖巧作揖' }
  );

  // ---------- 通行证（赛季制：1~100 级，免费轨 + 进阶轨） ----------
  const PASS_LEVELS = 100;
  const PASS_MILESTONE_PETS = ['munch', 'scott', 'beng'];
  // 满级（100 级）豪华大礼包：对标大厂满级终极奖励，多件高级权益 + 大量积分
  const PASS_FINAL_BUNDLE = {
    coins: 2000,
    pets: ['kami', 'norwe', 'siam'],               // 猫神 + 挪威森林 + 暹罗，3 只稀有限定猫
    auras: ['goldrain', 'neon', 'void'],           // 3 款高级光效
    actions: ['act-leap', 'act-flip', 'act-skate'],// 3 款高级动作
    costumes: ['wing', 'mask'],                    // 2 款高级服饰
  };
  // 依据当前商品目录确定性生成奖励表（赛季内稳定；目录变更则随赛季刷新）
  // 设计对标大厂：免费轨 / 豪华轨双轨；豪华轨积分 = 免费轨双倍（UI 标 2×）；满级送豪华大礼包
  function buildPassTable() {
    const auras = AURAS.map(a => a.id);
    const actions = ACTIONS.map(a => a.id);
    const costumes = COSTUMES.map(c => c.id);
    const table = [];
    let ai = 0, ci = 0, ui = 0;
    const milestoneAt = { 25: 0, 50: 1, 75: 2, 100: 3 };
    for (let lv = 1; lv <= PASS_LEVELS; lv++) {
      const base = 20 + lv;                          // 免费轨积分基数
      const free = { type: 'coins', qty: base };
      let premium = { type: 'coins', qty: base * 2 }; // 豪华轨积分 = 免费轨双倍（lv=100 时为礼包，故用 let）
      if (lv % 10 === 0) { free.type = 'aura'; free.id = auras[(ui++) % auras.length]; free.qty = 1; }
      else if (lv % 5 === 0) { free.type = 'costume'; free.id = costumes[(ci++) % costumes.length]; free.qty = 1; }
      if (lv % 10 === 0) { premium.type = 'aura'; premium.id = auras[(ui++) % auras.length]; premium.qty = 1; }
      else if (lv % 3 === 0) { premium.type = 'action'; premium.id = actions[(ai++) % actions.length]; premium.qty = 1; }
      else if (lv % 5 === 0) { premium.type = 'costume'; premium.id = costumes[(ci++) % costumes.length]; premium.qty = 1; }
      let milestone = false;
      if (lv in milestoneAt) {
        milestone = true;
        free.type = 'coins'; free.qty = 200 + lv * 2;  // 里程碑额外积分（免费轨）
        if (lv === 100) {
          premium = { type: 'bundle', qty: 1, bundle: PASS_FINAL_BUNDLE }; // 满级豪华大礼包
        } else {
          premium.type = 'pet'; premium.id = PASS_MILESTONE_PETS[milestoneAt[lv]]; premium.qty = 1;
        }
      }
      table.push({ lv, free, premium, milestone });
    }
    return table;
  }

  const petById = (id) => PETS.find(p => p.id === id) || PETS[0];
  const costumeById = (id) => COSTUMES.find(c => c.id === id) || null;
  const auraById = (id) => AURAS.find(a => a.id === id) || null;
  const actionById = (id) => ACTIONS.find(a => a.id === id) || null;

  // 组装一只宠物的展示（活体矢量猫 + 可选服装 SVG 叠加层，服装按猫色着色）
  function buildPetArt(petId, costumeId) {
    const pet = petById(petId);
    let behind = '', over = '';
    if (costumeId && COSTUME_ART[costumeId]) {
      const c = COSTUME_ART[costumeId](petColors(pet));
      const svg = `<svg class="pet-costume" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">${c.svg}</svg>`;
      if (c.behind) behind = svg; else over = svg;
    }
    if (pet && pet.svg) return `${behind}<div class="pet-photo pet-cat-svg">${buildCatSVG(pet)}</div>${over}`;
    return `${behind}<img class="pet-photo" draggable="false" src="${PET_IMAGE_DIR}${petId}.png" alt="${pet ? pet.name : petId}">${over}`;
  }

  window.COSTUME_ART = COSTUME_ART;
  window.AURA_ART = AURA_ART;
  window.PETS = PETS;
  window.COSTUMES = COSTUMES;
  window.AURAS = AURAS;
  window.ACTIONS = ACTIONS;
  window.petById = petById;
  window.costumeById = costumeById;
  window.auraById = auraById;
  window.actionById = actionById;
  window.buildPetArt = buildPetArt;
  window.buildCatSVG = buildCatSVG;
  window.buildAuraSVG = buildAuraSVG;
  window.buildPetSVG = buildPetArt; // 兼容旧调用名
  window.PASS_LEVELS = PASS_LEVELS;
  window.buildPassTable = buildPassTable;
})();
