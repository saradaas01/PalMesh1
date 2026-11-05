/** Reproducible fixed, balanced bilingual holdout; never trains on its examples. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createPriorityClassifier,normalizeText} from '../../src/features/ai';
import type {MessagePriority} from '../../src/features/dtn/domain/types';
const classes=['critical','high','normal','low'] as const;
type Example={id:string;language:'ar'|'en';expected:MessagePriority;text:string};
const datasetPath='scripts/ai/risk-holdout.v1.json';
const paths=[datasetPath,'scripts/ai/priority-corpus.json','src/features/ai/data/curated-risk-lexicon.v1.json','src/features/ai/model/priorityModel.ts'];
const raw=JSON.parse(readFileSync(datasetPath,'utf8')) as {version:number;provenance:string;examples:Example[]};
if(raw.version!==1||!Array.isArray(raw.examples)||raw.examples.length!==64)throw new Error('Unexpected fixed holdout');
const training=Object.values(JSON.parse(readFileSync(paths[1]!,'utf8')) as Record<string,string[]>).flat();
const trainingTexts=new Set(training.map(normalizeText));const seen=new Set<string>();
for(const row of raw.examples){
 if(!row.id||!['ar','en'].includes(row.language)||!classes.includes(row.expected)||!row.text||row.text.length>4096)throw new Error('Invalid holdout example');
 const normalized=normalizeText(row.text);if(trainingTexts.has(normalized)||seen.has(normalized))throw new Error('Training/holdout overlap or duplicate: '+row.id);seen.add(normalized);
}
for(const language of ['ar','en'])for(const priority of classes)if(raw.examples.filter(row=>row.language===language&&row.expected===priority).length!==8)throw new Error('Unbalanced language/class holdout');
const classifier=createPriorityClassifier();
const results=raw.examples.map(row=>({...row,predicted:classifier.classify(row.text).priority}));
const ratio=(a:number,b:number)=>b===0?null:Math.round(a/b*1e6)/1e6;
function metrics(rows:typeof results){
 const tp=rows.filter(r=>r.expected==='critical'&&r.predicted==='critical').length;
 const fp=rows.filter(r=>r.expected!=='critical'&&r.predicted==='critical').length;
 const fn=rows.filter(r=>r.expected==='critical'&&r.predicted!=='critical').length;
 return {examples:rows.length,critical:{truePositives:tp,falsePositives:fp,falseNegatives:fn,precision:ratio(tp,tp+fp),recall:ratio(tp,tp+fn),f1:ratio(2*tp,2*tp+fp+fn)},
  confusion:Object.fromEntries(classes.map(actual=>[actual,Object.fromEntries(classes.map(predicted=>[predicted,rows.filter(row=>row.expected===actual&&row.predicted===predicted).length]))]))};
}
const report={version:1,method:raw.provenance,limitations:['Author-labeled synthetic examples; not independent human adjudication or field/medical validation.','Balanced classes do not represent deployment prevalence.','Curated lexical rules and the trained model are evaluated together.','User-mentioned palmesh_risk_lexicon_ar_en.json was not received; project baseline resource only.'],inputSha256:Object.fromEntries(paths.map(path=>[path,createHash('sha256').update(readFileSync(path)).digest('hex')])),overall:metrics(results),arabic:metrics(results.filter(r=>r.language==='ar')),english:metrics(results.filter(r=>r.language==='en')),errors:results.filter(r=>r.expected!==r.predicted)};
const serialized=JSON.stringify(report,null,2)+'\n';
const reportPath='docs/ai-risk-evaluation.json';
if(process.argv.includes('--check')){if(readFileSync(reportPath,'utf8')!==serialized)throw new Error('Risk evaluation report is stale');}
else{mkdirSync('docs',{recursive:true});writeFileSync(reportPath,serialized);}
console.log(JSON.stringify({overall:report.overall,arabic:report.arabic,english:report.english,errors:report.errors.map(e=>({id:e.id,expected:e.expected,predicted:e.predicted}))},null,2));
