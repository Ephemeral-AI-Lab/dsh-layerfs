// The sharky maid skin's cast (dsh/sim/avatars, built by its build.py): one
// sprite sheet of ten poses per maid and a strip of head crops. Ellen is the
// lead and her poses are expressions. The maids are fan art of another
// studio's character: a local skin, never a published one.
const ELLEN_POSES = ["happy", "thinking", "thumbs_up", "surprised", "crying", "angry", "smug", "sleepy", "shy", "love"];
const MAID_POSES = ["idle", "run", "laptop", "read", "cheer", "heart", "sleep", "wave", "serve_tea", "arms_open"];
// each maid's sheet name and colour (dsh/sim/avatars/avatars.js), in the head strip's order
export const MAIDS = [
  ["ellen_joe", "#41307e"],
  ["2", "#467ab9"],
  ["3", "#c53a42"],
  ["4", "#6946b9"],
  ["5", "#46b982"],
  ["6", "#b96b46"],
  ["7", "#7b7a85"],
  ["8", "#e6a319"],
  ["9", "#46a2b9"],
  ["11", "#797887"],
  ["12", "#467db9"],
  ["13", "#3d74a2"],
];

/** The view's `avatars` option from each sheet's URL; `urlOf("heads")` is the head strip. */
export const maidAvatars = (urlOf) => ({
  main: "ellen_joe",
  lead: "Ellen",
  heroes: Object.fromEntries(
    MAIDS.map(([name, color], index) => [
      name,
      {
        src: urlOf(name),
        color,
        poses: name === "ellen_joe" ? ELLEN_POSES : MAID_POSES,
        head: { src: urlOf("heads"), index, count: MAIDS.length },
      },
    ]),
  ),
});
