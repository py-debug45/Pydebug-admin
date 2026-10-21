const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('js/admin-common.js','utf8');
const helpers = source.slice(source.indexOf('async function fetchAdminRows'));
function context(sb) {
  const ctx = vm.createContext({ sb, planAmountPaise: () => 9900 });
  vm.runInContext(helpers, ctx);
  return ctx;
}
test('analytics reads all rows beyond PostgREST response limit', async () => {
  const rows = Array.from({length:1274},(_,id)=>({id}));
  const ranges=[];
  const ctx = context({from:()=>({select:()=>({order:()=>({range:async(a,b)=>{
    ranges.push([a,b]);return {data:rows.slice(a,b+1),error:null};
  }})})})});
  assert.equal((await ctx.fetchAdminRows('submissions','id')).length,1274);
  assert.deepEqual(ranges,[[0,499],[500,999],[1000,1499]]);
});
test('query failures are not presented as empty real data', async()=>{
  const ctx=context({from:()=>({select:()=>({order:()=>({range:async()=>({error:new Error('denied')})})})})});
  await assert.rejects(ctx.fetchAdminRows('problems','id'),/denied/);
});
test('revenue uses verified charged amount, including zero, with legacy fallback',()=>{
  const ctx=context();
  assert.equal(ctx.grantAmountPaise({amount_paise:4900}),4900);
  assert.equal(ctx.grantAmountPaise({amount_paise:0}),0);
  assert.equal(ctx.grantAmountPaise({amount_paise:null,plan_key:'monthly'}),9900);
});
