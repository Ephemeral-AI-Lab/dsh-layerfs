// How an agent looks, for every skin (skins/*/cast.js gives each skin's cast).
// A cast is { main, heroes: { name: { src, color } } }: the website's pixel
// heroes (skins/heroes) are one image each. A cast with sprite sheets (the
// sharky maids, skins/maids) gives a hero `poses` (frame names, side by
// side in `src`, each 3:4) and `head` ({ src, index, count }: square head
// crops side by side): an agent then shows the pose of its last call, and
// its History name tag is its head.

/** What a call shows on its agent: a mood, which each sheet draws with its own pose. */
export function moodOf(last) {
  const o = last.o, r = o.result, call = last.call || "";
  if (!o.ok) return o.code === "Conflict" ? "oops" : "fail";
  if (o.code === "Committed") return "win";
  if (o.code === "Merged") return "merge";
  if (o.code === "Added") return "serve";
  if (o.code === "Forked" || o.code === "Mounted") return "move";
  if (o.code === "Ready" || o.code === "Closed") return "hello";
  if (call === "sandbox.exec" && r && r.exitCode) return "fail";
  if (/^fs\.(read|list|grep|stat|blame|diff|find)/.test(call) || /^branch\.(diff|log)/.test(call)) return "read";
  return "work";
}

/** The mood of a History node an agent made, where no call says more: a Commit, a merge, a published Layer, a fork. */
export function nodeMood(node) {
  if (node.kind === "layer") return "serve";
  if (node.kind === "fork") return "move";
  return node.parents && node.parents.filter(Boolean).length > 1 ? "merge" : "win";
}

// a mood's pose: the first of these a sheet has (the numbered maids' poses, then Ellen's expressions)
const POSES = {
  work: ["laptop", "thinking"], read: ["read", "thinking"], win: ["cheer", "thumbs_up"], merge: ["heart", "love"],
  serve: ["serve_tea", "smug"], move: ["run", "happy"], hello: ["wave", "happy"], oops: ["arms_open", "surprised"],
  fail: ["arms_open", "crying"], idle: ["idle", "happy"], sleep: ["sleep", "sleepy"],
};
const frameOf = (hero, mood) => Math.max(0, hero.poses.indexOf((POSES[mood] || POSES.idle).find((p) => hero.poses.includes(p))));

/** The hero's figure inside an `.av` box: its image, or its pose's frame of the sheet. */
export function figureStyle(hero, mood) {
  if (!hero.poses) return `background-image:url(${hero.src})`;
  const n = hero.poses.length, k = frameOf(hero, mood);
  return `background:url(${hero.src}) ${n > 1 ? ((k / (n - 1)) * 100).toFixed(3) : 0}% 0 / ${n * 100}% 100% no-repeat;aspect-ratio:3/4;width:auto`;
}

/** The hero's head for a History name tag, 16 px, as SVG. */
export function headSvg(hero, title) {
  const t = `<title>${title}</title>`;
  if (!hero.head) return `<image href="${hero.src}" width="16" height="16" preserveAspectRatio="xMidYMax meet"/>${t}`;
  const { src, index, count } = hero.head;
  return `<svg width="16" height="16" viewBox="${index} 0 1 1" preserveAspectRatio="xMidYMid slice" overflow="hidden"><image href="${src}" width="${count}" height="1" preserveAspectRatio="none"/></svg>${t}`;
}
