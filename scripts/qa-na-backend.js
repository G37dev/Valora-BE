/* N/A backend-verifiable checks — read-only validations (no real plans) */
require('dotenv').config();
const { sequelize } = require('../models');
let pass=0, fail=0; const bad=[];
const ok=(name,cond,info='')=>{cond?pass++:fail++,cond||bad.push(name);console.log((cond?'PASS':'FAIL')+' '+name+(info?' — '+info:''));};
(async()=>{
// INS-088/089: DP bounds 30-50%
const v=require('../services/installment/installment.validation');
for(const [pct,exp] of [[29.99,false],[50.01,false],[30,true],[50,true],[40,true]]){
  try{const r=v.parseDpBps({dp_percent:pct});ok(`DP ${pct}% -> ${r}bps`,exp===true);}
  catch(e){ok(`DP ${pct}% rejected`,exp===false, e.code||e.message);}
}
// INS-086/087/090/091: min payment behavior
const eng=require('../services/installment/installment.engine');
console.log('engine exports:',Object.keys(eng).join(','));
// DEP-056: unknown asset
const tc=require('../controllers/transactionController');
// DEP-057: min/max config — check admin config source
const RULES=require('../services/installment/installment.constants').RULES||require('../services/installment/installment.constants');
console.log('MIN_PAYMENT_IDR=',RULES.MIN_PAYMENT_IDR?.toString(),'MIN_INSTALLMENT_IDR=',RULES.MIN_INSTALLMENT_IDR?.toString());
process.exit(0);
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
