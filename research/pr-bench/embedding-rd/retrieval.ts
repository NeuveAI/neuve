import * as Schema from "effect/Schema";
import {canonicalRank, equalRrf, packWholeUnits} from "./support-method";
export {packWholeUnits};
const Id = Schema.NonEmptyString;
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Nat = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
const Finite = Schema.Number.check(Schema.isFinite());
const Vector = Schema.NonEmptyArray(Finite);
const Source = Schema.Struct({sourceId: Id, sha256: Digest, revision: Id, utf8Bytes: Nat});
const Document = Schema.Struct({unitId: Id, source: Source, start: Nat, end: Nat, text: Schema.String, textSha256: Digest});
const Segment = Schema.Struct({segmentId: Id, start: Nat, end: Nat, vector: Vector});
const EncodedDocument = Schema.Struct({unitId: Id, segments: Schema.NonEmptyArray(Segment)});
const CommonConfig = {modelPin: Digest, tokenizerPin: Digest, frameworkPin: Digest, baseWeightsPin: Digest, queryEncoderPin: Digest, segmenterPin: Digest};
const BaseEncoding = Schema.Struct({config: Schema.Struct({...CommonConfig, adapter: Schema.Struct({kind: Schema.Literal("BASE")})}), documents: Schema.NonEmptyArray(EncodedDocument)});
const TunedEncoding = Schema.Struct({config: Schema.Struct({...CommonConfig, adapter: Schema.Struct({kind: Schema.Literal("TUNED"), weightsPin: Digest})}), documents: Schema.NonEmptyArray(EncodedDocument)});
const Custody = Schema.Union([
 Schema.Struct({kind: Schema.Literal("UNKNOWN"), reason: Id}),
 Schema.Struct({kind: Schema.Literal("CERTIFIED"), evidencePin: Digest}),
]);
export const RetrievalInputSchema = Schema.Struct({
 schema: Schema.Literal("historical-retrieval-input-v1"), corpusPin: Digest, segmentationPin: Digest, baseEncodingPin: Digest, tunedEncodingPin: Digest,
 scheduledUnitIds: Schema.NonEmptyArray(Id), scheduledTaskIds: Schema.NonEmptyArray(Id),
 sources: Schema.NonEmptyArray(Schema.Struct({source: Source, text: Schema.String})),
 documents: Schema.NonEmptyArray(Document), baseEncoding: BaseEncoding, tunedEncoding: TunedEncoding,
 custody: Custody,
 tasks: Schema.NonEmptyArray(Schema.Struct({taskId: Id, familyId: Id, split: Schema.Literals(["TRAIN", "DEV"]), text: Schema.String, textSha256: Digest,
  queryEncoderPin: Digest, queryVector: Vector, queryVectorPin: Digest, qualification: Custody})),
 cohort: Schema.Union([
  Schema.Struct({kind: Schema.Literal("UNKNOWN"), reason: Id}),
  Schema.Struct({kind: Schema.Literal("CERTIFIED"), evidencePin: Digest, scheduledCensusPin: Digest, taskIds: Schema.NonEmptyArray(Id)}),
 ]),
});
export type RetrievalInput = typeof RetrievalInputSchema.Type;
function fail(message: string): never {throw new Error(message);}
function compareId(a: string, b: string) {return a < b ? -1 : a > b ? 1 : 0;}
function unique(ids: readonly string[], label: string) {if(new Set(ids).size !== ids.length)fail("Duplicate " + label);}
function sameIds(a: readonly string[], b: readonly string[]) {return a.length === b.length && a.every(id => b.includes(id));}
function sourceKey(source: typeof Source.Type) {return JSON.stringify([source.sourceId, source.sha256, source.revision]);}
function bytes(text: string) {
 const encoded = new TextEncoder().encode(text);
 if(new TextDecoder("utf-8", {fatal:true}).decode(encoded) !== text)fail("Text must be well-formed Unicode");
 return encoded;
}
export async function sha256(text: string) {
 const digest = await crypto.subtle.digest("SHA-256", bytes(text));
 return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2,"0")).join("");
}
export function normalizedVector(raw: unknown): readonly number[] {
 const vector = Schema.decodeUnknownSync(Vector)(raw);
 const scale = vector.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0);
 if(scale === 0)fail("Zero vector cannot have cosine score");
 const scaled = vector.map(value => value / scale);
 const norm = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
 return scaled.map(value => value / norm);
}
export function normalizedMax(query: readonly number[], segments: readonly {segmentId:string; vector: readonly number[]}[]) {
 if(segments.length === 0)fail("All complete segments required");
 unique(segments.map(s => s.segmentId), "MAX segment");
 const q=normalizedVector(query);
 const scores=segments.map(segment => {
  if(segment.vector.length !== q.length)fail("Embedding dimensions must match");
  const d=normalizedVector(segment.vector);
  const score=d.reduce((sum, value, index) => {
   const component=q[index]; if(component === undefined)return fail("Absent query component");
   return sum + value * component;
  },0);
  if(!Number.isFinite(score))fail("Nonfinite cosine score");
  return {segmentId:segment.segmentId,score:Math.min(1,Math.max(-1,score))};
 }).sort((a,b)=>b.score-a.score||compareId(a.segmentId,b.segmentId));
 const winner=scores[0] ?? fail("No segment score");
 return {score:winner.score,winningSegmentId:winner.segmentId,completeSegments:segments.length,segmentScores:scores};
}
export function unicodeWords(text: string): readonly string[] {bytes(text);return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];}
export function wholeCorpusBm25(query: string, rawDocuments: unknown) {
 const documents=Schema.decodeUnknownSync(Schema.NonEmptyArray(Schema.Struct({unitId:Id,text:Schema.String})),{onExcessProperty:"error"})(rawDocuments);
 unique(documents.map(d=>d.unitId),"BM25 document");
 const counts=documents.map(document=>{
  const terms=unicodeWords(document.text); const count=new Map<string,number>();
  for(const term of terms)count.set(term,(count.get(term)??0)+1);
  return {unitId:document.unitId,length:terms.length,count};
 });
 const meanLength=counts.reduce((sum,d)=>sum+d.length,0)/counts.length;
 const documentFrequency=new Map<string,number>();
 for(const document of counts)for(const term of document.count.keys())documentFrequency.set(term,(documentFrequency.get(term)??0)+1);
 const queryTerms=unicodeWords(query);
 const rows=counts.map(document=>{
  let score=0;
  for(const term of queryTerms){
   const frequency=documentFrequency.get(term)??0;
   const idf=Math.log(1+(counts.length-frequency+0.5)/(frequency+0.5));
   const tf=document.count.get(term)??0;
   const norm=1.2*(0.25+0.75*document.length/Math.max(meanLength,1));
   score+=idf*tf*2.2/(tf+norm);
  }
  return {unitId:document.unitId,score};
 });
 return {scores:rows,rank:canonicalRank(rows),documents:documents.length,meanLength,k1:1.2,b:0.75,queryTerms};
}
export async function identityPins(raw: unknown) {
 const input=Schema.decodeUnknownSync(RetrievalInputSchema,{onExcessProperty:"error"})(raw);
 const sourceRows=[...input.sources].sort((a,b)=>compareId(sourceKey(a.source),sourceKey(b.source))).map(s=>s.source);
 const documentRows=[...input.documents].sort((a,b)=>compareId(a.unitId,b.unitId)).map(({text:_text,...d})=>d);
 const segmentRows=[...input.baseEncoding.documents].sort((a,b)=>compareId(a.unitId,b.unitId)).map(d=>({unitId:d.unitId,segments:d.segments.map(({vector:_vector,...s})=>s)}));
 return {corpusPin:await sha256(JSON.stringify({sources:sourceRows,documents:documentRows})),segmentationPin:await sha256(JSON.stringify(segmentRows)),
  baseEncodingPin:await sha256(JSON.stringify(input.baseEncoding)),tunedEncodingPin:await sha256(JSON.stringify(input.tunedEncoding))};
}
export async function decodeRetrievalInput(raw: unknown): Promise<RetrievalInput> {
 const input=Schema.decodeUnknownSync(RetrievalInputSchema,{onExcessProperty:"error"})(raw);
 unique(input.scheduledUnitIds,"scheduled unit");unique(input.scheduledTaskIds,"scheduled task");
 unique(input.documents.map(d=>d.unitId),"document");unique(input.tasks.map(t=>t.taskId),"task");
 if(!sameIds(input.scheduledUnitIds,input.documents.map(d=>d.unitId)))fail("Every scheduled source unit required");
 if(!sameIds(input.scheduledTaskIds,input.tasks.map(t=>t.taskId)))fail("Every scheduled task row required");
 unique(input.sources.map(s=>sourceKey(s.source)),"immutable source");
 const sizes=new Map<string,number>();
 for(const source of [...input.sources.map(s=>s.source),...input.documents.map(d=>d.source)]){
  const key=sourceKey(source);const prior=sizes.get(key);
  if(prior!==undefined && prior!==source.utf8Bytes)fail("Contradictory immutable source length");sizes.set(key,source.utf8Bytes);
 }
 for(const source of input.sources){
  const material=bytes(source.text);
  if(material.length===0 || material.length!==source.source.utf8Bytes || await sha256(source.text)!==source.source.sha256)fail("Full source byte/hash mismatch");
  const documents=input.documents.filter(d=>sourceKey(d.source)===sourceKey(source.source)).sort((a,b)=>a.start-b.start);
  let position=0;
  for(const document of documents){
   if(document.start!==position||document.end<=document.start||document.end>material.length)fail("Full source unit coverage must be gapless and nonoverlapping");
   const text=new TextDecoder("utf-8",{fatal:true}).decode(material.subarray(document.start,document.end));
   if(text!==document.text||await sha256(text)!==document.textSha256)fail("Original document text/byte/hash mismatch");
   position=document.end;
  }
  if(position!==material.length)fail("Source body cannot silently disappear");
 }
 if(input.documents.some(d=>!input.sources.some(s=>sourceKey(s.source)===sourceKey(d.source))))fail("Document source absent");
 const {adapter:_baseAdapter,...baseConfig}=input.baseEncoding.config;
 const {adapter:_tunedAdapter,...tunedConfig}=input.tunedEncoding.config;
 if(JSON.stringify(baseConfig)!==JSON.stringify(tunedConfig))fail("Only document adapter identity may vary");
 for(const encoding of [input.baseEncoding,input.tunedEncoding]){
  unique(encoding.documents.map(d=>d.unitId),"encoded document");
  if(!sameIds(input.scheduledUnitIds,encoding.documents.map(d=>d.unitId)))fail("Complete encoded source census required");
  for(const encoded of encoding.documents){
   const document=input.documents.find(d=>d.unitId===encoded.unitId)??fail("Missing encoded document source");
   unique(encoded.segments.map(s=>s.segmentId),"encoded segment");
   let position=0;
   for(const segment of encoded.segments){
    if(segment.start!==position||segment.end<=segment.start||segment.end>bytes(document.text).length)fail("Every document segment byte required in order");
    new TextDecoder("utf-8",{fatal:true}).decode(bytes(document.text).subarray(segment.start,segment.end));
    normalizedVector(segment.vector);position=segment.end;
   }
   if(position!==bytes(document.text).length)fail("Incomplete document segment coverage");
  }
 }
 for(const base of input.baseEncoding.documents){
  const tuned=input.tunedEncoding.documents.find(d=>d.unitId===base.unitId)??fail("Missing tuned document");
  if(JSON.stringify(base.segments.map(({vector:_v,...s})=>s))!==JSON.stringify(tuned.segments.map(({vector:_v,...s})=>s)))fail("BASE/tuned segment identity must match exactly");
 }
 const pins=await identityPins(input);
 if(pins.corpusPin!==input.corpusPin||pins.segmentationPin!==input.segmentationPin)fail("Frozen corpus/segmentation digest mismatch");
 if(pins.baseEncodingPin!==input.baseEncodingPin||pins.tunedEncodingPin!==input.tunedEncodingPin)fail("Frozen embedding payload digest mismatch");
 for(const task of input.tasks){
  if(task.queryEncoderPin!==baseConfig.queryEncoderPin)fail("Query encoder must be shared/frozen");
  if(await sha256(task.text)!==task.textSha256||await sha256(JSON.stringify(task.queryVector))!==task.queryVectorPin)fail("Frozen query text/vector digest mismatch");
  const dimension=task.queryVector.length;normalizedVector(task.queryVector);
  if([...input.baseEncoding.documents,...input.tunedEncoding.documents].some(d=>d.segments.some(s=>s.vector.length!==dimension)))fail("All query/document embedding dimensions must match");
 }
 if(input.cohort.kind==="CERTIFIED"){
  unique(input.cohort.taskIds,"cohort task");
  if(input.cohort.taskIds.some(id=>!input.scheduledTaskIds.includes(id)))fail("Cohort cannot invent tasks");
 }
 return input;
}
function tag<const K extends string>(kind:K):K{return kind;}
export async function retrieveFiveArms(raw: unknown) {
 const input=await decodeRetrievalInput(raw);
 const tasks=input.tasks.map(task=>({taskId:task.taskId,familyId:task.familyId,split:task.split}));
 const retained={scheduledTaskIds:input.scheduledTaskIds,scheduledUnitIds:input.scheduledUnitIds,tasks,
  corpusPin:input.corpusPin,segmentationPin:input.segmentationPin,
  custody:input.custody,cohort:input.cohort,
  runtimeIdentity:"DECLARED_AND_PAYLOAD_CHECKED; ACTUAL_ENCODER_WEIGHTS_AND_AUTHORITY_NOT_PROVED"};
 if(input.custody.kind==="UNKNOWN"||input.cohort.kind==="UNKNOWN")return{kind:tag("UNKNOWN"),...retained,
  reason:input.custody.kind==="UNKNOWN"?input.custody.reason:input.cohort.kind==="UNKNOWN"?input.cohort.reason:"missing",results:[]};
 const cohortIds=input.cohort.taskIds;
 const results=input.tasks.map(task=>{
  const common={taskId:task.taskId,familyId:task.familyId,split:task.split};
  if(!cohortIds.includes(task.taskId))return{kind:tag("OUTSIDE_COHORT"),...common};
  if(task.qualification.kind==="UNKNOWN")return{kind:tag("UNKNOWN"),...common,reason:task.qualification.reason};
  const lexical=wholeCorpusBm25(task.text,input.documents.map(d=>({unitId:d.unitId,text:d.text})));
  const dense=(encoding:typeof input.baseEncoding|typeof input.tunedEncoding)=>encoding.documents.map(document=>({unitId:document.unitId,...normalizedMax(task.queryVector,document.segments)}));
  const base=dense(input.baseEncoding),tuned=dense(input.tunedEncoding);
  const baseRank=canonicalRank(base.map(d=>({unitId:d.unitId,score:d.score}))),tunedRank=canonicalRank(tuned.map(d=>({unitId:d.unitId,score:d.score})));
  return{kind:tag("COMPUTED"),...common,normalization:"ACTUALLY_NORMALIZED_FROM_SUPPLIED_NONZERO_VECTORS",arms:{
   BM25:{rank:lexical.rank,scores:lexical.scores},BASEdense:{rank:baseRank,scores:base},tunedDense:{rank:tunedRank,scores:tuned},
   BASEhybrid:{rank:equalRrf(baseRank,lexical.rank)},tunedHybrid:{rank:equalRrf(tunedRank,lexical.rank)},
  }};
 });
 return{kind:tag("COMPUTED"),...retained,results,admission:"PURE_RETRIEVAL_COMPUTATION_ONLY; NO_RUNTIME_OR_SCIENTIFIC_ACCEPTANCE"};
}
