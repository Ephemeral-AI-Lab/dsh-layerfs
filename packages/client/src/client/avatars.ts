// The cast dsh draws its agents with: the sharky maids (view/src/skins/maids;
// fan art, a local skin, never a published one), for every agent on the
// LayerFS tab and the project board. The website's heroes (skins/heroes) are
// not offered here, so there is no Cast switch. Each image is bundled as a
// data URL instead of a page-relative path.
import { maidAvatars } from '../../../view/src/skins/maids/cast.js'
import m11 from './assets/11.png'
import m12 from './assets/12.png'
import m13 from './assets/13.png'
import m2 from './assets/2.png'
import m3 from './assets/3.png'
import m4 from './assets/4.png'
import m5 from './assets/5.png'
import m6 from './assets/6.png'
import m7 from './assets/7.png'
import m8 from './assets/8.png'
import m9 from './assets/9.png'
import ellen from './assets/ellen_joe.png'
import heads from './assets/heads.png'

const SHEET: Record<string, string> = { ellen_joe: ellen, 2: m2, 3: m3, 4: m4, 5: m5, 6: m6, 7: m7, 8: m8, 9: m9, 11: m11, 12: m12, 13: m13, heads }

export const MAID_AVATARS = maidAvatars((name: string) => SHEET[name])

/** The view's casts: the maids alone, so their skin is on and the Cast switch is hidden. */
export const CASTS = [{ id: 'maids', label: 'Sharky maids', avatars: MAID_AVATARS }]
