// Shots for docs/guide/bucket.md: the bucket cards on Home › Stores, the Bucket page and a Backup file page.
// Opening a bucket page lists it once (backup list, a read); nothing here backs up, restores or disconnects.
//   DSH_LAYERFS_DEV_DIR=$PWD/.dev-guide node tools/guide/shoot.mjs tools/guide/shots/bucket.mjs [--only <file>]

const bar = (page) => page.locator('header[aria-label="Home navigation"]')
const dialog = (page) => page.getByRole('dialog').last()
const menu = (page) => page.getByRole('menu').last()
const bucketCard = (page) => page.locator('article[data-bucket="guide-backups"]')

/** Home › Stores › SQLite › Buckets. */
async function buckets(page, h) {
  await h.home()
  await page.getByRole('tab', { name: /^Stores/ }).first().click()
  await h.wait(800)
  await page.getByRole('tab', { name: /^SQLite/ }).first().click()
  await page.getByRole('tab', { name: /^Buckets/ }).first().click()
  await bucketCard(page).waitFor({ timeout: 20000 })
  await h.wait(1500)
}

/** The Bucket page (Jump to: the bucket's own row). */
async function bucket(page, h) {
  await h.jump('guide-backups minio')
  await page.locator('[data-storage-page="bucket:guide-backups"]').waitFor({ timeout: 20000 })
  await page.getByRole('table').first().waitFor({ timeout: 20000 })
  await h.wait(2000)
}

/** The Backup file page of guide-backups/guide-notes (its file link on the Bucket page). */
async function file(page, h) {
  await bucket(page, h)
  await page.getByRole('table').getByRole('button', { name: 'guide-notes', exact: true }).first().click()
  await page.locator('[data-storage-page="backup:guide-backups/guide-notes"]').waitFor({ timeout: 20000 })
  await h.wait(2000)
}

const paneBar = (page) => page.locator('[data-storage-page] header[class*=paneBar]').first()

export default [
  {
    file: 'bucket-cards',
    run: async (page, h) => { await buckets(page, h) },
    callouts: [
      (page) => page.getByRole('tablist', { name: 'Show' }),
      (page) => bucketCard(page).locator('header'),
      (page) => bucketCard(page).locator('p').first(),
      (page) => bucketCard(page).locator('ul'),
      (page) => bucketCard(page).locator('footer'),
      (page) => page.getByRole('button', { name: 'List bucket files' }),
      (page) => page.getByRole('button', { name: 'Add bucket', exact: true }),
    ],
  },
  {
    file: 'bucket-card-menu',
    run: async (page, h) => {
      await buckets(page, h)
      await bucketCard(page).getByRole('button', { name: 'More actions for guide-backups' }).click()
      await menu(page).waitFor()
      await h.wait(1000)
    },
    clip: (page) => page.locator('[class*=grid]').filter({ has: bucketCard(page) }).first(), pad: 60,
  },
  {
    file: 'bucket-overview',
    run: async (page, h) => { await bucket(page, h) },
    callouts: [
      (page) => bar(page),
      (page) => paneBar(page).locator('[class*=paneBarMeta]'),
      (page) => page.getByRole('button', { name: 'Test connection' }),
      (page) => page.getByRole('button', { name: /^List/ }).first(),
      (page) => page.getByRole('button', { name: 'guide-backups', exact: true }).last(),
      (page) => page.getByRole('table').locator('tr[class*=groupRow]').first(),
      (page) => page.getByRole('table').locator('tbody tr').nth(1),
    ],
  },
  {
    file: 'bucket-menu',
    run: async (page, h) => {
      await bucket(page, h)
      await paneBar(page).getByRole('button', { name: 'guide-backups', exact: true }).click()
      await menu(page).waitFor()
      await h.wait(1000)
    },
    clip: (page) => menu(page), pad: 16,
  },
  {
    file: 'bucket-disconnect',
    run: async (page, h) => {
      await bucket(page, h)
      await paneBar(page).getByRole('button', { name: 'guide-backups', exact: true }).click()
      await menu(page).getByRole('menuitem', { name: 'Disconnect' }).click()
      await dialog(page).waitFor()
      await h.wait(800)
    },
    clip: dialog,
  },
  {
    file: 'bucket-file',
    run: async (page, h) => { await file(page, h) },
    callouts: [
      (page) => paneBar(page).locator('[class*=paneBarMeta]'),
      (page) => page.getByRole('button', { name: /^List/ }).first(),
      (page) => page.getByRole('button', { name: 'Restore as a new Store…' }),
      (page) => page.locator('[class*=backupFacts]'),
      (page) => page.getByRole('table').first(),
    ],
  },
  {
    file: 'bucket-restore',
    run: async (page, h) => {
      await file(page, h)
      await page.getByRole('button', { name: 'Restore as a new Store…' }).click()
      await dialog(page).waitFor()
      await h.wait(800)
    },
    clip: dialog,
  },
]
