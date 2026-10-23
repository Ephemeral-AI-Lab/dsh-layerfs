// The sharky maid skin's voice: a kaomoji on the call's bubble, a sparkle or
// heart where a Commit or merge lands. The view calls these only while
// data-skin is "maids".

// a call's bubble, said the maid way: the same words, with a face after them
const FACE = {
  win: "(๑•̀ㅂ•́)و✧", merge: "♡", serve: "☕", move: "♪", hello: "(・ω・)ノ",
  oops: "Σ(°△°|||)", fail: "(╥﹏╥)", read: "📖", work: "…",
};
/** The bubble's [text, class] with the mood's face. */
export function maidBubble(bubble, mood) {
  const face = FACE[mood];
  return face && bubble ? [`${bubble[0]} ${face}`, bubble[1]] : bubble;
}

/** A few sparkles (a Commit or publish), hearts (a merge) or a sweat drop (a conflict) at a point of the overlay, once. */
export function maidBurst(overlay, x, y, mood) {
  const glyphs = mood === "merge" ? ["♡", "♡", "♥"] : mood === "oops" || mood === "fail" ? ["💦"] : mood === "win" || mood === "serve" ? ["✦", "✧", "✦"] : null;
  if (!glyphs) return;
  glyphs.forEach((g, i) => {
    const el = document.createElement("span");
    el.className = "maidfx"; el.textContent = g;
    el.style.left = x + "px"; el.style.top = y + "px";
    el.style.setProperty("--dx", `${(i - (glyphs.length - 1) / 2) * 12}px`);
    el.style.color = mood === "merge" ? "#F08BB0" : "#4D6BFE";
    el.style.animationDelay = `${i * 90}ms`;
    overlay.appendChild(el);
    setTimeout(() => el.remove(), 1400 + i * 90);
  });
}
