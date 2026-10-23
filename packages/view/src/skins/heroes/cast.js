// The heroes skin's cast: the LayerFS website's 14 pixel heroes
// (layerfs-website public/agents, downscaled into ./images). The lead is the cloud, as
// the website's orchestrator; every other agent gets a hero by a hash of its
// name. Each colour is a readable shade of the hero's own, for its name in
// tags, History and cards.
export const HEROES = {
  cloud: "#4F86C9", crab: "#D2603F", frog: "#4E9A35", jelly: "#A66BC0", ghost: "#5C6B8C", sprout: "#8C6E45", shroom: "#B8483A",
  axolotl: "#D9707A", bat: "#8E6BB0", bot: "#5F7AA8", cactus: "#6E8A45", flame: "#D9861E", penguin: "#3F5D8C", snail: "#B88A1E",
};
export const LEAD_HERO = "cloud";

/** The view's `avatars` option from each hero's image URL. */
export const heroAvatars = (urlOf) => ({
  main: LEAD_HERO,
  heroes: Object.fromEntries(Object.entries(HEROES).map(([k, color]) => [k, { src: urlOf(k), color }])),
});
