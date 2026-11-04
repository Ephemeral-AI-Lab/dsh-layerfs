// Real-browser regression. Run with Tabbit CLI against the already opened 3081 test GUI:
// tabbit-cli nodejs --task "LayerFS GUI 3081" --request-id native-overview-check < this-file
// Does not create a Store, session, Sandbox or Workspace; no simulated SDK responses.
assert(new URL(page.url()).port === '3081', 'Only the isolated test GUI is allowed');
await page.reload({waitUntil:'domcontentloaded'});
await page.getByRole('button',{name:'LayerFS',exact:true}).waitFor({timeout:20000});
await page.getByRole('button',{name:'LayerFS',exact:true}).click();
await page.getByRole('tab',{name:'All projects',exact:true}).waitFor({timeout:20000});
await page.getByRole('tab',{name:'All projects',exact:true}).click();
const main=page.locator('main').first();
await expect(main).toContainText('not used · Windows-native',{timeout:20000});
await expect(main).toContainText('Native projects · no containers required');
await expect(main).toContainText('no container sweep needed');
const text=await main.innerText();
assert(text.toLowerCase().includes('native projects · no containers required'));
assert(!text.includes('not answering'),'Native route must not claim Docker is down');
assert(!text.includes('start a Sandbox on the next mount'),'Native route must not promise a container');
const response=await page.fetch('/layerfs/runtime',{as:'json'});
assert.equal(response.status,200);
assert.equal(response.json.engine.level,'not-used');
assert.equal(response.json.store,null);
return {status:'PASS native overview GUI',readAt:new Date().toISOString(),origin:new URL(page.url()).origin,engine:response.json.engine,totals:response.json.totals,text};
