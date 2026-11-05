import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPriorityClassifier, PriorityClassifier } from '../src/features/ai';
import { validateRiskLexicon } from '../src/features/ai/domain/lexicon';
import { normalizeText, tokenize } from '../src/features/ai/domain/features';
import { matchCues } from '../src/features/ai/domain/signals';
import { PRIORITY_MODEL } from '../src/features/ai/model/priorityModel';
import { ChatService } from '../src/features/chat/application/ChatService';
import { SqliteChatRepository } from '../src/features/chat/infrastructure/SqliteChatRepository';
import { ControlledChatEngine } from './helpers/chat';
import { TestSqliteDatabase } from './helpers/sqlite';

const classifier=createPriorityClassifier();
function source(): any { return JSON.parse(readFileSync(new URL('../src/features/ai/data/curated-risk-lexicon.v1.json',import.meta.url),'utf8')); }

test('one versioned data lexicon is bounded, normalized, immutable and rejects ambiguous/corrupt entries',()=>{
 const resource=validateRiskLexicon(source());assert.equal(resource.schemaVersion,1);assert.equal(resource.source.kind,'project-curated-baseline');assert.ok(Object.isFrozen(resource.entries));
 for(const mutate of [
  (d:any)=>{d.schemaVersion=2;},(d:any)=>{d.entries[0].priority='sos';},(d:any)=>{d.entries[0].language='xx';},
  (d:any)=>{d.entries.push({...d.entries[0],id:'different-id'});},(d:any)=>{d.entries[0].phrase=' '.repeat(200);},
  (d:any)=>{d.entries[0].regex='.*';},(d:any)=>{d.context.negators=[];},(d:any)=>{d.source.description=42;},
 ]){const data=source();mutate(data);assert.throws(()=>validateRiskLexicon(data),TypeError);}
});

test('active severe danger retains critical priority across Arabic forms, misspellings and physiological negation',()=>{
 const cases=[
  'There is a fire in our building and people are trapped','He is not breathing','No one is breathing',
  'We cannot breathe because the room is filling with smoke','His bleeding has not stopped',
  'My sister is unconcious and bleading','I cantbreathe please help',
  'ابني بنزف وفاقد الوعي الحقونا','والنزيف شديد والولد عالق','بقدرش اتنفس الحقوني',
  'مش قادرين نتنفس في دخان','هي فاقدة الوعي وبَتنزف','الدم مش واقف','ما في نبض',
 ];
 for(const text of cases)assert.equal(classifier.classify(text).priority,'critical',text);
});

test('denied, resolved, fictional and figurative cues do not become active emergencies',()=>{
 const cases=[
  'There is no fire','No one is injured here','There is not an active fire','He is not unconscious',
  'The fire was extinguished and everyone is safe','Bleeding stopped and she is awake now',
  'He was unconscious but he is awake now','The article says "people are trapped" in an old incident',
  'In the movie somebody is not breathing','This is a fire drill','I am dying laughing',
  'Our team is on fire today','This song is fire','We shot a photo of the sea',
  'No ambulance is needed','We do not need any medicine',
  'لا يوجد حريق هنا','ما في اي نزيف','الاسعاف مش مطلوب','وقف النزيف وصار بخير',
  'كان فاقد الوعي بس هلا صار بخير','بالفيلم في انفجار','بموت من الضحك','الاغنية نار',
 ];
 for(const text of cases){const value=classifier.classify(text);assert.ok(value.priority==='normal'||value.priority==='low',`${text}: ${value.priority}`);assert.equal(value.suggestSos,false,text);}
});

test('context never lets an unrelated denial, joke, resolution or quote erase a current dangerous clause',()=>{
 for(const text of [
  'There is no fire but he is not breathing','The fire was extinguished and a child is unconscious',
  'I am dying laughing while someone is bleeding badly','She texted "I cannot breathe", please help',
  'This is not a drill; the house is burning','I am not joking, people are trapped',
  'مافي حريق بس ابني مش عم يتنفس','هدا مش تدريب في حريق حقيقي',
  'النزيف وقف لكن ابوي فاقد الوعي','كان مصاب ولسه فاقد الوعي',
 ])assert.equal(classifier.classify(text).priority,'critical',text);
});

test('lack of essential supplies remains urgent while explicit no-need statements do not',()=>{
 for(const text of ['No water left for the children','Insulin has run out','مافي مي للاطفال','المي مش موجوده','خلص الانسولين'])assert.equal(classifier.classify(text).priority,'high',text);
 assert.notEqual(classifier.classify('We do not need any water').priority,'high');
});

test('the full bounded body includes late danger and normalization never creates empty tokens',()=>{
 const text='routine '.repeat(450)+'My child is not breathing';assert.ok(text.length>1024&&text.length<=4096);
 const value=classifier.classify(text);assert.equal(value.priority,'critical');assert.ok(value.signals.includes('not breathing'));
 assert.deepEqual(tokenize('  hi    there\n friend  '),['hi','there','friend']);
 assert.equal(normalizeText('أَنا   هُنا'),'انا هنا');
 assert.equal(matchCues('The firefly is bright').some(c=>c.cue==='fire'),false);
});

test('model shares are finite bounded heuristics and repeated cues cannot add unbounded boost',()=>{
 const once=classifier.classify('not breathing');const repeated=classifier.classify('not breathing '.repeat(100));
 assert.equal(repeated.priority,'critical');assert.deepEqual(repeated.signals,once.signals);
 for(const text of ['???','unfamiliar words','ابني بنزف','no fire','thanks']){
  const assessment=classifier.classify(text);assert.ok(assessment.confidence>=0&&assessment.confidence<=1);
  assert.ok(Object.values(assessment.scores).every(score=>Number.isFinite(score)&&score>=0&&score<=1));
 }
 assert.throws(()=>new PriorityClassifier({...PRIORITY_MODEL,priors:[NaN,0,0,0]}),TypeError);
});

test('lazy model failure leaves startup and normal offline chat sending available; an assessment never sends SOS',async t=>{
 const broken=createPriorityClassifier({...PRIORITY_MODEL,priors:[NaN,0,0,0]});
 const db=new TestSqliteDatabase();const engine=new ControlledChatEngine();
 const service=new ChatService({engine,repository:new SqliteChatRepository(db),clock:{now:()=>1000},classifier:broken});
 t.after(async()=>{await service.stop();db.close();});await service.start();await service.openConversation('bob');
 service.setDraft('My child cannot breathe');assert.equal(service.getSnapshot().draftAssessment,null);assert.equal(engine.publications.length,0);
 assert.equal((await service.send()).status,'queued');assert.equal(engine.publications.at(-1)?.kind,'chat');assert.equal(Object.hasOwn(engine.publications.at(-1)!,'priority'),false);
 assert.equal(engine.publications.some(packet=>packet.kind==='sos'),false);
});
