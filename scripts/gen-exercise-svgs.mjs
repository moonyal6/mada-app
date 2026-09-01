// Generates the schematic exercise illustrations under public/exercises/.
//
// ⚠️ PLACEHOLDER ART. These are stick-figure diagrams drawn from the design
// tokens so the handout and patient page have consistent, self-hosted images
// until the clinical lead supplies approved photos/illustrations. Re-run with
// `node scripts/gen-exercise-svgs.mjs` after editing a pose.

import fs from "node:fs";
import nodePath from "node:path";

const OUT = nodePath.join(process.cwd(), "public", "exercises");
fs.mkdirSync(OUT, { recursive: true });

const INK = "#1B5E56";
const GOLD = "#B4893D";
const BG = "#DCEAE6";
const FLOOR = "#B9CFC9";

const line = (x1, y1, x2, y2, c = INK, w = 6) =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
const head = (cx, cy, r = 11) =>
  `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${INK}"/>`;
const path = (d, c = INK, w = 6) =>
  `<path d="${d}" fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;
/** Motion cue: a gold arrow along path d (arrowhead at the end). */
const arrow = (d) => `<path d="${d}" fill="none" stroke="${GOLD}" stroke-width="4" stroke-linecap="round" marker-end="url(#ah)"/>`;
const floor = (y = 160) => line(24, y, 176, y, FLOOR, 4);
const wall = (x = 150) => line(x, 30, x, 160, FLOOR, 4);
const band = (d) => path(d, GOLD, 3);

const wrap = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200" role="img" aria-label="رسم توضيحي مبدئي">
<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L10 5 0 10z" fill="${GOLD}"/></marker></defs>
<rect width="200" height="200" rx="24" fill="${BG}"/>
${body}
</svg>
`;

// ── Poses ───────────────────────────────────────────────────────────────
// Coordinates are hand-tuned on a 200×200 canvas; the floor sits at y=160.
const POSES = {
  // Supine, knees bent; pelvis rocking (arrow curls under the low back).
  "back-pelvic-tilt": [
    floor(),
    head(40, 146),
    line(52, 148, 118, 150), // trunk
    line(118, 150, 138, 118), // thigh up
    line(138, 118, 156, 156), // shin down
    line(70, 149, 100, 150), // arm resting
    arrow("M96 138 q12 -12 24 0"),
  ],
  // Cat–cow: all-fours, spine arched; arrows both ways.
  "back-cat-cow": [
    floor(),
    head(158, 96),
    path("M148 100 q-48 -34 -100 4"), // arched spine
    line(60, 104, 56, 158), // back leg
    line(76, 100, 74, 158), // back leg 2
    line(138, 102, 142, 158), // arm
    line(124, 100, 126, 158), // arm 2
    arrow("M100 74 v-18"),
    arrow("M100 92 v18"),
  ],
  // Bridge: shoulders down, hips lifted, straight line to knees.
  "back-bridge": [
    floor(),
    head(34, 148),
    line(48, 152, 128, 112), // shoulders → hips (lifted)
    line(128, 112, 150, 156), // shin
    line(60, 152, 96, 156), // arm on floor
    arrow("M112 96 v-20"),
  ],
  // Knee-to-chest: supine, one knee hugged.
  "back-knee-to-chest": [
    floor(),
    head(38, 148),
    line(52, 150, 112, 150), // trunk
    line(112, 150, 172, 152), // straight leg
    line(112, 148, 94, 106), // thigh to chest
    line(94, 106, 118, 96), // shin folded
    path("M66 140 q22 -34 40 -30"), // arm hugging
    arrow("M112 84 q-10 -18 -28 -8"),
  ],
  // Bird-dog: all-fours, opposite arm & leg extended.
  "back-bird-dog": [
    floor(),
    head(150, 92),
    line(60, 98, 138, 96), // trunk
    line(138, 96, 186, 84), // extended arm
    line(126, 98, 128, 158), // support arm
    line(60, 98, 14, 108), // extended leg
    line(72, 98, 70, 158), // support leg
  ],
  // Chin tuck: profile head gliding straight back.
  "neck-chin-tuck": [
    path("M60 178 q0 -50 40 -60", INK, 6), // shoulder/neck line
    path("M100 118 q-20 -6 -22 -34 q0 -32 30 -32 q32 0 30 34 q-2 26 -20 32", INK, 6), // head profile
    line(100, 118, 100, 132),
    arrow("M150 84 h-30"),
  ],
  // Lateral flexion: front view, head tilted toward a shoulder.
  "neck-lateral-flexion": [
    line(56, 150, 144, 150, INK, 8), // shoulders
    line(100, 150, 100, 122), // neck
    `<circle cx="112" cy="94" r="24" fill="none" stroke="${INK}" stroke-width="6" transform="rotate(20 100 120)"/>`,
    arrow("M60 96 q10 -34 40 -34"),
  ],
  // Rotation: front view head with a horizontal turning arrow.
  "neck-rotation": [
    line(56, 152, 144, 152, INK, 8),
    line(100, 152, 100, 126),
    `<circle cx="100" cy="98" r="26" fill="none" stroke="${INK}" stroke-width="6"/>`,
    line(112, 92, 118, 96, INK, 5), // nose hint (turned)
    arrow("M60 70 q40 -30 84 0"),
  ],
  // Upper trapezius stretch: head tilted, hand on head.
  "neck-upper-trap-stretch": [
    line(50, 152, 150, 152, INK, 8),
    line(100, 152, 100, 126),
    `<circle cx="110" cy="98" r="24" fill="none" stroke="${INK}" stroke-width="6" transform="rotate(22 100 124)"/>`,
    path("M150 150 q6 -70 -38 -72"), // arm over head
    line(50, 152, 44, 184), // other arm down
    arrow("M62 104 q6 -24 30 -30"),
  ],
  // Levator scapulae: head tilted and turned down toward the armpit.
  "neckstrain-levator-stretch": [
    line(50, 152, 150, 152, INK, 8),
    line(100, 152, 98, 126),
    `<circle cx="108" cy="104" r="22" fill="none" stroke="${INK}" stroke-width="6" transform="rotate(40 100 126)"/>`,
    path("M150 150 q10 -60 -26 -56"),
    line(50, 152, 44, 184),
    arrow("M66 92 q10 -8 24 8"),
  ],
  // Shoulder rolls: front view with circular arrows on both shoulders.
  "neckstrain-shoulder-rolls": [
    line(54, 140, 146, 140, INK, 8),
    line(100, 140, 100, 118),
    `<circle cx="100" cy="94" r="22" fill="none" stroke="${INK}" stroke-width="6"/>`,
    line(54, 140, 46, 182),
    line(146, 140, 154, 182),
    arrow("M40 136 a18 18 0 1 1 28 -4"),
    arrow("M160 136 a18 18 0 1 0 -28 -4"),
  ],
  // Scalene stretch: head tilted back/side, hand pinning collarbone.
  "neckstrain-scalene-stretch": [
    line(50, 152, 150, 152, INK, 8),
    line(100, 152, 102, 126),
    `<circle cx="112" cy="96" r="24" fill="none" stroke="${INK}" stroke-width="6" transform="rotate(-24 100 124)"/>`,
    path("M148 150 q-30 -10 -70 -2"), // hand across to collarbone
    line(74, 148, 76, 156, GOLD, 4),
    arrow("M64 96 q4 -20 28 -32"),
  ],
  // Pendulum: bent forward, arm hanging, circular arrow.
  "shoulder-pendulum": [
    floor(),
    head(40, 78),
    line(52, 84, 104, 104), // trunk leaning
    line(104, 104, 104, 158), // legs
    line(116, 104, 118, 158),
    line(76, 92, 74, 148), // hanging arm
    line(100, 102, 132, 92), // hand on table
    line(132, 92, 160, 92, FLOOR, 4),
    arrow("M60 150 a16 8 0 1 0 28 0"),
  ],
  // Wall finger walk: standing, fingers walking up the wall.
  "shoulder-wall-walk": [
    floor(),
    wall(),
    head(96, 44),
    line(96, 58, 100, 112), // trunk
    line(100, 112, 92, 158),
    line(100, 112, 112, 158),
    line(98, 70, 148, 46), // arm up to wall
    line(98, 74, 86, 116), // other arm
    arrow("M166 110 v-56"),
  ],
  // External rotation: elbow tucked, forearm swinging out against a band.
  "shoulder-external-rotation": [
    floor(),
    head(90, 46),
    line(90, 60, 92, 116),
    line(92, 116, 84, 158),
    line(92, 116, 104, 158),
    line(92, 74, 92, 104), // upper arm at side
    line(92, 104, 132, 104), // forearm out
    band("M132 104 q30 -2 44 -30"),
    line(176, 74, 176, 60, GOLD, 3),
    arrow("M116 122 q22 -4 30 -22"),
  ],
  // Cross-body stretch: arm across chest, held by the other.
  "shoulder-cross-body": [
    floor(),
    head(100, 46),
    line(100, 60, 100, 118),
    line(100, 118, 90, 158),
    line(100, 118, 112, 158),
    line(70, 76, 134, 84), // arm across chest
    path("M130 76 q-14 30 -46 16"), // holding arm
    arrow("M60 70 h-20"),
  ],
  // Straight leg raise: supine, one leg straight & lifted.
  "knee-straight-leg-raise": [
    floor(),
    head(36, 148),
    line(50, 150, 108, 150),
    line(108, 150, 126, 118),
    line(126, 118, 150, 156), // bent leg
    line(108, 148, 170, 104), // raised straight leg
    line(66, 150, 96, 152),
    arrow("M172 128 v-18"),
  ],
  // Quad set: long sitting, knee pressed down into a rolled towel.
  "knee-quad-set": [
    floor(),
    head(46, 82),
    line(48, 96, 60, 142),
    line(60, 142, 170, 150), // straight leg
    line(52, 110, 76, 144), // arm behind for support
    `<ellipse cx="112" cy="154" rx="14" ry="6" fill="${FLOOR}"/>`,
    arrow("M112 124 v18"),
  ],
  // Mini squat: standing, knees slightly bent, hips back.
  "knee-mini-squat": [
    floor(),
    head(90, 42),
    line(90, 56, 104, 108),
    line(104, 108, 92, 134),
    line(92, 134, 96, 158),
    line(104, 108, 118, 136),
    line(118, 136, 114, 158),
    line(92, 70, 130, 82), // arms forward
    arrow("M60 96 v22"),
  ],
  // Hamstring stretch: heel on a low step, leaning forward.
  "knee-hamstring-stretch": [
    floor(),
    head(70, 48),
    line(76, 62, 96, 112), // trunk leaning
    line(96, 112, 94, 158), // stance leg
    line(96, 112, 150, 130), // leg on step
    line(150, 130, 154, 136),
    `<rect x="136" y="136" width="36" height="24" rx="3" fill="${FLOOR}"/>`,
    line(80, 74, 122, 106), // arms reaching
    arrow("M66 84 q6 20 20 26"),
  ],
  // Ankle alphabet: seated, foot tracing letters.
  "ankle-alphabet": [
    floor(),
    head(46, 60),
    line(50, 74, 66, 120),
    line(66, 120, 128, 126), // thigh (seated)
    line(128, 126, 146, 152), // shin
    path("M150 152 q10 -18 12 6 q4 -20 12 -2", GOLD, 4), // squiggle
    `<rect x="60" y="120" width="16" height="40" fill="${FLOOR}"/>`,
  ],
  // Calf raises: standing on toes, arrow up.
  "ankle-calf-raises": [
    floor(),
    head(100, 40),
    line(100, 54, 100, 108),
    line(100, 108, 92, 150),
    line(100, 108, 110, 150),
    line(92, 150, 84, 158), // heel up, toes down
    line(110, 150, 118, 158),
    line(100, 68, 138, 84), // hand on support
    wall(148),
    arrow("M60 130 v-22"),
  ],
  // Dorsiflexion with band: seated, band pulling foot up.
  "ankle-dorsiflexion": [
    floor(),
    head(44, 62),
    line(48, 76, 62, 122),
    line(62, 122, 150, 130), // straight leg
    line(150, 130, 150, 148), // foot
    band("M150 140 q-30 -8 -66 -6"),
    line(84, 134, 66, 132, GOLD, 3),
    arrow("M164 140 v-22"),
  ],
  // Achilles stretch: wall lunge, back heel down.
  "ankle-achilles-stretch": [
    floor(),
    wall(160),
    head(96, 44),
    line(96, 58, 118, 112),
    line(118, 112, 138, 158), // front leg
    line(118, 112, 72, 158), // back leg straight
    line(100, 70, 156, 66), // arms on wall
    arrow("M60 146 h14"),
  ],
  // Passive ROM: therapist's hands moving the patient's knee.
  "postop-passive-rom": [
    floor(),
    head(36, 148),
    line(50, 150, 110, 150),
    line(110, 150, 134, 120), // thigh lifted
    line(134, 120, 158, 152),
    line(146, 138, 166, 132, GOLD, 5), // helper hand
    line(128, 116, 140, 100, GOLD, 5), // helper hand
    arrow("M116 106 q14 -18 34 -8"),
  ],
  // Isometric: straight leg, tension marks over the thigh.
  "postop-isometric": [
    floor(),
    head(36, 148),
    line(50, 150, 168, 152),
    line(66, 150, 96, 152),
    line(108, 136, 112, 126, GOLD, 4),
    line(122, 134, 128, 124, GOLD, 4),
    line(136, 134, 144, 124, GOLD, 4),
  ],
  // Progressive gait: walking with a cane.
  "postop-gait": [
    floor(),
    head(96, 42),
    line(96, 56, 100, 110),
    line(100, 110, 78, 158),
    line(100, 110, 124, 158),
    line(98, 70, 130, 100), // arm to cane
    line(130, 100, 136, 158, GOLD, 5), // cane
    line(98, 70, 74, 92),
    arrow("M40 130 h24"),
  ],
  // Balance: single-leg stance, arms out.
  "postop-balance": [
    floor(),
    head(100, 40),
    line(100, 54, 102, 112),
    line(102, 112, 100, 158), // stance leg
    line(102, 112, 130, 128), // lifted leg
    line(130, 128, 128, 150),
    line(60, 76, 140, 72), // arms out
    arrow("M40 100 q6 -12 0 -24"),
  ],
};

let n = 0;
for (const [id, parts] of Object.entries(POSES)) {
  fs.writeFileSync(nodePath.join(OUT, `${id}.svg`), wrap(parts.join("\n")));
  n += 1;
}
console.log(`wrote ${n} illustrations to ${nodePath.relative(process.cwd(), OUT)}`);
